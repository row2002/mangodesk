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
        <textarea id="q-filter" class="mono" spellcheck="false" rows="1" placeholder="{}"></textarea>
        <button id="q-history-btn" title="Recent queries">⌄</button>
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
      <button data-rtab="explain">Explain</button>
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
        <button id="grid-expand" title="Expand / collapse all documents">⊞ Expand all</button>
        <label id="grid-selall-wrap" title="Select every document on this page">
          <input type="checkbox" id="grid-selall"> all
        </label>
        <span id="sel-info" class="muted"></span>
        <button id="sel-delete" class="danger" hidden>Delete selected</button>
        <button id="sel-clear" hidden>Clear</button>
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
    </div>
    <div id="rtab-explain" hidden>
      <div id="explain-summary"></div>
      <div class="panel-title">Indexes</div>
      <pre id="explain-indexes"></pre>
      <div class="panel-title">Query planner</div>
      <pre id="explain-plan"></pre>
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
    cols: new Set(), // table columns seen so far in this query — keeps them from jumping
    sel: new Set(),  // selected _id JSON, cleared on every load — selection is per page
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

  const runBtn = document.getElementById('q-run');
  const refreshBtn = document.getElementById('grid-refresh');
  const insertBtn = document.getElementById('grid-insert');

  // The pager's own enabled state is owned by render()/showHint(), which run right
  // after — so busy only has to switch it off, never back on.
  function setBusy(on) {
    body.classList.toggle('busy', on);
    runBtn.disabled = refreshBtn.disabled = insertBtn.disabled = on;
    if (on) { selInfo.textContent = ''; selDelete.hidden = selClear.hidden = true; }
    if (!on) return;
    firstBtn.disabled = prevBtn.disabled = nextBtn.disabled = lastBtn.disabled = true;
    pageInfo.textContent = 'Loading…';
  }

  async function load() {
    const { connectionId, db, collection } = App.state;
    if (!collection) { showHint('Select a collection in the tree to browse its documents.'); return; }
    g.sel.clear(); // selection is per page — a new result set invalidates it
    setBusy(true);
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
      // drop the stale rows — leaving them next to an error reads as a successful query
      g.docs = [];
      errBox.textContent = e.message;
      showHint('Query failed — see the error above.');
    } finally {
      setBusy(false);
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
    renderSelBar();
  }

  /* ---- mongo-shell syntax in the query bar ---- */

  // What people actually paste from Compass / Studio 3T / logs: unquoted keys,
  // single quotes, ObjectId("…"), ISODate(…), /re/i, trailing commas. The server
  // API stays strict EJSON — the text is normalised here before it is sent.
  const SHELL = {
    ObjectId: (v) => ({ $oid: String(v) }),
    ISODate: (v) => new Date(v === undefined ? Date.now() : v),
    NumberLong: (v) => ({ $numberLong: String(v) }),
    NumberInt: (v) => ({ $numberInt: String(v) }),
    NumberDouble: (v) => ({ $numberDouble: String(v) }),
    NumberDecimal: (v) => ({ $numberDecimal: String(v) }),
    UUID: (v) => ({ $uuid: String(v) }),
    BinData: (t, v) => ({ $binary: { base64: String(v), subType: Number(t).toString(16).padStart(2, '0') } }),
    MinKey: () => ({ $minKey: 1 }),
    MaxKey: () => ({ $maxKey: 1 }),
  };
  SHELL.ObjectID = SHELL.ObjectId;
  SHELL.Date = SHELL.ISODate;
  const SHELL_NAMES = Object.keys(SHELL);

  // Date/RegExp have to be read off the holder: their own toJSON runs first.
  function ejsonReplacer(k, v) {
    const raw = this[k];
    if (raw instanceof RegExp) return { $regex: raw.source, $options: raw.flags };
    if (raw instanceof Date) return { $date: raw.toISOString() };
    return v;
  }

  // Returns strict EJSON text ('' for empty input); throws with a readable message.
  function toEjsonText(text, label) {
    const t = (text || '').trim();
    if (!t) return '';
    try { JSON.parse(t); return t; } catch { /* not strict JSON — try shell syntax */ }
    let value;
    try {
      // eslint-disable-next-line no-new-func -- the user's own expression, in their own tab
      value = new Function(...SHELL_NAMES, '"use strict"; return (' + t + ');')(
        ...SHELL_NAMES.map((n) => SHELL[n]));
    } catch (e) {
      throw new Error(label + ': ' + e.message);
    }
    if (value === null || typeof value !== 'object') throw new Error(label + ' must be an object');
    return JSON.stringify(value, ejsonReplacer);
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
      // Dragging selected text inside the inline editor bubbles up here — leave that
      // drag alone, otherwise the QB payload replaces the text being moved.
      if (e.target.classList && e.target.classList.contains('cell-edit')) return;
      e.stopPropagation();
      e.dataTransfer.setData('text/plain', JSON.stringify(dragPayload(path, getValue())));
    });
  }

  /* ---- field names: single click acts, double click selects the name ---- */

  // Header sort / tree expand fire on single click only; the action is deferred so a
  // double click can cancel it and hand the name over to the selection instead.
  function clickOrSelectName(node, labelEl, onClick) {
    let timer = null;
    node.addEventListener('click', () => {
      clearTimeout(timer);
      timer = setTimeout(onClick, 200);
    });
    node.addEventListener('dblclick', (e) => {
      clearTimeout(timer);
      e.stopPropagation();
      getSelection().selectAllChildren(labelEl);
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

  // EJSON scalar wrappers the inline editor unwraps and re-wraps ($date has its own picker)
  const WRAPPERS = ['$oid', '$numberInt', '$numberLong', '$numberDouble', '$numberDecimal'];

  function startCellEdit(td, doc, path, rerender) {
    if (td.querySelector('input, select')) return;
    if (!hasId(doc)) return;
    const cur = getPathVal(doc, path);
    td.textContent = '';
    td.className = '';
    td.title = '';
    let inp, getVal, saveOnChange = false;
    if (typeof cur === 'boolean') {
      inp = document.createElement('select');
      inp.className = 'cell-edit';
      for (const v of ['true', 'false']) {
        const o = document.createElement('option');
        o.value = o.textContent = v;
        inp.appendChild(o);
      }
      inp.value = String(cur);
      getVal = () => inp.value === 'true';
      saveOnChange = true; // picking an option is the whole edit
    } else if (cur !== null && typeof cur === 'object' && cur.$date !== undefined) {
      inp = document.createElement('input');
      inp.type = 'datetime-local';
      inp.step = '0.001'; // keep seconds/milliseconds editable
      inp.className = 'cell-edit';
      const d = typeof cur.$date === 'object'
        ? new Date(Number(cur.$date.$numberLong)) : new Date(cur.$date);
      // datetime-local is local time; shift so the shown value matches the stored instant
      if (!isNaN(d.getTime())) {
        inp.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 23);
      }
      getVal = () => {
        const ms = new Date(inp.value).getTime();
        return Number.isFinite(ms) ? { $date: { $numberLong: String(ms) } } : undefined;
      };
    } else {
      inp = document.createElement('input');
      inp.className = 'cell-edit mono';
      // Edit the bare value, not its EJSON wrapper ({"$oid":…}) or JSON quoting,
      // and put the original shape back on save so the BSON type survives the edit.
      const wrapKey = cur !== null && typeof cur === 'object'
        && WRAPPERS.find((w) => cur[w] !== undefined);
      if (wrapKey) {
        inp.value = String(cur[wrapKey]);
        getVal = () => {
          const text = inp.value.trim();
          if (wrapKey === '$oid' && !/^[0-9a-f]{24}$/i.test(text)) {
            errBox.textContent = 'Not a valid ObjectId: ' + text;
            return undefined;
          }
          return { [wrapKey]: text };
        };
      } else if (typeof cur === 'string') {
        inp.value = cur;
        getVal = () => inp.value; // a string stays a string — no quotes to type
      } else {
        inp.value = cur === undefined ? '' : JSON.stringify(cur);
        getVal = () => {
          const text = inp.value.trim();
          try { return JSON.parse(text); } catch { return text; } // bare text becomes a string
        };
      }
    }
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (!save) { rerender(); return; }
      const val = getVal();
      if (val === undefined) { rerender(); return; } // unparsable date — discard the edit
      // snapshot before the write; _id is captured too in case the edit changes it
      const id = JSON.stringify(doc._id);
      const before = JSON.stringify(doc);
      setPathVal(doc, path, val);
      App.api('/api/doc', { method: 'PUT', body: { ...target(), id, doc: JSON.stringify(doc) } })
        .then(() => {
          errBox.textContent = '';
          App.toast('Saved', false, () => revertDoc(id, before));
          rerender();
        })
        .catch((e) => { errBox.textContent = e.message; rerender(); });
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    if (saveOnChange) inp.addEventListener('change', () => finish(true));
    inp.addEventListener('blur', () => finish(false));
    td.appendChild(inp);
    inp.focus();
    if (inp.select) inp.select();
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
    // accumulate across pages of the same query, otherwise columns appear and vanish
    // as you page through documents with different shapes
    g.docs.forEach((d) => Object.keys(d).forEach((k) => g.cols.add(k)));
    const keys = [...g.cols];
    const idIdx = keys.indexOf('_id');
    if (idIdx > 0) { keys.splice(idIdx, 1); keys.unshift('_id'); }

    const table = document.createElement('table');
    table.className = 'data-table';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    keys.forEach((k) => {
      const th = document.createElement('th');
      th.dataset.col = k;
      const name = document.createElement('span');
      name.textContent = k;
      th.append(name, g.sortField === k ? (g.sortDir === 1 ? ' ▲' : ' ▼') : '');
      th.title = 'Sort by ' + k + ' — double-click to select the name';
      clickOrSelectName(th, name, () => cycleSort(k));
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
      tr._doc = doc;
      keys.forEach((k) => {
        const td = document.createElement('td');
        td._path = k;
        renderCell(td, doc[k]);
        makeDraggable(td, k, () => doc[k]);
        td.addEventListener('dblclick', () =>
          startCellEdit(td, doc, k, () => renderCell(td, doc[k])));
        tr.appendChild(td);
      });
      const td = document.createElement('td');
      td.className = 'row-actions';
      td.append(...actionNodes(doc));
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

  /* ---- row selection ---- */

  const selInfo = document.getElementById('sel-info');
  const selDelete = document.getElementById('sel-delete');
  const selClear = document.getElementById('sel-clear');
  const selAll = document.getElementById('grid-selall');

  const selKey = (doc) => (doc._id === undefined ? null : JSON.stringify(doc._id));

  function renderSelBar() {
    const n = g.sel.size;
    selInfo.textContent = n ? n + ' selected' : '';
    selDelete.hidden = selClear.hidden = !n;
    selAll.checked = n > 0 && g.docs.every((d) => g.sel.has(selKey(d)));
  }

  // The checkbox rides along with Edit/Del instead of claiming its own column, so
  // table rows, tree rows and JSON cards all get selection from one place.
  function actionNodes(doc) {
    const nodes = [];
    const key = selKey(doc);
    if (key) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'row-check';
      cb.title = 'Select document';
      cb.checked = g.sel.has(key);
      cb.addEventListener('change', () => {
        if (cb.checked) g.sel.add(key); else g.sel.delete(key);
        renderSelBar();
      });
      nodes.push(cb);
    }
    nodes.push(actionBtn('Edit', () => editDoc(doc)), actionBtn('Del', () => deleteDoc(doc), true));
    return nodes;
  }

  selAll.addEventListener('change', () => {
    g.docs.forEach((d) => {
      const key = selKey(d);
      if (!key) return;
      if (selAll.checked) g.sel.add(key); else g.sel.delete(key);
    });
    render();
  });

  selClear.addEventListener('click', () => { g.sel.clear(); render(); });

  selDelete.addEventListener('click', async () => {
    const ids = [...g.sel];
    if (!await App.confirm(`Delete ${ids.length} document${ids.length === 1 ? '' : 's'}?`)) return;
    try {
      const r = await App.api('/api/docs/delete', { method: 'POST', body: { ...target(), ids } });
      App.toast('Deleted ' + r.deletedCount);
      g.needCount = true;
      load();
    } catch (e) {
      errBox.textContent = e.message;
    }
  });

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
    tr._doc = rootDoc;
    tr._path = path;
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

    const toggle = () => {
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
    };
    if (container) tdKey.classList.add('expandable');
    clickOrSelectName(tdKey, keyLabel, container ? toggle : () => {});
    return { tr, toggle };
  }

  // Top-level document rows of the current tree render — Expand all works on these only;
  // recursing into every nested field would blow the row count up for no real gain.
  let rootRows = [];

  function renderTree() {
    expandBtn.textContent = '⊞ Expand all';
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

    rootRows = [];
    g.docs.forEach((doc) => {
      const root = treeRow(idLabel(doc), doc, 0, '', doc);
      const tdActions = document.createElement('td');
      tdActions.className = 'row-actions';
      tdActions.append(...actionNodes(doc));
      root.tr.appendChild(tdActions);
      tbody.appendChild(root.tr);
      rootRows.push(root);
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
      box._doc = doc;
      const pre = document.createElement('pre');
      pre.textContent = JSON.stringify(doc, null, 2);
      const actions = document.createElement('div');
      actions.className = 'json-doc-actions';
      actions.append(...actionNodes(doc));
      box.append(pre, actions);
      body.appendChild(box);
    });
  }

  /* ---- modal ---- */

  // native <dialog>: Esc, focus trap, backdrop and focus restore for free
  const modal = document.createElement('dialog');
  modal.id = 'doc-modal';
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
  const cancelBtn = actionBtn('Cancel', () => modal.close());
  const saveBtn = actionBtn('Save', onSaveClick);
  saveBtn.className = 'primary';
  const modalHint = document.createElement('span');
  modalHint.className = 'muted modal-hint';
  modalHint.textContent = 'Ctrl+Enter to save';
  modalActions.append(modalHint, cancelBtn, saveBtn);
  modalBox.append(modalTitle, modalText, modalErr, modalActions);
  modal.appendChild(modalBox);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.close(); });
  document.body.appendChild(modal);

  let modalSave = null;
  let modalUndo = null;

  // Validate while typing so a stray comma is visible before Save is pressed.
  function validateModal() {
    let err = '';
    try { JSON.parse(modalText.value); } catch (e) { err = e.message; }
    modalErr.textContent = err;
    saveBtn.disabled = !!err;
  }
  modalText.addEventListener('input', validateModal);
  modalText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSaveClick(); }
  });

  function openModal(title, text, onSave, onUndo) {
    modalTitle.textContent = title;
    modalText.value = text;
    modalSave = onSave;
    modalUndo = onUndo || null;
    validateModal();
    modal.showModal();
    modalText.focus();
  }

  async function onSaveClick() {
    if (saveBtn.disabled) return;
    saveBtn.disabled = true;
    try {
      await modalSave(modalText.value);
      modal.close();
      App.toast('Saved', false, modalUndo);
      g.needCount = true;
      load();
    } catch (e) {
      modalErr.textContent = e.message;
    } finally {
      saveBtn.disabled = false;
    }
  }

  /* ---- CRUD ---- */

  function target() {
    const { connectionId, db, collection } = App.state;
    return { connectionId, db, collection };
  }

  // Every write matches on _id, so a projection that drops it makes the row read-only.
  function hasId(doc) {
    if (doc._id !== undefined) return true;
    errBox.textContent = 'Document has no _id (excluded by the projection?) — it cannot be edited or deleted here.';
    return false;
  }

  // Put a snapshot back. Deletes are not undoable this way — the document is gone,
  // so only edits offer Undo.
  function revertDoc(id, docText) {
    App.api('/api/doc', { method: 'PUT', body: { ...target(), id, doc: docText } })
      .then(() => { App.toast('Reverted'); load(); })
      .catch((e) => { errBox.textContent = e.message; });
  }

  function editDoc(doc) {
    if (!hasId(doc)) return;
    const id = JSON.stringify(doc._id);
    const before = JSON.stringify(doc);
    openModal('Edit document', JSON.stringify(doc, null, 2),
      (text) => App.api('/api/doc', { method: 'PUT', body: { ...target(), id, doc: text } }),
      () => revertDoc(id, before));
  }

  function insertDoc() {
    openModal('Insert document', '{}', (text) =>
      App.api('/api/doc', { method: 'POST', body: { ...target(), doc: text } }));
  }

  async function deleteDoc(doc) {
    if (!hasId(doc)) return;
    if (!await App.confirm('Delete this document?')) return;
    try {
      await App.api('/api/doc', {
        method: 'DELETE',
        body: { ...target(), id: JSON.stringify(doc._id) },
      });
      App.toast('Document deleted');
      g.needCount = true;
      load();
    } catch (e) {
      errBox.textContent = e.message;
    }
  }

  /* ---- query bar + toolbar wiring ---- */

  function run() {
    try {
      g.filter = toEjsonText(filterInput.value, 'Query');
      g.projection = toEjsonText(projInput.value, 'Projection');
      g.sort = toEjsonText(sortInput.value, 'Sort');
    } catch (e) {
      errBox.textContent = e.message;
      return;
    }
    g.userSkip = Math.max(0, parseInt(skipInput.value, 10) || 0);
    g.userLimit = Math.max(0, parseInt(limitInput.value, 10) || 0);
    g.sortField = null; // manual Sort text overrides column-cycle state
    g.page = 0;
    g.needCount = true;
    g.cols.clear();
    rememberQuery(filterInput.value.trim());
    // remember the query bar per collection, so switching away and back keeps it
    App.memSet('query', {
      filter: filterInput.value,
      projection: projInput.value,
      sort: sortInput.value,
      skip: skipInput.value,
      limit: limitInput.value,
    });
    load();
  }

  /* ---- recent queries ---- */

  // A textarea can't carry a <datalist>, so history is a small popup instead —
  // which also shows the whole query rather than one truncated line.
  const HIST_KEY = 'mangodesk.queryHistory';
  const histBtn = document.getElementById('q-history-btn');

  const readHistory = () => {
    try { return JSON.parse(localStorage.getItem(HIST_KEY)) || []; } catch { return []; }
  };

  function rememberQuery(text) {
    if (!text || text === '{}') return;
    const items = [text, ...readHistory().filter((q) => q !== text)];
    localStorage.setItem(HIST_KEY, JSON.stringify(items.slice(0, 20)));
  }

  histBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeCtx();
    const items = readHistory();
    if (!items.length) { App.toast('No queries yet'); return; }
    const menu = document.createElement('div');
    menu.className = 'ctx-menu q-history-menu';
    for (const q of items) {
      const b = document.createElement('button');
      b.className = 'mono';
      b.textContent = q;
      b.title = q;
      b.addEventListener('click', () => { filterInput.value = q; autoGrow(); run(); });
      menu.appendChild(b);
    }
    const r = histBtn.getBoundingClientRect();
    menu.style.left = Math.max(4, r.right - 420) + 'px';
    menu.style.top = r.bottom + 2 + 'px';
    document.body.appendChild(menu);
    ctxMenu = menu;
  });

  /* ---- multi-line query field ---- */

  function autoGrow() {
    filterInput.style.height = 'auto';
    filterInput.style.height = Math.min(filterInput.scrollHeight, 160) + 'px';
  }
  filterInput.addEventListener('input', autoGrow);

  document.getElementById('q-run').addEventListener('click', run);
  [projInput, sortInput, skipInput, limitInput].forEach((i) =>
    i.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); }));
  // textarea: Enter runs, Shift+Enter inserts the newline
  filterInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run(); }
  });

  document.querySelectorAll('#result-tabs button').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('#result-tabs button')
        .forEach((x) => x.classList.toggle('active', x === b));
      const tab = b.dataset.rtab;
      for (const name of ['result', 'code', 'explain']) {
        document.getElementById('rtab-' + name).hidden = tab !== name;
      }
      if (tab === 'code') renderCode();
      if (tab === 'explain') loadExplain();
    }));

  /* ---- Explain tab ---- */

  const explainSummary = document.getElementById('explain-summary');
  const explainIndexes = document.getElementById('explain-indexes');
  const explainPlan = document.getElementById('explain-plan');

  // Walk the winning plan for the stage names — COLLSCAN is the one worth shouting about.
  function planStages(stage, out = []) {
    if (!stage || typeof stage !== 'object') return out;
    if (stage.stage) out.push(stage.stage);
    if (stage.inputStage) planStages(stage.inputStage, out);
    (stage.inputStages || []).forEach((s) => planStages(s, out));
    return out;
  }

  async function loadExplain() {
    const { connectionId, db, collection } = App.state;
    if (!collection) { explainSummary.textContent = 'Select a collection first.'; return; }
    explainSummary.textContent = 'Explaining…';
    explainIndexes.textContent = explainPlan.textContent = '';
    try {
      const res = await App.api('/api/explain', {
        method: 'POST',
        body: { connectionId, db, collection, filter: g.filter, sort: g.sort, projection: g.projection },
      });
      const winning = (res.plan.queryPlanner || {}).winningPlan;
      const stages = planStages(winning);
      const index = (winning && winning.inputStage && winning.inputStage.indexName)
        || (winning && winning.indexName);
      const scan = stages.includes('COLLSCAN');
      explainSummary.className = scan ? 'explain-warn' : 'explain-ok';
      explainSummary.textContent = scan
        ? 'COLLSCAN — every document is read. Add an index on the filtered/sorted fields.'
        : `Index scan${index ? ' using "' + index + '"' : ''} — ${stages.join(' → ')}`;
      explainIndexes.textContent = res.indexes
        .map((i) => `${i.name}: ${JSON.stringify(i.key)}${i.unique ? ' (unique)' : ''}`).join('\n');
      explainPlan.textContent = JSON.stringify(winning || res.plan, null, 2);
    } catch (e) {
      explainSummary.className = 'explain-warn';
      explainSummary.textContent = e.message;
    }
  }

  document.getElementById('code-copy').addEventListener('click', () =>
    navigator.clipboard.writeText(codeEl.textContent));

  document.getElementById('grid-refresh').addEventListener('click', () => { g.needCount = true; load(); });
  document.getElementById('grid-insert').addEventListener('click', insertDoc);

  const expandBtn = document.getElementById('grid-expand');
  expandBtn.addEventListener('click', () => {
    const collapsed = rootRows.filter((r) => !r.tr._children);
    const targets = collapsed.length ? collapsed : rootRows;
    targets.forEach((r) => r.toggle());
    expandBtn.textContent = collapsed.length ? '⊟ Collapse all' : '⊞ Expand all';
  });

  const viewSel = document.getElementById('grid-viewsel');
  viewSel.value = g.view;
  document.getElementById('grid-pagesize').value = String(g.pageSize);

  function syncView() {
    expandBtn.hidden = g.view !== 'tree';
    expandBtn.textContent = '⊞ Expand all';
  }
  syncView();

  viewSel.addEventListener('change', (e) => {
    g.view = e.target.value;
    localStorage.setItem('mangodesk.view', g.view);
    syncView();
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

  /* ---- context menu ---- */

  // Flat text for a cell: the same unwrapping renderCell does, without truncation,
  // so "Copy value" yields the hex id / raw string rather than its EJSON wrapper.
  function plainValue(v) {
    if (v === undefined) return '';
    if (v === null) return 'null';
    if (typeof v !== 'object') return String(v);
    const w = WRAPPERS.find((k) => v[k] !== undefined);
    if (w) return String(v[w]);
    if (v.$date !== undefined) return fmtDate(v.$date);
    return JSON.stringify(v, null, 2);
  }

  const copy = (text) => navigator.clipboard.writeText(text)
    .then(() => App.toast('Copied'), (e) => App.toast(e.message, true));

  let ctxMenu = null;
  const closeCtx = () => { if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; } };
  document.addEventListener('click', closeCtx);
  window.addEventListener('blur', closeCtx);

  body.addEventListener('contextmenu', (e) => {
    const cell = e.target.closest('td, .json-doc');
    const row = cell && cell.closest('tr');
    const doc = (row && row._doc) || (cell && cell._doc);
    if (!doc) return; // header or empty space — leave the browser menu alone
    const path = (cell && cell._path) || (row && row._path);
    e.preventDefault();
    closeCtx();

    const items = [];
    if (path) {
      items.push(['Copy value', () => copy(plainValue(getPathVal(doc, path)))]);
      items.push(['Copy field name', () => copy(path)]);
    }
    items.push(['Copy document JSON', () => copy(JSON.stringify(doc, null, 2))]);
    items.push(null);
    items.push(['Edit document…', () => editDoc(doc)]);
    items.push(['Delete document…', () => deleteDoc(doc)]);

    ctxMenu = document.createElement('div');
    ctxMenu.className = 'ctx-menu';
    for (const item of items) {
      if (!item) { ctxMenu.appendChild(document.createElement('hr')); continue; }
      const [label, fn] = item;
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', fn);
      ctxMenu.appendChild(b);
    }
    ctxMenu.style.left = e.clientX + 'px';
    ctxMenu.style.top = e.clientY + 'px';
    document.body.appendChild(ctxMenu);
    // keep it on screen when the click lands near the right/bottom edge
    const r = ctxMenu.getBoundingClientRect();
    if (r.right > innerWidth) ctxMenu.style.left = Math.max(0, innerWidth - r.width - 4) + 'px';
    if (r.bottom > innerHeight) ctxMenu.style.top = Math.max(0, innerHeight - r.height - 4) + 'px';
  });

  /* ---- keyboard shortcuts ---- */

  runBtn.title = 'Run query (Ctrl+Enter)';
  prevBtn.title = 'Previous page (Alt+←)';
  nextBtn.title = 'Next page (Alt+→)';

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCtx();
    // dialogs own the keyboard while they are open (Esc, Ctrl+Enter to save)
    if (document.querySelector('dialog[open]')) return;
    if (!document.getElementById('tab-data').classList.contains('active')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 'Enter') { e.preventDefault(); run(); return; }
    if (mod && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      filterInput.focus();
      filterInput.select();
      return;
    }
    if (!e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === 'ArrowLeft' && !prevBtn.disabled) { e.preventDefault(); prevBtn.click(); }
    else if (e.key === 'ArrowRight' && !nextBtn.disabled) { e.preventDefault(); nextBtn.click(); }
  });

  /* ---- events ---- */

  App.on('target', () => {
    const saved = App.memGet('query') || {};
    filterInput.value = saved.filter || '';
    projInput.value = saved.projection || '';
    sortInput.value = saved.sort || '';
    skipInput.value = saved.skip || '';
    limitInput.value = saved.limit || '';
    autoGrow();
    errBox.textContent = '';
    run(); // parses the restored text and loads the first page
  });

  App.on('query', ({ filter, sort, projection }) => {
    filterInput.value = filter || '';
    sortInput.value = sort && sort !== '{}' ? sort : '';
    projInput.value = projection && projection !== '{}' ? projection : '';
    run();
  });
})();
