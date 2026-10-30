const express = require('express');
const { Double, Long, ObjectId, MongoBulkWriteError, MongoServerError } = require('mongodb');
const { getClient } = require('../lib/clients');
const ejson = require('../lib/ejson');

const router = express.Router();

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

const FORMATS = new Set(['json', 'ndjson', 'csv']);
const TYPES = new Set(['auto', 'string', 'number', 'bool', 'date', 'objectId']);
const BATCH_DOCS = 1000;
const BATCH_CHARS = 8 * 1024 * 1024; // source text per batch, a rough cap on what one batch holds in memory
const MAX_RECORD = 32 * 1024 * 1024; // one document's text; BSON stops at 16 MB anyway
const MAX_ERRORS = 20;               // errors listed in the response; failed counts them all
const PREVIEW_BYTES = 1024 * 1024;

/* ================= JSON / NDJSON splitters ================= */

// Every splitter takes text in arbitrary chunks: feed(text) returns the records completed
// so far, end() the rest, both as { text, line } with line the 1-based line it starts on.
// A record is the source text of one document; parsing it (ejson.parse) is per record,
// so one bad document is one failure, not the end of the file.

// JSON: an array of documents (export's JSON format, mongoexport --jsonArray), or bare
// documents one after another (mongoexport's default output, NDJSON, pretty-printed or
// not). Only strings and brackets are tracked — enough to find where each top-level
// value ends; what is inside is JSON.parse's business.
class JsonSplitter {
  constructor() {
    this.mode = null;   // 'array' after a leading '[', else 'stream'
    this.closed = false; // the array's ']' has been seen
    this.depth = 0;
    this.inStr = false;
    this.esc = false;
    this.cur = null;    // text of the value in progress (null between values)
    this.scalar = false; // the value in progress is a bare number/literal
    this.line = 1;
    this.curLine = 1;
    this.problem = null;
  }

  feed(text) {
    const out = [];
    let start = this.cur === null ? -1 : 0; // where the value in progress starts in this chunk
    const finish = (end) => {
      this.cur += text.slice(start, end);
      out.push({ text: this.cur, line: this.curLine });
      this.cur = null;
      this.scalar = false;
      start = -1;
    };
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '\n') this.line++;
      if (this.inStr) {
        if (this.esc) this.esc = false;
        else if (c === '\\') this.esc = true;
        else if (c === '"') {
          this.inStr = false;
          if (this.depth === 0) finish(i + 1); // a top-level string: not a document, but a record
        }
        continue;
      }
      if (this.depth > 0) {
        if (c === '"') this.inStr = true;
        else if (c === '{' || c === '[') this.depth++;
        else if (c === '}' || c === ']') { if (--this.depth === 0) finish(i + 1); }
        continue;
      }
      // top level, between or inside a bare scalar
      const ws = c === ' ' || c === '\n' || c === '\r' || c === '\t';
      if (this.scalar && (ws || c === ',' || c === ']')) finish(i);
      if (ws || c === '﻿') continue;
      if (this.closed) throw bad(`Line ${this.line}: unexpected text after the closing ]`);
      if (this.mode === null) {
        this.mode = c === '[' ? 'array' : 'stream';
        if (c === '[') continue;
      }
      if (c === ',') continue;
      if (c === ']' && this.mode === 'array') { this.closed = true; continue; }
      if (this.cur === null) {
        this.cur = '';
        this.curLine = this.line;
        start = i;
      }
      if (c === '{' || c === '[') this.depth = 1;
      else if (c === '"') this.inStr = true;
      else if (c === '}' || c === ']') throw bad(`Line ${this.line}: unexpected ${c}`);
      else this.scalar = true;
    }
    if (start !== -1) {
      this.cur += text.slice(start);
      if (this.cur.length > MAX_RECORD) throw bad(`Line ${this.curLine}: document is larger than 32 MB`);
    }
    return out;
  }

  end() {
    if (this.inStr || this.depth > 0) throw bad(`Line ${this.curLine}: the file ends inside this document (truncated?)`);
    const out = [];
    if (this.cur !== null) out.push({ text: this.cur, line: this.curLine });
    this.cur = null;
    // every document so far was whole, so they still go in; the caller reports this
    if (this.mode === 'array' && !this.closed) this.problem = 'The file ends before the closing ] (truncated?)';
    return out;
  }
}

// NDJSON: one document per line. A broken line only costs that line.
class NdjsonSplitter {
  constructor() { this.rest = ''; this.line = 0; }

  feed(text) {
    if (!text.includes('\n')) { // part of a long line: don't re-split it on every chunk
      this.rest += text;
      if (this.rest.length > MAX_RECORD) throw bad(`Line ${this.line + 1}: document is larger than 32 MB`);
      return [];
    }
    const parts = (this.rest + text).split('\n');
    this.rest = parts.pop();
    return this.records(parts);
  }

  end() {
    const parts = [this.rest];
    this.rest = '';
    return this.records(parts);
  }

  records(parts) {
    const out = [];
    for (const p of parts) {
      this.line++;
      const t = p.trim();
      if (t) out.push({ text: t, line: this.line });
    }
    return out;
  }
}

/* ================= CSV ================= */

const DELIMS = [',', ';', '\t', '|'];

// The separator is the candidate that occurs most often outside quotes on the first
// line. A tie or none falls back to ',' — or ';' when the file starts with a UTF-8 BOM,
// which is what export's Excel mode (and Excel on a RU/EU locale) writes.
function detectDelimiter(text, bom = false) {
  const counts = new Map(DELIMS.map((d) => [d, 0]));
  let inQ = false;
  for (const c of text) {
    if (c === '"') inQ = !inQ;
    else if (!inQ && (c === '\n' || c === '\r')) break;
    else if (!inQ && counts.has(c)) counts.set(c, counts.get(c) + 1);
  }
  let best = bom ? ';' : ',';
  for (const [d, n] of counts) if (n > counts.get(best)) best = d;
  return best;
}

// RFC 4180 rows: quoted fields with "" escapes and line breaks inside, CRLF / LF / CR
// line ends. A quote in the middle of an unquoted field is kept as text. Rows come out
// as { cells, line }. With delimiter 'auto' the first line is buffered and detected.
class CsvParser {
  constructor(delimiter = 'auto', bom = false) {
    this.delim = delimiter === 'auto' ? null : delimiter;
    this.bom = bom;
    this.head = '';
    this.field = '';
    this.cells = [];
    this.inQ = false;
    this.afterQ = false; // a quote inside a quoted field: closing, or the first of ""
    this.quoted = false; // the current field was quoted (so "" is a value, not nothing)
    this.skipLF = false; // just ended a row on \r; a following \n belongs to it
    this.line = 1;
    this.rowLine = 1;
  }

  feed(text) {
    if (this.delim === null) {
      this.head += text;
      if (!/[\r\n]/.test(this.head.replace(/"[^"]*"/g, ''))) {
        if (this.head.length > MAX_RECORD) throw bad('The header row is larger than 32 MB');
        return [];
      }
      this.delim = detectDelimiter(this.head, this.bom);
      text = this.head;
      this.head = '';
    }
    const out = [];
    const d = this.delim;
    let run = 0; // start of the plain run of text not yet copied into this.field
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (this.skipLF) {
        this.skipLF = false;
        if (c === '\n') { run = i + 1; continue; }
      }
      if (this.afterQ) {
        this.afterQ = false;
        if (c === '"') { this.field += '"'; run = i + 1; continue; } // ""
        this.inQ = false; // that quote closed the field; c is handled below
      }
      if (this.inQ) {
        if (c === '"') { this.field += text.slice(run, i); this.afterQ = true; run = i + 1; }
        else if (c === '\n') this.line++;
        continue;
      }
      if (c === d) {
        this.field += text.slice(run, i);
        this.endField();
        run = i + 1;
      } else if (c === '\n' || c === '\r') {
        this.field += text.slice(run, i);
        this.endField();
        out.push({ cells: this.cells, line: this.rowLine });
        this.cells = [];
        this.line++;
        this.rowLine = this.line;
        if (c === '\r') this.skipLF = true;
        run = i + 1;
      } else if (c === '"' && !this.quoted && this.field === '' && run === i) {
        this.inQ = true;
        this.quoted = true;
        run = i + 1;
      }
    }
    this.field += text.slice(run);
    return out.filter(nonEmpty);
  }

  end() {
    const out = this.delim === null ? this.feed('\n') : [];
    if (this.inQ && !this.afterQ) throw bad(`Line ${this.rowLine}: unterminated quoted field`);
    if (this.field !== '' || this.quoted || this.cells.length) {
      this.endField();
      out.push({ cells: this.cells, line: this.rowLine });
      this.cells = [];
    }
    return out.filter(nonEmpty);
  }

  endField() {
    this.cells.push(this.field);
    this.field = '';
    this.quoted = false;
  }
}

const nonEmpty = (row) => row.cells.length > 1 || row.cells[0] !== '';

/* ================= CSV cells -> values ================= */

const NUM = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;            // JSON's number grammar
const LOOSE_NUM = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const ISO_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
const ISO_LOOSE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const HEX24 = /^[0-9a-fA-F]{24}$/;
// export prefixes strings starting with these with ' so spreadsheets don't run them
const GUARDED = /^'[=+@\t\r-]/;

const INT32 = 2n ** 31n;
const INT64 = 2n ** 63n;

// Number text -> the type mongosh would pick: Int32 in range, Long beyond (exact past
// 2^53), Double for anything written with a fraction or exponent ("1.0" stays a Double).
function toNumber(s) {
  if (/^[+-]?\d+$/.test(s)) {
    const n = BigInt(s);
    if (n >= -INT32 && n < INT32) return Number(n);
    if (n >= -INT64 && n < INT64) return Long.fromBigInt(n);
  }
  return new Double(Number(s));
}

function toDate(s) {
  let t = s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) t += 'T00:00:00Z';
  else if (!/(Z|[+-]\d{2}:?\d{2})$/.test(t)) t += 'Z'; // no zone: UTC, not the server's local time
  const d = new Date(t.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

const CONVERT = {
  string: (s) => (GUARDED.test(s) ? s.slice(1) : s),
  number(s, delim) {
    // Excel on a decimal-comma locale writes 2,5 into its ';' files
    if (delim !== ',' && /^[+-]?\d+,\d+$/.test(s)) s = s.replace(',', '.');
    if (LOOSE_NUM.test(s)) return toNumber(s.replace(/^\+/, ''));
    if (/^[+-]?(NaN|Infinity)$/.test(s)) return new Double(Number(s));
    throw new Error('not a number: ' + s);
  },
  bool(s) {
    const v = s.toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(v)) return true;
    if (['false', '0', 'no', 'n'].includes(v)) return false;
    throw new Error('not a boolean: ' + s);
  },
  date(s) {
    if (/^-?\d+$/.test(s)) return new Date(Number(s)); // epoch milliseconds
    const d = ISO_LOOSE.test(s) ? toDate(s) : undefined;
    if (!d) throw new Error('not an ISO date: ' + s);
    return d;
  },
  objectId(s) {
    if (!HEX24.test(s)) throw new Error('not an ObjectId (24 hex digits): ' + s);
    return new ObjectId(s);
  },
  // What export's CSV writes, read back: true/false, numbers, ISO instants, and the
  // JSON it writes for nested documents and arrays. Everything else stays a string.
  auto(s) {
    if (GUARDED.test(s)) return s.slice(1);
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (NUM.test(s)) return toNumber(s);
    if (ISO_DT.test(s)) return toDate(s) || s;
    if (s[0] === '{' || s[0] === '[') {
      try { return ejson.parse(s); } catch { /* text that just starts with a bracket */ }
    }
    return s;
  },
};

// Guessed per-column type for the preview: the one thing 'auto' won't infer by itself
// is an ObjectId, since a 24-hex string can be just a string.
function guessType(values) {
  const v = values.filter((x) => x !== '');
  return v.length && v.every((x) => HEX24.test(x)) ? 'objectId' : 'auto';
}

// Header row -> columns. Dotted names build nested documents ("a.b" -> {a:{b:…}}).
// Blank names are skipped (Excel leaves trailing separators); duplicates, and a name
// that is also the parent of another ("a" next to "a.b"), are refused up front.
function makeColumns(header, types = {}) {
  const cols = [];
  const seen = new Set();
  header.forEach((name, i) => {
    if (name === '') return;
    if (seen.has(name)) throw bad(`Duplicate column: ${name}`);
    seen.add(name);
    const path = name.split('.');
    if (path.some((p) => p === '')) throw bad(`Bad column name: ${name}`);
    const type = types[name] || 'auto';
    if (!TYPES.has(type)) throw bad(`Unknown type for column ${name}: ${type}`);
    cols.push({ i, name, path, type });
  });
  for (const name of seen) {
    for (let j = name.indexOf('.'); j !== -1; j = name.indexOf('.', j + 1)) {
      if (seen.has(name.slice(0, j))) throw bad(`Column ${name.slice(0, j)} conflicts with ${name}`);
    }
  }
  if (!cols.length) throw bad('The header row has no column names');
  return cols;
}

// own property even for "__proto__"
const put = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });

// One data row -> document. Blank cells are left out: export writes '' for a missing
// field, so leaving it out is what gives the original document back.
function rowToDoc(cells, cols, delim) {
  if (cells.slice(cols[cols.length - 1].i + 1).some((x) => x !== '')) {
    throw new Error(`${cells.length} fields, more than the header has columns`);
  }
  const doc = {};
  for (const col of cols) {
    const s = cells[col.i];
    if (s === undefined || s === '') continue;
    let v;
    try { v = CONVERT[col.type](s, delim); } catch (err) { throw new Error(`column ${col.name}: ${err.message}`); }
    let o = doc;
    for (const k of col.path.slice(0, -1)) {
      if (!Object.prototype.hasOwnProperty.call(o, k)) put(o, k, {});
      o = o[k];
    }
    put(o, col.path[col.path.length - 1], v);
  }
  return doc;
}

const isDocument = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !v._bsontype
  && Object.prototype.toString.call(v) === '[object Object]';

// The source for one format: text chunks in, { line, size, doc | error } per record out.
function makeSource(format, { delimiter = 'auto', types = {}, bom = false } = {}) {
  if (format !== 'csv') {
    const split = format === 'json' ? new JsonSplitter() : new NdjsonSplitter();
    const toDoc = ({ text, line }) => {
      try {
        const doc = ejson.parse(text);
        if (!isDocument(doc)) return { line, size: text.length, error: 'not a document: ' + text.slice(0, 40) };
        return { line, size: text.length, doc };
      } catch (err) { return { line, size: text.length, error: err.message }; }
    };
    return {
      feed: (text) => split.feed(text).map(toDoc),
      end: () => split.end().map(toDoc),
      get problem() { return split.problem; },
    };
  }
  const csv = new CsvParser(delimiter, bom);
  let cols = null;
  const toDocs = (rows) => {
    const out = [];
    for (const { cells, line } of rows) {
      if (!cols) { cols = makeColumns(cells, types); continue; }
      const size = cells.reduce((n, c) => n + c.length + 1, 0);
      try { out.push({ line, size, doc: rowToDoc(cells, cols, csv.delim) }); } catch (err) {
        out.push({ line, size, error: err.message });
      }
    }
    return out;
  };
  return {
    feed: (text) => toDocs(csv.feed(text)),
    end: () => toDocs(csv.end()),
    problem: null,
  };
}

/* ================= writing ================= */

// About the server or the whole command (lost connection, no write privilege, a bad
// namespace), not one document: these end the import instead of failing each document.
const commandError = (err) => err instanceof MongoServerError
  || /^Mongo(Network|ServerSelection|NotConnected|Topology|OperationTimeout)/.test(err.name);

// insertMany / bulkWrite of one batch, unordered: every document that can go in does.
// -> { inserted, updated, failures: [{ index, message }] }
async function writeBatch(coll, docs, upsert) {
  const ops = upsert ? docs.map((d) => (d._id === undefined ? { insertOne: { document: d } }
    // $eq: an _id that is itself a document is matched as a value, never as operators
    : { replaceOne: { filter: { _id: { $eq: d._id } }, replacement: d, upsert: true } })) : null;
  const counts = (r) => (upsert
    ? { inserted: r.insertedCount + r.upsertedCount, updated: r.matchedCount }
    : { inserted: r.insertedCount, updated: 0 });
  try {
    const r = upsert ? await coll.bulkWrite(ops, { ordered: false }) : await coll.insertMany(docs, { ordered: false });
    return { ...counts(r), failures: [] };
  } catch (err) {
    if (err instanceof MongoBulkWriteError) {
      // A command the server refused as a whole comes back as a bulk error without any
      // per-document errors, and none of the batch written: that is not a document's fault.
      if (!err.writeErrors.length) throw err;
      return { ...counts(err.result), failures: err.writeErrors.map((w) => ({ index: w.index, message: w.errmsg })) };
    }
    if (commandError(err)) throw err;
    if (docs.length === 1) return { inserted: 0, updated: 0, failures: [{ index: 0, message: err.message }] };
    // The driver refuses the whole batch for one bad document (e.g. over 16 MB) before
    // sending any of it: go one by one to find which.
    const out = { inserted: 0, updated: 0, failures: [] };
    for (let i = 0; i < docs.length; i++) {
      const r = await writeBatch(coll, [docs[i]], upsert);
      out.inserted += r.inserted;
      out.updated += r.updated;
      out.failures.push(...r.failures.map((f) => ({ ...f, index: i })));
    }
    return out;
  }
}

function options(q) {
  const one = (k) => (Array.isArray(q[k]) ? q[k][0] : q[k]);
  const { connectionId, db, collection } = Object.fromEntries(['connectionId', 'db', 'collection'].map((k) => [k, one(k)]));
  const format = one('format');
  if (!FORMATS.has(format)) throw bad('Unknown format: ' + format);
  if (!connectionId || !db || !collection) throw bad('connectionId, db and collection are required');
  const mode = one('mode') || 'insert';
  if (mode !== 'insert' && mode !== 'upsert') throw bad('mode must be insert or upsert');
  const onError = one('onError') || 'stop';
  if (onError !== 'stop' && onError !== 'continue') throw bad('onError must be stop or continue');
  const delimiter = one('delimiter') || 'auto';
  if (delimiter !== 'auto' && (delimiter.length !== 1 || /["\r\n]/.test(delimiter))) throw bad('Bad delimiter');
  let types = {};
  if (one('types')) {
    try { types = JSON.parse(one('types')); } catch { throw bad('types must be JSON'); }
    if (!isDocument(types)) throw bad('types must be an object');
  }
  return { connectionId, db, collection, format, upsert: mode === 'upsert', stopOnError: onError === 'stop', delimiter, types };
}

// The upload is the raw file (lib/app.js runs no body parser on /api/import), read as
// a stream: a batch is written before the next one is parsed, and the socket pauses
// meanwhile, so memory stays at about one batch whatever the file size.
router.post('/api/import', wrap(async (req, res) => {
  const opt = options(req.query);
  const client = await getClient(opt.connectionId);
  const coll = client.db(opt.db).collection(opt.collection);

  const result = { inserted: 0, updated: 0, failed: 0, errors: [], stopped: false };
  let stop = false;
  const fail = (line, message) => {
    result.failed++;
    if (result.errors.length < MAX_ERRORS) result.errors.push({ line, message });
    if (opt.stopOnError) stop = true;
  };

  let batch = [];
  let lines = [];
  let chars = 0;
  const flush = async () => {
    if (!batch.length) return;
    const docs = batch;
    const at = lines;
    batch = [];
    lines = [];
    chars = 0;
    const r = await writeBatch(coll, docs, opt.upsert);
    result.inserted += r.inserted;
    result.updated += r.updated;
    for (const f of r.failures) fail(at[f.index], f.message);
  };
  const take = async (recs) => {
    for (const rec of recs) {
      if (rec.error) {
        fail(rec.line, rec.error);
        if (stop) return; // stop: the documents before the bad one still go in (below), none after it
        continue;
      }
      batch.push(rec.doc);
      lines.push(rec.line);
      chars += rec.size;
      if (batch.length >= BATCH_DOCS || chars >= BATCH_CHARS) await flush();
      if (stop) return;
    }
  };

  // A broken file (unterminated string, bad CSV header) or a lost server ends the
  // import; the response still says what got in. Anything else is a bug: rethrow.
  let fatal = null;
  const guarded = async (fn) => {
    try { await fn(); } catch (err) {
      if (!err.status && !commandError(err)) throw err;
      stop = true;
      fatal = err;
    }
  };

  let source = null;
  req.setEncoding('utf8');
  try {
    for await (let chunk of req) {
      // Once stopped, read on to the end: answering mid-upload makes the browser
      // report a network error instead of this result.
      if (stop) continue;
      await guarded(async () => {
        if (!source) {
          const bom = chunk[0] === '﻿';
          if (bom) chunk = chunk.slice(1);
          source = makeSource(opt.format, { ...opt, bom });
        }
        await take(source.feed(chunk));
      });
    }
  } catch (err) {
    if (req.destroyed || res.destroyed) return; // the client cancelled; what got in stays in
    throw err;
  }
  if (!source) throw bad('The file is empty');
  if (!stop) await guarded(() => take(source.end()));
  // what was parsed before the stop is written, unless writing is what failed
  if (!(fatal && commandError(fatal))) await guarded(flush);
  // write errors are only known once their batch is written: list in file order, then
  // what ended the import
  result.errors.sort((a, b) => a.line - b.line);
  if (fatal) result.errors.push({ message: fatal.message });
  if (source.problem) result.errors.push({ message: source.problem });
  result.stopped = stop;
  res.json(result);
}));

// First part of the file (the client sends at most 1 MB) -> what the import would see:
// the detected CSV separator, columns with a guessed type and sample values, or the
// first documents of a JSON / NDJSON file. complete=1 when that part is the whole file.
router.post('/api/import/preview', wrap(async (req, res) => {
  const q = req.query;
  const format = String(q.format || '');
  if (!FORMATS.has(format)) throw bad('Unknown format: ' + format);
  let text = '';
  req.setEncoding('utf8');
  for await (const chunk of req) {
    if (text.length <= PREVIEW_BYTES) text += chunk; // read past the limit: see /api/import
  }
  if (text.length > PREVIEW_BYTES) throw Object.assign(new Error('Preview is limited to 1 MB'), { status: 413 });
  const bom = text[0] === '﻿';
  if (bom) text = text.slice(1);
  const complete = q.complete === '1';

  if (format === 'csv') {
    const delimiter = q.delimiter && q.delimiter !== 'auto' ? String(q.delimiter) : detectDelimiter(text, bom);
    const parser = new CsvParser(delimiter, bom);
    const rows = parser.feed(text);
    if (complete) rows.push(...parser.end());
    const [header = { cells: [] }, ...data] = rows;
    makeColumns(header.cells); // the same refusals as the import itself
    const sample = data.slice(0, 50).map((r) => r.cells);
    const columns = header.cells.map((name, i) => ({ name, i })).filter((c) => c.name !== '').map(({ name, i }) => {
      const values = sample.map((cells) => cells[i] ?? '');
      return { name, type: guessType(values), samples: values.filter((v) => v !== '').slice(0, 3) };
    });
    return res.json({ format, delimiter, bom, columns, rows: data.length, complete });
  }

  const source = makeSource(format);
  let recs;
  try {
    recs = source.feed(text);
    if (complete) recs.push(...source.end());
  } catch (err) {
    return res.json({ format, docs: [], errors: [{ message: err.message }], complete });
  }
  const first = recs.slice(0, 3);
  res.json({
    format,
    docs: first.filter((r) => r.doc).map((r) => ejson.serialize(r.doc)),
    errors: first.filter((r) => r.error).map((r) => ({ line: r.line, message: r.error })),
    complete,
  });
}));

module.exports = router;
Object.assign(module.exports, { JsonSplitter, NdjsonSplitter, CsvParser, detectDelimiter, makeColumns, rowToDoc, CONVERT, guessType, makeSource });
