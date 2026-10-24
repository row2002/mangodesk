const express = require('express');
const { getClient } = require('../lib/clients');
const ejson = require('../lib/ejson');

const router = express.Router();

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

const CONTENT_TYPES = {
  json: 'application/json',
  ndjson: 'application/x-ndjson',
  csv: 'text/csv; charset=utf-8',
};

function csvEscape(s, delim = ',') {
  if (s.includes(delim) || /["\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// BSON scalars whose toString() is the value a human expects in a cell.
const BSON_SCALARS = new Set(['ObjectId', 'Decimal128', 'Long', 'Int32', 'Double', 'UUID', 'BSONSymbol']);

// Plain-text rendering of a BSON scalar, or undefined if it has none.
function bsonScalar(v) {
  const t = v._bsontype;
  if (BSON_SCALARS.has(t)) return v.toString();
  if (t === 'Binary') return v.sub_type === 4 ? v.toUUID().toString() : v.toString('base64');
  if (t === 'Timestamp') return `${v.t}.${v.i}`;
  if (t === 'MinKey' || t === 'MaxKey') return t; // toString() is [object Object]
  return undefined;
}

// Int32/Double/Long as a JSON number inside nested docs; NaN/Infinity and Longs past
// 2^53 fall through to their text form.
function bsonNumber(v) {
  const t = v._bsontype;
  const n = t === 'Int32' || t === 'Double' ? v.valueOf() : t === 'Long' ? v.toNumber() : undefined;
  if (n === undefined || !Number.isFinite(n) || (t === 'Long' && !Number.isSafeInteger(n))) return undefined;
  return n;
}

// Same unwrapping one level down, so nested docs don't leak $numberDecimal either.
// Read the raw value off the holder: toJSON runs before the replacer, and BSON's
// toJSON is exactly the extended-JSON form we're trying to avoid.
function nestedReplacer(k, v) {
  const raw = this[k];
  if (raw && raw._bsontype) {
    const n = bsonNumber(raw);
    if (n !== undefined) return n;
    const s = bsonScalar(raw);
    if (s !== undefined) return s;
  }
  return v;
}

function csvValue(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if (v._bsontype) {
      const s = bsonScalar(v);
      if (s !== undefined) return s;
    }
    return JSON.stringify(v, nestedReplacer);
  }
  // formula-injection guard: keep spreadsheet apps from executing string values
  if (typeof v === 'string' && /^[=+@\t\r-]/.test(v)) return "'" + v;
  return String(v);
}

// Resolve a possibly-dotted CSV header key ("a.b") against a document.
// A literal "a.b" key wins over the nested path.
function dig(doc, path) {
  if (path in doc) return doc[path];
  let v = doc;
  for (const part of path.split('.')) {
    if (v == null || typeof v !== 'object') return undefined;
    v = v[part];
  }
  return v;
}

// Write with backpressure; settles on client abort too so the handler never hangs.
function write(res, chunk) {
  if (res.write(chunk)) return Promise.resolve();
  return new Promise((r) => {
    const done = () => {
      res.removeListener('drain', done);
      res.removeListener('close', done);
      res.removeListener('error', done);
      r();
    };
    res.once('drain', done);
    res.once('close', done);
    res.once('error', done);
  });
}

// Every top-level field name in the result set, in first-seen order. An expression
// projection (MongoDB 4.4+) sends only the key names back, so this is one light extra
// pass rather than a sample that drops columns first appearing after document 200.
const KEYS = { _id: 0, k: { $map: { input: { $objectToArray: '$$ROOT' }, in: '$$this.k' } } };

// Projection values: 0/false (also as Int32/Double wrappers) exclude a field.
const excluded = (v) => !v || (typeof v === 'object' && v._bsontype !== undefined && Number(v) === 0);
// {a:{$slice:n}} returns every field, like an exclusion projection
const isSlice = (v) => v !== null && typeof v === 'object' && !v._bsontype && '$slice' in v;

async function csvColumns(coll, f, s, skip, limit, p) {
  const scan = (projection, n) => {
    let c = coll.find(f, { projection });
    if (s && (skip || n)) c = c.sort(s); // order only matters for which docs skip/limit pick
    if (skip) c = c.skip(skip);
    if (n) c = c.limit(n);
    return c;
  };
  const keys = new Set();
  try {
    for await (const { k } of scan(KEYS, limit)) k.forEach((x) => keys.add(x));
  } catch (err) {
    if (err.name !== 'MongoServerError') throw err;
    // older server: fall back to sampling (a broken filter fails here again and surfaces)
    keys.clear();
    for await (const doc of scan(p, limit ? Math.min(200, limit) : 200)) {
      Object.keys(doc).forEach((x) => keys.add(x));
    }
  }
  // p has no inclusions here; drop excluded columns (a dotted exclusion trims inside a
  // column, not the column; {_id:1} and {a:{$slice:n}} keep theirs)
  if (p) Object.keys(p).filter((x) => !x.includes('.') && excluded(p[x])).forEach((x) => keys.delete(x));
  return [...keys];
}

router.post('/api/export', wrap(async (req, res, next) => {
  const { connectionId, db, collection, filter, sort, projection, format } = req.body;
  if (!CONTENT_TYPES[format]) throw bad('Unknown format: ' + format);
  if (!connectionId || !db || !collection) throw bad('connectionId, db and collection are required');

  const f = ejson.parseDoc(filter, {}, 'Filter');
  const s = ejson.parseDoc(sort, undefined, 'Sort');
  const p = ejson.parseDoc(projection, undefined, 'Projection');
  const limit = Math.max(0, parseInt(req.body.limit, 10) || 0);
  const skip = Math.max(0, parseInt(req.body.skip, 10) || 0);
  const client = await getClient(connectionId);
  const coll = client.db(db).collection(collection);

  let header = null;
  if (format === 'csv') {
    // Included fields from an inclusion projection, else every top-level key in the
    // result. _id alone doesn't make one: {_id:1, a:0} still returns all but a.
    if (p) {
      const included = Object.keys(p).filter((k) => k !== '_id' && !excluded(p[k]) && !isSlice(p[k]));
      if (included.length) header = '_id' in p && excluded(p._id) ? included : ['_id', ...included];
    }
    if (!header) header = await csvColumns(coll, f, s, skip, limit, p);
  }

  // promoteValues:false: a Long stays a Long and 1.0 a Double in the JSON/NDJSON files
  let cursor = coll.find(f, { promoteValues: false });
  if (s) cursor = cursor.sort(s);
  if (p) cursor = cursor.project(p);
  if (skip) cursor = cursor.skip(skip);
  if (limit) cursor = cursor.limit(limit);
  // Fetch the first batch before any header goes out, so a bad operator, a sort over
  // the memory limit or a missing privilege comes back as a JSON error the export
  // panel shows, not as an attachment that dies at 0 bytes.
  try { await cursor.hasNext(); } catch (err) {
    await cursor.close().catch(() => {});
    throw err;
  }

  const safeName = String(collection).replace(/[^\w.-]/g, '_');
  res.setHeader('Content-Type', CONTENT_TYPES[format]);
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.${format}"`);
  res.on('close', () => cursor.close().catch(() => {}));

  try {
    if (format === 'json') {
      await write(res, '[\n');
      let first = true;
      for await (const doc of cursor) {
        // canonical EJSON is the lossless form; mongoimport reads it as is
        await write(res, (first ? '' : ',\n') + ejson.stringify(doc, 2));
        first = false;
      }
      await write(res, '\n]');
    } else if (format === 'ndjson') {
      for await (const doc of cursor) {
        await write(res, ejson.stringify(doc) + '\n');
      }
    } else {
      // Excel (RU/EU locale) needs a UTF-8 BOM to not mangle Cyrillic, ';' as the
      // separator and CRLF; plain CSV consumers are better off without all three.
      const excel = req.body.excel === '1' || req.body.excel === true;
      const delim = excel ? ';' : ',';
      const eol = excel ? '\r\n' : '\n';
      if (excel) await write(res, '\uFEFF');
      await write(res, header.map((h) => csvEscape(h, delim)).join(delim) + eol);
      for await (const doc of cursor) {
        await write(res, header.map((k) => csvEscape(csvValue(dig(doc, k)), delim)).join(delim) + eol);
      }
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.removeHeader('Content-Disposition');
      return next(err);
    }
    // Failed mid-stream (or the client went away): kill the socket so the chunked body
    // never terminates. Browsers then mark the download failed and curl exits non-zero;
    // an in-band error marker would leave a file that looks complete up to a batch edge.
    res.destroy();
  } finally {
    await cursor.close().catch(() => {});
  }
}));

module.exports = router;
module.exports.csvEscape = csvEscape;
module.exports.csvValue = csvValue;
module.exports.dig = dig;
