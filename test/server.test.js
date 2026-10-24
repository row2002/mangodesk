// HTTP-level tests for lib/app.js: Host/Origin guard, /api/version, JSON 404,
// connection colours, corrupt-config errors. Integration bits need MANGODESK_TEST_MONGO.
const { test, before, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mangodesk-server-'));
const CONFIG = path.join(dir, 'connections.json');
process.env.MANGODESK_CONFIG = CONFIG; // before lib/store is loaded
const { createApp } = require('../lib/app');
const clients = require('../lib/clients');

let server, port;
before(async () => {
  server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
after(async () => {
  await clients.closeAll();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// -> { status, body } with body JSON-parsed when possible; headers are sent verbatim
function request(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined
      : typeof body === 'string' ? body : JSON.stringify(body);
    const h = { Host: `127.0.0.1:${port}`, ...headers };
    if (data !== undefined && !Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['Content-Type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let parsed = text;
        try { parsed = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body: parsed });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}
const self = () => `http://127.0.0.1:${port}`;
const reset = () => fs.rmSync(CONFIG, { force: true });

test('GET /api/version names the app, version and config file', async () => {
  const r = await request('GET', '/api/version');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, { app: 'mangodesk', version: require('../package.json').version, configFile: CONFIG });
});

test('foreign Host header is refused (DNS rebinding), loopback names on any port pass', async () => {
  for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1.evil.example:${port}`, 'localhost@evil.example']) {
    const r = await request('GET', '/api/connections', { headers: { Host: host } });
    assert.strictEqual(r.status, 403, host);
  }
  const page = await request('GET', '/', { headers: { Host: `evil.example:${port}` } });
  assert.strictEqual(page.status, 403, 'the UI itself is not served to a rebound page');
  for (const host of [`localhost:${port}`, `LocalHost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, 'localhost:9000']) {
    const r = await request('GET', '/api/version', { headers: { Host: host } });
    assert.strictEqual(r.status, 200, host);
  }
});

test('cross-origin writes are refused, including form posts', async () => {
  reset();
  const form = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const cases = [
    { Origin: 'http://evil.example', ...form },
    { Origin: 'null', ...form },
    { Origin: `http://localhost:${port + 1}` }, // another local app on another port
    { Origin: `https://127.0.0.1:${port}` },
    { 'Sec-Fetch-Site': 'cross-site', ...form },
    { 'Sec-Fetch-Site': 'same-site' },
  ];
  for (const headers of cases) {
    const body = headers['Content-Type'] ? 'name=pwn&uri=mongodb://evil.example' : { name: 'pwn', uri: 'mongodb://evil.example' };
    const r = await request('POST', '/api/connections', { headers, body });
    assert.strictEqual(r.status, 403, JSON.stringify(headers));
    const del = await request('DELETE', '/api/connections/x', { headers });
    assert.strictEqual(del.status, 403);
  }
  assert.ok(!fs.existsSync(CONFIG), 'nothing was written');
  // the export download form is refused before it reaches the route
  const exp = await request('POST', '/api/export', { headers: { Origin: 'http://evil.example', ...form }, body: 'connectionId=x' });
  assert.strictEqual(exp.status, 403);
});

test('form bodies are only parsed for /api/export', async () => {
  const r = await request('POST', '/api/connections', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=a&uri=mongodb://h',
  });
  assert.strictEqual(r.status, 400);
});

test('a POST that no body parser matched is still a clean 4xx', async () => {
  // express 5 leaves req.body unset when the Content-Type matches no parser; the routes
  // destructure it, which turned these into 500s leaking the TypeError text.
  const cases = [
    ['/api/query', undefined], ['/api/query', 'text/plain'],
    ['/api/doc', 'text/plain'], ['/api/export', 'text/plain'],
  ];
  for (const [url, type] of cases) {
    const r = await request('POST', url, {
      headers: type ? { 'Content-Type': type } : {}, body: type ? 'not a body' : undefined,
    });
    const label = `${url} (${type || 'no Content-Type'}) -> ${r.status}`;
    assert.ok(r.status >= 400 && r.status < 500, label);
    assert.doesNotMatch(String(r.body.error), /Cannot destructure/, label);
  }
});

test('same-origin writes work, with optional colour persisted', async () => {
  reset();
  for (const origin of [self(), `http://localhost:${port}`]) {
    const host = new URL(origin).host;
    const r = await request('POST', '/api/connections', {
      headers: { Host: host, Origin: origin, 'Sec-Fetch-Site': 'same-origin' },
      body: { name: 'prod', uri: 'mongodb://h:1', color: 'red' },
    });
    assert.strictEqual(r.status, 200, origin);
    assert.strictEqual(r.body.color, 'red');
  }
  const plain = await request('POST', '/api/connections', { body: { name: 'plain', uri: 'mongodb://h:2' } });
  assert.strictEqual(plain.status, 200);
  assert.strictEqual(plain.body.color, undefined, 'records without colour stay as they were');

  const bad = await request('POST', '/api/connections', { body: { name: 'x', uri: 'mongodb://h', color: 'pink' } });
  assert.strictEqual(bad.status, 400);

  const list = (await request('GET', '/api/connections')).body;
  assert.strictEqual(list.length, 3);
  assert.deepStrictEqual(list.map((c) => c.color), ['red', 'red', undefined]);

  // PUT without colour keeps it; with '' clears it
  const id = list[0].id;
  let put = await request('PUT', `/api/connections/${id}`, { headers: { Origin: self() }, body: { name: 'prod2', uri: 'mongodb://h:1' } });
  assert.strictEqual(put.body.color, 'red');
  put = await request('PUT', `/api/connections/${id}`, { body: { name: 'prod2', uri: 'mongodb://h:1', color: 'blue' } });
  assert.strictEqual(put.body.color, 'blue');
  put = await request('PUT', `/api/connections/${id}`, { body: { name: 'prod2', uri: 'mongodb://h:1', color: '' } });
  assert.strictEqual(put.body.color, '');
  put = await request('PUT', `/api/connections/${id}`, { body: { name: 'prod2', uri: 'mongodb://h:1', color: 7 } });
  assert.strictEqual(put.status, 400);
  assert.strictEqual(JSON.parse(fs.readFileSync(CONFIG, 'utf8'))[0].color, '');
});

test('unknown /api routes answer JSON 404', async () => {
  for (const [m, u] of [['GET', '/api/nope'], ['POST', '/api/connections/x/y/z'], ['GET', '/api']]) {
    const r = await request(m, u, { body: m === 'POST' ? {} : undefined });
    assert.strictEqual(r.status, 404, u);
    assert.match(r.type, /json/);
    assert.match(r.body.error, /No such endpoint/);
  }
});

test('corrupt connections file -> 500 naming the file, and it is left alone', async () => {
  fs.writeFileSync(CONFIG, '{bad');
  const r = await request('GET', '/api/connections');
  assert.strictEqual(r.status, 500);
  assert.strictEqual(r.body.code, 'CONFIG_CORRUPT');
  assert.ok(r.body.error.includes(CONFIG), r.body.error);
  const w = await request('POST', '/api/connections', { body: { name: 'a', uri: 'mongodb://h' } });
  assert.strictEqual(w.status, 500);
  assert.strictEqual(fs.readFileSync(CONFIG, 'utf8'), '{bad');
  reset();
});

test('saved connection reaches a real MongoDB', async (t) => {
  const uri = process.env.MANGODESK_TEST_MONGO;
  if (!uri) return t.skip('MANGODESK_TEST_MONGO not set');
  reset();
  const { body: rec } = await request('POST', '/api/connections', { body: { name: 'it', uri, color: 'green' } });
  const r = await request('POST', `/api/connections/${rec.id}/test`, { headers: { Origin: self() } });
  assert.deepStrictEqual(r.body, { ok: true });
  const dbs = await request('GET', `/api/connections/${rec.id}/databases`);
  assert.strictEqual(dbs.status, 200);
  assert.ok(Array.isArray(dbs.body));
  reset();
});
