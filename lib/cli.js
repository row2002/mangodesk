// Command-line handling for server.js: flags, browser auto-open, port selection.
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_PORT = 27080;
const PORT_TRIES = 10; // extra ports tried when the default one is taken by another program

const HELP = `Usage: mangodesk [options]

  -p, --port N   port to listen on (default ${DEFAULT_PORT}, env PORT)
      --no-open  don't open the browser (env MANGODESK_NO_OPEN=1)
  -v, --version  print the version and exit
  -h, --help     print this help and exit

Environment:
  MANGODESK_CONFIG=<path>  connections file to use instead of ~/.mangodesk.json`;

// Pure: argv (without node + script) and env -> options. Errors are returned, not thrown.
function parseArgs(argv, env = {}) {
  const opts = { port: DEFAULT_PORT, explicitPort: false, open: true, help: false, version: false, error: null };
  let portRaw = env.PORT ? String(env.PORT) : undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.startsWith('--port=') ? a.slice(7) : null;
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-v' || a === '--version') opts.version = true;
    else if (a === '--no-open') opts.open = false;
    else if (eq !== null) portRaw = eq;
    else if (a === '-p' || a === '--port') {
      if (i + 1 >= argv.length) return { ...opts, error: `${a} needs a port number` };
      portRaw = argv[++i];
    } else return { ...opts, error: `Unknown option: ${a}` };
  }
  if (portRaw !== undefined) {
    const n = Number(portRaw);
    // a non-numeric PORT would otherwise be taken by listen() as a pipe path
    if (!/^\d+$/.test(portRaw.trim()) || n < 1 || n > 65535) return { ...opts, error: `Invalid port: ${portRaw}` };
    Object.assign(opts, { port: n, explicitPort: true });
  }
  const off = (v) => v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
  if (off(env.MANGODESK_NO_OPEN) || off(env.CI)) opts.open = false;
  return opts;
}

// No desktop to open a browser on: headless Linux/BSD, e.g. a jump host over SSH.
function hasDisplay(env = process.env, platform = process.platform) {
  return platform === 'win32' || platform === 'darwin' || !!(env.DISPLAY || env.WAYLAND_DISPLAY);
}

function openBrowser(url) {
  // no shell anywhere: explorer.exe hands a URL to the default browser without cmd.exe quoting
  const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
  } catch { /* no opener: the URL is printed anyway */ }
}

// Resolves with the /api/version body when a MangoDesk answers on this port, else null.
function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/version', timeout: 1500 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { const v = JSON.parse(body); resolve(v && v.app === 'mangodesk' ? v : null); } catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function tryListen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { server.off('listening', onListening); reject(err); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1'); // localhost only: the API exposes stored DB credentials
  });
}

const CASELESS_FS = process.platform === 'win32' || process.platform === 'darwin';
function sameFile(a, b) {
  a = path.resolve(a); b = path.resolve(b);
  return CASELESS_FS ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// -> { server, port } once listening, or { reused: true, port } when a MangoDesk using the
// same connections file (configFile; any, if omitted) already owns a port we tried.
// Throws a friendly-message error when no port can be had.
async function listen(handler, { port, explicitPort, configFile }) {
  const last = explicitPort ? port : Math.min(port + PORT_TRIES, 65535);
  const hint = `Try: mangodesk --port ${port === 65535 ? DEFAULT_PORT : port + 1}`;
  for (let p = port; p <= last; p++) {
    const server = http.createServer(handler);
    try {
      await tryListen(server, p);
      return { server, port: p };
    } catch (err) {
      if (err.code !== 'EADDRINUSE') {
        if (err.code === 'EACCES') err.message = `Not allowed to listen on port ${p}. Try: mangodesk --port ${DEFAULT_PORT}`;
        throw err;
      }
      const other = await probe(p);
      // another MangoDesk on a different connections file (MANGODESK_CONFIG, portable
      // mode, another user) is not ours to hand over to: treat it as a foreign program
      if (other && (!configFile || sameFile(String(other.configFile), configFile))) {
        return { reused: true, port: p };
      }
      if (other && explicitPort) {
        throw Object.assign(new Error(`Port ${p} is used by another MangoDesk with connections file `
          + `${other.configFile}, not ${configFile}. ${hint}`), { code: 'EADDRINUSE' });
      }
    }
  }
  const msg = explicitPort
    ? `Port ${port} is in use by another program. ${hint}`
    : `Ports ${port}-${last} are all in use by other programs. Try: mangodesk --port <free port>`;
  throw Object.assign(new Error(msg), { code: 'EADDRINUSE' });
}

module.exports = { parseArgs, hasDisplay, openBrowser, probe, listen, HELP, DEFAULT_PORT };
