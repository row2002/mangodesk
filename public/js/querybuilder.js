// Visual drag & drop query builder. Lives in the right-hand #query-panel.
// Fields are dragged in from the data grid (table cells / tree rows).
(() => {
  const root = document.getElementById('query-panel');

  // Panel show/hide toggle (Studio 3T "Hide Query Builder").
  const toggleBtn = document.getElementById('qb-toggle');
  const qbSaved = localStorage.getItem('mangodesk.qbOpen');
  if (qbSaved !== null) {
    root.hidden = qbSaved !== '1';
    toggleBtn.classList.toggle('active', !root.hidden);
  }
  toggleBtn.addEventListener('click', () => {
    root.hidden = !root.hidden;
    toggleBtn.classList.toggle('active', !root.hidden);
    localStorage.setItem('mangodesk.qbOpen', root.hidden ? '0' : '1');
  });

  // ---- state ----
  let groups = [];                 // [[{path, type, op, value}], ...] — conds inside a group are AND-ed
  let topOp = '$and';              // how groups are combined
  let sortItems = [];              // [{path, dir: 1|-1}]
  let projItems = [];              // [{path, mode: 1|0}] — include/exclude per field

  // ---- helpers ----
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const OPS = {
    string: ['equals', 'not equals', 'contains', 'starts with', '>', '>=', '<', '<=', 'in', 'exists', 'not exists'],
    number: ['equals', 'not equals', '>', '>=', '<', '<=', 'in', 'exists', 'not exists'],
    date: ['equals', 'not equals', '>', '>=', '<', '<=', 'in', 'exists', 'not exists'],
    objectId: ['equals', 'not equals', 'in', 'exists', 'not exists'],
    boolean: ['equals', 'not equals', 'exists', 'not exists'],
    array: ['equals', 'not equals', 'in', 'exists', 'not exists'],
    object: ['exists', 'not exists'],
    null: ['equals', 'not equals', 'exists', 'not exists'],
  };
  const opsFor = (type) => OPS[type] || OPS.string;

  function typedValue(raw, type) {
    if (type === 'number') {
      const n = parseFloat(raw);
      return Number.isFinite(n) ? n : null;
    }
    if (type === 'boolean') return raw === 'true';
    if (type === 'date') {
      const ms = new Date(raw).getTime();
      // invalid date → null, so the preview makes the mistake visible
      // instead of silently querying for 1970-01-01
      if (!Number.isFinite(ms)) return null;
      return { $date: { $numberLong: String(ms) } };
    }
    if (type === 'objectId') return { $oid: raw };
    return raw;
  }

  function condToObj(c) {
    const v = () => typedValue(c.value, c.type);
    switch (c.op) {
      case 'exists': return { [c.path]: { $exists: true } };
      case 'not exists': return { [c.path]: { $exists: false } };
      case 'contains': return { [c.path]: { $regex: escRe(c.value), $options: 'i' } };
      case 'starts with': return { [c.path]: { $regex: '^' + escRe(c.value), $options: 'i' } };
      case 'in': return { [c.path]: { $in: c.value.split(',').map((s) => typedValue(s.trim(), c.type)) } };
      case 'not equals': return { [c.path]: { $ne: v() } };
      case '>': return { [c.path]: { $gt: v() } };
      case '>=': return { [c.path]: { $gte: v() } };
      case '<': return { [c.path]: { $lt: v() } };
      case '<=': return { [c.path]: { $lte: v() } };
      default: return { [c.path]: v() };
    }
  }

  function buildFilter() {
    if (!queryCheck.checked) return {};
    const gs = groups.filter((g) => g.length).map((g) => {
      const conds = g.map(condToObj);
      return conds.length === 1 ? conds[0] : { $and: conds };
    });
    if (!gs.length) return {};
    if (gs.length === 1) return gs[0];
    return { [topOp]: gs };
  }
  const buildSort = () =>
    sortCheck.checked ? Object.fromEntries(sortItems.map((s) => [s.path, s.dir])) : {};
  const buildProj = () =>
    projCheck.checked ? Object.fromEntries(projItems.map((p) => [p.path, p.mode])) : {};

  // Build a condition from a drop payload; cells dragged from the data grid
  // carry a value, so the condition arrives prefilled as "field equals value".
  function condFrom(f) {
    const hasVal = f.value !== undefined && opsFor(f.type).includes('equals');
    return {
      path: f.path,
      type: f.type,
      op: hasVal ? 'equals' : opsFor(f.type)[0],
      value: hasVal ? String(f.value) : '',
    };
  }

  // ---- drag & drop plumbing ----
  function makeDropZone(node, onDrop) {
    node.addEventListener('dragover', (e) => { e.preventDefault(); node.classList.add('drop-hl'); });
    node.addEventListener('dragleave', () => node.classList.remove('drop-hl'));
    node.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      node.classList.remove('drop-hl');
      try {
        const f = JSON.parse(e.dataTransfer.getData('text/plain'));
        if (f && f.path) onDrop(f);
      } catch (_) { /* not a field drop */ }
    });
  }

  // ---- layout: Query / Projection / Sort sections ----
  function section(titleText) {
    const sec = el('div', 'qb-section');
    const head = el('div', 'qb-sec-head');
    const title = el('span', 'qb-sec-title', titleText);
    const check = el('input');
    check.type = 'checkbox';
    check.checked = true;
    check.title = 'Apply this part of the query';
    head.append(title, check);
    sec.appendChild(head);
    return { sec, head, check };
  }

  // Query section
  const q = section('Query');
  const controls = el('div', 'qb-controls');
  const topOpSel = el('select');
  for (const [v, label] of [['$and', 'Match all of ($and)'], ['$or', 'Match any of ($or)']]) {
    const o = el('option', '', label);
    o.value = v;
    topOpSel.appendChild(o);
  }
  const clearBtn = el('button', '', 'Clear');
  const runBtn = el('button', 'primary', 'Run');
  controls.append(topOpSel, el('span', 'qb-spacer'), clearBtn, runBtn);

  const canvas = el('div', 'qb-canvas');
  const groupsBox = el('div', 'qb-groups');
  const canvasHint = el('div', 'qb-canvas-hint');
  canvasHint.append(el('span', 'muted', '+ Drag field here or double-click'));
  const addGroupBtn = el('button', 'qb-link', 'Add AND/OR group');
  canvasHint.appendChild(addGroupBtn);
  canvas.append(groupsBox, canvasHint);
  q.sec.append(controls, canvas);

  // Projection section
  const p = section('Projection');
  const projZone = el('div', 'qb-strip');
  p.sec.appendChild(projZone);
  const projWarn = el('div', 'qb-hint');
  projWarn.style.color = '#e5534b';
  p.sec.appendChild(projWarn);

  // Sort section
  const s = section('Sort');
  const sortZone = el('div', 'qb-strip');
  s.sec.appendChild(sortZone);

  const queryCheck = q.check;
  const projCheck = p.check;
  const sortCheck = s.check;

  // Preview
  const previewWrap = el('div', 'qb-preview-wrap');
  const previewHead = el('div', 'qb-sec-head');
  previewHead.appendChild(el('span', 'qb-sec-title', 'Filter preview'));
  const copyBtn = el('button', 'qb-mini', 'Copy');
  previewHead.appendChild(copyBtn);
  const preview = el('pre', 'qb-preview', '{}');
  previewWrap.append(previewHead, preview);

  const wrap = el('div', 'qb-root');
  wrap.append(q.sec, p.sec, s.sec, previewWrap);
  root.appendChild(wrap);

  // ---- builder rendering ----
  function renderGroups() {
    groupsBox.textContent = '';
    groups.forEach((group, gi) => {
      if (gi > 0) groupsBox.appendChild(el('div', 'qb-or-label', topOp === '$and' ? 'AND' : 'OR'));
      const box = el('div', 'qb-group');
      const head = el('div', 'qb-group-head');
      head.appendChild(el('span', 'muted', 'Group ' + (gi + 1) + ' (AND)'));
      const delGroup = el('button', 'qb-x', '✕');
      delGroup.title = 'Remove group';
      delGroup.addEventListener('click', () => { groups.splice(gi, 1); renderGroups(); update(); });
      head.appendChild(delGroup);
      box.appendChild(head);

      group.forEach((cond, ci) => box.appendChild(renderCond(cond, group, ci)));
      if (!group.length) box.appendChild(el('div', 'muted qb-hint', 'Drop a field here.'));

      makeDropZone(box, (f) => {
        group.push(condFrom(f));
        renderGroups(); update();
      });
      groupsBox.appendChild(box);
    });
  }

  function renderCond(cond, group, ci) {
    const row = el('div', 'qb-cond');

    const fieldInp = el('input', 'qb-field-input mono');
    fieldInp.placeholder = 'field.name';
    fieldInp.value = cond.path;
    fieldInp.addEventListener('input', () => { cond.path = fieldInp.value.trim(); update(); });
    row.appendChild(fieldInp);

    const typeSel = el('select', 'qb-type-sel');
    typeSel.title = 'Value type';
    for (const t of Object.keys(OPS)) {
      const o = el('option', '', t);
      o.value = t;
      typeSel.appendChild(o);
    }
    typeSel.value = OPS[cond.type] ? cond.type : 'string';
    typeSel.addEventListener('change', () => {
      cond.type = typeSel.value;
      if (!opsFor(cond.type).includes(cond.op)) cond.op = opsFor(cond.type)[0];
      renderGroups(); update();
    });
    row.appendChild(typeSel);

    const line = el('span', 'qb-cond-line');
    const opSel = el('select');
    for (const op of opsFor(cond.type)) {
      const o = el('option', '', op);
      o.value = op;
      opSel.appendChild(o);
    }
    opSel.value = cond.op;
    line.appendChild(opSel);

    const valSlot = el('span', 'qb-val-slot');
    line.appendChild(valSlot);

    function renderValInput() {
      valSlot.textContent = '';
      if (cond.op === 'exists' || cond.op === 'not exists') return;
      if (cond.type === 'boolean' && cond.op !== 'in') {
        const sel = el('select');
        for (const v of ['true', 'false']) {
          const o = el('option', '', v);
          o.value = v;
          sel.appendChild(o);
        }
        sel.value = cond.value === 'false' ? 'false' : 'true';
        cond.value = sel.value;
        sel.addEventListener('change', () => { cond.value = sel.value; update(); });
        valSlot.appendChild(sel);
        return;
      }
      if (cond.op === 'in') {
        // chip list; cond.value stays a comma-joined string so condToObj is unchanged
        const box = el('span', 'qb-chips');
        const chipInp = el('input', 'qb-chip-input');
        chipInp.placeholder = 'value ⏎';
        const vals = () => cond.value.split(',').map((x) => x.trim()).filter(Boolean);
        const sync = (arr) => { cond.value = arr.join(', '); redraw(); update(); };
        function redraw() {
          box.querySelectorAll('.qb-chip').forEach((n) => n.remove());
          vals().forEach((v, i) => {
            const chip = el('span', 'qb-chip', v);
            const x = el('button', 'qb-chip-x', '×');
            x.type = 'button';
            x.title = 'Remove value';
            x.addEventListener('click', () => { const a = vals(); a.splice(i, 1); sync(a); });
            chip.appendChild(x);
            box.insertBefore(chip, chipInp);
          });
        }
        const commit = () => {
          if (!chipInp.value.trim()) return;
          sync([...vals(), chipInp.value]); // vals() re-splits, so pasted "a, b, c" becomes chips
          chipInp.value = '';
        };
        chipInp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
          else if (e.key === 'Backspace' && !chipInp.value) sync(vals().slice(0, -1));
        });
        chipInp.addEventListener('blur', commit);
        box.addEventListener('click', (e) => { if (e.target === box) chipInp.focus(); });
        box.appendChild(chipInp);
        redraw();
        valSlot.appendChild(box);
        return;
      }
      const inp = el('input');
      if (cond.type === 'number') {
        inp.type = 'number';
        inp.step = 'any';
      } else if (cond.type === 'date') {
        inp.type = 'datetime-local';
      } else {
        inp.type = 'text';
        if (cond.type === 'objectId') inp.placeholder = 'hex id';
      }
      inp.value = cond.value;
      inp.addEventListener('input', () => { cond.value = inp.value; update(); });
      valSlot.appendChild(inp);
    }
    renderValInput();

    opSel.addEventListener('change', () => { cond.op = opSel.value; renderValInput(); update(); });

    const del = el('button', 'qb-x', '✕');
    del.title = 'Remove condition';
    del.addEventListener('click', () => { group.splice(ci, 1); renderGroups(); update(); });
    row.appendChild(del);
    row.appendChild(line); // op + value wrap onto their own line
    return row;
  }

  // Shared: a strip row = field name + per-field select + remove button.
  function stripRow(zone, path, options, current, onSelect, onRemove) {
    const row = el('div', 'qb-strip-row');
    row.appendChild(el('span', 'qb-strip-field mono', path));
    const sel = el('select');
    for (const [v, label] of options) {
      const o = el('option', '', label);
      o.value = String(v);
      sel.appendChild(o);
    }
    sel.value = String(current);
    sel.addEventListener('change', () => { onSelect(sel.value); update(); });
    const x = el('button', 'qb-x', '✕');
    x.title = 'Remove';
    x.addEventListener('click', () => { onRemove(); update(); });
    row.append(sel, x);
    zone.appendChild(row);
  }

  function renderSort() {
    sortZone.textContent = '';
    if (!sortItems.length) sortZone.appendChild(el('span', 'muted qb-hint', '+ Drag and drop fields here or double-click'));
    sortItems.forEach((it, i) => stripRow(
      sortZone, it.path,
      [[1, 'Asc'], [-1, 'Desc']], it.dir,
      (v) => { it.dir = Number(v); },
      () => { sortItems.splice(i, 1); renderSort(); },
    ));
  }

  function renderProj() {
    projZone.textContent = '';
    if (!projItems.length) projZone.appendChild(el('span', 'muted qb-hint', '+ Drag and drop fields here or double-click'));
    projItems.forEach((it, i) => stripRow(
      projZone, it.path,
      [[1, 'Include'], [0, 'Exclude']], it.mode,
      (v) => { it.mode = Number(v); },
      () => { projItems.splice(i, 1); renderProj(); },
    ));
  }

  function update() {
    preview.textContent = JSON.stringify(buildFilter(), null, 2);
    // MongoDB rejects projections mixing include and exclude (except _id)
    const inc = projItems.some((x) => x.mode === 1);
    const exc = projItems.some((x) => x.mode === 0 && x.path !== '_id');
    projWarn.textContent = projCheck.checked && inc && exc
      ? 'Include and Exclude cannot be mixed (only _id may be excluded)' : '';
  }

  // ---- wiring ----
  makeDropZone(canvas, (f) => {
    if (!groups.length) groups.push([]);
    groups[groups.length - 1].push(condFrom(f));
    renderGroups(); update();
  });
  makeDropZone(sortZone, (f) => {
    if (!sortItems.some((it) => it.path === f.path)) sortItems.push({ path: f.path, dir: 1 });
    renderSort(); update();
  });
  makeDropZone(projZone, (f) => {
    if (!projItems.some((it) => it.path === f.path)) projItems.push({ path: f.path, mode: 1 });
    renderProj(); update();
  });

  // ---- double-click to add without dragging ----
  function addEmptyCond(group) {
    group.push({ path: '', type: 'string', op: 'equals', value: '' });
    renderGroups(); update();
    const inputs = groupsBox.querySelectorAll('.qb-field-input');
    if (inputs.length) inputs[inputs.length - 1].focus();
  }

  canvas.addEventListener('dblclick', (e) => {
    if (e.target.closest('.qb-group, input, select, button')) return;
    if (!groups.length) groups.push([]);
    addEmptyCond(groups[groups.length - 1]);
  });

  // dblclick inside a specific group adds a condition to that group
  groupsBox.addEventListener('dblclick', (e) => {
    if (e.target.closest('.qb-cond, input, select, button')) return;
    const box = e.target.closest('.qb-group');
    if (!box) return;
    e.stopPropagation();
    const gi = Array.from(groupsBox.querySelectorAll('.qb-group')).indexOf(box);
    if (gi !== -1) addEmptyCond(groups[gi]);
  });

  // dblclick on Sort/Projection strips shows an inline field-name input
  function dblclickAdder(zone, commit) {
    zone.addEventListener('dblclick', (e) => {
      if (e.target.closest('.qb-chip, input, button')) return;
      if (zone.querySelector('.qb-new-field')) return;
      const inp = el('input', 'qb-new-field mono');
      inp.placeholder = 'field.name';
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        const v = inp.value.trim();
        inp.remove();
        if (ok && v) commit(v);
      };
      inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') finish(true);
        else if (ev.key === 'Escape') finish(false);
      });
      inp.addEventListener('blur', () => finish(true));
      zone.appendChild(inp);
      inp.focus();
    });
  }

  dblclickAdder(sortZone, (v) => {
    if (!sortItems.some((it) => it.path === v)) sortItems.push({ path: v, dir: 1 });
    renderSort(); update();
  });
  dblclickAdder(projZone, (v) => {
    if (!projItems.some((it) => it.path === v)) projItems.push({ path: v, mode: 1 });
    renderProj(); update();
  });

  addGroupBtn.addEventListener('click', () => { groups.push([]); renderGroups(); });
  topOpSel.addEventListener('change', () => { topOp = topOpSel.value; renderGroups(); update(); });
  [queryCheck, projCheck, sortCheck].forEach((c) => c.addEventListener('change', update));

  runBtn.addEventListener('click', () => {
    App.emit('query', {
      filter: JSON.stringify(buildFilter()),
      sort: JSON.stringify(buildSort()),
      projection: JSON.stringify(buildProj()),
    });
    App.showTab('data');
  });
  copyBtn.addEventListener('click', () => navigator.clipboard.writeText(JSON.stringify(buildFilter())));
  clearBtn.addEventListener('click', () => {
    groups = []; sortItems = []; projItems = [];
    renderGroups(); renderSort(); renderProj(); update();
  });

  App.on('target', () => {
    // new collection — old field paths are meaningless, start clean
    groups = []; sortItems = []; projItems = [];
    renderGroups(); renderSort(); renderProj(); update();
  });

  renderGroups(); renderSort(); renderProj(); update();
})();
