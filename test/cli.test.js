// lib/cli.js flag parsing and port selection, plus server.js launched as a process.
const { test, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { parseArgs, hasDisplay, listen, probe, DEFAULT_PORT } = require('../lib/cli');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mangodesk-cli-'));
process.env.MANGODESK_CONFIG = path.join(dir, 'connections.json');
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const SERVER = path.join(__dirname, '..', 'server.js');
const { version } = require('../package.json');

test('parseArgs: defaults and flags', () => {
  const d = parseArgs([], {});
  assert.deepStrictEqual(d, { port: DEFAULT_PORT, explicitPort: false, open: true, help: false, version: false, error: null });
  assert.deepStrictEqual(
    [parseArgs(['-p', '1234']).port, parseArgs(['--port', '1234']).port, parseArgs(['--port=1234']).port],
    [1234, 1234, 1234]);
  assert.strictEqual(parseArgs(['-p', '1234']).explicitPort, true);
  assert.strictEqual(parseArgs([], { PORT: '4321' }).port, 4321);
  assert.strictEqual(parseArgs([], { PORT: '4321' }).explicitPort, true);
  assert.strictEqual(parseArgs(['-p', '5'], { PORT: '4321' }).port, 5, 'flag beats env');
  assert.strictEqual(parseArgs(['--no-open']).open, false);
  assert.strictEqual(parseArgs(['-h']).help, true);
  assert.strictEqual(parseArgs(['--help']).help, true);
  assert.strictEqual(parseArgs(['-v']).version, true);
  assert.strictEqual(parseArgs(['--version']).version, true);
});

test('parseArgs: environment opt-outs for the browser', () => {
  assert.strictEqual(parseArgs([], { MANGODESK_NO_OPEN: '1' }).open, false);
  assert.strictEqual(parseArgs([], { CI: 'true' }).open, false);
  assert.strictEqual(parseArgs([], { MANGODESK_NO_OPEN: '0' }).open, true);
  assert.strictEqual(parseArgs([], { CI: '' }).open, true);
});

test('parseArgs: bad input is reported, not thrown', () => {
  for (const [argv, env] of [[['--bogus']], [['-p']], [['-p', 'abc']], [['--port=0']], [['-p', '70000']], [['-p', '1.5']], [[], { PORT: 'x' }]]) {
    assert.ok(parseArgs(argv, env || {}).error, JSON.stringify(argv) + JSON.stringify(env));
  }
});

test('hasDisplay: only headless Linux/BSD skips the browser', () => {
  assert.strictEqual(hasDisplay({}, 'linux'), false);
  assert.strictEqual(hasDisplay({ DISPLAY: ':0' }, 'linux'), true);
  assert.strictEqual(hasDisplay({ WAYLAND_DISPLAY: 'wayland-0' }, 'freebsd'), true);
  assert.strictEqual(hasDisplay({}, 'darwin'), true);
  assert.strictEqual(hasDisplay({}, 'win32'), true);
});

const foreign = () => new Promise((resolve) => {
  const s = http.createServer((req, res) => res.end('not mangodesk'));
  s.listen(0, '127.0.0.1', () => resolve(s));
});
const mango = async () => {
  const { createApp } = require('../lib/app');
  const s = http.createServer(createApp());
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  return s;
};

test('listen: busy default port moves on; explicit port fails with a hint', async () => {
  const f = await foreign();
  const busy = f.address().port;
  assert.strictEqual(await probe(busy), null);
  const r = await listen(() => {}, { port: busy, explicitPort: false });
  assert.ok(r.port > busy && r.port <= busy + 10, String(r.port));
  r.server.close();
  await assert.rejects(listen(() => {}, { port: busy, explicitPort: true }),
    (err) => err.code === 'EADDRINUSE' && err.message.includes(`--port ${busy + 1}`));
  f.close();
});

test('listen: a running MangoDesk is reused', async () => {
  const m = await mango();
  const p = m.address().port;
  assert.strictEqual((await probe(p)).configFile, process.env.MANGODESK_CONFIG);
  assert.deepStrictEqual(await listen(() => {}, { port: p, explicitPort: true }), { reused: true, port: p });
  assert.deepStrictEqual(await listen(() => {}, { port: p, explicitPort: true, configFile: process.env.MANGODESK_CONFIG }),
    { reused: true, port: p });
  m.close();
});

test('listen: a MangoDesk on another connections file is not reused', async () => {
  const m = await mango();
  const p = m.address().port;
  const other = path.join(dir, 'work.json');
  await assert.rejects(listen(() => {}, { port: p, explicitPort: true, configFile: other }),
    (err) => err.code === 'EADDRINUSE' && err.message.includes(other)
      && err.message.includes(process.env.MANGODESK_CONFIG) && err.message.includes(`--port ${p + 1}`));
  const r = await listen(() => {}, { port: p, explicitPort: false, configFile: other });
  assert.ok(r.server && r.port > p, String(r.port));
  r.server.close();
  m.close();
});

// -> { code, out } once the process exits; onOut sees stdout as it arrives
function run(args, { env = {}, onOut } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SERVER, ...args], {
      env: { ...process.env, MANGODESK_NO_OPEN: '', CI: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const take = (d) => { out += d; if (onOut) onOut(out, p); };
    p.stdout.on('data', take);
    p.stderr.on('data', take);
    const timer = setTimeout(() => p.kill(), 15000);
    p.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, out }); });
  });
}

test('server.js --version / --help', async () => {
  assert.strictEqual((await run(['--version'])).out.trim(), version);
  const h = await run(['-h']);
  assert.strictEqual(h.code, 0);
  assert.match(h.out, /--no-open/);
  const bad = await run(['--nope']);
  assert.strictEqual(bad.code, 2);
});

test('server.js on a port where MangoDesk already runs exits 0', async () => {
  const m = await mango();
  const p = m.address().port;
  const r = await run(['--port', String(p), '--no-open']);
  m.close();
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`MangoDesk is already running at http://localhost:${p}`));
});

test('server.js with a different MANGODESK_CONFIG does not hand over to a running MangoDesk', async () => {
  const m = await mango();
  const p = m.address().port;
  const work = path.join(dir, 'work.json');
  const r = await run(['--port', String(p), '--no-open'], { env: { MANGODESK_CONFIG: work } });
  m.close();
  assert.strictEqual(r.code, 1, r.out);
  assert.ok(r.out.includes(work) && r.out.includes(process.env.MANGODESK_CONFIG), r.out);
  assert.doesNotMatch(r.out, /already running/);
});

test('server.js on an explicit port held by another program exits 1 with one line', async () => {
  const f = await foreign();
  const r = await run(['--no-open'], { env: { PORT: String(f.address().port) } });
  f.close();
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /in use by another program/);
  assert.doesNotMatch(r.out, /\n\s+at /, 'no stack trace');
});

test('server.js prints the banner and stops on SIGTERM', { skip: process.platform === 'win32' }, async () => {
  // grab a free port, release it, start there
  const f = await foreign();
  const p = f.address().port;
  await new Promise((resolve) => f.close(resolve));
  const r = await run(['-p', String(p), '--no-open'], {
    onOut: (out, child) => { if (out.includes('Ctrl+C')) child.kill('SIGTERM'); },
  });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`MangoDesk v${version.replace(/\./g, '\\.')} running at http://localhost:${p}`));
  assert.ok(r.out.includes(`Connections file: ${process.env.MANGODESK_CONFIG}`), r.out);
  assert.match(r.out, /Press Ctrl\+C to stop\./);
});
