// Core: shared state, event bus, API helper, tab switching.
const App = {
  state: { connectionId: null, db: null, collection: null },
  listeners: {},
  connections: [], // saved connections, kept current by connections.js (target label, hash links)
  info: null,      // GET /api/version: { version, configFile }

  on(event, fn) {
    (this.listeners[event] ||= []).push(fn);
  },

  emit(event, data) {
    (this.listeners[event] || []).forEach((fn) => fn(data));
  },

  // Set the active collection. Emits 'target' with state. The single writer of the
  // URL hash (#/<connectionId>/<db>/<collection>): each change is a history entry, so
  // Back/Forward walk between collections; `replace` rewrites the current entry.
  setTarget(connectionId, db, collection, { replace = false } = {}) {
    Object.assign(this.state, { connectionId, db, collection });
    localStorage.setItem('lastTarget', JSON.stringify(this.state));
    const h = this.hashTarget();
    const same = h ? h.connectionId === connectionId && h.db === db && h.collection === collection : !collection;
    if (!same) {
      const url = collection
        ? '#/' + [connectionId, db, collection].map(encodeURIComponent).join('/')
        : location.pathname + location.search;
      if (replace || !collection) history.replaceState(null, '', url);
      else history.pushState(null, '', url);
    }
    this.renderTarget();
    this.emit('target', this.state);
  },

  // The target named by the URL hash, or null.
  hashTarget() {
    const m = /^#\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(location.hash);
    if (!m) return null;
    try {
      const [connectionId, db, collection] = m.slice(1).map(decodeURIComponent);
      return { connectionId, db, collection };
    } catch { return null; }
  },

  // Top bar: "Connection › db.collection" plus the connection's colour stripe, so it is
  // always clear which server an edit or delete is about to hit.
  renderTarget() {
    const { connectionId, db, collection } = this.state;
    const rec = collection && this.connections.find((c) => c.id === connectionId);
    const label = document.getElementById('target-label');
    label.textContent = '';
    if (collection) {
      if (rec) {
        const name = document.createElement('span');
        name.className = 'target-conn';
        name.dataset.color = rec.color || '';
        name.textContent = rec.name;
        label.append(name, ' › ');
      }
      label.append(`${db}.${collection}`);
    }
    document.getElementById('topbar').dataset.color = (rec && rec.color) || '';
    document.title = collection ? `${collection} — MangoDesk` : 'MangoDesk';
  },

  async api(url, opts = {}) {
    let res;
    try {
      res = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...opts,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      // fetch rejects (TypeError "Failed to fetch") only when nothing answers at all
      this.serverDown(true);
      throw new Error('Cannot reach the MangoDesk server — is it still running?');
    }
    this.serverDown(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || res.statusText);
    }
    return res.json();
  },

  // Banner while the server is unreachable; polls until it answers again.
  serverDown(down) {
    const banner = document.getElementById('server-down');
    if (banner.hidden === !down) return;
    banner.hidden = !down;
    clearInterval(this._pingTimer);
    if (!down) return;
    this._pingTimer = setInterval(() => {
      fetch('/api/version').then((r) => { if (r.ok) this.serverDown(false); }, () => {});
    }, 3000);
  },

  // Confirmation prompt. Native <dialog> gives Esc, focus trap and a backdrop for free,
  // and unlike window.confirm it looks like the rest of the app. With requireText the
  // OK button stays disabled until exactly that text is typed (drops of whole
  // collections / databases).
  confirm(message, okLabel = 'Delete', { requireText } = {}) {
    const dlg = document.createElement('dialog');
    dlg.className = 'app-confirm';
    const p = document.createElement('p');
    p.textContent = message;
    const row = document.createElement('div');
    row.className = 'app-confirm-actions';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.className = 'danger';
    ok.textContent = okLabel;
    row.append(cancel, ok);
    dlg.appendChild(p);
    let typed = null;
    if (requireText !== undefined) {
      const label = document.createElement('label');
      label.className = 'app-form-field';
      const what = document.createElement('span');
      what.append('Type ');
      const b = document.createElement('b');
      b.className = 'mono';
      b.textContent = requireText;
      what.append(b, ' to confirm');
      typed = document.createElement('input');
      typed.className = 'mono';
      typed.spellcheck = false;
      typed.autocomplete = 'off';
      label.append(what, typed);
      dlg.appendChild(label);
      ok.disabled = true;
      typed.addEventListener('input', () => { ok.disabled = typed.value !== requireText; });
    }
    dlg.appendChild(row);
    document.body.appendChild(dlg);
    return new Promise((resolve) => {
      let done = false;
      // Settle from the handlers we control rather than from the 'close' event —
      // that event is not reliably delivered in every embedded browser.
      const finish = (answer) => {
        if (done) return;
        done = true;
        if (dlg.open) dlg.close();
        dlg.remove();
        resolve(answer);
      };
      ok.addEventListener('click', () => finish(true));
      cancel.addEventListener('click', () => finish(false));
      if (typed) typed.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !ok.disabled) finish(true); });
      dlg.addEventListener('cancel', () => finish(false)); // Esc
      dlg.addEventListener('close', () => finish(false));
      dlg.showModal();
      (typed || cancel).focus();
    });
  },

  // Small input dialog. fields: [{ name, label, type ('text' | 'number' | 'checkbox' |
  // 'textarea'), value, placeholder, hint, required, mono }]. validate(values) returns an error to show
  // (Submit stays disabled); submit(values) runs on Submit and may throw — the message
  // is shown and the dialog stays open. Resolves with submit's result, or null on Cancel.
  form({ title, fields, okLabel = 'OK', validate, submit }) {
    const dlg = document.createElement('dialog');
    dlg.className = 'app-confirm app-form';
    const h = document.createElement('h3');
    h.textContent = title;
    dlg.appendChild(h);
    const inputs = {};
    for (const f of fields) {
      const label = document.createElement('label');
      label.className = 'app-form-field' + (f.type === 'checkbox' ? ' app-form-check' : '');
      const text = document.createElement('span');
      text.textContent = f.label;
      let input;
      if (f.type === 'textarea') {
        input = document.createElement('textarea');
        input.rows = 3;
      } else {
        input = document.createElement('input');
        input.type = f.type || 'text';
      }
      if (f.type === 'checkbox') input.checked = !!f.value;
      else input.value = f.value == null ? '' : f.value;
      if (f.placeholder) input.placeholder = f.placeholder;
      if (f.type !== 'checkbox') { input.spellcheck = false; input.autocomplete = 'off'; }
      if (f.mono) input.classList.add('mono');
      if (f.type === 'checkbox') label.append(input, text);
      else label.append(text, input);
      if (f.hint) {
        const hint = document.createElement('small');
        hint.className = 'muted';
        hint.textContent = f.hint;
        label.appendChild(hint);
      }
      inputs[f.name] = input;
      dlg.appendChild(label);
    }
    const err = document.createElement('div');
    err.className = 'app-form-error';
    const row = document.createElement('div');
    row.className = 'app-confirm-actions';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.className = 'primary';
    ok.textContent = okLabel;
    row.append(cancel, ok);
    dlg.append(err, row);
    document.body.appendChild(dlg);

    const values = () => Object.fromEntries(fields.map((f) => [f.name,
      f.type === 'checkbox' ? inputs[f.name].checked : inputs[f.name].value]));
    let busy = false;
    // a blank required field only disables Submit; validate's message is shown
    const check = () => {
      const v = values();
      let msg = '';
      try { msg = (validate && validate(v)) || ''; } catch (e) { msg = e.message; }
      err.textContent = msg;
      const ready = !msg && fields.every((f) => !f.required || String(v[f.name]).trim());
      ok.disabled = busy || !ready;
      return ready;
    };
    dlg.addEventListener('input', check);
    dlg.addEventListener('change', check);
    check();

    return new Promise((resolve) => {
      let done = false;
      const finish = (answer) => {
        if (done) return;
        done = true;
        if (dlg.open) dlg.close();
        dlg.remove();
        resolve(answer);
      };
      const onOk = async () => {
        if (busy || !check()) return;
        busy = true;
        ok.disabled = true;
        try {
          finish(submit ? await submit(values()) : values());
        } catch (e) {
          err.textContent = e.message;
        } finally {
          busy = false;
          if (!done) ok.disabled = false;
        }
      };
      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', () => finish(null));
      dlg.addEventListener('keydown', (e) => {
        // Enter submits from a one-line field; Ctrl+Enter from anywhere
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || e.target.tagName === 'INPUT')) {
          e.preventDefault();
          onOk();
        }
      });
      dlg.addEventListener('cancel', () => finish(null)); // Esc
      dlg.addEventListener('close', () => finish(null));
      dlg.showModal();
      const first = Object.values(inputs)[0];
      if (first) { first.focus(); if (first.select) first.select(); }
    });
  },

  // Transient status line in the top bar — for things that don't deserve a dialog.
  // `undo` adds an inline button that runs it and clears the toast.
  toast(message, isError, undo) {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.className = isError ? 'err' : '';
    if (undo) {
      const b = document.createElement('button');
      b.id = 'toast-undo';
      b.textContent = 'Undo';
      b.addEventListener('click', () => { el.textContent = ''; undo(); });
      el.appendChild(b);
    }
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { el.textContent = ''; }, undo ? 8000 : 4000);
  },

  // Per-collection scratch state (query bar, query builder) kept in localStorage.
  memKey(kind) {
    const { connectionId, db, collection } = this.state;
    return `mangodesk.${kind}:${connectionId}:${db}:${collection}`;
  },
  memGet(kind) {
    try { return JSON.parse(localStorage.getItem(this.memKey(kind))); } catch { return null; }
  },
  memSet(kind, value) {
    localStorage.setItem(this.memKey(kind), JSON.stringify(value));
  },

  showTab(name) {
    document.querySelectorAll('.tab-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab-content').forEach((s) =>
      s.classList.toggle('active', s.id === 'tab-' + name));
  },
};

document.querySelectorAll('.tab-btn').forEach((b) =>
  b.addEventListener('click', () => App.showTab(b.dataset.tab)));

// Back/Forward and pasted links: follow the hash to its collection.
addEventListener('hashchange', () => {
  const t = App.hashTarget();
  const s = App.state;
  if (!t || (t.connectionId === s.connectionId && t.db === s.db && t.collection === s.collection)) return;
  if (!App.connections.some((c) => c.id === t.connectionId)) {
    App.toast('That link points to a connection that is not saved here', true);
    return;
  }
  App.setTarget(t.connectionId, t.db, t.collection);
});

App.api('/api/version').then((info) => {
  App.info = info;
  document.getElementById('app-version').textContent = 'v' + info.version;
  document.getElementById('logo').title = `MangoDesk v${info.version}\nConnections file: ${info.configFile}`;
  App.emit('info', info);
}).catch(() => { /* serverDown() already shows the banner */ });

const sidebar = document.getElementById('sidebar');
if (localStorage.getItem('mangodesk.sidebarHidden') === '1') sidebar.hidden = true;
document.getElementById('sidebar-toggle').addEventListener('click', () => {
  sidebar.hidden = !sidebar.hidden;
  localStorage.setItem('mangodesk.sidebarHidden', sidebar.hidden ? '1' : '0');
});

/* ---- theme ---- */

const themeBtn = document.getElementById('theme-toggle');
const prefersLight = matchMedia('(prefers-color-scheme: light)').matches;

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeBtn.textContent = theme === 'light' ? '☀' : '🌙';
  localStorage.setItem('mangodesk.theme', theme);
}
applyTheme(localStorage.getItem('mangodesk.theme') || (prefersLight ? 'light' : 'dark'));
themeBtn.addEventListener('click', () =>
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'));

/* ---- draggable panel widths ---- */

// A grip pinned to the panel edge; the width is remembered per panel.
function makeResizable(panel, side) {
  const key = 'mangodesk.width.' + panel.id;
  const saved = Number(localStorage.getItem(key));
  if (saved) panel.style.width = saved + 'px';
  const grip = document.createElement('div');
  grip.className = 'panel-resizer panel-resizer-' + side;
  panel.appendChild(grip);
  grip.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panel.offsetWidth;
    const onMove = (ev) => {
      const delta = side === 'right' ? ev.clientX - startX : startX - ev.clientX;
      panel.style.width = Math.min(720, Math.max(180, startW + delta)) + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      localStorage.setItem(key, panel.offsetWidth);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
makeResizable(sidebar, 'right');
makeResizable(document.getElementById('query-panel'), 'left');

/* ---- keyboard shortcuts help ---- */

const SHORTCUTS = [
  ['Query', [
    ['Ctrl+Enter', 'Run the query (Data tab)'],
    ['Enter', 'Run from the filter field'],
    ['Shift+Enter', 'New line in the filter field'],
    ['Ctrl+F', 'Jump to the filter field'],
    ['Alt+← / Alt+→', 'Previous / next page'],
  ]],
  ['Editing', [
    ['Double-click', 'Edit a value in place'],
    ['Enter / Esc', 'Save / cancel the inline edit'],
    ['Ctrl+Enter', 'Save in the document editor'],
    ['Tab', 'Indent in the document editor'],
  ]],
  ['Navigation', [
    ['↑ / ↓', 'Move through the sidebar tree'],
    ['→ / ←', 'Expand / collapse a database'],
    ['Enter', 'Open the focused database or collection'],
    ['Right-click / Shift+F10', 'Tree menu: create, rename, clear, drop'],
    ['Esc', 'Close a dialog or menu'],
    ['?', 'Show this help'],
  ]],
];
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

function openHelp() {
  if (document.querySelector('.help-dialog[open]')) return;
  const dlg = document.createElement('dialog');
  dlg.className = 'app-confirm help-dialog';
  const h = document.createElement('h3');
  h.textContent = 'Keyboard shortcuts';
  dlg.appendChild(h);
  for (const [group, rows] of SHORTCUTS) {
    const t = document.createElement('table');
    const cap = document.createElement('caption');
    cap.textContent = group;
    t.appendChild(cap);
    for (const [keys, what] of rows) {
      const tr = t.insertRow();
      const k = tr.insertCell();
      for (const [i, key] of keys.split(' / ').entries()) {
        if (i) k.append(' / ');
        const kbd = document.createElement('kbd');
        kbd.textContent = isMac ? key.replace('Ctrl+', '⌘').replace('Alt+', '⌥') : key;
        k.appendChild(kbd);
      }
      tr.insertCell().textContent = what;
    }
    dlg.appendChild(t);
  }
  const foot = document.createElement('p');
  foot.className = 'muted help-foot';
  foot.textContent = App.info ? `MangoDesk v${App.info.version} · connections saved in ${App.info.configFile}` : '';
  const row = document.createElement('div');
  row.className = 'app-confirm-actions';
  const ok = document.createElement('button');
  ok.textContent = 'Close';
  ok.addEventListener('click', () => dlg.close());
  row.appendChild(ok);
  dlg.append(foot, row);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.appendChild(dlg);
  dlg.showModal();
  ok.focus();
}

document.getElementById('help-toggle').addEventListener('click', openHelp);
document.addEventListener('keydown', (e) => {
  if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
  if (document.querySelector('dialog[open]')) return;
  e.preventDefault();
  openHelp();
});
