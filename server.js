#!/usr/bin/env node
const path = require('path');
const express = require('express');
const sea = require('./lib/sea');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false, limit: '10mb' })); // export download form
// Inside a single-executable build public/ is embedded as SEA assets; otherwise serve from disk.
app.use(sea.isSea() ? sea.staticAssets() : express.static(path.join(__dirname, 'public')));

// static requires (not a loop over names) so a bundler can follow them
app.use(require('./routes/connections'));
app.use(require('./routes/data'));
app.use(require('./routes/export'));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // parse/validation/mongo errors are caused by user input → 400; the rest is on us
  const status = err.status
    || (err instanceof SyntaxError || err.name === 'BSONError' || err.name === 'MongoServerError' ? 400 : 500);
  res.status(status).json({ error: err.message });
});

const PORT = process.env.PORT || 27080;
const url = `http://localhost:${PORT}`;
// localhost only: the API exposes stored DB credentials and unauthenticated read/write
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`MangoDesk running on ${url}`);
  if (sea.isSea() && !process.env.MANGODESK_NO_OPEN) openBrowser(url);
});
server.on('error', (err) => {
  // double-clicked a second time: an instance already owns the port, just show it
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} is busy — MangoDesk is probably already running at ${url}`);
    if (sea.isSea() && !process.env.MANGODESK_NO_OPEN) openBrowser(url);
    setTimeout(() => process.exit(0), 1500);
    return;
  }
  throw err;
});

function openBrowser(target) {
  const { spawn } = require('child_process');
  // explorer.exe hands a URL to the default browser without cmd.exe quoting games
  const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [target]]
    : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch { /* headless box: the URL is printed above */ }
}
