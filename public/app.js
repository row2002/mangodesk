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

  showTab(name) {
    document.querySelectorAll('.tab-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab-content').forEach((s) =>
      s.classList.toggle('active', s.id === 'tab-' + name));
  },
};

document.querySelectorAll('.tab-btn').forEach((b) =>
  b.addEventListener('click', () => App.showTab(b.dataset.tab)));

document.getElementById('sidebar-toggle').addEventListener('click', () => {
  const sb = document.getElementById('sidebar');
  sb.hidden = !sb.hidden;
});
