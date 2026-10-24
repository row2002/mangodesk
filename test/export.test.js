// Integration tests for routes/export.js against a real MongoDB.
// Run: MANGODESK_TEST_MONGO=mongodb://127.0.0.1:27017 npm test
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const URI = process.env.MANGODESK_TEST_MONGO;
const DB = `data_export_test_${process.pid}`;

test('export route', { skip: !URI && 'set MANGODESK_TEST_MONGO to run' }, async (t) => {
  // lib/store reads MANGODESK_CONFIG when first required, so set it before the routes load
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mangodesk-export-'));
  process.env.MANGODESK_CONFIG = path.join(dir, 'connections.json');
  fs.writeFileSync(process.env.MANGODESK_CONFIG, JSON.stringify([{ id: 't', name: 't', uri: URI }]));
  const express = require('express');
  const { MongoClient, Long, Double, Int32, Decimal128 } = require('mongodb');
  const { closeClient } = require('../lib/clients');

  const app = express().use(express.json()).use(express.urlencoded({ extended: false }))
    .use(require('../routes/export'));
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
  const db = mongo.db(DB);
  t.after(async () => {
    server.close();
    await db.dropDatabase().catch(() => {});
    await mongo.close();
    await closeClient('t');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const exp = (body, form) => fetch(base + '/api/export', {
    method: 'POST',
    headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
    body: form ? new URLSearchParams({ connectionId: 't', db: DB, collection: 'c', ...body }).toString()
      : JSON.stringify({ connectionId: 't', db: DB, collection: 'c', ...body }),
  });

  await db.collection('c').insertOne({
    _id: 1, l: Long.fromNumber(5), d: new Double(1), f: new Double(2.5), i: new Int32(7),
    big: Long.fromString('9007199254740993'), dec: Decimal128.fromString('12.30'), at: new Date(0),
    sub: { l: Long.fromNumber(6), d: new Double(3) },
  });

  await t.test('JSON and NDJSON are canonical EJSON', async () => {
    const r = await exp({ format: 'json' });
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /attachment; filename="c.json"/);
    const [doc] = JSON.parse(await r.text());
    assert.deepStrictEqual(doc, {
      _id: { $numberInt: '1' }, l: { $numberLong: '5' }, d: { $numberDouble: '1.0' },
      f: { $numberDouble: '2.5' }, i: { $numberInt: '7' }, big: { $numberLong: '9007199254740993' },
      dec: { $numberDecimal: '12.30' }, at: { $date: { $numberLong: '0' } },
      sub: { l: { $numberLong: '6' }, d: { $numberDouble: '3.0' } },
    });
    const nd = await (await exp({ format: 'ndjson' })).text();
    assert.strictEqual(nd.split('\n').length, 2);
    assert.deepStrictEqual(JSON.parse(nd.split('\n')[0]), doc);
  });

  await t.test('CSV renders numbers as plain values', async () => {
    const text = await (await exp({ format: 'csv' })).text();
    assert.strictEqual(text,
      '_id,l,d,f,i,big,dec,at,sub\n'
      + '1,5,1,2.5,7,9007199254740993,12.30,1970-01-01T00:00:00.000Z,"{""l"":6,""d"":3}"\n');
  });

  await t.test('CSV columns include fields first seen after document 200', async () => {
    const wide = db.collection('wide');
    await wide.insertMany(Array.from({ length: 300 }, (_, n) => (n < 250 ? { _id: n, name: 'n' + n }
      : { _id: n, name: 'n' + n, email: n + '@x', secret: 's' })));
    let text = await (await exp({ collection: 'wide', format: 'csv' })).text();
    let lines = text.trim().split('\n');
    assert.strictEqual(lines[0], '_id,name,email,secret');
    assert.strictEqual(lines.length, 301);
    assert.strictEqual(lines[261], '260,n260,260@x,s');
    // exclusion projection drops the column; skip/limit bound the key scan
    text = await (await exp({ collection: 'wide', format: 'csv', projection: '{"secret":0,"_id":0}' })).text();
    assert.strictEqual(text.split('\n')[0], 'name,email');
    text = await (await exp({ collection: 'wide', format: 'csv', sort: '{"_id":1}', limit: '10' })).text();
    assert.strictEqual(text.split('\n')[0], '_id,name');
    text = await (await exp({ collection: 'wide', format: 'csv', sort: '{"_id":-1}', limit: '10' })).text();
    assert.strictEqual(text.split('\n')[0], '_id,name,email,secret');
  });

  await t.test('CSV header follows what the projection really returns', async () => {
    const pj = db.collection('pj');
    await pj.insertMany([{ _id: 0, a: [1, 2], b: 'x', d: 5 }, { _id: 1, a: [3], b: 'y', d: 6 }]);
    const csv = async (projection) => (await (await exp({ collection: 'pj', format: 'csv', projection })).text());
    assert.strictEqual(await csv('{"a":0,"_id":1}'), '_id,b,d\n0,x,5\n1,y,6\n');
    assert.strictEqual(await csv('{"a":{"$slice":1}}'), '_id,a,b,d\n0,[1],x,5\n1,[3],y,6\n');
    assert.strictEqual(await csv('{"_id":false,"a":1}'), 'a\n"[1,2]"\n[3]\n');
    assert.strictEqual(await csv('{"b":1}'), '_id,b\n0,x\n1,y\n');
    assert.strictEqual(await csv('{"b":1,"_id":{"$numberInt":"0"}}'), 'b\nx\ny\n');
  });

  await t.test('errors before the first byte are JSON, not a broken download', async () => {
    for (const format of ['json', 'ndjson', 'csv']) {
      const r = await exp({ format, filter: '{"a":{"$bogus":1}}' });
      assert.strictEqual(r.status, 400, format);
      assert.strictEqual(r.headers.get('content-disposition'), null);
      assert.match((await r.json()).error, /\$bogus/);
    }
    // CSV with an inclusion projection skips the key scan; the first batch still runs first
    let r = await exp({ format: 'csv', projection: '{"l":1}', filter: '{"a":{"$bogus":1}}' });
    assert.strictEqual(r.status, 400);
    // the download form posts urlencoded
    r = await exp({ format: 'json', filter: '42' }, true);
    assert.strictEqual(r.status, 400);
    assert.deepStrictEqual(await r.json(), { error: 'Filter must be an object, e.g. {}' });
    r = await exp({ format: 'xml' }, true);
    assert.strictEqual(r.status, 400);
  });

  await t.test('an error mid-stream aborts the response', async () => {
    await db.collection('many').insertMany(Array.from({ length: 500 }, (_, n) => ({ _id: n })));
    // fails on a getMore, after the first batch (101 docs) has been streamed
    const filter = JSON.stringify({ $where: 'if (this._id >= 300) throw new Error("boom"); return true' });
    for (const format of ['json', 'ndjson', 'csv']) {
      const r = await exp({ collection: 'many', format, filter, sort: '{"_id":1}' });
      assert.strictEqual(r.status, 200, format);
      await assert.rejects(r.text(), undefined, format + ' body should not complete');
    }
  });
});
