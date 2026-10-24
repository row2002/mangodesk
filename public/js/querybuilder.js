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
    long: ['equals', 'not equals', '>', '>=', '<', '<=', 'in', 'exists', 'not exists'],
    decimal: ['equals', 'not equals', '>', '>=', '<', '<=', 'in', 'exists', 'not exists'],
    date: ['equals', 'not equals', '>', '>=', '<', '<=', 'in', 'exists', 'not exists'],
    objectId: ['equals', 'not equals', 'in', 'exists', 'not exists'],
    boolean: ['equals', 'not equals', 'exists', 'not exists'],
    array: ['equals', 'not equals', 'in', 'exists', 'not exists'],
    object: ['exists', 'not exists'],
    null: ['equals', 'not equals', 'exists', 'not exists'],
  };
  const opsFor = (type) => OPS[type] || OPS.string;

  // Dates are kept as ISO strings (UTC, "Z"). How much of the time is written decides
  // what "equals" means: to the millisecond it is that instant, to the second or minute
  // (as the picker writes a whole value) it is that whole second or minute.
  // A string without a zone is an old saved condition typed in local time.
  function dateSpan(raw) {
    const t = String(raw).trim();
    const ms = new Date(t).getTime();
    const span = /T\d\d:\d\d:\d\d\.\d/.test(t) ? 0
      : /T\d\d:\d\d:\d\d/.test(t) ? 1000
        : /T\d\d:\d\d/.test(t) ? 60000 : 86400000;
    return { ms, span };
  }
  const $date = (ms) => ({ $date: { $numberLong: String(ms) } });

  // ISO string → datetime-local value (local wall time), to the precision it has.
  function dateToInput(raw) {
    const { ms, span } = dateSpan(raw);
    if (!Number.isFinite(ms)) return '';
    const local = new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString();
    return local.slice(0, span === 0 ? 23 : span === 1000 ? 19 : 16);
  }
  // datetime-local value → ISO string (UTC), keeping the precision typed.
  function inputToDate(v) {
    const ms = new Date(v).getTime();
    if (!v || !Number.isFinite(ms)) return '';
    const iso = new Date(ms).toISOString();
    return /:\d\d\.\d/.test(v) ? iso : (/:\d\d:\d\d$/.test(v) ? iso.slice(0, 19) : iso.slice(0, 16)) + 'Z';
  }

  const isNum = (t) => t !== '' && (!isNaN(Number(t)) || /^[-+]?(NaN|Inf(inity)?)$/i.test(t));

  // Values in the filter are canonical EJSON where JSON can't say it (C3); plain JSON
  // numbers compare numerically against Int32, Int64, Double and Decimal128 alike.
  function typedValue(raw, type) {
    const t = String(raw == null ? '' : raw).trim();
    if (type === 'null') return null;
    if (type === 'number') {
      // past 2^53 a JS number no longer is the integer typed
      if (/^-?\d+$/.test(t) && !Number.isSafeInteger(Number(t))) return { $numberLong: t };
      if (/^[-+]?(NaN|Infinity)$/.test(t)) return { $numberDouble: t.replace('+', '') };
      const n = Number(t);
      return t !== '' && Number.isFinite(n) ? n : null;
    }
    if (type === 'long') return /^[-+]?\d+$/.test(t) ? { $numberLong: t.replace('+', '') } : null;
    // a double never equals the decimal it was printed from (12.34 ≠ Decimal128('12.34'))
    if (type === 'decimal') return isNum(t) ? { $numberDecimal: t } : null;
    if (type === 'boolean') return raw === 'true';
    if (type === 'date') {
      const { ms } = dateSpan(t);
      // invalid date → null, so the preview makes the mistake visible
      // instead of silently querying for 1970-01-01
      return Number.isFinite(ms) ? $date(ms) : null;
    }
    if (type === 'objectId') return { $oid: t };
    return raw;
  }

  function condToObj(c) {
    const v = () => typedValue(c.value, c.type);
    if (c.type === 'date' && (c.op === 'equals' || c.op === 'not equals')) {
      const { ms, span } = dateSpan(c.value);
      if (span && Number.isFinite(ms)) {
        const range = { $gte: $date(ms), $lt: $date(ms + span) };
        return { [c.path]: c.op === 'equals' ? range : { $not: range } };
      }
    }
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

  // A dropped value as {type, value-text}. The grid sends text plus a type; a raw
  // canonical EJSON value ({"$numberLong": …}, {"$date": …}) is understood as well.
  function dropValue(f) {
    let { type, value: v } = f;
    if (v === null) return { type: 'null' };
    if (typeof v === 'number') return { type: 'number', value: String(v) };
    if (typeof v === 'boolean') return { type: 'boolean', value: String(v) };
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('$numberInt' in v) return { type: 'number', value: v.$numberInt };
      if ('$numberDouble' in v) return { type: 'number', value: v.$numberDouble };
      if ('$numberLong' in v) return { type: 'long', value: v.$numberLong };
      if ('$numberDecimal' in v) return { type: 'decimal', value: v.$numberDecimal };
      if ('$oid' in v) return { type: 'objectId', value: v.$oid };
      if ('$date' in v) {
        const d = v.$date;
        const ms = d && typeof d === 'object' ? Number(d.$numberLong) : new Date(d).getTime();
        return Number.isFinite(ms) ? { type: 'date', value: new Date(ms).toISOString() } : { type: 'date' };
      }
      return { type: type || 'object' };
    }
    if (v === undefined) return { type };
    v = String(v);
    if (type === 'date') {
      // Zone-less text: cut from toISOString() it is UTC; with milliseconds it is the
      // inline editor's local wall time, which new Date() already reads as local.
      if (!/(Z|[+-]\d\d:?\d\d)$/.test(v) && /T\d\d:\d\d(:\d\d)?$/.test(v)) v += 'Z';
      const { ms, span } = dateSpan(v);
      if (!Number.isFinite(ms)) return { type };
      const iso = new Date(ms).toISOString();
      v = span === 0 ? iso : (span === 1000 ? iso.slice(0, 19) : iso.slice(0, 16)) + 'Z';
    }
    return { type, value: v };
  }

  // Build a condition from a drop payload; cells dragged from the data grid
  // carry a value, so the condition arrives prefilled as "field equals value".
  function condFrom(f) {
    const { type, value } = dropValue(f);
    const ops = opsFor(type);
    const hasVal = value !== undefined && ops.includes('equals');
    // nothing to compare an array or sub-document with: start from "exists"
    const op = hasVal || type === 'null' ? 'equals' : (ops.includes('exists') ? 'exists' : ops[0]);
    return { path: f.path, type: OPS[type] ? type : 'string', op, value: hasVal ? value : '' };
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
  const projWarn = el('div', 'qb-hint qb-warn');
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
      if (cond.op === 'exists' || cond.op === 'not exists' || cond.type === 'null') return;
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
      if (cond.type === 'date') {
        // local wall time in the picker, the exact instant (to the ms) in cond.value
        inp.type = 'datetime-local';
        inp.step = '0.001';
        inp.value = dateToInput(cond.value);
        inp.title = 'Local time. To the minute or second, "equals" matches that whole minute/second.';
        inp.addEventListener('input', () => { cond.value = inputToDate(inp.value); update(); });
        valSlot.appendChild(inp);
        return;
      }
      // text, not type=number: a number input rounds long/decimal digits and drops NaN
      inp.type = 'text';
      if (cond.type === 'number' || cond.type === 'decimal') inp.inputMode = 'decimal';
      else if (cond.type === 'long') inp.inputMode = 'numeric';
      else if (cond.type === 'objectId') inp.placeholder = 'hex id';
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
    // update() runs after every edit, so it doubles as the autosave point
    if (App.state.collection) App.memSet('qb', { groups, topOp, sortItems, projItems });
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
    // field paths belong to the collection, so the builder is restored per collection
    const s = App.memGet('qb') || {};
    groups = s.groups || [];
    topOp = s.topOp || '$and';
    sortItems = s.sortItems || [];
    projItems = s.projItems || [];
    topOpSel.value = topOp;
    renderGroups(); renderSort(); renderProj(); update();
  });

  renderGroups(); renderSort(); renderProj(); update();
})();
