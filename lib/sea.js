// Helpers for running as a Node Single Executable Application (release binaries).
// Outside a SEA every export degrades to a no-op so `node server.js` / npx are unchanged.
const path = require('path');

let sea = null;
try { sea = require('node:sea'); } catch { /* Node < 20 has no node:sea */ }

const isSea = () => !!(sea && sea.isSea());

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
};

// Express middleware serving public/* from the assets embedded by sea-config.json.
// Asset keys are the public/-relative paths ("index.html", "css/browser.css", ...).
function staticAssets() {
  const cache = new Map();
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let key = decodeURIComponent(req.path).replace(/^\/+/, '');
    if (key === '' || key.endsWith('/')) key += 'index.html';
    if (key.includes('..')) return next();
    let body = cache.get(key);
    if (body === undefined) {
      try { body = Buffer.from(sea.getAsset(key)); } catch { body = null; } // throws if absent
      cache.set(key, body);
    }
    if (!body) return next();
    res.setHeader('Content-Type', TYPES[path.extname(key)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(req.method === 'HEAD' ? undefined : body);
  };
}

// Directory of the running binary (portable-mode config lives next to it).
const exeDir = () => path.dirname(process.execPath);

module.exports = { isSea, staticAssets, exeDir };
