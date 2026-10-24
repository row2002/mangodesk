// lib/store.js: atomic owner-only writes, corrupt-file errors, MANGODESK_CONFIG.
const { test, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mangodesk-store-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const POSIX = process.platform !== 'win32';
const mode = (f) => fs.statSync(f).mode & 0o777;

// FILE is resolved at require time, so each case loads a fresh copy
let n = 0;
function fresh(config) {
  const file = config || path.join(root, `case${++n}`, 'connections.json');
  process.env.MANGODESK_CONFIG = file;
  delete require.cache[require.resolve('../lib/store')];
  return { store: require('../lib/store'), file: path.resolve(file) };
}

test('missing file loads as an empty list; save creates dirs and round-trips', () => {
  const { store, file } = fresh();
  assert.deepStrictEqual(store.load(), []);
  store.save([{ id: 'a', name: 'x', uri: 'mongodb://h' }]);
  assert.deepStrictEqual(store.load(), [{ id: 'a', name: 'x', uri: 'mongodb://h' }]);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['connections.json'], 'no temp files left behind');
});

test('MANGODESK_CONFIG is honoured and exported as an absolute path', () => {
  const rel = path.relative(process.cwd(), path.join(root, 'rel', 'my.json'));
  const { store, file } = fresh(rel);
  assert.ok(path.isAbsolute(store.FILE));
  assert.strictEqual(store.FILE, file);
  store.save([]);
  assert.ok(fs.existsSync(file));
});

test('file is owner-only (0600), and an existing 0644 file is tightened on save', { skip: !POSIX }, () => {
  const { store, file } = fresh();
  store.save([]);
  assert.strictEqual(mode(file), 0o600);
  fs.chmodSync(file, 0o644);
  store.save([{ id: 'b' }]);
  assert.strictEqual(mode(file), 0o600);
});

test('save is atomic: a failed write leaves the old file intact', () => {
  const { store, file } = fresh();
  store.save([{ id: 'keep' }]);
  const before = fs.readFileSync(file, 'utf8');
  const orig = fs.writeFileSync;
  fs.writeFileSync = () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); };
  try {
    assert.throws(() => store.save([{ id: 'new' }]), /ENOSPC/);
  } finally {
    fs.writeFileSync = orig;
  }
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['connections.json'], 'temp file cleaned up');
});

test('save replaces the file by rename, not in place', { skip: !POSIX }, () => {
  const { store, file } = fresh();
  store.save([]);
  const ino = fs.statSync(file).ino;
  store.save([{ id: 'c' }]);
  assert.notStrictEqual(fs.statSync(file).ino, ino);
});

test('a symlinked config file stays a symlink', { skip: !POSIX }, () => {
  const dir = path.join(root, 'link');
  fs.mkdirSync(dir);
  const real = path.join(dir, 'real.json');
  fs.writeFileSync(real, '[]');
  fs.symlinkSync(real, path.join(dir, 'link.json'));
  const { store } = fresh(path.join(dir, 'link.json'));
  store.save([{ id: 'd' }]);
  assert.ok(fs.lstatSync(path.join(dir, 'link.json')).isSymbolicLink());
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(real, 'utf8')), [{ id: 'd' }]);
});

test('corrupt or non-array file -> clear error naming the file; file untouched', () => {
  for (const content of ['{bad', '', '{}', '"x"', 'null']) {
    const { store, file } = fresh();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    assert.throws(() => store.load(), (err) => {
      assert.strictEqual(err.status, 500);
      assert.strictEqual(err.code, 'CONFIG_CORRUPT');
      assert.ok(err.message.includes(file), err.message);
      assert.match(err.message, /move it aside/);
      return true;
    }, JSON.stringify(content));
    assert.strictEqual(fs.readFileSync(file, 'utf8'), content);
  }
});

// root ignores directory permissions, so this can only run as a normal user
test('writable file in a read-only directory is saved in place', { skip: !POSIX || process.getuid() === 0 }, () => {
  const { store, file } = fresh();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '[]', { mode: 0o600 });
  fs.chmodSync(path.dirname(file), 0o555);
  try {
    store.save([{ id: 'a' }]);
    assert.deepStrictEqual(store.load(), [{ id: 'a' }]);
  } finally { fs.chmodSync(path.dirname(file), 0o755); }
});
