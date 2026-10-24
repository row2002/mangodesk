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
  // and unlike window.confirm it looks like the rest of the app.
  confirm(message, okLabel = 'Delete') {
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
    dlg.append(p, row);
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
      dlg.addEventListener('cancel', () => finish(false)); // Esc
      dlg.addEventListener('close', () => finish(false));
      dlg.showModal();
      cancel.focus();
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
