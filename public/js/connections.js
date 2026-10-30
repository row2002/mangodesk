// Connection manager: settings form + collapsible connection→databases tree.
// Renders into #connections-panel.
(() => {
  const panel = document.getElementById('connections-panel');
  let connections = [];
  let selectedId = null;
  let editingId = null; // null = form closed, '' = adding, otherwise id being edited
  const expanded = new Set(); // connection ids expanded in the tree
  const nodes = new Map(); // connection id -> { item, children, expand } of the rendered tree
  const COLORS = ['', 'red', 'orange', 'green', 'blue', 'purple'];

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  // --- header ---
  const header = el('div', 'conn-header');
  const title = el('div', 'panel-title', 'Connections');
  const addBtn = el('button', 'conn-add', '+');
  addBtn.title = 'Add connection';
  addBtn.addEventListener('click', () => openForm(''));
  const closeBtn = el('button', 'conn-close', '✕');
  closeBtn.title = 'Close';
  closeBtn.addEventListener('click', closePicker);
  header.append(title, addBtn, closeBtn);

  // --- settings dialog (native <dialog>: focus trap, Esc, backdrop for free) ---
  const dlg = document.createElement('dialog');
  dlg.className = 'conn-dialog';
  const form = document.createElement('form');
  form.className = 'conn-form';
  dlg.appendChild(form);
  document.body.appendChild(dlg);

  const dlgTitle = el('h3', 'conn-dlg-title', 'New connection');

  const nameInput = el('input');
  nameInput.placeholder = 'defaults to host:port';

  // mode switch: standard fields vs raw connection string
  let mode = 'standard';
  const modeTabs = el('div', 'conn-mode');
  const stdTab = el('button', 'active', 'Fill in fields');
  stdTab.type = 'button';
  const uriTab = el('button', '', 'Paste connection string');
  uriTab.type = 'button';
  modeTabs.append(stdTab, uriTab);

  const field = (labelText, input, hint) => {
    const wrap = el('label', 'conn-field');
    wrap.append(el('span', 'conn-label', labelText), input);
    if (hint) wrap.appendChild(el('span', 'conn-hint muted', hint));
    return wrap;
  };
  const row2 = (cls, a, b) => {
    const r = el('div', 'conn-row2 ' + cls);
    r.append(a, b);
    return r;
  };
  const section = (text) => el('div', 'conn-section', text);

  const hostInput = el('input', 'mono');
  hostInput.placeholder = 'localhost';
  const srvInput = el('input');
  srvInput.type = 'checkbox';
  const srvRow = el('label', 'conn-check');
  srvRow.append(srvInput, el('span', '', 'DNS seed list (mongodb+srv://, e.g. Atlas)'));
  const portInput = el('input', 'mono');
  portInput.type = 'number';
  portInput.placeholder = '27017';
  portInput.min = 1;
  portInput.max = 65535;
  const userInput = el('input');
  userInput.placeholder = '(no authentication)';
  userInput.autocomplete = 'off';
  const passInput = el('input');
  passInput.type = 'password';
  passInput.autocomplete = 'new-password';
  const passWrap = el('div', 'conn-pass');
  const passToggle = el('button', 'conn-pass-toggle', '👁');
  passToggle.type = 'button';
  passToggle.title = 'Show/hide password';
  passToggle.addEventListener('click', () => {
    passInput.type = passInput.type === 'password' ? 'text' : 'password';
    passToggle.classList.toggle('active', passInput.type === 'text');
  });
  passWrap.append(passInput, passToggle);
  const authDbInput = el('input', 'mono');
  authDbInput.placeholder = 'admin';
  const tlsInput = el('input');
  tlsInput.type = 'checkbox';
  const tlsRow = el('label', 'conn-check');
  tlsRow.append(tlsInput, el('span', '', 'Use TLS/SSL'));
  const optsInput = el('input', 'mono');
  optsInput.placeholder = 'replicaSet=rs0&readPreference=secondary';

  const portField = field('Port', portInput);
  const stdBox = el('div', 'conn-std');
  stdBox.append(
    row2('hostport', field('Host', hostInput, 'replica set: h1:27017,h2:27017'), portField),
    srvRow,
    section('Authentication'),
    row2('', field('Username', userInput), field('Password', passWrap)),
    field('Auth database', authDbInput, 'database to authenticate against'),
    section('Options'),
    tlsRow,
    field('Extra parameters', optsInput),
  );

  const uriInput = el('input', 'mono');
  uriInput.placeholder = 'mongodb://user:pass@host:27017/?authSource=admin';
  const uriBox = el('div', 'conn-uri');
  uriBox.append(field('URI', uriInput, 'mongodb:// or mongodb+srv://'));
  uriBox.hidden = true;

  const uriPreview = el('div', 'conn-uri-preview mono muted');

  // colour tag (C4): a stripe on the top bar while this connection is active
  const colorSel = el('select', 'conn-color');
  for (const c of COLORS) {
    const o = el('option', '', c ? c[0].toUpperCase() + c.slice(1) : 'None');
    o.value = c;
    colorSel.appendChild(o);
  }
  const colorDot = el('span', 'conn-dot');
  const colorWrap = el('div', 'conn-color-wrap');
  colorWrap.append(colorDot, colorSel);
  colorSel.addEventListener('change', () => { colorDot.dataset.color = colorSel.value; });

  const testResult = el('span', 'conn-test-result');
  const formErr = el('div', 'conn-form-error');
  const footer = el('div', 'conn-form-footer');
  const testFormBtn = el('button', '', 'Test connection');
  testFormBtn.type = 'button';
  const saveBtn = el('button', 'primary', 'Save');
  saveBtn.type = 'submit';
  const cancelBtn = el('button', '', 'Cancel');
  cancelBtn.type = 'button';
  cancelBtn.addEventListener('click', closeForm);
  footer.append(testFormBtn, testResult, el('span', 'conn-footer-spacer'), cancelBtn, saveBtn);
  const savedTo = configLine();

  form.append(dlgTitle,
    row2('namecolor', field('Name (optional)', nameInput), field('Colour', colorWrap, 'e.g. red for production')),
    modeTabs, stdBox, uriBox, uriPreview, formErr, footer, savedTo);

  // "Saved to <file>" — which file is used depends on how MangoDesk was started (C1)
  function configLine() {
    const line = el('div', 'conn-config muted');
    line.append('Connections are saved to ', el('code', 'conn-config-path'));
    syncConfigPath(line);
    return line;
  }
  function syncConfigPath(root) {
    const file = App.info && App.info.configFile;
    root.hidden = !file;
    root.querySelectorAll('.conn-config-path').forEach((n) => { n.textContent = file || ''; });
  }
  App.on('info', () => document.querySelectorAll('.conn-config').forEach(syncConfigPath));

  // Field mode <-> pasted string: carry the connection over instead of dropping it.
  function setMode(m) {
    if (m === 'standard' && mode === 'uri' && uriInput.value.trim()) {
      const f = parseUri(uriInput.value);
      if (f) fillFields(f);
      else formErr.textContent = 'Could not split this connection string into fields — keep using the pasted form.';
    } else if (m === 'uri' && mode === 'standard' && !uriInput.value.trim()) {
      uriInput.value = buildUri(readSettings(), false);
    }
    mode = m;
    stdTab.classList.toggle('active', m === 'standard');
    uriTab.classList.toggle('active', m === 'uri');
    stdBox.hidden = m !== 'standard';
    uriBox.hidden = m !== 'uri';
    updatePreview();
  }
  stdTab.addEventListener('click', () => setMode('standard'));
  uriTab.addEventListener('click', () => setMode('uri'));

  function fillFields(f) {
    hostInput.value = f.host;
    portInput.value = f.port;
    srvInput.checked = f.srv;
    userInput.value = f.username;
    passInput.value = f.password;
    authDbInput.value = f.authDb;
    tlsInput.checked = f.tls;
    optsInput.value = f.options;
    syncSrv();
  }

  // mongodb[+srv]://[user[:pass]@]host[:port][,host…][/db][?opts] → form fields, or null
  function parseUri(uri) {
    const m = /^mongodb(\+srv)?:\/\/(?:([^@/]*)@)?([^/?]+)\/?([^?]*)(?:\?(.*))?$/.exec(uri.trim());
    if (!m) return null;
    const [, srv, userinfo, hosts, db, query] = m;
    const dec = (x) => { try { return decodeURIComponent(x); } catch { return x; } };
    const [user = '', ...pass] = userinfo ? userinfo.split(':') : [];
    const f = { srv: !!srv, host: hosts, port: '', username: dec(user), password: dec(pass.join(':')),
      authDb: '', tls: false, options: '' };
    const one = !srv && !hosts.includes(',') && /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hosts);
    if (one) { f.host = one[1]; f.port = one[2] || ''; }
    const rest = [];
    for (const kv of (query || '').split('&').filter(Boolean)) {
      const [k, v = ''] = kv.split('=');
      if (k === 'authSource') f.authDb = dec(v);
      else if ((k === 'tls' || k === 'ssl') && v === 'true') f.tls = true;
      else rest.push(kv);
    }
    if (!f.authDb && db && f.username) f.authDb = dec(db); // a path db is the auth db when none is given
    f.options = rest.join('&');
    return f;
  }

  function syncSrv() {
    portField.hidden = srvInput.checked; // SRV records carry the ports
  }
  srvInput.addEventListener('change', () => { syncSrv(); updatePreview(); });

  function readSettings() {
    return {
      mode,
      srv: srvInput.checked,
      host: hostInput.value.trim() || 'localhost',
      port: portInput.value.trim() || '27017',
      username: userInput.value.trim(),
      password: passInput.value,
      authDb: authDbInput.value.trim(),
      tls: tlsInput.checked,
      options: optsInput.value.trim(),
      uri: uriInput.value.trim(),
    };
  }

  function buildUri(s, maskPassword) {
    if (s.mode === 'uri') return s.uri;
    let auth = '';
    if (s.username) {
      const pass = s.password ? ':' + (maskPassword ? '•••' : encodeURIComponent(s.password)) : '';
      auth = encodeURIComponent(s.username) + pass + '@';
    }
    const params = [];
    if (s.username) params.push('authSource=' + encodeURIComponent(s.authDb || 'admin'));
    if (s.tls) params.push('tls=true');
    if (s.options) params.push(s.options);
    // a host list ("h1:27017,h2:27017") or a host with its own port is used as typed
    let hosts = s.host.replace(/\s+/g, '');
    if (!s.srv && !hosts.includes(',') && !/:\d+$/.test(hosts)) hosts += ':' + s.port;
    return (s.srv ? 'mongodb+srv://' : 'mongodb://') + auth + hosts + '/'
      + (params.length ? '?' + params.join('&') : '');
  }

  // Host part of a connection string, for names and the tree; works for host lists too.
  function hostsOf(uri) {
    const m = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/.exec(uri || '');
    return m ? m[1] : '';
  }

  function updatePreview() {
    uriPreview.textContent = mode === 'standard' ? buildUri(readSettings(), true) : '';
    uriPreview.hidden = mode !== 'standard';
  }
  [hostInput, portInput, userInput, passInput, authDbInput, optsInput].forEach((i) =>
    i.addEventListener('input', updatePreview));
  tlsInput.addEventListener('change', updatePreview);

  function openForm(id) {
    editingId = id;
    const rec = connections.find((c) => c.id === id);
    const s = (rec && rec.settings) || {};
    dlgTitle.textContent = rec ? 'Edit connection' : 'New connection';
    saveBtn.textContent = rec ? 'Save' : 'Create';
    nameInput.value = rec ? rec.name : '';
    hostInput.value = s.host || '';
    portInput.value = s.port || '';
    srvInput.checked = !!s.srv;
    syncSrv();
    colorSel.value = (rec && rec.color) || '';
    colorDot.dataset.color = colorSel.value;
    userInput.value = s.username || '';
    passInput.value = s.password || '';
    passInput.type = 'password';
    passToggle.classList.remove('active');
    authDbInput.value = s.authDb || '';
    tlsInput.checked = !!s.tls;
    optsInput.value = s.options || '';
    uriInput.value = s.uri || (rec && !rec.settings ? rec.uri : '');
    mode = ''; // no carry-over between fields and string while loading a record
    setMode(s.mode || (rec && !rec.settings ? 'uri' : 'standard'));
    formErr.textContent = '';
    syncConfigPath(savedTo);
    testResult.textContent = '';
    dlg.showModal();
    nameInput.focus();
  }

  function closeForm() {
    dlg.close();
  }
  dlg.addEventListener('close', () => { editingId = null; });

  testFormBtn.addEventListener('click', async () => {
    const uri = buildUri(readSettings(), false);
    testFormBtn.disabled = true;
    testResult.textContent = 'testing…';
    testResult.className = 'conn-test-result muted';
    try {
      const r = await App.api('/api/connections/test', { method: 'POST', body: { uri } });
      testResult.textContent = r.ok ? '✓ connected' : '✗ ' + friendlyError(r.error || 'failed');
      testResult.title = r.ok ? '' : r.error || '';
      testResult.className = 'conn-test-result ' + (r.ok ? 'ok' : 'err');
    } catch (err) {
      testResult.textContent = '✗ ' + err.message;
      testResult.title = '';
      testResult.className = 'conn-test-result err';
    } finally {
      testFormBtn.disabled = false;
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const settings = readSettings();
    const uri = buildUri(settings, false);
    if (!uri) { formErr.textContent = 'Connection string is empty.'; return; }
    const body = { name: nameInput.value.trim() || hostsOf(uri) || 'Unnamed', uri, settings, color: colorSel.value };
    try {
      if (editingId) await App.api('/api/connections/' + editingId, { method: 'PUT', body });
      else await App.api('/api/connections', { method: 'POST', body });
      closeForm();
      await reload(true);
    } catch (err) {
      formErr.textContent = err.message;
    }
  });

  // --- connection tree ---
  const filterInput = el('input', 'conn-filter');
  filterInput.type = 'search';
  filterInput.placeholder = 'Filter databases and collections…';
  filterInput.addEventListener('input', applyFilter);

  const listEl = el('div', 'conn-list');
  panel.append(header, filterInput, listEl);

  // Substring filter over whatever the tree has already rendered. A database stays
  // visible when its own name matches, so unexpanded databases are still findable.
  function applyFilter() {
    const q = filterInput.value.trim().toLowerCase();
    const match = (node, sel) => (node.querySelector(sel)?.textContent || '').toLowerCase().includes(q);
    listEl.querySelectorAll('.conn-node').forEach((connNode) => {
      let connHit = !q || match(connNode, '.conn-name');
      connNode.querySelectorAll('.tree-db').forEach((dbNode) => {
        const dbHit = !q || match(dbNode, '.tree-db-head');
        let collHit = false;
        dbNode.querySelectorAll('.tree-coll').forEach((row) => {
          const name = row.querySelector('.tree-coll-name');
          if (!name) return; // hint row ("loading…", errors) — always keep
          const hit = !q || name.textContent.toLowerCase().includes(q);
          row.hidden = !hit;
          collHit = collHit || hit;
        });
        dbNode.hidden = !(dbHit || collHit);
        connHit = connHit || dbHit || collHit;
      });
      connNode.hidden = !connHit;
    });
  }
  // Databases and collections arrive asynchronously — re-filter whenever rows appear.
  // childList only: our own `hidden` toggles are attribute changes, so this can't loop.
  new MutationObserver(applyFilter).observe(listEl, { childList: true, subtree: true });

  // Driver errors → what to check. The raw message stays available as a tooltip.
  function friendlyError(msg) {
    let m;
    if ((m = /ECONNREFUSED ([^\s,]+)/.exec(msg))) return `Nothing is listening on ${m[1]} — is MongoDB running?`;
    if ((m = /ENOTFOUND (?:_mongodb\._tcp\.)?([^\s,]+)/.exec(msg))) return `Host not found: ${m[1]} — check the host name`;
    if (/Authentication failed|bad auth|auth(entication)? error/i.test(msg)) {
      return 'Authentication failed — wrong username/password or auth database';
    }
    if (/timed out|ETIMEDOUT/i.test(msg)) {
      return 'Timed out — check host and port, firewall / Atlas IP access list, and the TLS setting';
    }
    return msg;
  }

  function render() {
    listEl.textContent = '';
    nodes.clear();
    filterInput.hidden = !connections.length;
    if (!connections.length) {
      listEl.append(renderWelcome());
      return;
    }
    for (const rec of connections) listEl.append(renderNode(rec));
  }

  // First run: one click to the usual local server, plus what to do without one.
  function renderWelcome() {
    const box = el('div', 'conn-welcome');
    const quick = el('button', 'primary conn-quick', 'Connect to localhost:27017');
    const quickErr = el('div', 'conn-welcome-err');
    quick.addEventListener('click', async () => {
      const uri = 'mongodb://localhost:27017/';
      quick.disabled = true;
      quick.textContent = 'Connecting…';
      quickErr.textContent = '';
      try {
        const r = await App.api('/api/connections/test', { method: 'POST', body: { uri } });
        if (!r.ok) {
          quickErr.textContent = friendlyError(r.error || 'failed');
          quickErr.title = r.error || '';
          return;
        }
        const rec = await App.api('/api/connections', { method: 'POST', body: {
          name: 'localhost:27017', uri,
          settings: { mode: 'standard', host: 'localhost', port: '27017' },
        } });
        selectedId = rec.id;
        expanded.add(rec.id); // render() loads its databases straight away
        await reload(true);
      } catch (err) {
        quickErr.textContent = err.message;
      } finally {
        quick.disabled = false;
        quick.textContent = 'Connect to localhost:27017';
      }
    });
    const other = el('div', 'conn-welcome-row');
    const add = el('button', '', 'Add connection…');
    add.addEventListener('click', () => openForm(''));
    const paste = el('button', '', 'Paste connection string…');
    paste.addEventListener('click', () => { openForm(''); setMode('uri'); uriInput.value = ''; uriInput.focus(); });
    other.append(add, paste);

    const hint = el('div', 'conn-welcome-hint muted');
    const cmd = 'docker run -d -p 27017:27017 mongo:7';
    const copy = el('button', 'conn-act', 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', () => navigator.clipboard.writeText(cmd)
      .then(() => App.toast('Copied'), () => App.toast('Copy failed — select the text instead', true)));
    hint.append('No MongoDB yet? Start one with Docker:', el('br'), el('code', '', cmd), ' ', copy);

    box.append(el('div', 'conn-welcome-title', 'Connect to MongoDB'),
      el('div', 'muted', 'No saved connections yet.'), quick, quickErr, other, hint, configLine());
    return box;
  }

  function renderNode(rec) {
    const node = el('div', 'conn-node');
    const item = el('div', 'conn-item');
    item.dataset.conn = rec.id; // the tree's context menu (browser.js) reads it
    if (rec.id === selectedId) item.classList.add('selected');

    const arrow = el('span', 'tree-arrow', expanded.has(rec.id) ? '▾' : '▸');
    const name = el('span', 'conn-name', rec.name);
    const dot = el('span', 'conn-dot');
    dot.dataset.color = rec.color || '';
    if (rec.color) dot.title = rec.color;
    const host = el('span', 'conn-host muted mono', hostsOf(rec.uri));
    const status = el('span', 'conn-status');
    const actions = el('span', 'conn-actions');

    const testBtn = mkAction('Test', async () => {
      status.textContent = '…';
      status.className = 'conn-status';
      status.title = '';
      const r = await App.api('/api/connections/' + rec.id + '/test', { method: 'POST' });
      status.textContent = r.ok ? '✓' : '✗';
      status.classList.add(r.ok ? 'ok' : 'err');
      if (!r.ok) {
        status.title = r.error || 'Connection failed';
        App.toast(rec.name + ': ' + friendlyError(r.error || 'connection failed'), true);
      }
      setTimeout(() => { status.textContent = ''; status.className = 'conn-status'; }, 3000);
    });
    const refreshBtn = mkAction('⟳', () => { children.dataset.loaded = ''; expand(true); });
    refreshBtn.title = 'Reload databases';
    const editBtn = mkAction('Edit', () => openForm(rec.id));
    const delBtn = mkAction('Del', async () => {
      if (!await App.confirm('Delete connection "' + rec.name + '"?')) return;
      await App.api('/api/connections/' + rec.id, { method: 'DELETE' });
      if (selectedId === rec.id) selectedId = null;
      // the grid, Export tab and URL must not keep pointing at a deleted connection (C5)
      if (App.state.connectionId === rec.id) App.setTarget(null, null, null);
      expanded.delete(rec.id);
      await reload(true);
    });
    delBtn.classList.add('danger');
    actions.append(testBtn, refreshBtn, editBtn, delBtn);

    item.append(arrow, dot, name, host, status, actions);
    const children = el('div', 'conn-children');
    children.hidden = !expanded.has(rec.id);

    function expand(force) {
      expanded.add(rec.id);
      children.hidden = false;
      arrow.textContent = '▾';
      if (!children.dataset.loaded || force) {
        children.dataset.loaded = '1';
        App.emit('connection-expanded', { connectionId: rec.id, container: children });
      }
    }

    item.addEventListener('click', () => {
      selectedId = rec.id;
      listEl.querySelectorAll('.conn-item.selected').forEach((x) => x.classList.remove('selected'));
      item.classList.add('selected');
      if (expanded.has(rec.id) && !children.hidden) {
        // second click on an already-expanded node collapses it
        expanded.delete(rec.id);
        children.hidden = true;
        arrow.textContent = '▸';
      } else {
        expand(false);
      }
      App.emit('connection-selected', rec.id);
    });

    node.append(item, children);
    nodes.set(rec.id, { item, children, expand });
    // restore subtree if this connection was expanded before a re-render
    if (expanded.has(rec.id)) {
      children.dataset.loaded = '1';
      App.emit('connection-expanded', { connectionId: rec.id, container: children });
    }
    return node;
  }

  function mkAction(label, fn) {
    const b = el('button', 'conn-act', label);
    b.type = 'button';
    b.addEventListener('click', async (e) => {
      e.stopPropagation(); // don't select the item
      try { await fn(); } catch (err) { App.toast(err.message, true); }
    });
    return b;
  }

  async function reload(emit) {
    connections = await App.api('/api/connections');
    App.connections = connections;
    App.renderTarget(); // name / colour may have changed
    render();
    if (emit) App.emit('connections-changed', connections);
  }

  // --- startup picker: the same panel, shown centered over an overlay ---
  const overlay = el('div');
  overlay.id = 'conn-overlay';
  overlay.hidden = true;
  overlay.addEventListener('click', closePicker);
  document.body.appendChild(overlay);

  // The panel lives inside #sidebar, whose display:none (☰ toggle) would hide the
  // picker too — show the sidebar while picking and put the user's choice back after.
  const sidebarEl = document.getElementById('sidebar');
  let pickerOpen = false;
  let sidebarWasHidden = false;

  function openPicker() {
    pickerOpen = true;
    sidebarWasHidden = sidebarEl.hidden;
    sidebarEl.hidden = false;
    overlay.hidden = false;
    document.body.classList.add('conn-modal');
    title.textContent = connections.length ? 'Select a connection' : 'Welcome to MangoDesk';
  }

  function closePicker() {
    if (!pickerOpen) return;
    pickerOpen = false;
    overlay.hidden = true;
    document.body.classList.remove('conn-modal');
    title.textContent = 'Connections';
    if (sidebarWasHidden) sidebarEl.hidden = true;
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pickerOpen && !document.querySelector('dialog[open]')) closePicker();
  });

  // with the sidebar hidden the picker is the only place to choose a collection from,
  // so it stays open until one is chosen
  App.on('connection-selected', () => { if (!sidebarWasHidden) closePicker(); });
  App.on('target', ({ collection }) => { if (collection) closePicker(); });

  // Keep the tree in step with targets set elsewhere (hash links, Back/Forward):
  // highlight the collection, expand its connection and open its database.
  App.on('target', ({ connectionId, db, collection }) => {
    listEl.querySelectorAll('.tree-coll[data-coll]').forEach((r) => r.classList.toggle('active',
      r.dataset.conn === connectionId && r.dataset.db === db && r.dataset.coll === collection));
    const n = collection && nodes.get(connectionId);
    if (!n) return;
    selectedId = connectionId;
    listEl.querySelectorAll('.conn-item.selected').forEach((x) => x.classList.remove('selected'));
    n.item.classList.add('selected');
    const wasLoaded = n.children.dataset.loaded;
    n.expand(false);
    if (!wasLoaded) return; // a fresh load opens the active database itself
    const head = [...n.children.querySelectorAll('.tree-db-head')]
      .find((h) => h.lastElementChild && h.lastElementChild.textContent === db);
    if (head && head.getAttribute('aria-expanded') === 'false') head.click();
  });

  // Startup: open the collection named by the URL hash, else the last one, if its
  // connection still exists; otherwise show the picker (or the first-run welcome).
  reload(false)
    .then(() => {
      const linked = App.hashTarget();
      let last = linked;
      if (!last) try { last = JSON.parse(localStorage.getItem('lastTarget')); } catch { /* ignore */ }
      if (last && last.collection && connections.some((c) => c.id === last.connectionId)) {
        App.setTarget(last.connectionId, last.db, last.collection, { replace: true });
        return;
      }
      if (linked) App.toast('That link points to a connection that is not saved here', true);
      openPicker();
    }, (e) => {
      listEl.textContent = '';
      const err = el('div', 'conn-empty conn-load-err', 'Failed to load connections: ' + e.message);
      const retry = el('button', 'conn-act', 'Retry');
      retry.addEventListener('click', () => location.reload());
      err.append(' ', retry);
      listEl.append(err);
    });
})();
