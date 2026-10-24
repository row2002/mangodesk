// public/js/shell.js: canonical EJSON -> mongosh text -> EJSON, the path every
// Edit dialog save, JSON view and "Filter by this value" takes.
const test = require('node:test');
const assert = require('assert');
const { BSON, MongoClient } = require('mongodb');
const { toShell, fromShell } = require('../public/js/shell');
const ejson = require('../lib/ejson');

const {
  Long, Double, Int32, Decimal128, ObjectId, Binary, UUID, Timestamp, MinKey, MaxKey, BSONRegExp, Code,
} = BSON;

const sample = () => ({
  _id: new ObjectId('65a1b2c3d4e5f60718293a4b'),
  long: Long.fromString('9007199254740993'), // past 2^53: must not be rounded
  one: new Double(1),
  half: new Double(2.5),
  negZero: new Double(-0),
  negDouble: new Double(-3),
  inf: new Double(Infinity),
  nan: new Double(NaN),
  huge: new Double(1e21),
  int: new Int32(5),
  negInt: new Int32(-7),
  dec: Decimal128.fromString('1.10'),
  date: new Date(0),
  oldDate: new Date(-1e12),
  bin: new Binary(Buffer.from('hi'), 0),
  uuid: new UUID('53d3b482-6afc-46c7-b957-5004637dddb8'),
  ts: new Timestamp({ t: 1, i: 2 }),
  min: new MinKey(),
  max: new MaxKey(),
  re: new BSONRegExp('^ab\\d+', 'im'),
  reSlash: new BSONRegExp('a/b', 'i'),
  reX: new BSONRegExp('a b', 'x'),
  code: new Code('x = 1'),
  nested: [[new Int32(1), new Double(1)], { a: new Double(1.5), b: [] }],
  'dotted.key': 's',
  str: 'it\'s "q" 1.0 // not a comment /re/',
  nul: null,
  yes: true,
  empty: {},
});

// What the server sends (C3) -> shell text -> what the browser would send back.
const roundTrip = (doc, indent) => ejson.serialize(ejson.parse(JSON.stringify(fromShell(toShell(doc, indent)))));

test('toShell prints mongosh syntax', () => {
  const c = ejson.serialize(sample());
  const out = toShell(c, 2);
  for (const want of [
    '_id: ObjectId("65a1b2c3d4e5f60718293a4b")', 'long: NumberLong("9007199254740993")',
    'one: 1.0', 'half: 2.5', 'negZero: -0.0', 'negDouble: -3.0', 'inf: Infinity', 'nan: NaN',
    'huge: 1e+21', 'int: 5', 'negInt: -7', 'dec: NumberDecimal("1.10")',
    'date: ISODate("1970-01-01T00:00:00.000Z")', 'bin: BinData(0, "aGk=")',
    'uuid: UUID("53d3b482-6afc-46c7-b957-5004637dddb8")', 'ts: Timestamp({ t: 1, i: 2 })',
    'min: MinKey()', 'max: MaxKey()', 're: /^ab\\d+/im', 'reSlash: BSONRegExp("a/b", "i")',
    'reX: BSONRegExp("a b", "x")', 'code: Code("x = 1")', 'nested: [[1, 1.0], { a: 1.5, b: [] }]',
    '"dotted.key": "s"', 'empty: {}',
  ]) assert.ok(out.includes(want), `missing ${want} in\n${out}`);
  assert.strictEqual(toShell({ a: { $numberInt: '1' } }), '{ a: 1 }');
  assert.strictEqual(toShell({ __proto__x: 1, ['__proto__']: 2 }), '{ __proto__x: 1, ["__proto__"]: 2 }');
});

test('every BSON type survives toShell -> fromShell exactly', () => {
  const c = ejson.serialize(sample());
  assert.deepStrictEqual(roundTrip(c, 2), c);
  assert.deepStrictEqual(roundTrip(c), c); // single-line form too (Query Code, filters)
});

test('fromShell reads typed and pasted shell text', () => {
  assert.deepStrictEqual(fromShell('{a: 1, b: 1.0, c: -2.50, d: 1e3, e: -Infinity, f: 5n, g: 1_000}'), {
    a: 1, b: { $numberDouble: '1.0' }, c: { $numberDouble: '-2.50' }, d: { $numberDouble: '1e3' },
    e: { $numberDouble: '-Infinity' }, f: { $numberLong: '5' }, g: 1000,
  });
  // ints stay plain JSON numbers, so the server stores Int32 like mongosh does
  assert.deepStrictEqual(fromShell('[1, -2, 0x10]'), [1, -2, 16]);
  assert.deepStrictEqual(fromShell("{'q': 'x', trailing: [1,],} // comment"), { q: 'x', trailing: [1] });
  assert.deepStrictEqual(fromShell('{d: new Date(0), e: ISODate("2024-01-01T10:00:00")}'), {
    d: { $date: { $numberLong: '0' } }, e: { $date: { $numberLong: String(Date.UTC(2024, 0, 1, 10)) } },
  });
  assert.deepStrictEqual(fromShell('{x: /a\\/b[/]/i, y: 10 / 4, z: NumberDecimal(1.10), w: NumberLong(5.0)}'), {
    x: { $regularExpression: { pattern: 'a\\/b[/]', options: 'i' } }, y: 2.5,
    z: { $numberDecimal: '1.10' }, w: { $numberLong: '5' },
  });
  assert.deepStrictEqual(fromShell('{"__proto__": {x: 1}}'), JSON.parse('{"__proto__": {"x": 1}}'));
  assert.deepStrictEqual(fromShell('{s: "1.5", n: NumberInt("7"), t: Timestamp(3, 4)}'),
    { s: '1.5', n: { $numberInt: '7' }, t: { $timestamp: { t: 3, i: 4 } } });
  // strict EJSON passes through untouched
  const strict = '{"a":{"$numberDouble":"1.0"},"b":{"$oid":"65a1b2c3d4e5f60718293a4b"}}';
  assert.deepStrictEqual(fromShell(strict), JSON.parse(strict));
  assert.match(fromShell('{_id: ObjectId()}')._id.$oid, /^[0-9a-f]{24}$/);
  assert.throws(() => fromShell('{a:'), /Unexpected/);
  assert.throws(() => fromShell('{d: ISODate("nope")}'), /Invalid date/);
});

test('an edited document keeps its stored BSON types', { skip: !process.env.MANGODESK_TEST_MONGO && 'set MANGODESK_TEST_MONGO to run' }, async (t) => {
  const mongo = await MongoClient.connect(process.env.MANGODESK_TEST_MONGO);
  const db = mongo.db(`grid_test_${process.pid}`);
  t.after(async () => { await db.dropDatabase().catch(() => {}); await mongo.close(); });
  const coll = db.collection('c');
  await coll.insertOne(sample());
  const read = async () => ejson.serialize(await coll.findOne({}, { promoteValues: false }));
  const before = await read();
  // the Edit dialog: shell text -> user changes one value -> normalised -> PUT (replaceOne)
  const edited = toShell(before, 2).replace('half: 2.5', 'half: 3.0');
  await coll.replaceOne({ _id: new ObjectId(before._id.$oid) },
    ejson.parse(JSON.stringify(fromShell(edited))));
  const after = await read();
  assert.deepStrictEqual(after.half, { $numberDouble: '3.0' });
  assert.deepStrictEqual({ ...after, half: before.half }, before);
});

test('free identifiers are errors, not page globals', () => {
  globalThis.closed = false; // what window.closed is in the browser
  try {
    assert.throws(() => fromShell('closed'), /closed is not defined/);
    assert.throws(() => fromShell('{status: closed}'), /closed is not defined/);
  } finally { delete globalThis.closed; }
  assert.deepStrictEqual(fromShell('{a: Math.max(1, 2), b: [1, 2].map((x) => x * 2), c: Number("3")}'),
    { a: 2, b: [2, 4], c: 3 });
});

test('new Date(y, m, d) and zone-less ISODate strings', () => {
  const ms = (text) => fromShell(text).$date.$numberLong;
  assert.strictEqual(ms('new Date(2024, 0, 1)'), String(new Date(2024, 0, 1).getTime()));
  assert.strictEqual(ms('Date(2024, 5, 1, 12, 30)'), String(new Date(2024, 5, 1, 12, 30).getTime()));
  assert.strictEqual(ms('new Date(0)'), '0');
  assert.strictEqual(ms('ISODate("2024-01-01T00:00")'), String(Date.UTC(2024, 0, 1)));
  // TZ is fixed at startup, so check the space form (read as UTC, like mongosh) off-UTC in a child
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath, ['-e', `const { fromShell } = require(${JSON.stringify(require.resolve('../public/js/shell'))});
    console.log(JSON.stringify(fromShell('[ISODate("2020-01-01 10:00:00"), ISODate("2020-01-01T10:00:00")]')))`],
  { env: { ...process.env, TZ: 'America/New_York' } });
  assert.deepStrictEqual(JSON.parse(out).map((d) => d.$date.$numberLong), ['1577872800000', '1577872800000']);
});
