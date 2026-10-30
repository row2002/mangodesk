// Import tab: a JSON / NDJSON / CSV file into a collection, streamed to /api/import.
(() => {
  const root = document.getElementById('tab-import');
  const PREVIEW_BYTES = 256 * 1024; // the server reads at most 1 MB of preview
  let file = null;
  let preview = null;     // last /api/import/preview answer for `file`
  let previewSeq = 0;     // drops answers for a file that has been replaced since
  let xhr = null;         // the running upload
  let targetMoved = false; // the sidebar selection changed while it ran
  const types = new Map(); // CSV column -> type picked by the user

  // --- build DOM ---
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  // same card as the Export tab
  const wrapEl = el('div', 'export-wrap');
  const card = el('div', 'export-card import-card');
  wrapEl.appendChild(card);
  root.appendChild(wrapEl);

  const title = el('div', 'panel-title', 'Import');

  const targetLine = el('label', 'import-target mono');
  const dbText = el('span');
  const collInput = el('input', 'mono');
  collInput.spellcheck = false;
  collInput.title = 'Target collection — a new name creates it';
  targetLine.append(dbText, collInput);
  const hint = el('div', 'muted export-hint');

  const picker = el('input');
  picker.type = 'file';
  picker.accept = '.json,.ndjson,.jsonl,.csv,.tsv,.txt';
  picker.hidden = true;
  const drop = el('div', 'import-drop');
  drop.tabIndex = 0;
  drop.setAttribute('role', 'button');
  const dropText = el('div', null, 'Drop a JSON, NDJSON or CSV file here');
  const chooseLink = el('span', 'import-choose', 'or choose a file');
  drop.append(dropText, chooseLink, picker);

  const fileLine = el('div', 'import-file');
  const fileName = el('span', 'mono import-file-name');
  const formatSel = el('select');
  formatSel.title = 'File format';
  for (const [val, label] of [['json', 'JSON'], ['ndjson', 'NDJSON'], ['csv', 'CSV']]) {
    const o = el('option', null, label);
    o.value = val;
    formatSel.appendChild(o);
  }
  fileLine.append(fileName, formatSel);

  // CSV: separator and per-column types
  const csvBox = el('div', 'import-csv');
  const delimRow = el('label', 'import-row');
  const delimSel = el('select');
  for (const [val, label] of [['auto', 'Auto'], [',', 'Comma ,'], [';', 'Semicolon ;'], ['\t', 'Tab'], ['|', 'Pipe |']]) {
    const o = el('option', null, label);
    o.value = val;
    delimSel.appendChild(o);
  }
  const delimNote = el('span', 'muted');
  delimRow.append(el('span', 'import-label', 'Separator'), delimSel, delimNote);
  const colsTable = el('table', 'import-cols');
  const colsNote = el('div', 'muted import-note');
  csvBox.append(delimRow, colsTable, colsNote);

  // JSON / NDJSON: the first document, as the Data tab would show it
  const docPreview = el('pre', 'export-query mono import-doc');

  const opts = el('div', 'import-opts');
  const radios = (name, choices) => {
    const row = el('div', 'import-row');
    row.appendChild(el('span', 'import-label', name));
    const key = 'mangodesk.import.' + name.toLowerCase().replace(/\W/g, '');
    let current = localStorage.getItem(key) || choices[0][0];
    for (const [val, label, tip] of choices) {
      const lab = el('label', 'import-radio');
      lab.title = tip;
      const r = el('input');
      r.type = 'radio';
      r.name = key;
      r.value = val;
      r.checked = val === current;
      r.addEventListener('change', () => { current = val; localStorage.setItem(key, val); });
      lab.append(r, document.createTextNode(' ' + label));
      row.appendChild(lab);
    }
    opts.appendChild(row);
    return () => current;
  };
  const mode = radios('Mode', [
    ['insert', 'Insert', 'Add every document; one whose _id already exists fails'],
    ['upsert', 'Upsert by _id', 'Replace the document with the same _id, or insert it if there is none'],
  ]);
  const onError = radios('On error', [
    ['stop', 'Stop', 'Stop at the first failing document (the rest of its batch of 1000 still goes in)'],
    ['continue', 'Continue', 'Skip failing documents and import everything else'],
  ]);

  const actions = el('div', 'export-controls');
  const importBtn = el('button', 'primary', 'Import');
  const cancelBtn = el('button', null, 'Cancel');
  cancelBtn.hidden = true;
  const progress = el('progress', 'import-progress');
  progress.hidden = true;
  const status = el('span', 'muted import-status');
  actions.append(importBtn, cancelBtn, progress, status);

  const errorEl = el('div', 'export-error');
  const resultEl = el('div', 'import-result');

  card.append(title, targetLine, hint, drop, fileLine, csvBox, docPreview, opts, actions, errorEl, resultEl);

  const fmtSize = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB'
    : (n / 1048576).toFixed(1) + ' MB');
  const delimName = (d) => ({ ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' }[d] || JSON.stringify(d));

  // --- state -> DOM ---

  function render() {
    const { db, collection } = App.state;
    const running = !!xhr;
    if (!collection) {
      dbText.textContent = '';
      targetLine.hidden = true;
      hint.textContent = 'Pick a collection in the sidebar; the file goes into it, or into a new one you name here.';
    } else {
      targetLine.hidden = false;
      dbText.textContent = db + '.';
      hint.textContent = '';
    }
    fileLine.hidden = !file;
    if (file) fileName.textContent = `${file.name} · ${fmtSize(file.size)}`;
    const csv = file && formatSel.value === 'csv';
    csvBox.hidden = !csv;
    docPreview.hidden = !file || csv || !docPreview.textContent;
    importBtn.disabled = running || !file || !collection || !collInput.value.trim()
      || !!(preview && preview.fatal);
    for (const c of [collInput, formatSel, delimSel, picker]) c.disabled = running;
    drop.classList.toggle('disabled', running);
    opts.querySelectorAll('input').forEach((r) => { r.disabled = running; });
    colsTable.querySelectorAll('select').forEach((s) => { s.disabled = running; });
    cancelBtn.hidden = !running;
    progress.hidden = !running;
  }

  // Guess from the name, then from the first bytes: '[' is a JSON array, a first line
  // that is a whole document is NDJSON, anything else JSON (one document after another).
  async function sniffFormat(f) {
    const name = f.name.toLowerCase();
    if (/\.(csv|tsv)$/.test(name)) return 'csv';
    if (/\.(ndjson|jsonl)$/.test(name)) return 'ndjson';
    const head = (await f.slice(0, 64 * 1024).text()).replace(/^﻿/, '').trimStart();
    if (head[0] === '[') return 'json';
    if (head[0] === '{') {
      try { JSON.parse(head.split('\n')[0]); return 'ndjson'; } catch { return 'json'; }
    }
    return /\.json$/.test(name) ? 'json' : 'csv';
  }

  async function choose(f) {
    if (!f || xhr) return;
    file = f;
    preview = null;
    types.clear();
    resultEl.textContent = '';
    errorEl.textContent = '';
    docPreview.textContent = '';
    colsTable.textContent = '';
    colsNote.textContent = '';
    delimNote.textContent = '';
    delimSel.value = 'auto';
    try { formatSel.value = await sniffFormat(f); } catch { formatSel.value = 'json'; }
    render();
    loadPreview();
  }

  async function loadPreview() {
    if (!file) return;
    const seq = ++previewSeq;
    const format = formatSel.value;
    const part = file.slice(0, PREVIEW_BYTES);
    const q = new URLSearchParams({ format, complete: file.size <= PREVIEW_BYTES ? '1' : '0' });
    if (format === 'csv') q.set('delimiter', delimSel.value);
    let res;
    try {
      const r = await fetch('/api/import/preview?' + q, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: part,
      });
      res = await r.json().catch(() => ({ error: r.statusText }));
      if (!r.ok) res = { fatal: res.error || r.statusText };
    } catch {
      App.serverDown(true);
      res = { fatal: 'Cannot reach the MangoDesk server — is it still running?' };
    }
    if (seq !== previewSeq) return;
    preview = res;
    errorEl.textContent = res.fatal || '';
    if (format === 'csv') renderColumns(res);
    else renderDocs(res);
    render();
  }

  function renderDocs(res) {
    const doc = res.docs && res.docs[0];
    docPreview.textContent = doc ? 'First document:\n' + MangoShell.toShell(doc, 2) : '';
    if (!res.fatal && res.errors && res.errors.length) {
      const e = res.errors[0];
      errorEl.textContent = (e.line ? `Line ${e.line}: ` : '') + e.message;
    } else if (!res.fatal && !doc) {
      errorEl.textContent = 'No documents found at the start of the file — is the format right?';
    }
  }

  const TYPE_CHOICES = [['auto', 'Auto'], ['string', 'String'], ['number', 'Number'], ['bool', 'Boolean'],
    ['date', 'Date'], ['objectId', 'ObjectId']];

  function renderColumns(res) {
    colsTable.textContent = '';
    colsNote.textContent = '';
    delimNote.textContent = '';
    if (!res.columns) return;
    delimNote.textContent = (delimSel.value === 'auto' ? 'found ' + delimName(res.delimiter) : '')
      + (res.bom ? (delimSel.value === 'auto' ? ' · ' : '') + 'UTF-8 BOM (Excel)' : '');
    const head = colsTable.createTHead().insertRow();
    for (const h of ['Field', 'Type', 'Sample']) head.appendChild(el('th', null, h));
    const body = colsTable.createTBody();
    for (const col of res.columns) {
      const tr = body.insertRow();
      tr.insertCell().appendChild(el('span', 'mono', col.name));
      const sel = el('select');
      for (const [val, label] of TYPE_CHOICES) {
        const o = el('option', null, label);
        o.value = val;
        sel.appendChild(o);
      }
      sel.value = types.get(col.name) || col.type;
      types.set(col.name, sel.value);
      sel.addEventListener('change', () => types.set(col.name, sel.value));
      tr.insertCell().appendChild(sel);
      const sample = tr.insertCell();
      sample.className = 'mono muted import-sample';
      sample.textContent = col.samples.join(' · ');
      sample.title = col.samples.join('\n');
    }
    colsNote.textContent = 'Auto reads true/false, numbers, ISO dates and JSON {…}/[…]; '
      + 'a.b names build nested documents; empty cells are left out.';
  }

  // --- import ---

  function showResult(r, t) {
    resultEl.textContent = '';
    const parts = [`Inserted ${r.inserted.toLocaleString()}`];
    if (mode() === 'upsert' || r.updated) parts.push(`replaced ${r.updated.toLocaleString()}`);
    parts.push(`failed ${r.failed.toLocaleString()}`);
    const summary = el('div', 'import-summary' + (r.failed || r.errors.length ? ' has-errors' : ''), parts.join(' · '));
    resultEl.appendChild(summary);
    if (r.stopped) resultEl.appendChild(el('div', 'muted', 'Stopped at the first error.'));
    if (r.errors.length) {
      const ul = el('ul', 'import-errors mono');
      for (const e of r.errors) ul.appendChild(el('li', null, (e.line ? `line ${e.line}: ` : '') + e.message));
      if (r.failed > r.errors.filter((e) => e.line).length) ul.appendChild(el('li', 'muted', '…'));
      resultEl.appendChild(ul);
    }
    const s = App.state;
    if (t.collection !== s.collection || t.db !== s.db || t.connectionId !== s.connectionId) {
      const open = el('button', null, `Open ${t.db}.${t.collection}`);
      open.addEventListener('click', () => {
        App.setTarget(t.connectionId, t.db, t.collection);
        App.showTab('data');
      });
      resultEl.appendChild(open);
    }
  }

  async function doImport() {
    errorEl.textContent = '';
    resultEl.textContent = '';
    const { connectionId, db } = App.state;
    const t = { connectionId, db, collection: collInput.value.trim() };
    const q = new URLSearchParams({ ...t, format: formatSel.value, mode: mode(), onError: onError() });
    if (formatSel.value === 'csv') {
      q.set('delimiter', delimSel.value);
      const picked = Object.fromEntries([...types].filter(([, v]) => v !== 'auto'));
      if (Object.keys(picked).length) q.set('types', JSON.stringify(picked));
    }
    // XHR rather than fetch: it streams the File from disk and reports upload progress
    // (the server writes as it reads, so that is the import's progress too).
    const req = new XMLHttpRequest();
    xhr = req;
    progress.value = 0;
    progress.max = 1;
    status.textContent = 'Importing…';
    render();
    const done = () => {
      xhr = null;
      if (targetMoved) collInput.value = App.state.collection || '';
      targetMoved = false;
      status.textContent = '';
      render();
      // even a failed or cancelled import may have written part of the file
      App.emit('collection-changed', { ...t, reload: true });
    };
    req.upload.addEventListener('progress', (e) => {
      if (!e.lengthComputable) return;
      progress.value = e.loaded / e.total;
      status.textContent = e.loaded < e.total
        ? `${fmtSize(e.loaded)} of ${fmtSize(e.total)}` : 'Finishing…';
    });
    req.addEventListener('load', () => {
      let body = null;
      try { body = JSON.parse(req.responseText); } catch { /* not JSON */ }
      done();
      App.serverDown(false);
      if (req.status !== 200 || !body) {
        errorEl.textContent = (body && body.error) || req.statusText || 'Import failed';
        return;
      }
      showResult(body, t);
      App.toast(`Imported ${body.inserted.toLocaleString()}${body.updated ? ' + ' + body.updated.toLocaleString() + ' replaced' : ''}`
        + ` into ${t.collection}${body.failed ? `, ${body.failed.toLocaleString()} failed` : ''}`, !!body.failed);
    });
    req.addEventListener('error', () => {
      done();
      App.serverDown(true);
      errorEl.textContent = 'Cannot reach the MangoDesk server — is it still running? '
        + 'Documents written before it stopped are in the collection.';
    });
    req.addEventListener('abort', () => {
      done();
      errorEl.textContent = 'Cancelled. Documents written before that are in the collection.';
    });
    req.open('POST', '/api/import?' + q);
    req.setRequestHeader('Content-Type', 'application/octet-stream');
    req.send(file);
  }

  // --- events ---

  drop.addEventListener('click', () => { if (!xhr) picker.click(); });
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!xhr) picker.click(); }
  });
  picker.addEventListener('click', (e) => e.stopPropagation());
  picker.addEventListener('change', () => { choose(picker.files[0]); picker.value = ''; });
  // the whole tab takes the drop, so a near miss doesn't make the browser open the file
  root.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = xhr ? 'none' : 'copy';
    drop.classList.add('drop-hl');
  });
  root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) drop.classList.remove('drop-hl'); });
  root.addEventListener('drop', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    drop.classList.remove('drop-hl');
    choose(e.dataTransfer.files[0]);
  });

  formatSel.addEventListener('change', () => {
    docPreview.textContent = '';
    colsTable.textContent = '';
    errorEl.textContent = '';
    render();
    loadPreview();
  });
  delimSel.addEventListener('change', loadPreview);
  collInput.addEventListener('input', render);
  importBtn.addEventListener('click', doImport);
  cancelBtn.addEventListener('click', () => { if (xhr) xhr.abort(); });

  App.on('target', ({ collection }) => {
    if (xhr) { targetMoved = true; return; } // the running import keeps its target
    collInput.value = collection || '';
    resultEl.textContent = '';
    render();
  });

  render();
})();
