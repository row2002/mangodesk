// Export tab: exports the last-run query as JSON / NDJSON / CSV.
(() => {
  const root = document.getElementById('tab-export');
  let lastQuery = null; // last 'query-ran' payload

  // --- build DOM ---
  const wrapEl = el('div', 'export-wrap');
  const card = el('div', 'export-card');
  wrapEl.appendChild(card);
  root.appendChild(wrapEl);

  const title = el('div', 'panel-title');
  title.textContent = 'Export';

  const targetLine = el('div', 'export-target mono');
  const hint = el('div', 'muted export-hint');

  const queryBox = el('pre', 'export-query mono');
  const queryNote = el('div', 'muted export-note');

  const controls = el('div', 'export-controls');
  const formatSel = document.createElement('select');
  for (const [val, label] of [['json', 'JSON array'], ['ndjson', 'NDJSON'], ['csv', 'CSV']]) {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = label;
    formatSel.appendChild(o);
  }
  const limitInput = document.createElement('input');
  limitInput.type = 'number';
  limitInput.min = '0';
  limitInput.placeholder = 'Limit (all)';
  limitInput.className = 'export-limit';

  const exportBtn = document.createElement('button');
  exportBtn.className = 'primary';
  exportBtn.textContent = 'Export';

  controls.append(formatSel, limitInput, exportBtn);

  const errorEl = el('div', 'export-error');

  card.append(title, targetLine, hint, queryBox, queryNote, controls, errorEl);

  function el(tag, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  function pretty(str) {
    try { return JSON.stringify(JSON.parse(str), null, 2); } catch { return str; }
  }

  function isEmptyFilter(str) {
    if (!str || !str.trim()) return true;
    try { return Object.keys(JSON.parse(str)).length === 0; } catch { return false; }
  }

  function render() {
    const { db, collection } = App.state;
    errorEl.textContent = '';
    if (!collection) {
      targetLine.textContent = 'No collection selected';
      hint.textContent = 'Pick a collection in the sidebar to export from it.';
      queryBox.style.display = 'none';
      queryNote.textContent = '';
      exportBtn.disabled = true;
      formatSel.disabled = true;
      limitInput.disabled = true;
      return;
    }
    exportBtn.disabled = false;
    formatSel.disabled = false;
    limitInput.disabled = false;
    targetLine.textContent = `${db}.${collection}`;
    hint.textContent = '';

    const q = lastQuery;
    const extras = [];
    if (q) {
      if (q.sort && q.sort.trim() && q.sort.trim() !== '{}') extras.push('sort: ' + q.sort);
      if (q.projection && q.projection.trim() && q.projection.trim() !== '{}') extras.push('projection: ' + q.projection);
      if (q.skip > 0) extras.push('skip: ' + q.skip);
      if (q.limit > 0) extras.push('limit: ' + q.limit);
    }
    limitInput.placeholder = q && q.limit > 0 ? 'Limit (' + q.limit + ' from query)' : 'Limit (all)';
    if (q && !isEmptyFilter(q.filter)) {
      queryBox.textContent = [pretty(q.filter), ...extras].join('\n');
      queryBox.style.display = '';
      queryNote.textContent = '';
    } else {
      queryNote.textContent = q && q.limit > 0
        ? 'no filter' : 'no filter — exporting whole collection';
      queryBox.textContent = extras.join('\n');
      queryBox.style.display = extras.length ? '' : 'none';
    }
  }

  // Hidden sink for the download form: a successful download never navigates it,
  // an error response renders in it and gets surfaced in errorEl.
  const frame = document.createElement('iframe');
  frame.name = 'export-sink';
  frame.hidden = true;
  frame.addEventListener('load', () => {
    let text = '';
    try { text = frame.contentDocument.body.textContent.trim(); } catch { /* ignore */ }
    if (!text) return; // initial about:blank load
    try { errorEl.textContent = JSON.parse(text).error || text; } catch { errorEl.textContent = text; }
  });
  document.body.appendChild(frame);

  // Plain form POST so the browser streams the download straight to disk
  // instead of buffering the whole export in a blob.
  function doExport() {
    errorEl.textContent = '';
    const { connectionId, db, collection } = App.state;
    const fields = {
      connectionId, db, collection, format: formatSel.value,
      filter: lastQuery ? lastQuery.filter : '',
      sort: lastQuery ? lastQuery.sort : '',
      projection: lastQuery ? lastQuery.projection : '',
      skip: (lastQuery && lastQuery.skip) || '0',
      limit: limitInput.value || (lastQuery && lastQuery.limit) || '0',
    };
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/api/export';
    form.target = 'export-sink';
    for (const [k, v] of Object.entries(fields)) {
      const inp = document.createElement('input');
      inp.type = 'hidden';
      inp.name = k;
      inp.value = v == null ? '' : v;
      form.appendChild(inp);
    }
    document.body.appendChild(form);
    form.submit();
    form.remove();
  }

  exportBtn.addEventListener('click', doExport);

  App.on('target', () => { lastQuery = null; render(); });
  App.on('query-ran', (params) => { lastQuery = params; render(); });

  render();
})();
