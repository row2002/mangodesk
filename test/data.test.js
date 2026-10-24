// Integration tests for routes/data.js against a real MongoDB.
// Run: MANGODESK_TEST_MONGO=mongodb://127.0.0.1:27017 npm test
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const URI = process.env.MANGODESK_TEST_MONGO;
const DB = `data_test_${process.pid}`;

test('data routes', { skip: !URI && 'set MANGODESK_TEST_MONGO to run' }, async (t) => {
  // lib/store reads MANGODESK_CONFIG when first required, so set it before the routes load
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mangodesk-data-'));
  process.env.MANGODESK_CONFIG = path.join(dir, 'connections.json');
  fs.writeFileSync(process.env.MANGODESK_CONFIG, JSON.stringify([{ id: 't', name: 't', uri: URI }]));
  const express = require('express');
  const { MongoClient, Long, Double, Int32 } = require('mongodb');
  const { closeClient } = require('../lib/clients');

  const app = express().use(express.json()).use(require('../routes/data'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status
      || (err instanceof SyntaxError || err.name === 'BSONError' || err.name === 'MongoServerError' ? 400 : 500);
    res.status(status).json({ error: err.message });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mongo = await MongoClient.connect(URI);
  const coll = mongo.db(DB).collection('c');
  t.after(async () => {
    server.close();
    await mongo.db(DB).dropDatabase().catch(() => {});
    await mongo.close();
    await closeClient('t');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const call = async (method, url, body) => {
    const r = await fetch(base + url, {
      method, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connectionId: 't', db: DB, collection: 'c', ...body }),
    });
    return { status: r.status, body: await r.json() };
  };
  const raw = (id) => coll.findOne({ _id: id }, { promoteValues: false });

  await coll.insertOne({
    _id: 1, name: 'a', l: Long.fromNumber(5), d: new Double(1), i: new Int32(7),
    big: Long.fromString('9007199254740993'), at: new Date(0), keep: 'me',
  });

  await t.test('query returns canonical wrappers', async () => {
    const { status, body } = await call('POST', '/api/query', { filter: '{"_id":1}' });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.total, 1);
    const [doc] = body.docs;
    assert.deepStrictEqual(doc.l, { $numberLong: '5' });
    assert.deepStrictEqual(doc.d, { $numberDouble: '1.0' });
    assert.deepStrictEqual(doc.i, { $numberInt: '7' });
    assert.deepStrictEqual(doc.big, { $numberLong: '9007199254740993' });
    assert.deepStrictEqual(doc.at, { $date: { $numberLong: '0' } });
  });

  await t.test('filter on a Long past 2^53 matches exactly', async () => {
    const hit = await call('POST', '/api/query', { filter: '{"big":{"$numberLong":"9007199254740993"}}' });
    assert.strictEqual(hit.body.docs.length, 1);
    const miss = await call('POST', '/api/query', { filter: '{"big":{"$numberLong":"9007199254740992"}}' });
    assert.strictEqual(miss.body.docs.length, 0);
  });

  await t.test('PUT of a queried doc keeps every number type', async () => {
    const { body } = await call('POST', '/api/query', { filter: '{"_id":1}' });
    const doc = { ...body.docs[0], name: 'b' };
    const put = await call('PUT', '/api/doc', { id: JSON.stringify(doc._id), doc: JSON.stringify(doc) });
    assert.deepStrictEqual(put, { status: 200, body: { ok: true } });
    const d = await raw(1);
    assert.strictEqual(d.name, 'b');
    assert.strictEqual(d.l._bsontype, 'Long');
    assert.strictEqual(d.d._bsontype, 'Double');
    assert.strictEqual(d.i._bsontype, 'Int32');
    assert.strictEqual(d.big._bsontype, 'Long');
    assert.strictEqual(d.big.toString(), '9007199254740993');
  });

  await t.test('PATCH sets one typed field and leaves the rest alone', async () => {
    const id = '{"$numberInt":"1"}';
    let r = await call('PATCH', '/api/doc', { id, path: 'l', value: '{"$numberLong":"9007199254740995"}' });
    assert.deepStrictEqual(r, { status: 200, body: { ok: true } });
    r = await call('PATCH', '/api/doc', { id, path: 'sub.x', value: '{"$numberDouble":"2.0"}' });
    assert.strictEqual(r.status, 200);
    r = await call('PATCH', '/api/doc', { id, path: 'name', value: '"text"' });
    assert.strictEqual(r.status, 200);
    r = await call('PATCH', '/api/doc', { id, path: 'at', value: '{"$date":{"$numberLong":"1000"}}' });
    assert.strictEqual(r.status, 200);
    const d = await raw(1);
    assert.strictEqual(d.l._bsontype, 'Long');
    assert.strictEqual(d.l.toString(), '9007199254740995');
    assert.strictEqual(d.sub.x._bsontype, 'Double');
    assert.strictEqual(d.name, 'text');
    assert.strictEqual(d.at.getTime(), 1000);
    assert.strictEqual(d.keep, 'me');
    assert.strictEqual(d.big.toString(), '9007199254740993');

    r = await call('PATCH', '/api/doc', { id, path: 'keep', unset: true });
    assert.strictEqual(r.status, 200);
    assert.ok(!('keep' in await raw(1)));
  });

  await t.test('PATCH errors', async () => {
    let r = await call('PATCH', '/api/doc', { id: '{"$numberInt":"404"}', path: 'x', value: '1' });
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.body.error, 'Document not found');
    r = await call('PATCH', '/api/doc', { id: '1', value: '1' });
    assert.strictEqual(r.status, 400);
    r = await call('PATCH', '/api/doc', { id: '1', path: 'x' });
    assert.strictEqual(r.status, 400);
    r = await call('PATCH', '/api/doc', { id: '1', path: 'x', value: '{bad' });
    assert.strictEqual(r.status, 400);
  });

  await t.test('operator-shaped id matches nothing; out-of-range Long is a 400', async () => {
    await coll.insertMany([{ _id: 101, q: 0 }, { _id: 102, q: 0 }]);
    let r = await call('PATCH', '/api/doc', { id: '{"$in":[101,102]}', path: 'q', value: '1' });
    assert.strictEqual(r.status, 404);
    r = await call('PUT', '/api/doc', { id: '{"$gt":100}', doc: '{"q":2}' });
    assert.strictEqual(r.status, 404);
    r = await call('DELETE', '/api/doc', { id: '{"$exists":true}' });
    assert.strictEqual(r.status, 404);
    r = await call('PATCH', '/api/doc', { id: '101', path: 'q', value: '{"$numberLong":"9223372036854775808"}' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /out of range/);
    r = await call('PATCH', '/api/doc', { path: 'q', value: '1' });
    assert.strictEqual(r.status, 400);
    assert.deepStrictEqual(await coll.find({ _id: { $in: [101, 102] } }).toArray(), [{ _id: 101, q: 0 }, { _id: 102, q: 0 }]);
    await coll.deleteMany({ _id: { $in: [101, 102] } });
  });

  await t.test('insert keeps wrapper types; plain numbers by range', async () => {
    const r = await call('POST', '/api/doc', { doc: '{"_id":2,"l":{"$numberLong":"3"},"n":3000000000,"s":5}' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.id, { $numberInt: '2' });
    const d = await raw(2);
    assert.strictEqual(d.l._bsontype, 'Long');
    assert.strictEqual(d.n._bsontype, 'Double');
    assert.strictEqual(d.s._bsontype, 'Int32');
    const bad = await call('POST', '/api/doc', { doc: '[1]' });
    assert.strictEqual(bad.status, 400);
  });

  await t.test('$near / $where: docs come back, total is null', async () => {
    const geo = mongo.db(DB).collection('geo');
    await geo.createIndex({ loc: '2dsphere' });
    await geo.insertMany([
      { _id: 1, loc: { type: 'Point', coordinates: [0, 0] } },
      { _id: 2, loc: { type: 'Point', coordinates: [1, 1] } },
    ]);
    const near = '{"loc":{"$near":{"$geometry":{"type":"Point","coordinates":[1,1]}}}}';
    let r = await call('POST', '/api/query', { collection: 'geo', filter: near });
    assert.strictEqual(r.status, 200, r.body.error);
    assert.deepStrictEqual(r.body.docs.map((d) => d._id), [{ $numberInt: '2' }, { $numberInt: '1' }]);
    assert.strictEqual(r.body.total, null);
    r = await call('POST', '/api/query', { collection: 'geo', filter: '{"$where":"this._id > 1"}' });
    assert.strictEqual(r.status, 200, r.body.error);
    assert.strictEqual(r.body.docs.length, 1);
    assert.strictEqual(r.body.total, null);
    // a genuinely bad filter still fails
    r = await call('POST', '/api/query', { collection: 'geo', filter: '{"a":{"$bogus":1}}' });
    assert.strictEqual(r.status, 400);
  });

  await t.test('non-object filter / sort / projection -> 400', async () => {
    for (const [key, label] of [['filter', 'Filter'], ['sort', 'Sort'], ['projection', 'Projection']]) {
      for (const text of ['42', 'null', '[1]']) {
        const r = await call('POST', '/api/query', { [key]: text });
        assert.strictEqual(r.status, 400, key + ' ' + text);
        assert.strictEqual(r.body.error, label + ' must be an object, e.g. {}');
      }
    }
    const r = await call('POST', '/api/explain', { filter: '42' });
    assert.strictEqual(r.status, 400);
  });

  await t.test('explain stays readable (relaxed)', async () => {
    const r = await call('POST', '/api/explain', { filter: '{"l":{"$numberLong":"5"}}' });
    assert.strictEqual(r.status, 200, r.body.error);
    assert.ok(r.body.plan.queryPlanner);
    assert.ok(Array.isArray(r.body.indexes));
  });

  await t.test('delete by canonical id', async () => {
    let r = await call('POST', '/api/docs/delete', { ids: ['{"$numberInt":"2"}'] });
    assert.deepStrictEqual(r.body, { ok: true, deletedCount: 1 });
    r = await call('DELETE', '/api/doc', { id: '{"$numberInt":"1"}' });
    assert.deepStrictEqual(r.body, { ok: true });
    assert.strictEqual(await coll.countDocuments(), 0);
  });
});
