const fs = require('fs');
const os = require('os');
const path = require('path');
const sea = require('./sea');

// ponytail: plaintext URI storage in a local JSON file; move to OS keychain if it matters.
// npx/global installs live in a throwaway dir, so config belongs in the home dir; an
// existing repo-local file still wins so dev checkouts keep the connections they have.
// Release binaries: a connections.json placed next to the executable enables portable
// mode (e.g. on a USB stick); __dirname is meaningless inside a bundled SEA.
const LOCAL = sea.isSea()
  ? path.join(sea.exeDir(), 'connections.json')
  : path.join(__dirname, '..', 'connections.json');
const FILE = path.resolve(process.env.MANGODESK_CONFIG
  || (fs.existsSync(LOCAL) ? LOCAL : path.join(os.homedir(), '.mangodesk.json')));
const POSIX = process.platform !== 'win32';

function load() {
  let raw;
  try { raw = fs.readFileSync(FILE, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  // corrupt file: fail loudly (and never save over it) instead of returning [] and
  // wiping every connection on the next save
  let data, why = 'expected a JSON array of connections';
  try { data = JSON.parse(raw); } catch (e) { why = e.message; }
  if (!Array.isArray(data)) {
    throw Object.assign(new Error(`The connections file ${FILE} is unreadable (${why}). `
      + 'Fix it in a text editor, or move it aside to start with no connections, then reload.'),
    { status: 500, code: 'CONFIG_CORRUPT' });
  }
  return data;
}

// Owner-only: the file holds plaintext passwords. mode on open only applies when a file
// is created, so files written 0644 by older versions are tightened here too.
function harden(file) {
  if (POSIX) try { fs.chmodSync(file, 0o600); } catch { /* not ours / odd FS: best effort */ }
}

function save(list) {
  const data = JSON.stringify(list, null, 2) + '\n';
  let target = FILE; // write through a symlink instead of replacing it
  try { target = fs.realpathSync(FILE); } catch { /* not there yet */ }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // atomic: temp file in the same dir, flushed, then renamed over the original, so a
  // crash or full disk mid-write leaves the old file intact rather than truncated
  const tmp = `${target}.tmp-${process.pid}`;
  let fd;
  try { fd = fs.openSync(tmp, 'w', 0o600); } catch (e) {
    // writable file in a directory we can't create files in: in place, as before
    if (e.code !== 'EACCES' && e.code !== 'EPERM' && e.code !== 'EROFS') throw e;
    fs.writeFileSync(target, data, { mode: 0o600 });
    return harden(target);
  }
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
  fs.closeSync(fd);
  harden(tmp); // a umask can't widen 0600, but a stale tmp from a crash may be looser
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    // Windows: antivirus/indexer holding the file -> EPERM/EBUSY; fall back to in-place
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    if (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES') throw e;
    fs.writeFileSync(target, data, { mode: 0o600 });
  }
  harden(target);
}

module.exports = { load, save, FILE };
