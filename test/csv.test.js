// Smoke test for the pure CSV helpers. Run: npm test
const assert = require('assert');
const { ObjectId, Decimal128, Long, Double, Int32, Binary, Timestamp } = require('mongodb');
const { csvEscape, csvValue, dig } = require('../routes/export');

// csvEscape
assert.strictEqual(csvEscape('plain'), 'plain');
assert.strictEqual(csvEscape('a,b'), '"a,b"');
assert.strictEqual(csvEscape('line\nbreak'), '"line\nbreak"');
assert.strictEqual(csvEscape('he said "hi"'), '"he said ""hi"""');
// Excel mode: ';' separates, so ';' must be quoted and a bare ',' must not
assert.strictEqual(csvEscape('a;b', ';'), '"a;b"');
assert.strictEqual(csvEscape('a,b', ';'), 'a,b');

// csvValue
assert.strictEqual(csvValue(null), '');
assert.strictEqual(csvValue(undefined), '');
assert.strictEqual(csvValue(5), '5');
assert.strictEqual(csvValue(-5), '-5'); // numbers are never formula-prefixed
assert.strictEqual(csvValue(true), 'true');
assert.strictEqual(csvValue(new Date(0)), '1970-01-01T00:00:00.000Z');
assert.strictEqual(csvValue(new ObjectId('0123456789abcdef01234567')), '0123456789abcdef01234567');
assert.strictEqual(csvValue({ a: 1 }), '{"a":1}');
// formula-injection guard on strings
assert.strictEqual(csvValue('=cmd()'), "'=cmd()");
assert.strictEqual(csvValue('+1'), "'+1");
assert.strictEqual(csvValue('-x'), "'-x");
assert.strictEqual(csvValue('@import'), "'@import");
assert.strictEqual(csvValue('safe'), 'safe');

// BSON scalars render as plain values, not extended-JSON wrappers
assert.strictEqual(csvValue(Decimal128.fromString('12.34')), '12.34');
assert.strictEqual(csvValue(Long.fromBigInt(9007199254740993n)), '9007199254740993');
assert.strictEqual(csvValue(new Double(1.5)), '1.5');
assert.strictEqual(csvValue(new Int32(3)), '3');
assert.strictEqual(csvValue(new Binary(Buffer.from('hi'))), 'aGk=');
assert.strictEqual(csvValue(new Timestamp({ t: 1700000000, i: 3 })), '1700000000.3');
// …and inside nested documents too
assert.strictEqual(
  csvValue({ price: Decimal128.fromString('12.34'), at: new Date(0), id: new ObjectId('0123456789abcdef01234567') }),
  '{"price":"12.34","at":"1970-01-01T00:00:00.000Z","id":"0123456789abcdef01234567"}',
);
assert.strictEqual(csvValue([Decimal128.fromString('1.5'), 2]), '["1.5",2]');
// Exports read with promoteValues:false, so numbers arrive as Int32/Long/Double objects:
// a whole Double prints like a spreadsheet shows it ('1', not '1.0'), and nested ones
// stay JSON numbers (a Long past 2^53 becomes a string rather than rounding)
assert.strictEqual(csvValue(new Double(1)), '1');
assert.strictEqual(csvValue(new Double(-2)), '-2'); // no formula guard on numbers
assert.strictEqual(csvValue(Long.fromNumber(-5)), '-5');
assert.strictEqual(
  csvValue({ i: new Int32(1), d: new Double(1), f: new Double(2.5), l: Long.fromNumber(5), big: Long.fromString('9007199254740993') }),
  '{"i":1,"d":1,"f":2.5,"l":5,"big":"9007199254740993"}',
);
assert.strictEqual(csvValue([new Double(NaN)]), '["NaN"]');

// dig — dotted CSV header keys
assert.strictEqual(dig({ a: { b: 7 } }, 'a.b'), 7);
assert.deepStrictEqual(dig({ a: { b: 7 } }, 'a'), { b: 7 }); // plain key
assert.strictEqual(dig({ 'a.b': 1, a: { b: 2 } }, 'a.b'), 1); // literal key wins
assert.strictEqual(dig({ a: null }, 'a.b'), undefined);
assert.strictEqual(dig({}, 'a.b'), undefined);
assert.strictEqual(dig({ a: [{ b: 3 }] }, 'a.0.b'), 3);

console.log('ok');
