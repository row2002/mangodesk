// Tests for routes/admin.js (collections, databases, indexes), mounted through
// lib/app.js. Integration tests run against a real MongoDB:
//   MANGODESK_TEST_MONGO=mongodb://127.0.0.1:27017 npm test
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const URI = process.env.MANGODESK_TEST_MONGO;
const DB = `admin_test_${process.pid}`;
const DB2 = `admin_test_new_${process.pid}`;

// lib/store reads MANGODESK_CONFIG when first required, so set it before the app loads
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mangodesk-admin-'));
process.env.MANGODESK_CONFIG = path.join(dir, 'connections.json');
// nothing listens on port 1: the validation tests must answer before connecting
fs.writeFileSync(process.env.MANGODESK_CONFIG, JSON.stringify([{ id: 't', name: 't', uri: URI || 'mongodb://127.0.0.1:1' }]));
const { createApp } = require('../lib/app');
const { closeClient } = require('../lib/clients');

let server, base;
test.before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close();
  await closeClient('t');
  fs.rmSync(dir, { recursive: true, force: true });
});

const url = (db, coll, rest = '') => '/api/connections/t/databases/' + encodeURIComponent(db)
  + (coll === undefined ? '' : '/collections' + (coll ? '/' + encodeURIComponent(coll) : '')) + rest;

async function call(method, path, body) {
  const r = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

test('refused before touching the server', async () => {
  let r = await call('DELETE', url(DB, 'c', '/indexes/_id_'));
  assert.deepStrictEqual(r, { status: 400, body: { error: 'The _id index cannot be dropped' } });
  for (const db of ['admin', 'config', 'local']) {
    r = await call('DELETE', url(db));
    assert.strictEqual(r.status, 400, db);
    assert.match(r.body.error, /system database/);
  }
  r = await call('POST', url(DB, ''), { name: '' });
  assert.deepStrictEqual(r, { status: 400, body: { error: 'Collection name is required' } });
  r = await call('PATCH', url(DB, 'c'), {});
  assert.strictEqual(r.status, 400);
  r = await call('PATCH', url(DB, 'c'), { name: 'c' });
  assert.strictEqual(r.status, 400);
  r = await call('POST', url(DB, 'c', '/indexes'), { keys: '{}' });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /at least one field/);
  r = await call('POST', url(DB, 'c', '/indexes'), { keys: '[1]' });
  assert.deepStrictEqual(r, { status: 400, body: { error: 'Keys must be an object, e.g. {}' } });
  r = await call('POST', url(DB, 'c', '/indexes'), { keys: '{"a":1}', expireAfterSeconds: -1 });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /expireAfterSeconds/);
  r = await call('POST', url(DB, 'c', '/indexes'), { keys: '{"a":1}', unique: 'yes' });
  assert.deepStrictEqual(r, { status: 400, body: { error: 'unique must be true or false' } });
});

test('admin routes', { skip: !URI && 'set MANGODESK_TEST_MONGO to run' }, async (t) => {
  const { MongoClient } = require('mongodb');
  const mongo = await MongoClient.connect(URI);
  const db = mongo.db(DB);
  t.after(async () => {
    await db.dropDatabase().catch(() => {});
    await mongo.db(DB2).dropDatabase().catch(() => {});
    await mongo.close();
  });
  const names = async (d = db) => (await d.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort();
  const dbNames = async () => (await mongo.db().admin().listDatabases()).databases.map((d) => d.name);

  await t.test('create collection; a duplicate or bad name is a 400', async () => {
    let r = await call('POST', url(DB, ''), { name: 'c' });
    assert.deepStrictEqual(r, { status: 200, body: { ok: true } });
    assert.deepStrictEqual(await names(), ['c']);
    r = await call('POST', url(DB, ''), { name: 'c' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /already exists/);
    r = await call('POST', url(DB, ''), { name: 'a$b' });
    assert.strictEqual(r.status, 400);
  });

  await t.test('create a database by creating its first collection', async () => {
    assert.ok(!(await dbNames()).includes(DB2));
    const r = await call('POST', url(DB2, ''), { name: 'first' });
    assert.strictEqual(r.status, 200, r.body.error);
    assert.ok((await dbNames()).includes(DB2));
    assert.deepStrictEqual(await names(mongo.db(DB2)), ['first']);
  });

  await t.test('rename; an existing target or missing source is a 400', async () => {
    await db.collection('c').insertMany([{ _id: 1 }, { _id: 2 }]);
    let r = await call('PATCH', url(DB, 'c'), { name: 'renamed' });
    assert.deepStrictEqual(r, { status: 200, body: { ok: true } });
    assert.deepStrictEqual(await names(), ['renamed']);
    assert.strictEqual(await db.collection('renamed').countDocuments(), 2);
    await db.createCollection('other');
    r = await call('PATCH', url(DB, 'renamed'), { name: 'other' });
    assert.strictEqual(r.status, 400);
    r = await call('PATCH', url(DB, 'missing'), { name: 'x' });
    assert.strictEqual(r.status, 400);
    assert.deepStrictEqual(await names(), ['other', 'renamed']);
  });

  await t.test('clear deletes every document and keeps the indexes', async () => {
    await db.collection('renamed').createIndex({ k: 1 });
    const r = await call('DELETE', url(DB, 'renamed', '/documents'));
    assert.deepStrictEqual(r, { status: 200, body: { ok: true, deletedCount: 2 } });
    assert.strictEqual(await db.collection('renamed').countDocuments(), 0);
    assert.deepStrictEqual((await db.collection('renamed').indexes()).map((i) => i.name), ['_id_', 'k_1']);
  });

  await t.test('create index: keys in EJSON, options, generated or given name', async () => {
    const coll = db.collection('renamed');
    let r = await call('POST', url(DB, 'renamed', '/indexes'), { keys: '{"a":1,"b":-1}' });
    assert.deepStrictEqual(r, { status: 200, body: { ok: true, name: 'a_1_b_-1' } });
    r = await call('POST', url(DB, 'renamed', '/indexes'), {
      keys: '{"email":1}', unique: true, sparse: true, name: 'by_email', ignored: 'x',
    });
    assert.deepStrictEqual(r, { status: 200, body: { ok: true, name: 'by_email' } });
    r = await call('POST', url(DB, 'renamed', '/indexes'), { keys: '{"at":{"$numberInt":"1"}}', expireAfterSeconds: 3600 });
    assert.strictEqual(r.status, 200, r.body.error);
    r = await call('POST', url(DB, 'renamed', '/indexes'), { keys: '{"loc":"2dsphere"}', unique: false, name: '' });
    assert.deepStrictEqual(r.body, { ok: true, name: 'loc_2dsphere' });

    const byName = Object.fromEntries((await coll.indexes()).map((i) => [i.name, i]));
    assert.deepStrictEqual(byName['a_1_b_-1'].key, { a: 1, b: -1 });
    assert.strictEqual(byName.by_email.unique, true);
    assert.strictEqual(byName.by_email.sparse, true);
    assert.strictEqual(byName.at_1.expireAfterSeconds, 3600);
    assert.strictEqual(byName.loc_2dsphere.unique, undefined);

    // the server's own refusals are user errors too
    r = await call('POST', url(DB, 'renamed', '/indexes'), { keys: '{"x":1}', name: 'by_email' });
    assert.strictEqual(r.status, 400);
    r = await call('POST', url(DB, 'renamed', '/indexes'), { keys: '{"x":"bogus"}' });
    assert.strictEqual(r.status, 400);
    r = await call('POST', url(DB, 'renamed', '/indexes'), { keys: '{bad' });
    assert.strictEqual(r.status, 400);
  });

  await t.test('drop index; _id_ and unknown names are refused', async () => {
    let r = await call('DELETE', url(DB, 'renamed', '/indexes/a_1_b_-1'));
    assert.deepStrictEqual(r, { status: 200, body: { ok: true } });
    r = await call('DELETE', url(DB, 'renamed', '/indexes/_id_'));
    assert.strictEqual(r.status, 400);
    r = await call('DELETE', url(DB, 'renamed', '/indexes/nope'));
    assert.deepStrictEqual(r, { status: 404, body: { error: 'No index named "nope"' } });
    r = await call('DELETE', url(DB, 'missing', '/indexes/a_1'));
    assert.ok(r.status >= 400 && r.status < 500, String(r.status));
    assert.deepStrictEqual((await db.collection('renamed').indexes()).map((i) => i.name).sort(),
      ['_id_', 'at_1', 'by_email', 'k_1', 'loc_2dsphere']);
  });

  await t.test('names with "/" and "." travel in the URL', async () => {
    let r = await call('POST', url(DB, ''), { name: 'a/b.c' });
    assert.strictEqual(r.status, 200, r.body.error);
    r = await call('PATCH', url(DB, 'a/b.c'), { name: 'd/e' });
    assert.strictEqual(r.status, 200, r.body.error);
    r = await call('DELETE', url(DB, 'd/e'));
    assert.strictEqual(r.status, 200, r.body.error);
    assert.deepStrictEqual(await names(), ['other', 'renamed']);
  });

  await t.test('drop collection, then drop database', async () => {
    let r = await call('DELETE', url(DB, 'other'));
    assert.deepStrictEqual(r, { status: 200, body: { ok: true } });
    assert.deepStrictEqual(await names(), ['renamed']);
    r = await call('DELETE', url(DB2));
    assert.deepStrictEqual(r, { status: 200, body: { ok: true } });
    assert.ok(!(await dbNames()).includes(DB2));
  });
});
