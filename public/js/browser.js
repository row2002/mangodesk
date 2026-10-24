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
    container.setAttribute('role', 'group');
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

  // Keyboard: the db heads and collection rows are treeitems. Enter/Space opens,
  // ↑/↓ walk the visible items, → expands a database and ← collapses it (or, on a
  // collection, jumps to its database).
  function treeItem(el, onActivate) {
    el.tabIndex = 0;
    el.setAttribute('role', 'treeitem');
    el.addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const items = [...document.querySelectorAll('#connections-panel [role="treeitem"]')]
        .filter((x) => x.offsetParent !== null);
      const next = items[items.indexOf(el) + (e.key === 'ArrowDown' ? 1 : -1)];
      if (next) next.focus();
    });
  }

  const fmtCount = (n) => (typeof n === 'number' ? n.toLocaleString() : String(n));

  // Counts go stale after every insert/delete — re-read them for that database.
  async function refreshCounts(connId, dbName) {
    const rows = [...document.querySelectorAll('#connections-panel .tree-coll[data-coll]')]
      .filter((r) => r.dataset.conn === connId && r.dataset.db === dbName);
    if (!rows.length) return;
    try {
      const colls = await App.api(
        `/api/connections/${encodeURIComponent(connId)}/databases/${encodeURIComponent(dbName)}/collections`);
      const counts = new Map(colls.map((c) => [c.name, c.count]));
      rows.forEach((r) => {
        if (counts.has(r.dataset.coll)) r.querySelector('.tree-count').textContent = fmtCount(counts.get(r.dataset.coll));
      });
    } catch { /* the tree keeps the old number; the grid shows the real error */ }
  }

  App.on('collection-changed', ({ connectionId, db }) => refreshCounts(connectionId, db));

  function dbNode(connId, dbName) {
    const node = document.createElement('div');
    node.className = 'tree-db';
    const head = document.createElement('div');
    head.className = 'tree-db-head';
    head.setAttribute('aria-expanded', 'false');
    treeItem(head, () => head.click());
    head.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' && children.hidden) { e.preventDefault(); head.click(); }
      if (e.key === 'ArrowLeft' && !children.hidden) { e.preventDefault(); head.click(); }
    });
    const arrow = document.createElement('span');
    arrow.className = 'tree-arrow';
    arrow.textContent = '▸';
    const label = document.createElement('span');
    label.textContent = dbName;
    head.append(arrow, label);
    const children = document.createElement('div');
    children.hidden = true;
    children.setAttribute('role', 'group');
    let loaded = false;

    head.addEventListener('click', async () => {
      children.hidden = !children.hidden;
      arrow.textContent = children.hidden ? '▸' : '▾';
      head.setAttribute('aria-expanded', String(!children.hidden));
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
          Object.assign(row.dataset, { conn: connId, db: dbName, coll: name });
          const n = document.createElement('span');
          n.className = 'tree-coll-name';
          n.textContent = name;
          const c = document.createElement('span');
          c.className = 'tree-count muted';
          c.textContent = fmtCount(count);
          row.append(n, c);
          if (connId === App.state.connectionId && dbName === App.state.db
            && name === App.state.collection) row.classList.add('active');
          row.addEventListener('click', () => {
            document.querySelectorAll('#connections-panel .tree-coll.active')
              .forEach((el) => el.classList.remove('active'));
            row.classList.add('active');
            App.setTarget(connId, dbName, name);
          });
          treeItem(row, () => row.click());
          row.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowLeft') { e.preventDefault(); head.focus(); }
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
    docs: [], effTotal: 0, more: false, // more: a next page may exist (only used when total is unknown)
    total: 0, needCount: true, // countDocuments once per query, reuse while paginating; null = can't count
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
    pageInfo.title = '';
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

  // Only the newest load() may render: a slow answer for the collection clicked
  // before would otherwise land under the current one, and edits would then send
  // its _ids to the wrong collection.
  let loadSeq = 0;
  let loadAbort = null;

  function cancelLoad() {
    loadSeq++;
    if (loadAbort) loadAbort.abort();
    loadAbort = null;
  }

  async function load() {
    const { connectionId, db, collection } = App.state;
    cancelLoad();
    const seq = loadSeq;
    if (!collection) {
      g.docs = [];
      g.sel.clear();
      rootRows = [];
      setBusy(false);
      renderSelBar();
      showHint('Select a collection in the tree to browse its documents.');
      return;
    }
    g.sel.clear(); // selection is per page — a new result set invalidates it
    setBusy(true);
    // page within the user-defined Skip/Limit window
    const skip = g.userSkip + g.page * g.pageSize;
    let limit = g.pageSize;
    if (g.userLimit > 0) limit = Math.min(limit, Math.max(1, g.userLimit - g.page * g.pageSize));
    const params = { filter: g.filter, sort: g.sort, projection: g.projection, skip, limit };
    const abort = loadAbort = new AbortController();
    try {
      const res = await App.api('/api/query', {
        method: 'POST',
        body: { connectionId, db, collection, ...params, count: g.needCount },
        signal: abort.signal,
      });
      if (seq !== loadSeq) return;
      // total null after asking means the server could not count ($near, $where):
      // keep it unknown rather than re-asking on every page
      if (g.needCount) { g.total = res.total; g.needCount = false; }
      if (g.total == null) {
        g.effTotal = null;
        g.more = res.docs.length >= limit && !(g.userLimit > 0 && skip + limit >= g.userSkip + g.userLimit);
        g.docs = res.docs;
      } else {
        const avail = Math.max(0, g.total - g.userSkip);
        g.effTotal = g.userLimit > 0 ? Math.min(avail, g.userLimit) : avail;
        if (g.page > 0 && g.page * g.pageSize >= g.effTotal && g.effTotal > 0) {
          // page fell off the end (e.g. last doc on page deleted) — clamp to last page
          g.page = Math.ceil(g.effTotal / g.pageSize) - 1;
          return load();
        }
        g.docs = res.docs.slice(0, Math.max(0, g.effTotal - g.page * g.pageSize));
      }
      errBox.textContent = '';
      render();
      renderCode();
      // the user's query window (Skip/Limit fields), not this page's skip/limit
      App.emit('query-ran', { filter: g.filter, sort: g.sort, projection: g.projection,
        skip: g.userSkip, limit: g.userLimit });
    } catch (e) {
      if (seq !== loadSeq) return; // superseded (or aborted) — the newer load owns the grid
      // drop the stale rows — leaving them next to an error reads as a successful query
      g.docs = [];
      errBox.textContent = e.message;
      showHint('Query failed — see the error above.');
    } finally {
      if (seq === loadSeq) { setBusy(false); loadAbort = null; }
    }
  }

  function render() {
    const unknown = g.effTotal == null; // the server could not count this query
    const from = g.page * g.pageSize + 1;
    const to = g.page * g.pageSize + g.docs.length;
    body.textContent = '';
    if (!g.docs.length) {
      showHint(g.page > 0 ? 'No more documents.' : 'No documents match.');
      firstBtn.disabled = prevBtn.disabled = g.page === 0; // keep a way back
      renderSelBar();
      return;
    }
    pageInfo.textContent = unknown
      ? `Documents ${from} to ${to} (total unknown)`
      : `Documents ${from} to ${to} of ${g.effTotal.toLocaleString()}`;
    pageInfo.title = unknown ? 'This query cannot be counted ($near, $where…) — page with › until it runs out' : '';
    firstBtn.disabled = prevBtn.disabled = g.page === 0;
    nextBtn.disabled = unknown ? !g.more : to >= g.effTotal;
    lastBtn.disabled = unknown || to >= g.effTotal;
    if (g.view === 'table') renderTable();
    else if (g.view === 'tree') renderTree();
    else renderJson();
    renderSelBar();
  }

  /* ---- mongo-shell syntax in the query bar ---- */

  // What people actually paste from Compass / Studio 3T / logs: unquoted keys,
  // single quotes, ObjectId("…"), ISODate(…), /re/i, trailing commas. The server
  // API stays strict EJSON — the text is normalised here (MangoShell.fromShell, in
  // shell.js) before it is sent. Double literals (1.0, 2.5) become {$numberDouble},
  // so text printed by toShell reads back with every BSON type intact.
  function toEjsonValue(text, label) {
    try { return MangoShell.fromShell(text); } catch (e) { throw new Error(label + ': ' + e.message); }
  }

  // Returns strict EJSON text ('' for empty input); throws with a readable message.
  function toEjsonText(text, label) {
    const t = (text || '').trim();
    if (!t) return '';
    const value = toEjsonValue(t, label);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(label + ' must be an object');
    }
    return JSON.stringify(value);
  }

  const shell = (v, indent) => MangoShell.toShell(v, indent);
  const shellText = (ejsonText) => { try { return shell(JSON.parse(ejsonText)); } catch { return ejsonText; } };

  /* ---- Query Code tab ---- */

  function renderCode() {
    const coll = App.state.collection;
    if (!coll) { codeEl.textContent = ''; return; }
    // g.* hold strict EJSON, which mongosh would send as literal {$oid: …} documents
    let s = 'db.getCollection(' + JSON.stringify(coll) + ').find(' + shellText(g.filter || '{}');
    if (g.projection && g.projection !== '{}') s += ', ' + shellText(g.projection);
    s += ')';
    if (g.sort && g.sort !== '{}') s += '.sort(' + shellText(g.sort) + ')';
    if (g.userSkip > 0) s += '.skip(' + g.userSkip + ')';
    if (g.userLimit > 0) s += '.limit(' + g.userLimit + ')';
    codeEl.textContent = s;
  }

  /* ---- cell rendering ---- */

  // EJSON wrappers that are leaf values (not documents) besides the numeric/date ones
  const SPECIAL_TYPE = {
    $binary: 'Binary', $uuid: 'Binary', $timestamp: 'Timestamp', $regularExpression: 'Regex',
    $regex: 'Regex', $minKey: 'MinKey', $maxKey: 'MaxKey', $code: 'Code', $symbol: 'Symbol',
  };
  const SPECIAL = Object.keys(SPECIAL_TYPE);

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
      else if (SPECIAL.some((k) => k in v)) text = shell(v); // BinData(…), /re/, Timestamp(…)
      else text = '{…}';
    } else text = String(v);
    td.textContent = text;
    if (cls) td.className = cls;
    if (v !== undefined) td.title = shell(v, 2);
  }

  /* ---- drag payloads (Data → Query Builder) ---- */

  const QB_TYPE = {
    ObjectId: 'objectId', Date: 'date',
    // long/decimal keep their type: 12.34 as a double never equals Decimal128("12.34")
    Int32: 'number', Int64: 'long', Double: 'number', Decimal128: 'decimal',
    Boolean: 'boolean', String: 'string', Null: 'null', Array: 'array', Document: 'object',
  };

  function dragPayload(path, v) {
    const t = bsonType(v);
    const p = { path, type: QB_TYPE[t] || 'string' };
    if (t === 'ObjectId') p.value = v.$oid;
    else if (t === 'Date') {
      const d = v.$date && typeof v.$date === 'object'
        ? new Date(Number(v.$date.$numberLong)) : new Date(v.$date);
      if (!isNaN(d.getTime())) p.value = d.toISOString(); // to the ms: "equals" is that instant
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

  // Paths are arrays of field names: a literal "a.b" key (MongoDB 5+) is one segment.
  function getPathVal(obj, segs) {
    let o = obj;
    for (const p of segs) o = o == null ? undefined : o[p];
    return o;
  }

  function setPathVal(obj, segs, val) {
    let o = obj;
    for (let i = 0; i < segs.length - 1; i++) o = o[segs[i]];
    o[segs[segs.length - 1]] = val;
  }

  // EJSON scalar wrappers the inline editor unwraps and re-wraps ($date has its own picker)
  const WRAPPERS = ['$oid', '$numberInt', '$numberLong', '$numberDouble', '$numberDecimal'];
  // What the bare text of each wrapper has to look like — the server would otherwise
  // truncate {$numberInt:"2.5"} to 2 without a word.
  const WRAPPER_CHECK = {
    $oid: [/^[0-9a-f]{24}$/i, 'Not a valid ObjectId'],
    $numberInt: [/^-?\d+$/, 'Not a 32-bit integer', (t) => Number(t) >= -(2 ** 31) && Number(t) < 2 ** 31],
    $numberLong: [/^-?\d+$/, 'Not a 64-bit integer', (t) => BigInt(t) >= -(2n ** 63n) && BigInt(t) < 2n ** 63n],
    $numberDouble: [/^(-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?|-?Infinity|NaN)$/, 'Not a number'],
    $numberDecimal: [/^(-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?|-?Infinity|NaN)$/i, 'Not a decimal number'],
  };

  // One-field write; undefined removes the field (the Undo of adding one).
  const patchField = (t, id, path, val) => App.api('/api/doc', {
    method: 'PATCH',
    body: val === undefined ? { ...t, id, path, unset: true } : { ...t, id, path, value: JSON.stringify(val) },
  });

  let cancelOpenEdit = null; // set while an inline editor is open

  function startCellEdit(td, doc, segs, rerender) {
    if (td.querySelector('input, select')) return;
    if (!hasId(doc)) return;
    // the dotted PATCH path (C2) can't address these: $set {"a.b"} would make {a:{b}}
    if (segs.some((p) => p.includes('.') || p.startsWith('$'))) {
      errBox.textContent = 'Field name contains "." or "$" — use Edit document to change it.';
      return;
    }
    const path = segs.join('.');
    // the target of the query on screen now, not whatever is open when the edit lands
    const t = target();
    // $slice / $elemMatch / positional projections show part of an array, so an
    // index in the path would not point at the same element in the stored document
    if (/\$slice|\$elemMatch|\.\$/.test(g.projection) && segs.some((p) => /^\d+$/.test(p))) {
      errBox.textContent = 'This projection shows only part of the array — clear it to edit array elements.';
      return;
    }
    const cur = getPathVal(doc, segs);
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
          const [re, msg, ok = () => true] = WRAPPER_CHECK[wrapKey];
          if (!re.test(text) || !ok(text)) {
            errBox.textContent = msg + ': ' + text;
            return undefined;
          }
          // editing a Double to 2 keeps it a Double — shown as 2.0, as the server sends it
          if (wrapKey === '$numberDouble' && /^-?\d+$/.test(text)) return { $numberDouble: text + '.0' };
          return { [wrapKey]: text };
        };
      } else if (typeof cur === 'string') {
        inp.value = cur;
        getVal = () => inp.value; // a string stays a string — no quotes to type
      } else {
        // null, arrays, documents, BinData…, or a field this document doesn't have yet:
        // shell syntax both ways, so 5 is an Int32, 5.0 a Double, ObjectId("…") an id
        inp.value = cur === undefined ? '' : shell(cur);
        getVal = () => {
          const text = inp.value.trim();
          if (!text && cur === undefined) return undefined; // nothing typed — no new field
          try { return toEjsonValue(text, 'Value'); } catch { return text; } // bare text becomes a string
        };
      }
    }
    let done = false;
    // navigating away re-renders the grid, whose blur must not commit the edit
    cancelOpenEdit = () => { done = true; };
    const finish = (save) => {
      if (done) return;
      done = true;
      cancelOpenEdit = null;
      if (!save) { rerender(); return; }
      const val = getVal();
      if (val === undefined) { rerender(); return; } // invalid value — discard the edit
      if (JSON.stringify(val) === JSON.stringify(cur)) { rerender(); return; } // unchanged
      // $set of this one path (C2): fields hidden by a projection, and other fields
      // changed elsewhere since the query ran, are left alone
      const id = JSON.stringify(doc._id);
      patchField(t, id, path, val)
        .then(() => {
          errBox.textContent = '';
          setPathVal(doc, segs, val);
          App.emit('collection-changed', t);
          App.toast('Saved', false, () => patchField(t, id, path, cur)
            .then(() => { App.toast('Reverted'); wrote(t); })
            .catch((e) => { errBox.textContent = e.message; }));
          rerender();
        })
        .catch((e) => { errBox.textContent = e.message; rerender(); });
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    if (saveOnChange) inp.addEventListener('change', () => finish(true));
    // Clicking away commits, like every other grid — discarding a typed edit silently
    // just looks like the editor is broken. Escape is the way out without saving.
    inp.addEventListener('blur', () => finish(true));
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
        td._segs = [k];
        renderCell(td, doc[k]);
        makeDraggable(td, k, () => doc[k]);
        td.addEventListener('dblclick', () =>
          startCellEdit(td, doc, [k], () => renderCell(td, doc[k])));
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
    const t = target();
    try {
      const docs = await undoSnapshot(t, g.docs.filter((d) => g.sel.has(selKey(d))));
      const r = await App.api('/api/docs/delete', { method: 'POST', body: { ...t, ids } });
      App.toast('Deleted ' + r.deletedCount, false, docs && (() => reinsert(t, docs)));
      wrote(t);
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
      const special = SPECIAL.find((k) => k in v);
      if (special) return SPECIAL_TYPE[special];
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

  function treeRow(key, value, depth, segs, rootDoc) {
    const path = segs.join('.');
    const tr = document.createElement('tr');
    tr.className = 'tree-row';
    tr._doc = rootDoc;
    tr._path = path;
    tr._segs = segs;
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
      makeDraggable(tr, path, () => getPathVal(rootDoc, segs));
      // …and its value edited in place
      tdVal.addEventListener('dblclick', () =>
        startCellEdit(tdVal, rootDoc, segs, () => {
          const v = getPathVal(rootDoc, segs);
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
        ? value.map((v, i) => ({ label: '[' + i + ']', childPath: [...segs, String(i)], v }))
        : Object.entries(value).map(([k, v]) => ({ label: k, childPath: [...segs, k], v }));
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
      const root = treeRow(idLabel(doc), doc, 0, [], doc);
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
      pre.textContent = shell(doc, 2);
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
  const cancelBtn = actionBtn('Cancel', () => requestClose());
  const saveBtn = actionBtn('Save', onSaveClick);
  saveBtn.className = 'primary';
  const modalHint = document.createElement('span');
  modalHint.className = 'muted modal-hint';
  modalHint.textContent = 'Ctrl+Enter to save';
  modalActions.append(modalHint, cancelBtn, saveBtn);
  modalBox.append(modalTitle, modalText, modalErr, modalActions);
  modal.appendChild(modalBox);
  // Backdrop click closes — but only a click that also started there: a text
  // selection dragged out of the textarea ends with a click on the dialog too.
  let downOnBackdrop = false;
  modal.addEventListener('mousedown', (e) => { downOnBackdrop = e.target === modal; });
  modal.addEventListener('click', (e) => {
    if (downOnBackdrop && e.target === modal) requestClose();
    downOnBackdrop = false;
  });
  modal.addEventListener('cancel', (e) => { e.preventDefault(); requestClose(); }); // Esc
  document.body.appendChild(modal);

  let modalSave = null;
  let modalTarget = null;
  let modalUndo = null;
  let modalOrig = '';

  async function requestClose() {
    if (modalText.value !== modalOrig && !await App.confirm('Discard your changes?', 'Discard')) return;
    modal.close();
  }

  // Validate while typing so a stray comma is visible before Save is pressed. The
  // editor speaks the same shell syntax the query bar does.
  function validateModal() {
    let err = '';
    try {
      if (!toEjsonText(modalText.value, 'Document')) err = 'Document: type a document, e.g. { name: "x" }';
    } catch (e) { err = e.message; }
    modalErr.textContent = err;
    saveBtn.disabled = !!err;
  }
  modalText.addEventListener('input', validateModal);
  modalText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSaveClick(); }
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); // indent instead of leaving the editor
      modalText.setRangeText('  ', modalText.selectionStart, modalText.selectionEnd, 'end');
    }
  });

  function openModal(title, text, onSave, onUndo) {
    modalTitle.textContent = title;
    modalText.value = modalOrig = text;
    modalSave = onSave;
    modalUndo = onUndo || null;
    modalTarget = target(); // where the dialog was opened, even if the user navigates
    validateModal();
    modal.showModal();
    modalText.focus();
  }

  async function onSaveClick() {
    if (saveBtn.disabled) return;
    saveBtn.disabled = true;
    const t = modalTarget;
    try {
      await modalSave(toEjsonText(modalText.value, 'Document'), t);
      modal.close();
      App.toast('Saved', false, modalUndo);
      wrote(t);
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

  // After any write: re-count, reload, and let the tree refresh its counts (C5).
  // t is the target the write went to — the user may have moved on since.
  function wrote(t) {
    App.emit('collection-changed', t);
    const s = App.state;
    if (s.connectionId !== t.connectionId || s.db !== t.db || s.collection !== t.collection) return;
    g.needCount = true;
    load();
  }

  const projected = () => !!g.projection && g.projection !== '{}';

  // The stored documents for these grid rows: the rows themselves, unless a
  // projection trimmed them — then read the full documents again by _id.
  async function fullDocs(t, docs) {
    if (!projected()) return docs;
    const ids = docs.map((d) => d._id);
    const res = await App.api('/api/query', {
      method: 'POST',
      body: { ...t, filter: JSON.stringify({ _id: { $in: ids } }), limit: ids.length, count: false },
    });
    return res.docs;
  }

  // What an Undo of a delete re-inserts. Not worth failing the delete over.
  const undoSnapshot = (t, docs) => fullDocs(t, docs).catch(() => null);

  function reinsert(t, docs) {
    Promise.all(docs.map((d) => App.api('/api/doc', { method: 'POST', body: { ...t, doc: JSON.stringify(d) } })))
      .then(() => { App.toast('Restored ' + docs.length); wrote(t); })
      .catch((e) => { errBox.textContent = e.message; wrote(t); });
  }

  // Put a whole-document snapshot back (Undo of the Edit dialog).
  function revertDoc(t, id, docText) {
    App.api('/api/doc', { method: 'PUT', body: { ...t, id, doc: docText } })
      .then(() => { App.toast('Reverted'); wrote(t); })
      .catch((e) => { errBox.textContent = e.message; });
  }

  async function editDoc(doc) {
    if (!hasId(doc)) return;
    const t = target();
    // a projected row is only part of the document; replacing with it would drop the rest
    let full = doc;
    try {
      [full] = await fullDocs(t, [doc]);
    } catch (e) {
      errBox.textContent = e.message;
      return;
    }
    if (!full) { errBox.textContent = 'Document not found — it may have been deleted elsewhere. Refresh.'; return; }
    const id = JSON.stringify(full._id);
    const before = JSON.stringify(full);
    openModal('Edit document', shell(full, 2),
      (text) => App.api('/api/doc', { method: 'PUT', body: { ...t, id, doc: text } }),
      () => revertDoc(t, id, before));
  }

  function insertDoc() {
    openModal('Insert document', '{}', (text, t) =>
      App.api('/api/doc', { method: 'POST', body: { ...t, doc: text } }));
  }

  async function deleteDoc(doc) {
    if (!hasId(doc)) return;
    if (!await App.confirm('Delete this document?')) return;
    const t = target();
    try {
      const [full] = (await undoSnapshot(t, [doc])) || [];
      await App.api('/api/doc', { method: 'DELETE', body: { ...t, id: JSON.stringify(doc._id) } });
      App.toast('Document deleted', false, full && (() => reinsert(t, [full])));
      wrote(t);
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

  // Walk the whole winning plan for stage and index names — COLLSCAN is the one worth
  // shouting about. Covers the classic tree (inputStage/inputStages), the SBE wrapper
  // ({queryPlan, slotBasedPlan}) and mongos ({shards: [{winningPlan}]}).
  function walkPlan(node, acc = { stages: [], indexes: new Set() }) {
    if (!node || typeof node !== 'object') return acc;
    if (node.queryPlan) return walkPlan(node.queryPlan, acc);
    if (node.stage) acc.stages.push(node.stage);
    if (node.indexName) acc.indexes.add(node.indexName);
    if (node.inputStage) walkPlan(node.inputStage, acc);
    (node.inputStages || []).forEach((s) => walkPlan(s, acc));
    (node.shards || []).forEach((sh) => walkPlan(sh.winningPlan || sh.executionStages, acc));
    return acc;
  }
  const INDEX_STAGES = ['IXSCAN', 'IDHACK', 'COUNT_SCAN', 'DISTINCT_SCAN', 'EXPRESS_IXSCAN', 'EXPRESS_IDHACK'];
  let explainSeq = 0;

  async function loadExplain() {
    const { connectionId, db, collection } = App.state;
    if (!collection) { explainSummary.textContent = 'Select a collection first.'; return; }
    explainSummary.className = '';
    explainSummary.textContent = 'Explaining…';
    explainIndexes.textContent = explainPlan.textContent = '';
    const seq = ++explainSeq;
    try {
      const res = await App.api('/api/explain', {
        method: 'POST',
        body: { connectionId, db, collection, filter: g.filter, sort: g.sort, projection: g.projection },
      });
      if (seq !== explainSeq) return;
      const winning = (res.plan.queryPlanner || {}).winningPlan;
      const { stages, indexes } = walkPlan(winning);
      const index = [...indexes].join('", "');
      const scan = stages.includes('COLLSCAN');
      const usesIndex = stages.some((st) => INDEX_STAGES.includes(st));
      explainSummary.className = scan ? 'explain-warn' : (usesIndex ? 'explain-ok' : '');
      explainSummary.textContent = scan
        ? 'COLLSCAN — every document is read. Add an index on the filtered/sorted fields.'
        : usesIndex
          ? `Index scan${index ? ' using "' + index + '"' : ''} — ${stages.join(' → ')}`
          : `No index used — ${stages.join(' → ') || 'unknown plan'}`; // e.g. EOF: no such collection
      explainIndexes.textContent = res.indexes
        .map((i) => `${i.name}: ${JSON.stringify(i.key)}${i.unique ? ' (unique)' : ''}`).join('\n');
      explainPlan.textContent = JSON.stringify(winning || res.plan, null, 2);
    } catch (e) {
      if (seq !== explainSeq) return;
      explainSummary.className = 'explain-warn';
      explainSummary.textContent = e.message;
    }
  }

  document.getElementById('code-copy').addEventListener('click', () => copy(codeEl.textContent));

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
    return shell(v, 2);
  }

  // Set the query bar to one condition and run it. Shell text, so the value keeps
  // its type (5 vs 5.0 vs NumberLong("5")) and stays readable in the history.
  function filterBy(path, cond) {
    filterInput.value = shell({ [path]: cond });
    autoGrow();
    run();
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
    const segs = (cell && cell._path && cell._segs) || (row && row._segs);
    e.preventDefault();
    closeCtx();

    const items = [];
    if (path) {
      const v = getPathVal(doc, segs);
      items.push(['Copy value', () => copy(plainValue(v))]);
      items.push(['Copy field name', () => copy(path)]);
      if (v !== undefined) {
        items.push(['Filter by this value', () => filterBy(path, v)]);
        items.push(['Exclude this value', () => filterBy(path, { $ne: v })]);
      }
      items.push(null);
    }
    items.push(['Copy document', () => copy(shell(doc, 2))]);
    items.push(['Copy document as EJSON', () => copy(JSON.stringify(doc, null, 2))]);
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

  App.on('target', ({ collection }) => {
    if (cancelOpenEdit) cancelOpenEdit(); // an edit open in the old collection is dropped
    const saved = (collection && App.memGet('query')) || {};
    filterInput.value = saved.filter || '';
    projInput.value = saved.projection || '';
    sortInput.value = saved.sort || '';
    skipInput.value = saved.skip || '';
    limitInput.value = saved.limit || '';
    autoGrow();
    errBox.textContent = '';
    if (collection) { run(); return; } // parses the restored text and loads the first page
    // target cleared, e.g. its connection was deleted (C5): back to the empty state
    document.querySelectorAll('#connections-panel .tree-coll.active')
      .forEach((el) => el.classList.remove('active'));
    Object.assign(g, { filter: '', sort: '', projection: '', userSkip: 0, userLimit: 0, page: 0, needCount: true });
    g.cols.clear();
    explainSeq++;
    explainSummary.className = '';
    explainSummary.textContent = 'Select a collection first.';
    explainIndexes.textContent = explainPlan.textContent = '';
    load(); // cancels any query still in flight and shows the hint
    renderCode();
  });

  App.on('query', ({ filter, sort, projection }) => {
    filterInput.value = filter || '';
    sortInput.value = sort && sort !== '{}' ? sort : '';
    projInput.value = projection && projection !== '{}' ? projection : '';
    run();
  });
})();
