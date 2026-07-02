const express = require('express');
const { BSON } = require('mongodb');
const { EJSON } = BSON;
const { getClient } = require('../lib/clients');

const router = express.Router();

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

const CONTENT_TYPES = {
  json: 'application/json',
  ndjson: 'application/x-ndjson',
  csv: 'text/csv',
};

function parseEjson(str, fallback) {
  return str && str.trim() ? EJSON.parse(str) : fallback;
}

function csvEscape(s) {
  if (/[,"\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function csvValue(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (v._bsontype === 'ObjectId') return v.toHexString();
  if (typeof v === 'object') return EJSON.stringify(EJSON.serialize(v));
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

router.post('/api/export', wrap(async (req, res) => {
  const { connectionId, db, collection, filter, sort, projection, format } = req.body;
  if (!CONTENT_TYPES[format]) throw bad('Unknown format: ' + format);
  if (!connectionId || !db || !collection) throw bad('connectionId, db and collection are required');

  const client = await getClient(connectionId);
  const coll = client.db(db).collection(collection);
  const f = parseEjson(filter, {});
  const s = parseEjson(sort, undefined);
  const p = parseEjson(projection, undefined);
  const limit = Number(req.body.limit) || 0;
  const skip = Number(req.body.skip) || 0;

  let header = null;
  if (format === 'csv') {
    // Included fields from projection, else sample top-level keys.
    if (p) {
      const included = Object.keys(p).filter((k) => p[k]);
      if (included.length) {
        header = included;
        if (!included.includes('_id') && p._id !== 0) header.unshift('_id');
      }
    }
    if (!header) {
      // sample with the same sort/projection/limit so the header matches what's exported
      let sample = coll.find(f);
      if (s) sample = sample.sort(s);
      if (p) sample = sample.project(p);
      if (skip) sample = sample.skip(skip);
      const keys = new Set();
      for await (const doc of sample.limit(limit ? Math.min(200, limit) : 200)) {
        Object.keys(doc).forEach((k) => keys.add(k));
      }
      header = [...keys];
    }
  }

  let cursor = coll.find(f);
  if (s) cursor = cursor.sort(s);
  if (p) cursor = cursor.project(p);
  if (skip) cursor = cursor.skip(skip);
  if (limit) cursor = cursor.limit(limit);

  const safeName = String(collection).replace(/[^\w.-]/g, '_');
  res.setHeader('Content-Type', CONTENT_TYPES[format]);
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.${format}"`);
  res.on('close', () => cursor.close().catch(() => {}));

  try {
    if (format === 'json') {
      await write(res, '[\n');
      let first = true;
      for await (const doc of cursor) {
        await write(res, (first ? '' : ',\n') + EJSON.stringify(EJSON.serialize(doc), null, 2));
        first = false;
      }
      await write(res, '\n]');
    } else if (format === 'ndjson') {
      for await (const doc of cursor) {
        await write(res, EJSON.stringify(EJSON.serialize(doc)) + '\n');
      }
    } else {
      await write(res, header.map(csvEscape).join(',') + '\n');
      for await (const doc of cursor) {
        await write(res, header.map((k) => csvEscape(csvValue(dig(doc, k)))).join(',') + '\n');
      }
    }
    res.end();
  } catch (err) {
    // Client aborted or cursor error mid-stream: headers already sent, just tear down.
    res.destroy();
  } finally {
    await cursor.close().catch(() => {});
  }
}));

module.exports = router;
module.exports.csvEscape = csvEscape;
module.exports.csvValue = csvValue;
module.exports.dig = dig;
