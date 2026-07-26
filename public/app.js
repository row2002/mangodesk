// Core: shared state, event bus, API helper, tab switching.
const App = {
  state: { connectionId: null, db: null, collection: null },
  listeners: {},

  on(event, fn) {
    (this.listeners[event] ||= []).push(fn);
  },

  emit(event, data) {
    (this.listeners[event] || []).forEach((fn) => fn(data));
  },

  // Set the active collection. Emits 'target' with state.
  setTarget(connectionId, db, collection) {
    Object.assign(this.state, { connectionId, db, collection });
    localStorage.setItem('lastTarget', JSON.stringify(this.state));
    document.getElementById('target-label').textContent =
      collection ? `${db}.${collection}` : '';
    this.emit('target', this.state);
  },

  async api(url, opts = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || res.statusText);
    }
    return res.json();
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
