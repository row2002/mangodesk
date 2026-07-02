// Connection manager: settings form + collapsible connection→databases tree.
// Renders into #connections-panel.
(() => {
  const panel = document.getElementById('connections-panel');
  let connections = [];
  let selectedId = null;
  let editingId = null; // null = form closed, '' = adding, otherwise id being edited
  const expanded = new Set(); // connection ids expanded in the tree

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

  const stdBox = el('div', 'conn-std');
  stdBox.append(
    row2('hostport', field('Host', hostInput), field('Port', portInput)),
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

  form.append(dlgTitle, field('Name (optional)', nameInput), modeTabs, stdBox, uriBox,
    uriPreview, formErr, footer);

  function setMode(m) {
    mode = m;
    stdTab.classList.toggle('active', m === 'standard');
    uriTab.classList.toggle('active', m === 'uri');
    stdBox.hidden = m !== 'standard';
    uriBox.hidden = m !== 'uri';
    updatePreview();
  }
  stdTab.addEventListener('click', () => setMode('standard'));
  uriTab.addEventListener('click', () => setMode('uri'));

  function readSettings() {
    return {
      mode,
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
    return 'mongodb://' + auth + s.host + ':' + s.port + '/' + (params.length ? '?' + params.join('&') : '');
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
    userInput.value = s.username || '';
    passInput.value = s.password || '';
    passInput.type = 'password';
    passToggle.classList.remove('active');
    authDbInput.value = s.authDb || '';
    tlsInput.checked = !!s.tls;
    optsInput.value = s.options || '';
    uriInput.value = s.uri || (rec && !rec.settings ? rec.uri : '');
    setMode(s.mode || (rec && !rec.settings ? 'uri' : 'standard'));
    formErr.textContent = '';
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
      testResult.textContent = r.ok ? '✓ connected' : '✗ ' + (r.error || 'failed');
      testResult.className = 'conn-test-result ' + (r.ok ? 'ok' : 'err');
    } catch (err) {
      testResult.textContent = '✗ ' + err.message;
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
    let fallback = 'Unnamed';
    try { fallback = new URL(uri).host || fallback; } catch {}
    const body = { name: nameInput.value.trim() || fallback, uri, settings };
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
  const listEl = el('div', 'conn-list');
  panel.append(header, listEl);

  function hostOf(rec) {
    try { return new URL(rec.uri).host; } catch { return ''; }
  }

  function render() {
    listEl.textContent = '';
    if (!connections.length) {
      listEl.append(el('div', 'muted conn-empty', 'No connections yet.'));
      return;
    }
    for (const rec of connections) listEl.append(renderNode(rec));
  }

  function renderNode(rec) {
    const node = el('div', 'conn-node');
    const item = el('div', 'conn-item');
    if (rec.id === selectedId) item.classList.add('selected');

    const arrow = el('span', 'tree-arrow', expanded.has(rec.id) ? '▾' : '▸');
    const name = el('span', 'conn-name', rec.name);
    const host = el('span', 'conn-host muted mono', hostOf(rec));
    const status = el('span', 'conn-status');
    const actions = el('span', 'conn-actions');

    const testBtn = mkAction('Test', async () => {
      status.textContent = '…';
      status.className = 'conn-status';
      status.title = '';
      const r = await App.api('/api/connections/' + rec.id + '/test', { method: 'POST' });
      status.textContent = r.ok ? '✓' : '✗';
      status.classList.add(r.ok ? 'ok' : 'err');
      if (!r.ok) status.title = r.error || 'Connection failed';
      setTimeout(() => { status.textContent = ''; status.className = 'conn-status'; }, 3000);
    });
    const refreshBtn = mkAction('⟳', () => { children.dataset.loaded = ''; expand(true); });
    refreshBtn.title = 'Reload databases';
    const editBtn = mkAction('Edit', () => openForm(rec.id));
    const delBtn = mkAction('Del', async () => {
      if (!confirm('Delete connection "' + rec.name + '"?')) return;
      await App.api('/api/connections/' + rec.id, { method: 'DELETE' });
      if (selectedId === rec.id) selectedId = null;
      expanded.delete(rec.id);
      await reload(true);
    });
    delBtn.classList.add('danger');
    actions.append(testBtn, refreshBtn, editBtn, delBtn);

    item.append(arrow, name, host, status, actions);
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
      try { await fn(); } catch (err) { alert(err.message); }
    });
    return b;
  }

  async function reload(emit) {
    connections = await App.api('/api/connections');
    render();
    if (emit) App.emit('connections-changed', connections);
  }

  // --- startup picker: the same panel, shown centered over an overlay ---
  const overlay = el('div');
  overlay.id = 'conn-overlay';
  overlay.hidden = true;
  overlay.addEventListener('click', closePicker);
  document.body.appendChild(overlay);

  function openPicker() {
    overlay.hidden = false;
    document.body.classList.add('conn-modal');
    title.textContent = 'Select a connection';
  }

  function closePicker() {
    overlay.hidden = true;
    document.body.classList.remove('conn-modal');
    title.textContent = 'Connections';
  }

  App.on('connection-selected', closePicker);

  // Startup: force picking a connection before any data is shown.
  reload(false)
    .catch((e) => alert('Failed to load connections: ' + e.message))
    .then(() => {
      openPicker();
      if (!connections.length) openForm('');
    });
})();
