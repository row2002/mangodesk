// Database/collection tree + data grid with pagination and document CRUD.
(() => {
  'use strict';

  /* ================= TREE (databases under each connection node) ================= */

  function treeHintEl(msg, isError) {
    const hint = document.createElement('div');
    hint.className = 'tree-coll ' + (isError ? 'tree-error' : 'muted');
    hint.textContent = msg;
    return hint;
  }

  async function loadTreeInto(connId, container) {
    container.textContent = '';
    container.appendChild(treeHintEl('loading…'));
    let dbs;
    try {
      dbs = await App.api(`/api/connections/${encodeURIComponent(connId)}/databases`);
    } catch (e) {
      container.textContent = '';
      container.appendChild(treeHintEl(e.message, true));
      return;
    }
    container.textContent = '';
    if (!dbs.length) container.appendChild(treeHintEl('(no databases)'));
    dbs.forEach((dbName) => {
      const node = dbNode(connId, dbName);
      container.appendChild(node);
      // auto-open the active db so the current collection is visible in the tree
      if (connId === App.state.connectionId && dbName === App.state.db) {
        node.querySelector('.tree-db-head').click();
      }
    });
  }

  App.on('connection-expanded', ({ connectionId, container }) =>
    loadTreeInto(connectionId, container));

  function dbNode(connId, dbName) {
    const node = document.createElement('div');
    node.className = 'tree-db';
    const head = document.createElement('div');
    head.className = 'tree-db-head';
    const arrow = document.createElement('span');
    arrow.className = 'tree-arrow';
    arrow.textContent = '▸';
    const label = document.createElement('span');
    label.textContent = dbName;
    head.append(arrow, label);
    const children = document.createElement('div');
    children.hidden = true;
    let loaded = false;

    head.addEventListener('click', async () => {
      children.hidden = !children.hidden;
      arrow.textContent = children.hidden ? '▸' : '▾';
      if (loaded || children.hidden) return;
      loaded = true;
      const loading = document.createElement('div');
      loading.className = 'tree-coll muted';
      loading.textContent = 'loading…';
      children.appendChild(loading);
      try {
        const colls = await App.api(
          `/api/connections/${encodeURIComponent(connId)}/databases/${encodeURIComponent(dbName)}/collections`);
        children.textContent = '';
        if (!colls.length) {
          const empty = document.createElement('div');
          empty.className = 'tree-coll muted';
          empty.textContent = '(no collections)';
          children.appendChild(empty);
        }
        colls.forEach(({ name, count }) => {
          const row = document.createElement('div');
          row.className = 'tree-coll';
          const n = document.createElement('span');
          n.className = 'tree-coll-name';
          n.textContent = name;
          const c = document.createElement('span');
          c.className = 'tree-count muted';
          c.textContent = count;
          row.append(n, c);
          if (connId === App.state.connectionId && dbName === App.state.db
            && name === App.state.collection) row.classList.add('active');
          row.addEventListener('click', () => {
            document.querySelectorAll('#connections-panel .tree-coll.active')
              .forEach((el) => el.classList.remove('active'));
            row.classList.add('active');
            App.setTarget(connId, dbName, name);
          });
          children.appendChild(row);
        });
      } catch (e) {
        loaded = false;
        children.textContent = '';
        const err = document.createElement('div');
        err.className = 'tree-coll tree-error';
        err.textContent = e.message;
        children.appendChild(err);
      }
    });

    node.append(head, children);
    return node;
  }

  /* ================= DATA GRID ================= */

  const tab = document.getElementById('tab-data');
  // Static markup only — no data interpolated.
  tab.innerHTML = `
    <div id="query-bar">
      <div class="qbar-row">
        <label for="q-filter">Query</label>
        <input id="q-filter" class="mono" spellcheck="false" placeholder="{}">
        <button id="q-run" class="primary">▶ Run</button>
      </div>
      <div class="qbar-row">
        <label for="q-projection">Projection</label>
        <input id="q-projection" class="mono" spellcheck="false" placeholder="{}">
        <label for="q-sort">Sort</label>
        <input id="q-sort" class="mono" spellcheck="false" placeholder="{}">
      </div>
      <div class="qbar-row">
        <label for="q-skip">Skip</label>
        <input id="q-skip" class="mono qbar-num" type="number" min="0" placeholder="0">
        <label for="q-limit">Limit</label>
        <input id="q-limit" class="mono qbar-num" type="number" min="0" placeholder="no limit">
        <span class="qbar-spacer"></span>
      </div>
    </div>
    <nav id="result-tabs">
      <button data-rtab="result" class="active">Result</button>
      <button data-rtab="code">Query Code</button>
    </nav>
    <div id="grid-error"></div>
    <div id="rtab-result">
      <div id="grid-toolbar">
        <button id="grid-refresh" title="Refresh">⟳</button>
        <button id="grid-first" title="First page">|‹</button>
        <button id="grid-prev" title="Previous page">‹</button>
        <span id="grid-pageinfo" class="muted"></span>
        <button id="grid-next" title="Next page">›</button>
        <button id="grid-last" title="Last page">›|</button>
        <select id="grid-pagesize" title="Documents per page">
          <option value="25">25</option>
          <option value="50" selected>50</option>
          <option value="100">100</option>
        </select>
        <select id="grid-viewsel" title="Select view">
          <option value="tree" selected>Tree View</option>
          <option value="table">Table View</option>
          <option value="json">JSON View</option>
        </select>
        <button id="grid-insert">Insert</button>
      </div>
      <div id="grid-body"></div>
    </div>
    <div id="rtab-code" hidden>
      <pre id="query-code"></pre>
      <button id="code-copy">Copy</button>
    </div>`;

  const filterInput = document.getElementById('q-filter');
  const projInput = document.getElementById('q-projection');
  const sortInput = document.getElementById('q-sort');
  const skipInput = document.getElementById('q-skip');
  const limitInput = document.getElementById('q-limit');
  const errBox = document.getElementById('grid-error');
  const body = document.getElementById('grid-body');
  const pageInfo = document.getElementById('grid-pageinfo');
  const firstBtn = document.getElementById('grid-first');
  const prevBtn = document.getElementById('grid-prev');
  const nextBtn = document.getElementById('grid-next');
  const lastBtn = document.getElementById('grid-last');
  const codeEl = document.getElementById('query-code');

  const g = {
    filter: '', sort: '', projection: '',
    userSkip: 0, userLimit: 0, // Skip/Limit fields — the query window
    sortField: null, sortDir: 1,
    page: 0, pageSize: Number(localStorage.getItem('mangodesk.pageSize')) || 50,
    view: localStorage.getItem('mangodesk.view') || 'tree',
    docs: [], effTotal: 0,
    total: 0, needCount: true, // countDocuments once per query, reuse while paginating
  };

  function showHint(msg) {
    body.textContent = '';
    const hint = document.createElement('div');
    hint.className = 'grid-hint muted';
    hint.textContent = msg;
    body.appendChild(hint);
    pageInfo.textContent = '';
    firstBtn.disabled = prevBtn.disabled = nextBtn.disabled = lastBtn.disabled = true;
  }
  showHint('Select a collection in the tree to browse its documents.');

  async function load() {
    const { connectionId, db, collection } = App.state;
    if (!collection) { showHint('Select a collection in the tree to browse its documents.'); return; }
    // page within the user-defined Skip/Limit window
    const skip = g.userSkip + g.page * g.pageSize;
    let limit = g.pageSize;
    if (g.userLimit > 0) limit = Math.min(limit, Math.max(1, g.userLimit - g.page * g.pageSize));
    const params = { filter: g.filter, sort: g.sort, projection: g.projection, skip, limit };
    try {
      const res = await App.api('/api/query', {
        method: 'POST',
        body: { connectionId, db, collection, ...params, count: g.needCount },
      });
      if (res.total != null) { g.total = res.total; g.needCount = false; }
      const avail = Math.max(0, g.total - g.userSkip);
      g.effTotal = g.userLimit > 0 ? Math.min(avail, g.userLimit) : avail;
      if (g.page > 0 && g.page * g.pageSize >= g.effTotal && g.effTotal > 0) {
        // page fell off the end (e.g. last doc on page deleted) — clamp to last page
        g.page = Math.ceil(g.effTotal / g.pageSize) - 1;
        return load();
      }
      g.docs = res.docs.slice(0, Math.max(0, g.effTotal - g.page * g.pageSize));
      errBox.textContent = '';
      render();
      renderCode();
      // the user's query window (Skip/Limit fields), not this page's skip/limit
      App.emit('query-ran', { filter: g.filter, sort: g.sort, projection: g.projection,
        skip: g.userSkip, limit: g.userLimit });
    } catch (e) {
      errBox.textContent = e.message;
    }
  }

  function render() {
    const from = g.effTotal === 0 ? 0 : g.page * g.pageSize + 1;
    const to = g.page * g.pageSize + g.docs.length;
    pageInfo.textContent = g.effTotal === 0
      ? 'no documents' : `Documents ${from} to ${to} of ${g.effTotal}`;
    firstBtn.disabled = prevBtn.disabled = g.page === 0;
    nextBtn.disabled = lastBtn.disabled = to >= g.effTotal;
    body.textContent = '';
    if (!g.docs.length) { showHint('No documents match.'); return; }
    if (g.view === 'table') renderTable();
    else if (g.view === 'tree') renderTree();
    else renderJson();
  }

  /* ---- Query Code tab ---- */

  function renderCode() {
    const coll = App.state.collection;
    if (!coll) { codeEl.textContent = ''; return; }
    let s = 'db.getCollection(' + JSON.stringify(coll) + ').find(' + (g.filter || '{}');
    if (g.projection && g.projection !== '{}') s += ', ' + g.projection;
    s += ')';
    if (g.sort && g.sort !== '{}') s += '.sort(' + g.sort + ')';
    if (g.userSkip > 0) s += '.skip(' + g.userSkip + ')';
    if (g.userLimit > 0) s += '.limit(' + g.userLimit + ')';
    codeEl.textContent = s;
  }

  /* ---- cell rendering ---- */

  function fmtDate(d) {
    const dt = d && typeof d === 'object' ? new Date(Number(d.$numberLong)) : new Date(d);
    return isNaN(dt.getTime()) ? String(d) : dt.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
  }

  function renderCell(td, v) {
    let text, cls = '';
    if (v === undefined) text = '';
    else if (v === null) text = 'null';
    else if (Array.isArray(v)) text = '[' + v.length + ']';
    else if (typeof v === 'object') {
      if ('$oid' in v) { text = String(v.$oid); cls = 'cell-oid'; }
      else if ('$date' in v) { text = fmtDate(v.$date); cls = 'cell-date'; }
      else if ('$numberLong' in v) text = String(v.$numberLong);
      else if ('$numberDecimal' in v) text = String(v.$numberDecimal);
      else if ('$numberInt' in v) text = String(v.$numberInt);
      else if ('$numberDouble' in v) text = String(v.$numberDouble);
      else text = '{…}';
    } else text = String(v);
    td.textContent = text;
    if (cls) td.className = cls;
    if (v !== undefined) td.title = JSON.stringify(v, null, 2);
  }

  /* ---- drag payloads (Data → Query Builder) ---- */

  const QB_TYPE = {
    ObjectId: 'objectId', Date: 'date',
    Int32: 'number', Int64: 'number', Double: 'number', Decimal128: 'number',
    Boolean: 'boolean', String: 'string', Null: 'null', Array: 'array', Document: 'object',
  };

  function dragPayload(path, v) {
    const t = bsonType(v);
    const p = { path, type: QB_TYPE[t] || 'string' };
    if (t === 'ObjectId') p.value = v.$oid;
    else if (t === 'Date') {
      const d = v.$date && typeof v.$date === 'object'
        ? new Date(Number(v.$date.$numberLong)) : new Date(v.$date);
      if (!isNaN(d.getTime())) p.value = d.toISOString().slice(0, 16);
    } else if (t === 'Int32' || t === 'Double') {
      p.value = String(typeof v === 'number' ? v : (v.$numberInt !== undefined ? v.$numberInt : v.$numberDouble));
    } else if (t === 'Int64') p.value = String(v.$numberLong);
    else if (t === 'Decimal128') p.value = String(v.$numberDecimal);
    else if (t === 'Boolean') p.value = String(v);
    else if (t === 'String') p.value = v;
    return p; // null/array/document carry no value — QB adds a bare condition
  }

  function makeDraggable(node, path, getValue) {
    node.draggable = true;
    node.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      e.dataTransfer.setData('text/plain', JSON.stringify(dragPayload(path, getValue())));
    });
  }

  /* ---- inline value editing (dblclick) ---- */

  function getPathVal(obj, path) {
    let o = obj;
    for (const p of path.split('.')) o = o == null ? undefined : o[p];
    return o;
  }

  function setPathVal(obj, path, val) {
    const parts = path.split('.');
    let o = obj;
    for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
    o[parts[parts.length - 1]] = val;
  }

  function startCellEdit(td, doc, path, rerender) {
    if (td.querySelector('input')) return;
    const cur = getPathVal(doc, path);
    td.textContent = '';
    td.className = '';
    td.title = '';
    const inp = document.createElement('input');
    inp.className = 'cell-edit mono';
    // unwrap canonical number wrappers for friendlier editing; other EJSON stays as-is
    const numWrap = (cur !== null && typeof cur === 'object')
      ? (cur.$numberInt ?? cur.$numberLong ?? cur.$numberDouble ?? cur.$numberDecimal)
      : undefined;
    inp.value = cur === undefined ? '' : (numWrap !== undefined ? String(numWrap) : JSON.stringify(cur));
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (!save) { rerender(); return; }
      const text = inp.value.trim();
      let val;
      try { val = JSON.parse(text); } catch { val = text; } // bare text becomes a string
      setPathVal(doc, path, val);
      App.api('/api/doc', { method: 'PUT', body: { ...target(), id: JSON.stringify(doc._id), doc: JSON.stringify(doc) } })
        .then(() => { errBox.textContent = ''; rerender(); })
        .catch((e) => { errBox.textContent = e.message; rerender(); });
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    inp.addEventListener('blur', () => finish(false));
    td.appendChild(inp);
    inp.focus();
    inp.select();
  }

  /* ---- resizable columns (widths remembered per collection & view) ---- */

  function widthsKey() {
    const { connectionId, db, collection } = App.state;
    return `mangodesk.colw:${connectionId}:${db}:${collection}:${g.view}`;
  }

  function makeColumnsResizable(table) {
    const ths = table.querySelectorAll('thead th');
    // restore saved widths for this collection/view
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(widthsKey())) || {}; } catch { /* ignore */ }
    if (Object.keys(saved).length) {
      table.style.tableLayout = 'fixed';
      ths.forEach((t) => { if (saved[t.dataset.col]) t.style.width = saved[t.dataset.col] + 'px'; });
    }
    const persist = () => {
      const out = {};
      ths.forEach((t) => { out[t.dataset.col] = t.offsetWidth; });
      localStorage.setItem(widthsKey(), JSON.stringify(out));
    };
    ths.forEach((th) => {
      const grip = document.createElement('span');
      grip.className = 'col-resizer';
      grip.addEventListener('click', (e) => e.stopPropagation()); // don't trigger sort
      grip.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (table.style.tableLayout !== 'fixed') {
          // freeze current widths once, so resizing one column doesn't shift the rest
          ths.forEach((t) => { t.style.width = t.offsetWidth + 'px'; });
          table.style.tableLayout = 'fixed';
        }
        const startX = e.clientX;
        const startW = th.offsetWidth;
        const onMove = (ev) => { th.style.width = Math.max(40, startW + ev.clientX - startX) + 'px'; };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          persist();
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
      th.appendChild(grip);
    });
  }

  /* ---- table view ---- */

  function cycleSort(field) {
    if (g.sortField !== field) { g.sortField = field; g.sortDir = 1; }
    else if (g.sortDir === 1) g.sortDir = -1;
    else g.sortField = null;
    g.sort = g.sortField ? JSON.stringify({ [g.sortField]: g.sortDir }) : '';
    sortInput.value = g.sort; // keep the Sort field in sync with column clicks
    g.page = 0;
    load();
  }

  function renderTable() {
    const keys = [];
    g.docs.forEach((d) => Object.keys(d).forEach((k) => { if (!keys.includes(k)) keys.push(k); }));
    const idIdx = keys.indexOf('_id');
    if (idIdx > 0) { keys.splice(idIdx, 1); keys.unshift('_id'); }

    const table = document.createElement('table');
    table.className = 'data-table';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    keys.forEach((k) => {
      const th = document.createElement('th');
      th.dataset.col = k;
      th.textContent = k + (g.sortField === k ? (g.sortDir === 1 ? ' ▲' : ' ▼') : '');
      th.title = 'Sort by ' + k;
      th.addEventListener('click', () => cycleSort(k));
      hr.appendChild(th);
    });
    const thActions = document.createElement('th');
    thActions.className = 'th-actions';
    thActions.dataset.col = '__actions';
    hr.appendChild(thActions);
    thead.appendChild(hr);

    const tbody = document.createElement('tbody');
    g.docs.forEach((doc) => {
      const tr = document.createElement('tr');
      keys.forEach((k) => {
        const td = document.createElement('td');
        renderCell(td, doc[k]);
        makeDraggable(td, k, () => doc[k]);
        td.addEventListener('dblclick', () =>
          startCellEdit(td, doc, k, () => renderCell(td, doc[k])));
        tr.appendChild(td);
      });
      const td = document.createElement('td');
      td.className = 'row-actions';
      td.append(actionBtn('Edit', () => editDoc(doc)), actionBtn('Del', () => deleteDoc(doc), true));
      tr.appendChild(td);
      tbody.appendChild(tr);
    });

    table.append(thead, tbody);
    body.appendChild(table);
    makeColumnsResizable(table);
  }

  function actionBtn(label, onClick, danger) {
    const b = document.createElement('button');
    b.textContent = label;
    if (danger) b.className = 'danger';
    b.addEventListener('click', onClick);
    return b;
  }

  /* ---- tree view ---- */

  function bsonType(v) {
    if (v === null || v === undefined) return 'Null';
    if (Array.isArray(v)) return 'Array';
    if (typeof v === 'object') {
      if ('$oid' in v) return 'ObjectId';
      if ('$date' in v) return 'Date';
      if ('$numberLong' in v) return 'Int64';
      if ('$numberInt' in v) return 'Int32';
      if ('$numberDouble' in v) return 'Double';
      if ('$numberDecimal' in v) return 'Decimal128';
      return 'Document';
    }
    if (typeof v === 'number') return Number.isInteger(v) ? 'Int32' : 'Double';
    if (typeof v === 'boolean') return 'Boolean';
    return 'String';
  }

  const isContainer = (v) => {
    const t = bsonType(v);
    return t === 'Array' || t === 'Document';
  };

  function containerSummary(v) {
    return Array.isArray(v)
      ? `[ ${v.length} element${v.length === 1 ? '' : 's'} ]`
      : `{ ${Object.keys(v).length} field${Object.keys(v).length === 1 ? '' : 's'} }`;
  }

  function collapseTreeRow(tr) {
    (tr._children || []).forEach((c) => { collapseTreeRow(c); c.remove(); });
    tr._children = null;
  }

  function idLabel(doc) {
    const id = doc._id;
    if (id && typeof id === 'object' && '$oid' in id) return id.$oid;
    if (id === undefined || id === null) return '(no _id)';
    return typeof id === 'object' ? JSON.stringify(id) : String(id);
  }

  function treeRow(key, value, depth, path, rootDoc) {
    const tr = document.createElement('tr');
    tr.className = 'tree-row';
    const container = isContainer(value);

    const tdKey = document.createElement('td');
    tdKey.className = 'tree-key';
    tdKey.style.paddingLeft = 10 + depth * 18 + 'px';
    const arrow = document.createElement('span');
    arrow.className = 'tree-arrow';
    arrow.textContent = container ? '▸' : '';
    const keyLabel = document.createElement('span');
    keyLabel.textContent = key;
    tdKey.append(arrow, keyLabel);

    const tdVal = document.createElement('td');
    if (container) {
      tdVal.textContent = containerSummary(value);
      tdVal.className = 'tree-summary';
    } else {
      renderCell(tdVal, value);
    }

    const tdType = document.createElement('td');
    tdType.className = 'muted tree-type';
    tdType.textContent = bsonType(value);

    tr.append(tdKey, tdVal, tdType);

    if (path) {
      // any field row can be dragged into the Query Builder…
      makeDraggable(tr, path, () => getPathVal(rootDoc, path));
      // …and its value edited in place
      tdVal.addEventListener('dblclick', () =>
        startCellEdit(tdVal, rootDoc, path, () => {
          const v = getPathVal(rootDoc, path);
          if (isContainer(v)) { tdVal.className = 'tree-summary'; tdVal.textContent = containerSummary(v); }
          else renderCell(tdVal, v);
        }));
    }

    if (container) {
      tdKey.classList.add('expandable');
      tdKey.addEventListener('click', () => {
        if (tr._children) {
          collapseTreeRow(tr);
          arrow.textContent = '▸';
          return;
        }
        arrow.textContent = '▾';
        const entries = Array.isArray(value)
          ? value.map((v, i) => ({ label: '[' + i + ']', childPath: path ? path + '.' + i : String(i), v }))
          : Object.entries(value).map(([k, v]) => ({ label: k, childPath: path ? path + '.' + k : k, v }));
        tr._children = [];
        let anchor = tr;
        for (const { label, childPath, v } of entries) {
          const child = treeRow(label, v, depth + 1, childPath, rootDoc);
          anchor.after(child.tr);
          tr._children.push(child.tr);
          anchor = child.tr;
        }
      });
    }
    return { tr };
  }

  function renderTree() {
    const table = document.createElement('table');
    table.className = 'data-table tree-table';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const h of ['Key', 'Value', 'Type', '']) {
      const th = document.createElement('th');
      th.className = 'th-actions'; // not sortable
      th.dataset.col = h || '__actions';
      th.textContent = h;
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    const tbody = document.createElement('tbody');

    g.docs.forEach((doc) => {
      const { tr } = treeRow(idLabel(doc), doc, 0, '', doc);
      const tdActions = document.createElement('td');
      tdActions.className = 'row-actions';
      tdActions.append(actionBtn('Edit', () => editDoc(doc)), actionBtn('Del', () => deleteDoc(doc), true));
      tr.appendChild(tdActions);
      tbody.appendChild(tr);
    });

    table.append(thead, tbody);
    body.appendChild(table);
    makeColumnsResizable(table);
  }

  /* ---- JSON view ---- */

  function renderJson() {
    g.docs.forEach((doc) => {
      const box = document.createElement('div');
      box.className = 'json-doc';
      const pre = document.createElement('pre');
      pre.textContent = JSON.stringify(doc, null, 2);
      const actions = document.createElement('div');
      actions.className = 'json-doc-actions';
      actions.append(actionBtn('Edit', () => editDoc(doc)), actionBtn('Delete', () => deleteDoc(doc), true));
      box.append(pre, actions);
      body.appendChild(box);
    });
  }

  /* ---- modal ---- */

  const modal = document.createElement('div');
  modal.id = 'doc-modal';
  modal.hidden = true;
  const modalBox = document.createElement('div');
  modalBox.className = 'modal-box';
  const modalTitle = document.createElement('div');
  modalTitle.className = 'panel-title';
  const modalText = document.createElement('textarea');
  modalText.spellcheck = false;
  const modalErr = document.createElement('div');
  modalErr.className = 'modal-error';
  const modalActions = document.createElement('div');
  modalActions.className = 'modal-actions';
  const cancelBtn = actionBtn('Cancel', () => { modal.hidden = true; });
  const saveBtn = actionBtn('Save', onSaveClick);
  saveBtn.className = 'primary';
  modalActions.append(cancelBtn, saveBtn);
  modalBox.append(modalTitle, modalText, modalErr, modalActions);
  modal.appendChild(modalBox);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });
  document.body.appendChild(modal);

  let modalSave = null;

  function openModal(title, text, onSave) {
    modalTitle.textContent = title;
    modalText.value = text;
    modalErr.textContent = '';
    modalSave = onSave;
    modal.hidden = false;
    modalText.focus();
  }

  async function onSaveClick() {
    try {
      JSON.parse(modalText.value); // quick local syntax check
      await modalSave(modalText.value);
      modal.hidden = true;
      g.needCount = true;
      load();
    } catch (e) {
      modalErr.textContent = e.message;
    }
  }

  /* ---- CRUD ---- */

  function target() {
    const { connectionId, db, collection } = App.state;
    return { connectionId, db, collection };
  }

  function editDoc(doc) {
    openModal('Edit document', JSON.stringify(doc, null, 2), (text) =>
      App.api('/api/doc', { method: 'PUT', body: { ...target(), id: JSON.stringify(doc._id), doc: text } }));
  }

  function insertDoc() {
    openModal('Insert document', '{}', (text) =>
      App.api('/api/doc', { method: 'POST', body: { ...target(), doc: text } }));
  }

  async function deleteDoc(doc) {
    if (doc._id === undefined) { errBox.textContent = 'Document has no _id — cannot delete it from here.'; return; }
    if (!confirm('Delete this document?')) return;
    try {
      await App.api('/api/doc', {
        method: 'DELETE',
        body: { ...target(), id: JSON.stringify(doc._id) },
      });
      g.needCount = true;
      load();
    } catch (e) {
      errBox.textContent = e.message;
    }
  }

  /* ---- query bar + toolbar wiring ---- */

  function run() {
    g.filter = filterInput.value.trim();
    g.projection = projInput.value.trim();
    g.sort = sortInput.value.trim();
    g.userSkip = Math.max(0, parseInt(skipInput.value, 10) || 0);
    g.userLimit = Math.max(0, parseInt(limitInput.value, 10) || 0);
    g.sortField = null; // manual Sort text overrides column-cycle state
    g.page = 0;
    g.needCount = true;
    load();
  }

  document.getElementById('q-run').addEventListener('click', run);
  [filterInput, projInput, sortInput, skipInput, limitInput].forEach((i) =>
    i.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); }));

  document.querySelectorAll('#result-tabs button').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('#result-tabs button')
        .forEach((x) => x.classList.toggle('active', x === b));
      document.getElementById('rtab-result').hidden = b.dataset.rtab !== 'result';
      document.getElementById('rtab-code').hidden = b.dataset.rtab !== 'code';
      if (b.dataset.rtab === 'code') renderCode();
    }));

  document.getElementById('code-copy').addEventListener('click', () =>
    navigator.clipboard.writeText(codeEl.textContent));

  document.getElementById('grid-refresh').addEventListener('click', () => { g.needCount = true; load(); });
  document.getElementById('grid-insert').addEventListener('click', insertDoc);

  document.getElementById('grid-viewsel').value = g.view;
  document.getElementById('grid-pagesize').value = String(g.pageSize);

  document.getElementById('grid-viewsel').addEventListener('change', (e) => {
    g.view = e.target.value;
    localStorage.setItem('mangodesk.view', g.view);
    render();
  });

  document.getElementById('grid-pagesize').addEventListener('change', (e) => {
    g.pageSize = Number(e.target.value);
    localStorage.setItem('mangodesk.pageSize', String(g.pageSize));
    g.page = 0;
    load();
  });
  firstBtn.addEventListener('click', () => { g.page = 0; load(); });
  prevBtn.addEventListener('click', () => { if (g.page > 0) { g.page--; load(); } });
  nextBtn.addEventListener('click', () => { g.page++; load(); });
  lastBtn.addEventListener('click', () => {
    g.page = Math.max(0, Math.ceil(g.effTotal / g.pageSize) - 1);
    load();
  });

  /* ---- events ---- */

  App.on('target', () => {
    g.filter = g.sort = g.projection = '';
    g.userSkip = g.userLimit = 0;
    filterInput.value = projInput.value = sortInput.value = '';
    skipInput.value = limitInput.value = '';
    g.sortField = null;
    g.page = 0;
    g.needCount = true;
    errBox.textContent = '';
    load();
  });

  App.on('query', ({ filter, sort, projection }) => {
    filterInput.value = filter || '';
    sortInput.value = sort && sort !== '{}' ? sort : '';
    projInput.value = projection && projection !== '{}' ? projection : '';
    run();
  });
})();
