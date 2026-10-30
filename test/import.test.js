// routes/import.js: the streaming parsers (no MongoDB needed), then the route through
// lib/app.js against a real MongoDB, including export -> import round trips.
// Run: MANGODESK_TEST_MONGO=mongodb://127.0.0.1:27017 npm test
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Long, Double, Int32, Decimal128, ObjectId, Binary, Timestamp, BSONRegExp, UUID } = require('mongodb');

// lib/store reads MANGODESK_CONFIG when first required, so set it before the routes load
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mangodesk-import-'));
process.env.MANGODESK_CONFIG = path.join(dir, 'connections.json');
const imp = require('../routes/import');
const ejson = require('../lib/ejson');
const { JsonSplitter, NdjsonSplitter, CsvParser, detectDelimiter, makeColumns, rowToDoc, CONVERT } = imp;

// Feed text in every possible two-piece split and char by char: the records must not
// depend on where the chunks of the upload happen to break.
function splits(text) {
  const out = [[text], [...text]];
  for (let i = 1; i < text.length; i++) out.push([text.slice(0, i), text.slice(i)]);
  return out;
}
function run(Parser, chunks, ...args) {
  const p = new Parser(...args);
  const recs = chunks.flatMap((c) => p.feed(c));
  return { recs: recs.concat(p.end()), p };
}

test('JsonSplitter: array and document stream, any chunking', () => {
  const arr = '[\n {"a":"x]}\\"{"},\n\n {"b":[1,{"c":2}]} , {"d":"\\\\"}\n]\n';
  for (const chunks of splits(arr)) {
    const { recs, p } = run(JsonSplitter, chunks);
    assert.deepStrictEqual(recs.map((r) => JSON.parse(r.text)), [{ a: 'x]}"{' }, { b: [1, { c: 2 }] }, { d: '\\' }]);
    assert.deepStrictEqual(recs.map((r) => r.line), [2, 4, 4]);
    assert.strictEqual(p.problem, null);
  }
  // mongoexport's default output and pretty-printed docs back to back, commas or not
  const stream = '{"a":1}\n{\n  "b": 2\n},{"c":3}';
  for (const chunks of splits(stream)) {
    assert.deepStrictEqual(run(JsonSplitter, chunks).recs.map((r) => r.line), [1, 2, 4]);
  }
  // non-documents are records too, so they can be reported one by one
  assert.deepStrictEqual(run(JsonSplitter, ['[1, "s", {"a":1}, null]']).recs.map((r) => r.text), ['1', '"s"', '{"a":1}', 'null']);
  assert.deepStrictEqual(run(JsonSplitter, ['[]']).recs, []);
});

test('JsonSplitter: truncated or trailing text', () => {
  assert.throws(() => run(JsonSplitter, ['[{"a":1},{"b":']), /line 1: the file ends inside this document/i);
  assert.throws(() => run(JsonSplitter, ['[{"a":"x']), /ends inside/);
  assert.throws(() => run(JsonSplitter, ['[{"a":1}]\n{"b":2}']), /Line 2: unexpected text after the closing \]/);
  const { recs, p } = run(JsonSplitter, ['[{"a":1},\n{"b":2}']);
  assert.strictEqual(recs.length, 2, 'whole documents before a missing ] still count');
  assert.match(p.problem, /closing \]/);
});

test('NdjsonSplitter: CRLF, blank lines, line numbers', () => {
  const text = '{"a":1}\r\n\r\n  {"b":2}  \n{bad\n{"c":3}';
  for (const chunks of splits(text)) {
    const { recs } = run(NdjsonSplitter, chunks);
    assert.deepStrictEqual(recs, [
      { text: '{"a":1}', line: 1 }, { text: '{"b":2}', line: 3 }, { text: '{bad', line: 4 }, { text: '{"c":3}', line: 5 },
    ]);
  }
});

test('CsvParser: quotes, escapes, line breaks, any chunking', () => {
  const text = 'a,b,c\r\n1,"x,y","he said ""hi"""\r\n2,"multi\nline",\n\n3,,"" \r4,"q"x,end';
  for (const chunks of splits(text)) {
    const { recs } = run(CsvParser, chunks, ',');
    assert.deepStrictEqual(recs, [
      { cells: ['a', 'b', 'c'], line: 1 },
      { cells: ['1', 'x,y', 'he said "hi"'], line: 2 },
      { cells: ['2', 'multi\nline', ''], line: 3 },
      { cells: ['3', '', ' '], line: 6 },
      { cells: ['4', 'qx', 'end'], line: 7 },
    ]);
  }
  assert.throws(() => run(CsvParser, ['a\n"open'], ','), /Line 2: unterminated/);
});

test('CSV separator detection, incl. export\'s Excel mode', () => {
  assert.strictEqual(detectDelimiter('a,b,c\n1;2;3'), ',');
  assert.strictEqual(detectDelimiter('a;b;c\r\n'), ';');
  assert.strictEqual(detectDelimiter('a\tb\n'), '\t');
  assert.strictEqual(detectDelimiter('a|b|c'), '|');
  assert.strictEqual(detectDelimiter('"x;y;z",b\n'), ',', 'quoted separators do not count');
  assert.strictEqual(detectDelimiter('name\n'), ',');
  assert.strictEqual(detectDelimiter('name\n', true), ';', 'a BOM points to Excel');
  // auto in the parser: the header can arrive in pieces
  for (const chunks of splits('_id;name\r\n1;a,b\r\n')) {
    const { recs, p } = run(CsvParser, chunks, 'auto');
    assert.strictEqual(p.delim, ';');
    assert.deepStrictEqual(recs.map((r) => r.cells), [['_id', 'name'], ['1', 'a,b']]);
  }
});

test('CSV cell types', () => {
  const t = (v) => (v && v._bsontype) || (v instanceof Date ? 'Date' : typeof v);
  const auto = (s) => CONVERT.auto(s);
  assert.strictEqual(auto('5'), 5);
  assert.strictEqual(t(auto('3000000000')), 'Long');
  assert.strictEqual(auto('9007199254740993').toString(), '9007199254740993');
  assert.strictEqual(t(auto('99999999999999999999')), 'Double');
  assert.strictEqual(t(auto('1.0')), 'Double');
  assert.strictEqual(t(auto('2.5e3')), 'Double');
  assert.strictEqual(auto('007'), '007', 'leading zeros: an id, not a number');
  assert.strictEqual(auto('true'), true);
  assert.strictEqual(auto('True'), 'True');
  assert.strictEqual(auto('1970-01-01T00:00:00.000Z').getTime(), 0);
  assert.strictEqual(auto('2024-01-02T03:04:05+03:00').toISOString(), '2024-01-02T00:04:05.000Z');
  assert.strictEqual(auto('2024-01-02'), '2024-01-02', 'a bare date stays text unless the column is Date');
  assert.deepStrictEqual(auto('{"l":6,"d":3}'), { l: 6, d: 3 });
  assert.strictEqual(t(auto('{"$numberLong":"6"}')), 'Long');
  assert.deepStrictEqual(auto('[1,"a"]'), [1, 'a']);
  assert.strictEqual(auto('[draft]'), '[draft]');
  assert.strictEqual(auto('0123456789abcdef01234567'), '0123456789abcdef01234567');
  // export's formula guard comes off again
  for (const s of ['=cmd()', '+1', '-x', '@import', '-5']) assert.strictEqual(auto("'" + s), s);
  assert.strictEqual(auto("'quoted'"), "'quoted'");

  assert.strictEqual(CONVERT.string('42'), '42');
  assert.strictEqual(CONVERT.string("'=x"), '=x');
  assert.strictEqual(CONVERT.number('+42'), 42);
  assert.strictEqual(t(CONVERT.number('.5')), 'Double');
  assert.strictEqual(CONVERT.number('2,5', ';').valueOf(), 2.5, 'decimal comma in an Excel file');
  assert.throws(() => CONVERT.number('2,5', ','), /not a number/);
  assert.ok(Number.isNaN(CONVERT.number('NaN').valueOf()));
  assert.throws(() => CONVERT.number('12abc'), /not a number: 12abc/);
  assert.throws(() => CONVERT.number('0x10'), /not a number/);
  assert.strictEqual(CONVERT.bool('YES'), true);
  assert.strictEqual(CONVERT.bool('0'), false);
  assert.throws(() => CONVERT.bool('maybe'), /not a boolean/);
  assert.strictEqual(CONVERT.date('2024-01-02').toISOString(), '2024-01-02T00:00:00.000Z');
  assert.strictEqual(CONVERT.date('2024-01-02 03:04').toISOString(), '2024-01-02T03:04:00.000Z', 'no zone means UTC');
  assert.strictEqual(CONVERT.date('86400000').toISOString(), '1970-01-02T00:00:00.000Z');
  assert.throws(() => CONVERT.date('02/01/2024'), /not an ISO date/);
  assert.throws(() => CONVERT.date('2024-13-45'), /not an ISO date/);
  assert.ok(CONVERT.objectId('0123456789abcdef01234567') instanceof ObjectId);
  assert.throws(() => CONVERT.objectId('xyz'), /not an ObjectId/);
});

test('CSV header: dotted names nest, conflicts and duplicates are refused', () => {
  const cols = makeColumns(['_id', 'a.b', 'a.c', '', 'n'], { _id: 'objectId', n: 'string' });
  const doc = rowToDoc(['0123456789abcdef01234567', '1', 'x', 'ignored', '7'], cols, ',');
  assert.deepStrictEqual(Object.keys(doc), ['_id', 'a', 'n']);
  assert.ok(doc._id instanceof ObjectId);
  assert.deepStrictEqual(doc.a, { b: 1, c: 'x' });
  assert.strictEqual(doc.n, '7');
  assert.deepStrictEqual(rowToDoc(['', '', '', '', ''], cols, ','), {}, 'blank cells are left out');
  assert.deepStrictEqual(rowToDoc(['0123456789abcdef01234567'], cols, ',').a, undefined, 'short rows are fine');
  assert.throws(() => rowToDoc(['0123456789abcdef01234567', '1', 'x', '', '7', 'extra'], cols, ','), /6 fields/);
  assert.throws(() => rowToDoc(['nope'], cols, ','), /column _id: not an ObjectId/);
  assert.throws(() => makeColumns(['a', 'a']), /Duplicate column: a/);
  assert.throws(() => makeColumns(['a.b', 'a']), /Column a conflicts with a\.b/);
  assert.throws(() => makeColumns(['x.y.z', 'x.y']), /Column x\.y conflicts with x\.y\.z/);
  assert.throws(() => makeColumns(['a..b']), /Bad column name/);
  assert.throws(() => makeColumns(['a'], { a: 'float' }), /Unknown type/);
  assert.throws(() => makeColumns(['', '']), /no column names/);
  // a literal __proto__ column stays data
  const p = rowToDoc(['1'], makeColumns(['__proto__.x']), ',');
  assert.strictEqual(Object.getPrototypeOf(p), Object.prototype);
  assert.deepStrictEqual(Object.keys(p), ['__proto__']);
});

const URI = process.env.MANGODESK_TEST_MONGO;
const DB = `data_import_test_${process.pid}`;

test('import route', { skip: !URI && 'set MANGODESK_TEST_MONGO to run' }, async (t) => {
  fs.writeFileSync(process.env.MANGODESK_CONFIG, JSON.stringify([{ id: 't', name: 't', uri: URI }]));
  const http = require('http');
  const { MongoClient } = require('mongodb');
  const { createApp } = require('../lib/app');
  const { closeClient } = require('../lib/clients');

  // the real app: the route must be mounted there and get past its Host/Origin guard
  const server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
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

  const same = { Origin: base, 'Sec-Fetch-Site': 'same-origin' };
  const doImport = async (collection, body, params = {}, headers = {}) => {
    const q = new URLSearchParams({ connectionId: 't', db: DB, collection, ...params });
    const r = await fetch(`${base}/api/import?${q}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...same, ...headers }, body,
    });
    return { status: r.status, body: await r.json() };
  };
  const exportText = async (collection, format, extra = {}) => {
    const r = await fetch(base + '/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...same },
      body: new URLSearchParams({ connectionId: 't', db: DB, collection, format, sort: '{"_id":1}', ...extra }),
    });
    assert.strictEqual(r.status, 200);
    return Buffer.from(await r.arrayBuffer()); // bytes: keep the BOM
  };
  const raw = (collection) => db.collection(collection)
    .find({}, { promoteValues: false, bsonRegExp: true }).sort({ _id: 1 }).toArray();
  // canonical EJSON tags every value with its BSON type, so "equal" means "same types" too
  const shape = (docs) => docs.map(ejson.serialize);

  const DOCS = [
    {
      _id: new ObjectId('0123456789abcdef01234567'), l: Long.fromNumber(5), big: Long.fromString('9007199254740993'),
      d: new Double(1), f: new Double(2.5), i: new Int32(7), dec: Decimal128.fromString('12.30'),
      at: new Date(Date.UTC(2024, 0, 2, 3, 4, 5, 678)), early: new Date(-1e12), s: 'text "quoted"\nline', b: true, n: null,
      bin: new Binary(Buffer.from([0, 1, 2, 255])), uuid: new UUID('0123456789ab4def8123456789abcdef').toBinary(),
      ts: new Timestamp({ t: 1700000000, i: 3 }), re: new BSONRegExp('^a.c', 'i'),
      sub: { l: Long.fromNumber(6), d: new Double(3), arr: [new Int32(1), new Double(1), 'x', { deep: Decimal128.fromString('1E+3') }] },
    },
    { _id: 2, onlyHere: 'y', nested: { a: { b: 1 } } },
  ];
  await db.collection('src').insertMany(DOCS);

  for (const format of ['json', 'ndjson']) {
    await t.test(`export ${format} -> import keeps every BSON type`, async () => {
      const file = await exportText('src', format);
      const r = await doImport('rt_' + format, file, { format });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.body, { inserted: 2, updated: 0, failed: 0, errors: [], stopped: false });
      assert.deepStrictEqual(shape(await raw('rt_' + format)), shape(await raw('src')));
      // and the copy exports byte for byte the same
      assert.strictEqual((await exportText('rt_' + format, format)).toString(), file.toString());
    });
  }

  await t.test('export CSV (plain and Excel) -> import', async () => {
    const coll = db.collection('csvsrc');
    await coll.insertMany([
      { _id: new ObjectId('0123456789abcdef01234567'), name: 'Ёжик; "в тумане"', n: 5, big: Long.fromString('9007199254740993'),
        f: new Double(2.5), ok: true, at: new Date(0), formula: '=1+1', neg: -3, sub: { a: 1, b: 'x' }, tags: ['a', 'b'] },
      { _id: new ObjectId('0123456789abcdef01234568'), name: 'second', n: 6 }, // no other fields: blanks
    ]);
    for (const excel of ['', '1']) {
      const file = await exportText('csvsrc', 'csv', { excel });
      assert.strictEqual(file[0] === 0xEF, !!excel, 'Excel mode has a BOM');
      const r = await doImport('csv_rt' + excel, file, { format: 'csv', types: JSON.stringify({ _id: 'objectId' }) });
      assert.deepStrictEqual(r.body, { inserted: 2, updated: 0, failed: 0, errors: [], stopped: false });
      const got = await raw('csv_rt' + excel);
      assert.deepStrictEqual(shape(got), shape(await raw('csvsrc')), 'excel=' + excel);
    }
  });

  await t.test('CSV: dotted columns, chosen types, row errors with line numbers', async () => {
    const csv = 'id,user.name,user.age,joined,active\n1,ann,31,2024-01-02,yes\n2,bob,old,2024-01-03,no\n3,"c, d",40,,1\n';
    const types = JSON.stringify({ 'user.age': 'number', joined: 'date', active: 'bool', 'user.name': 'string' });
    const r = await doImport('people', csv, { format: 'csv', types, onError: 'continue' });
    assert.strictEqual(r.body.inserted, 2);
    assert.strictEqual(r.body.failed, 1);
    assert.deepStrictEqual(r.body.errors, [{ line: 3, message: 'column user.age: not a number: old' }]);
    const docs = await db.collection('people').find({}, { projection: { _id: 0 } }).sort({ id: 1 }).toArray();
    assert.deepStrictEqual(docs, [
      { id: 1, user: { name: 'ann', age: 31 }, joined: new Date('2024-01-02T00:00:00Z'), active: true },
      { id: 3, user: { name: 'c, d', age: 40 }, active: true },
    ]);
    // a bad header is reported before anything is written
    const h = await doImport('people', 'a,a\n1,2\n', { format: 'csv' });
    assert.strictEqual(h.body.inserted, 0);
    assert.deepStrictEqual(h.body.errors, [{ message: 'Duplicate column: a' }]);
    assert.strictEqual(h.body.stopped, true);
  });

  await t.test('insert: duplicates and bad lines, stop vs continue', async () => {
    await db.collection('dups').insertOne({ _id: 2 });
    const nd = ['{"_id":1}', '{"_id":2}', '{"_id":3}', '{"_id":', '{"_id":{"$numberInt":"99999999999"}}', '[1]', '{"_id":4}'].join('\n');
    let r = await doImport('dups', nd, { format: 'ndjson', onError: 'continue' });
    assert.strictEqual(r.body.inserted, 3);
    assert.strictEqual(r.body.failed, 4);
    assert.strictEqual(r.body.stopped, false);
    assert.deepStrictEqual(r.body.errors.map((e) => e.line), [2, 4, 5, 6]);
    assert.match(r.body.errors[0].message, /E11000 duplicate key/);
    assert.match(r.body.errors[2].message, /out of range/);
    assert.match(r.body.errors[3].message, /not a document/);

    // stop at a bad line: what came before goes in, nothing after
    await db.collection('stop').deleteMany({});
    r = await doImport('stop', '{"a":1}\n{"a":2}\n{bad\n{"a":3}\n', { format: 'ndjson', onError: 'stop' });
    assert.deepStrictEqual({ ...r.body, errors: r.body.errors.length }, { inserted: 2, updated: 0, failed: 1, errors: 1, stopped: true });
    assert.deepStrictEqual((await db.collection('stop').find().toArray()).map((d) => d.a), [1, 2]);

    // stop at a write error: the batch it was in is written unordered, the next batch is not
    const many = Array.from({ length: 2500 }, (_, n) => JSON.stringify({ _id: n === 1500 ? 0 : n })).join('\n');
    r = await doImport('stopw', many, { format: 'ndjson' }); // stop is the default
    assert.strictEqual(r.body.stopped, true);
    assert.strictEqual(r.body.failed, 1);
    assert.strictEqual(r.body.inserted, 1999);
    assert.deepStrictEqual(r.body.errors.map((e) => e.line), [1501]);
    assert.strictEqual(await db.collection('stopw').countDocuments(), 1999);
  });

  await t.test('upsert by _id replaces, inserts the rest', async () => {
    const c = db.collection('up');
    await c.insertMany([{ _id: 1, v: 'old', gone: true }, { _id: 2, v: 'keep' }]);
    const r = await doImport('up', '[{"_id":1,"v":"new"},{"_id":3,"v":"added"},{"v":"no id"},{"_id":{"a":1},"v":"doc id"}]',
      { format: 'json', mode: 'upsert' });
    assert.deepStrictEqual(r.body, { inserted: 3, updated: 1, failed: 0, errors: [], stopped: false });
    const docs = await c.find({}, { projection: { _id: 0 } }).sort({ v: 1 }).toArray();
    assert.deepStrictEqual(docs.map((d) => d.v), ['added', 'doc id', 'keep', 'new', 'no id']);
    assert.strictEqual((await c.findOne({ _id: 1 })).gone, undefined, 'replaced, not merged');
  });

  await t.test('batches: a large file streams through in many writes', async () => {
    const n = 25000;
    const big = Array.from({ length: n }, (_, k) => JSON.stringify({ _id: k, pad: 'x'.repeat(200) })).join('\n');
    const r = await doImport('big', big, { format: 'ndjson' });
    assert.deepStrictEqual(r.body, { inserted: n, updated: 0, failed: 0, errors: [], stopped: false });
    assert.strictEqual(await db.collection('big').countDocuments(), n);
  });

  await t.test('a document over 16 MB fails alone, its batch still goes in', async () => {
    const nd = `{"_id":1}\n{"_id":2,"s":"${'x'.repeat(17 * 1024 * 1024)}"}\n{"_id":3}\n`;
    const r = await doImport('huge', nd, { format: 'ndjson', onError: 'continue' });
    assert.strictEqual(r.body.inserted, 2);
    assert.deepStrictEqual(r.body.errors.map((e) => e.line), [2]);
    assert.match(r.body.errors[0].message, /larger than the maximum/);
    // alone in its batch, too
    const one = await doImport('huge', `{"s":"${'x'.repeat(17 * 1024 * 1024)}"}`, { format: 'ndjson' });
    assert.strictEqual(one.status, 200);
    assert.deepStrictEqual([one.body.inserted, one.body.failed, one.body.stopped], [0, 1, true]);
  });

  await t.test('a command error ends the import, it is no document\'s failure', async () => {
    // refused as a whole, like a missing write privilege: no per-document errors at all
    const nd = Array.from({ length: 1500 }, (_, k) => JSON.stringify({ _id: k })).join('\n');
    for (const mode of ['insert', 'upsert']) {
      const r = await doImport('x', nd, { format: 'ndjson', onError: 'continue', mode, db: 'bad$db' });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual([r.body.inserted, r.body.failed, r.body.stopped], [0, 0, true], mode);
      assert.deepStrictEqual(r.body.errors.map((e) => e.message), ['Invalid namespace: bad$db.x']);
    }
    // a view refuses each document instead: those are failures, counted and listed
    await db.createCollection('aview', { viewOn: 'src', pipeline: [] });
    const r = await doImport('aview', nd, { format: 'ndjson', onError: 'continue' });
    assert.deepStrictEqual([r.body.inserted, r.body.failed, r.body.errors.length], [0, 1500, 20]);
    assert.match(r.body.errors[0].message, /is a view/);
  });

  await t.test('truncated JSON: whole documents are kept, the problem reported', async () => {
    const r = await doImport('trunc', '[{"a":1},{"a":2},{"a":', { format: 'json', onError: 'continue' });
    assert.strictEqual(r.body.inserted, 2);
    assert.strictEqual(r.body.stopped, true);
    assert.match(r.body.errors[0].message, /ends inside this document/);
  });

  await t.test('a .json Content-Type is not swallowed by the JSON body parser', async () => {
    const r = await doImport('ctype', '[{"a":1}]', { format: 'json' }, { 'Content-Type': 'application/json' });
    assert.strictEqual(r.body.inserted, 1);
  });

  await t.test('bad requests and the CSRF guard', async () => {
    let r = await doImport('x', '{}', { format: 'xml' });
    assert.strictEqual(r.status, 400);
    r = await doImport('x', '{}', { format: 'json', mode: 'merge' });
    assert.strictEqual(r.status, 400);
    r = await doImport('x', '', { format: 'json' });
    assert.deepStrictEqual(r, { status: 400, body: { error: 'The file is empty' } });
    r = await doImport('x', 'a\n1', { format: 'csv', types: '[1]' });
    assert.strictEqual(r.status, 400);
    for (const headers of [{ Origin: 'http://evil.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site', Origin: undefined }]) {
      const h = { 'Content-Type': 'text/plain', ...same, ...headers };
      if (h.Origin === undefined) delete h.Origin;
      const q = new URLSearchParams({ connectionId: 't', db: DB, collection: 'csrf', format: 'ndjson' });
      const res = await fetch(`${base}/api/import?${q}`, { method: 'POST', headers: h, body: '{"pwn":1}' });
      assert.strictEqual(res.status, 403, JSON.stringify(headers));
    }
    assert.strictEqual(await db.collection('csrf').countDocuments(), 0);
  });

  await t.test('preview: CSV columns and JSON first documents', async () => {
    const pv = async (body, params) => {
      const r = await fetch(`${base}/api/import/preview?${new URLSearchParams(params)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...same }, body,
      });
      return { status: r.status, body: await r.json() };
    };
    let r = await pv('﻿_id;name;n\r\n0123456789abcdef01234567;"a;b";1\r\n0123456789abcdef01234568;c;\r\n0123',
      { format: 'csv', delimiter: 'auto' });
    assert.deepStrictEqual(r.body, {
      format: 'csv', delimiter: ';', bom: true, rows: 2, complete: false,
      columns: [
        { name: '_id', type: 'objectId', samples: ['0123456789abcdef01234567', '0123456789abcdef01234568'] },
        { name: 'name', type: 'auto', samples: ['a;b', 'c'] },
        { name: 'n', type: 'auto', samples: ['1'] },
      ],
    });
    r = await pv('a,a\n', { format: 'csv' });
    assert.deepStrictEqual(r, { status: 400, body: { error: 'Duplicate column: a' } });
    r = await pv('[{"l":{"$numberLong":"5"}},{"x":1},{"y', { format: 'json' });
    assert.deepStrictEqual(r.body, { format: 'json', docs: [{ l: { $numberLong: '5' } }, { x: { $numberInt: '1' } }], errors: [], complete: false });
    r = await pv('{bad}\n{"a":1}\n', { format: 'ndjson', complete: '1' });
    assert.strictEqual(r.body.docs.length, 1);
    assert.strictEqual(r.body.errors[0].line, 1);
  });
});
