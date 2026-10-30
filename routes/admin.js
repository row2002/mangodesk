// Management: create / rename / drop / clear collections, drop databases, and create /
// drop indexes. A database has no create of its own — creating its first collection
// makes it.
const express = require('express');
const { getClient } = require('../lib/clients');
const ejson = require('../lib/ejson');

const router = express.Router();

// The driver checks names before the server sees them ("collection names cannot
// contain '$'") and throws MongoInvalidArgumentError: user input, so a 400 like the rest.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
  if (err.name === 'MongoInvalidArgumentError' && !err.status) err.status = 400;
  next(err);
});
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

const DB = '/api/connections/:id/databases/:db';
const COLL = DB + '/collections/:coll';

function nameOf(body, label) {
  const { name } = body;
  if (typeof name !== 'string' || !name.trim()) throw bad(label + ' name is required');
  return name;
}

const database = async (req) => (await getClient(req.params.id)).db(req.params.db);
const collection = async (req) => (await database(req)).collection(req.params.coll);

router.post(DB + '/collections', wrap(async (req, res) => {
  const name = nameOf(req.body, 'Collection');
  const db = await database(req);
  // since MongoDB 7 `create` succeeds on an existing collection with the same options:
  // say so rather than report a create that did nothing
  if (await db.listCollections({ name }, { nameOnly: true }).hasNext()) {
    throw bad(`Collection ${req.params.db}.${name} already exists`);
  }
  await db.createCollection(name);
  res.json({ ok: true });
}));

router.patch(COLL, wrap(async (req, res) => {
  const name = nameOf(req.body, 'New collection');
  if (name === req.params.coll) throw bad('The new name is the same as the old one');
  await (await collection(req)).rename(name); // dropTarget false: an existing name is an error
  res.json({ ok: true });
}));

router.delete(COLL, wrap(async (req, res) => {
  await (await collection(req)).drop();
  res.json({ ok: true });
}));

// Clear: every document goes, the collection and its indexes stay.
router.delete(COLL + '/documents', wrap(async (req, res) => {
  const { deletedCount } = await (await collection(req)).deleteMany({});
  res.json({ ok: true, deletedCount });
}));

// The server's own databases hold users, roles, the oplog and sharding metadata.
const SYSTEM_DBS = new Set(['admin', 'config', 'local']);

router.delete(DB, wrap(async (req, res) => {
  if (SYSTEM_DBS.has(req.params.db)) throw bad(`"${req.params.db}" is a system database and is not dropped from here`);
  await (await database(req)).dropDatabase();
  res.json({ ok: true });
}));

// keys: EJSON text of the key document ({"a":1,"b":-1}, {"loc":"2dsphere"}).
// Options are a fixed set — anything else in the body is ignored.
function indexOptions(body) {
  const opts = {};
  for (const flag of ['unique', 'sparse']) {
    if (body[flag] === undefined || body[flag] === false) continue;
    if (body[flag] !== true) throw bad(flag + ' must be true or false');
    opts[flag] = true;
  }
  const ttl = body.expireAfterSeconds;
  if (ttl !== undefined && ttl !== null && ttl !== '') {
    if (!Number.isInteger(ttl) || ttl < 0 || ttl > 2147483647) {
      throw bad('expireAfterSeconds must be a whole number of seconds, 0 or more');
    }
    opts.expireAfterSeconds = ttl;
  }
  if (body.name !== undefined && body.name !== null && body.name !== '') {
    if (typeof body.name !== 'string' || !body.name.trim()) throw bad('Index name must be text');
    opts.name = body.name;
  }
  return opts;
}

router.post(COLL + '/indexes', wrap(async (req, res) => {
  const keys = ejson.parseDoc(req.body.keys, undefined, 'Keys');
  if (!keys || !Object.keys(keys).length) throw bad('Keys: name at least one field, e.g. { field: 1 }');
  const opts = indexOptions(req.body);
  const name = await (await collection(req)).createIndex(keys, opts);
  res.json({ ok: true, name });
}));

router.delete(COLL + '/indexes/:name', wrap(async (req, res) => {
  const { name } = req.params;
  if (name === '_id_') throw bad('The _id index cannot be dropped');
  const coll = await collection(req);
  // MongoDB 8 answers ok for a name that isn't there; a stale list should hear about it
  if (!(await coll.indexes()).some((i) => i.name === name)) {
    return res.status(404).json({ error: `No index named "${name}"` });
  }
  await coll.dropIndex(name);
  res.json({ ok: true });
}));

module.exports = router;
