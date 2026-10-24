const { BSON } = require('mongodb');
const { EJSON } = BSON;

// Server-side EJSON parsing, shared by every route that takes EJSON text.
//
// Wrappers are parsed in canonical mode (relaxed:false) so the types the UI sends back
// survive: {$numberLong:"5"} stays a Long, {$numberDouble:"1.0"} a Double, and a Long
// past 2^53 is not rounded. Relaxed mode (the bson default) turns all of them into JS
// numbers, which a save then writes back as Int32/Double.
//
// Plain JSON numbers are left as JS numbers, so the driver stores them the way mongosh
// does: integers in int32 range as Int32, everything else as Double. (Canonical mode
// would make 3000000000 a Long and turn projection/sort values into Int32 objects.)

const CANONICAL = { relaxed: false };
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

// Keys that make an object an EJSON value rather than a document. $regex/$options is
// also the query-operator spelling; bson reads both as a BSONRegExp, which the server
// accepts in either place.
const WRAPPERS = new Set([
  '$oid', '$date', '$numberInt', '$numberLong', '$numberDouble', '$numberDecimal',
  '$binary', '$uuid', '$symbol', '$code', '$timestamp', '$regex', '$regularExpression',
  '$minKey', '$maxKey', '$dbPointer', '$ref', '$undefined',
]);

// bson's canonical parser wraps out-of-range text ("9223372036854775808" -> Long.MIN)
// and truncates fractions ({$numberInt:"2.5"} -> 2), which would store or match a
// different number than the user typed: reject those instead.
const RANGES = { $numberInt: 2n ** 31n, $numberLong: 2n ** 63n };
function checkInts(v) {
  if (v === null || typeof v !== 'object') return;
  for (const [k, x] of Object.entries(v)) {
    if (RANGES[k] !== undefined && typeof x === 'string') {
      const n = /^-?\d+$/.test(x) ? BigInt(x) : null;
      if (n === null || n < -RANGES[k] || n >= RANGES[k]) {
        throw bad(`${k} ${n === null ? 'is not an integer' : 'out of range'}: ${x}`);
      }
    } else checkInts(x);
  }
}

function revive(v) {
  if (Array.isArray(v)) return v.map(revive);
  if (v === null || typeof v !== 'object') return v;
  const keys = Object.keys(v);
  if (keys.some((k) => WRAPPERS.has(k))) {
    // legacy {$date: <ms>} is only understood by the relaxed parser
    if (typeof v.$date === 'number') v = { ...v, $date: { $numberLong: String(Math.trunc(v.$date)) } };
    checkInts(v);
    return EJSON.parse(JSON.stringify(v), CANONICAL);
  }
  // in place, so a literal "__proto__" key stays an own property
  for (const k of keys) v[k] = revive(v[k]);
  return v;
}

// EJSON text -> JS/BSON value. Throws SyntaxError / BSONError on bad input.
function parse(text) {
  return revive(JSON.parse(text));
}

const isDocument = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && !v._bsontype && Object.prototype.toString.call(v) === '[object Object]';

// Filter / sort / projection text -> plain document; blank -> fallback.
// 42, null, [1] or a bare ObjectId parse fine but are not queries: 400 with a clear message.
function parseDoc(text, fallback, label = 'Value') {
  if (text == null || (typeof text === 'string' && !text.trim())) return fallback;
  if (typeof text !== 'string') throw bad(label + ' must be EJSON text');
  let v;
  try { v = parse(text); } catch (err) { throw bad(label + ': ' + err.message); }
  if (!isDocument(v)) throw bad(label + ' must be an object, e.g. {}');
  return v;
}

// Canonical EJSON for documents going to the UI or an export file. Read docs with
// promoteValues:false so Int32/Long/Double reach this point with their types intact.
const serialize = (v) => EJSON.serialize(v, CANONICAL);
const stringify = (v, indent) => EJSON.stringify(v, null, indent, CANONICAL);

module.exports = { parse, parseDoc, serialize, stringify };
