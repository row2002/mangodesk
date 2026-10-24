// Unit tests for lib/ejson.js (no MongoDB needed).
const test = require('node:test');
const assert = require('assert');
const { BSON, Long, Double, Int32, ObjectId, BSONRegExp, Timestamp } = require('mongodb');
const ejson = require('../lib/ejson');

const roundTrip = (v) => BSON.deserialize(BSON.serialize({ v }), { promoteValues: false }).v;

test('wrappers keep their BSON type (canonical, not relaxed)', () => {
  const v = ejson.parse('{"l":{"$numberLong":"5"},"d":{"$numberDouble":"1.0"},"i":{"$numberInt":"7"},'
    + '"big":{"$numberLong":"9007199254740993"},"dec":{"$numberDecimal":"1.10"}}');
  assert.ok(v.l instanceof Long);
  assert.strictEqual(v.l.toString(), '5');
  assert.ok(v.d instanceof Double);
  assert.ok(v.i instanceof Int32);
  assert.strictEqual(v.big.toString(), '9007199254740993');
  assert.strictEqual(v.dec.toString(), '1.10');
  // and they survive BSON serialisation, which is what the driver writes
  assert.strictEqual(roundTrip(v.l)._bsontype, 'Long');
  assert.strictEqual(roundTrip(v.d)._bsontype, 'Double');
  assert.strictEqual(roundTrip(v.big).toString(), '9007199254740993');
});

test('plain JSON numbers are stored by range, like mongosh', () => {
  const v = ejson.parse('{"small":5,"big":3000000000,"frac":1.5,"one":1.0}');
  assert.strictEqual(v.small, 5);
  assert.strictEqual(v.big, 3000000000);
  assert.strictEqual(roundTrip(v.small)._bsontype, 'Int32');
  assert.strictEqual(roundTrip(v.big)._bsontype, 'Double');
  assert.strictEqual(roundTrip(v.frac)._bsontype, 'Double');
  assert.strictEqual(roundTrip(v.one)._bsontype, 'Int32'); // JSON has no 1.0; use $numberDouble
});

test('other wrappers, operators and nesting', () => {
  const v = ejson.parse('{"_id":{"$oid":"0123456789abcdef01234567"},"a":{"$in":[{"$numberLong":"1"},2]},'
    + '"at":{"$date":{"$numberLong":"0"}},"iso":{"$date":"1970-01-01T00:00:00Z"},"ms":{"$date":0},'
    + '"re":{"$regex":"^a","$options":"i"},"ts":{"$timestamp":{"t":4294967295,"i":1}},'
    + '"deep":[{"x":{"$numberDouble":"2.0"}}]}');
  assert.ok(v._id instanceof ObjectId);
  assert.ok(v.a.$in[0] instanceof Long);
  assert.strictEqual(v.a.$in[1], 2);
  assert.strictEqual(v.at.getTime(), 0);
  assert.strictEqual(v.iso.getTime(), 0);
  assert.strictEqual(v.ms.getTime(), 0); // legacy numeric $date still accepted
  assert.ok(v.re instanceof BSONRegExp);
  assert.ok(v.ts instanceof Timestamp);
  assert.ok(v.deep[0].x instanceof Double);
});

test('a literal __proto__ key stays data', () => {
  const v = ejson.parse('{"__proto__":{"x":1}}');
  assert.strictEqual(Object.getPrototypeOf(v), Object.prototype);
  assert.deepStrictEqual(Object.keys(v), ['__proto__']);
});

test('parseDoc: blank -> fallback, non-objects -> 400', () => {
  assert.deepStrictEqual(ejson.parseDoc('', {}), {});
  assert.strictEqual(ejson.parseDoc('  ', undefined), undefined);
  assert.strictEqual(ejson.parseDoc(undefined, 7), 7);
  assert.deepStrictEqual(ejson.parseDoc('{"a":1}', {}), { a: 1 });
  for (const t of ['42', 'null', '[1]', '"x"', 'true', '{"$oid":"0123456789abcdef01234567"}']) {
    assert.throws(() => ejson.parseDoc(t, {}, 'Filter'),
      (e) => e.status === 400 && e.message === 'Filter must be an object, e.g. {}', t);
  }
  assert.throws(() => ejson.parseDoc('{bad', {}, 'Sort'), (e) => e.status === 400 && /^Sort: /.test(e.message));
  assert.throws(() => ejson.parseDoc({ a: 1 }, {}, 'Filter'), (e) => e.status === 400);
});

test('serialize/stringify are canonical', () => {
  const doc = { l: Long.fromString('9007199254740993'), d: new Double(1), i: new Int32(2), at: new Date(0) };
  assert.deepStrictEqual(ejson.serialize(doc), {
    l: { $numberLong: '9007199254740993' }, d: { $numberDouble: '1.0' }, i: { $numberInt: '2' },
    at: { $date: { $numberLong: '0' } },
  });
  assert.strictEqual(ejson.stringify({ d: new Double(1) }), '{"d":{"$numberDouble":"1.0"}}');
  assert.strictEqual(ejson.stringify({ a: 'x' }, 2), '{\n  "a": "x"\n}');
});

test('out-of-range or fractional integer wrappers are rejected (400), not wrapped', () => {
  for (const t of ['{"$numberLong":"9223372036854775808"}', '{"$numberLong":"99999999999999999999"}',
    '{"$numberLong":"-9223372036854775809"}', '{"$numberInt":"3000000000"}', '{"$numberInt":"2.5"}',
    '{"a":{"$gte":{"$numberLong":"1e3"}}}', '{"$date":{"$numberLong":"99999999999999999999"}}']) {
    assert.throws(() => ejson.parse(t), (e) => e.status === 400, t);
  }
  assert.throws(() => ejson.parseDoc('{"a":{"$numberInt":"3000000000"}}'), (e) => e.status === 400 && /out of range/.test(e.message));
  // the edges still parse
  assert.strictEqual(ejson.parse('{"$numberLong":"9223372036854775807"}').toString(), '9223372036854775807');
  assert.strictEqual(ejson.parse('{"$numberLong":"-9223372036854775808"}').toString(), '-9223372036854775808');
  assert.strictEqual(ejson.parse('{"$numberInt":"-2147483648"}').value, -2147483648);
  assert.strictEqual(ejson.parse('{"$numberInt":"2147483647"}').value, 2147483647);
});
