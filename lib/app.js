// Express app construction, separate from listening so tests can mount it on any port.
const path = require('path');
const express = require('express');
const sea = require('./sea');
const store = require('./store');
const { version } = require('../package.json');

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const hostname = (host) => { try { return new URL('http://' + host).hostname; } catch { return null; } };

// Binding 127.0.0.1 only keeps other machines out; these checks keep web pages out.
function guard(req, res, next) {
  const host = String(req.headers.host || '').toLowerCase();
  // DNS rebinding: a rebound page still sends its own hostname in Host (any port is
  // fine, so `ssh -L 9000:127.0.0.1:27080` tunnels keep working)
  if (!LOOPBACK.has(hostname(host))) return res.status(403).json({ error: 'Forbidden host' });
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  // CSRF: a browser sends Origin on every POST/PUT/DELETE (form posts included);
  // only the page served from this very host:port may write. "null" fails to parse.
  const origin = req.headers.origin;
  const site = req.headers['sec-fetch-site'];
  let ok = site === undefined || site === 'same-origin' || site === 'none';
  if (origin !== undefined) {
    try { const u = new URL(origin); ok = ok && u.protocol === 'http:' && u.host === host; } catch { ok = false; }
  }
  if (!ok) return res.status(403).json({ error: 'Cross-origin request refused' });
  next();
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(guard);
  app.use(express.json({ limit: '10mb' }));
  // the export download is a plain form POST; nothing else accepts form bodies
  app.use('/api/export', express.urlencoded({ extended: false, limit: '10mb' }));
  // With no parser for the Content-Type, body-parser 2 (express 5) leaves req.body
  // unset where 1.x left {}; the routes read it unconditionally, so keep the old shape.
  app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });
  // Inside a single-executable build public/ is embedded as SEA assets; otherwise serve from disk.
  app.use(sea.isSea() ? sea.staticAssets() : express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/version', (req, res) => res.json({ app: 'mangodesk', version, configFile: store.FILE }));
  // static requires (not a loop over names) so a bundler can follow them
  app.use(require('../routes/connections'));
  app.use(require('../routes/data'));
  app.use(require('../routes/export'));
  app.use('/api', (req, res) => res.status(404).json({ error: `No such endpoint: ${req.method} ${req.originalUrl}` }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // parse/validation/mongo errors are caused by user input → 400; the rest is on us
    const status = err.status
      || (err instanceof SyntaxError || err.name === 'BSONError' || err.name === 'MongoServerError' ? 400 : 500);
    res.status(status).json(err.code === 'CONFIG_CORRUPT'
      ? { error: err.message, code: err.code, configFile: store.FILE }
      : { error: err.message });
  });
  return app;
}

module.exports = { createApp, guard, version };
