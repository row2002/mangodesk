// Smoke test for the pure CSV helpers. Run: npm test
const assert = require('assert');
const { ObjectId } = require('mongodb');
const { csvEscape, csvValue, dig } = require('./routes/export');

// csvEscape
assert.strictEqual(csvEscape('plain'), 'plain');
assert.strictEqual(csvEscape('a,b'), '"a,b"');
assert.strictEqual(csvEscape('line\nbreak'), '"line\nbreak"');
assert.strictEqual(csvEscape('he said "hi"'), '"he said ""hi"""');

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

// dig — dotted CSV header keys
assert.strictEqual(dig({ a: { b: 7 } }, 'a.b'), 7);
assert.deepStrictEqual(dig({ a: { b: 7 } }, 'a'), { b: 7 }); // plain key
assert.strictEqual(dig({ 'a.b': 1, a: { b: 2 } }, 'a.b'), 1); // literal key wins
assert.strictEqual(dig({ a: null }, 'a.b'), undefined);
assert.strictEqual(dig({}, 'a.b'), undefined);
assert.strictEqual(dig({ a: [{ b: 3 }] }, 'a.0.b'), 3);

console.log('ok');
