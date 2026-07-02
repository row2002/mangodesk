const express = require('express');
const { BSON } = require('mongodb');
const { EJSON } = BSON;
const { getClient } = require('../lib/clients');

const router = express.Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const parseEJSON = (str, fallback) => (str && str.trim() ? EJSON.parse(str) : fallback);
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

router.get('/api/connections/:id/databases', wrap(async (req, res) => {
  const client = await getClient(req.params.id);
  const { databases } = await client.db().admin().listDatabases();
  res.json(databases.map((d) => d.name).sort());
}));

router.get('/api/connections/:id/databases/:db/collections', wrap(async (req, res) => {
  const client = await getClient(req.params.id);
  const db = client.db(req.params.db);
  const colls = await db.listCollections({}, { nameOnly: true }).toArray();
  const out = await Promise.all(colls.map(async (c) => ({
    name: c.name,
    count: await db.collection(c.name).estimatedDocumentCount(),
  })));
  out.sort((a, b) => a.name.localeCompare(b.name));
  res.json(out);
}));

router.post('/api/query', wrap(async (req, res) => {
  const { connectionId, db, collection, filter, sort, projection } = req.body;
  const skip = Math.max(0, parseInt(req.body.skip, 10) || 0);
  const limit = Math.min(1000, Math.max(1, parseInt(req.body.limit, 10) || 50));
  const f = parseEJSON(filter, {});
  const s = parseEJSON(sort, {});
  const p = parseEJSON(projection, undefined);
  const client = await getClient(connectionId);
  const coll = client.db(db).collection(collection);
  const [docs, total] = await Promise.all([
    coll.find(f, { projection: p }).sort(s).skip(skip).limit(limit).toArray(),
    // count is expensive on big collections — the client asks for it once per
    // query and reuses the cached total while paginating (count: false)
    req.body.count === false ? null : coll.countDocuments(f),
  ]);
  res.json({ docs: docs.map((d) => EJSON.serialize(d, { relaxed: false })), total });
}));

router.post('/api/doc', wrap(async (req, res) => {
  const { connectionId, db, collection, doc } = req.body;
  const parsed = EJSON.parse(doc);
  const client = await getClient(connectionId);
  const { insertedId } = await client.db(db).collection(collection).insertOne(parsed);
  res.json({ ok: true, id: EJSON.serialize(insertedId, { relaxed: false }) });
}));

router.put('/api/doc', wrap(async (req, res) => {
  const { connectionId, db, collection, id, doc } = req.body;
  if (!id) throw bad('id is required');
  const parsed = EJSON.parse(doc);
  const client = await getClient(connectionId);
  // match by the original _id, not the (possibly edited) one from the doc body —
  // otherwise editing _id could silently overwrite another document
  const result = await client.db(db).collection(collection)
    .replaceOne({ _id: EJSON.parse(id) }, parsed);
  if (result.matchedCount === 0) return res.status(404).json({ error: 'Document not found' });
  res.json({ ok: true });
}));

router.delete('/api/doc', wrap(async (req, res) => {
  const { connectionId, db, collection, id } = req.body;
  if (!id) throw bad('id is required');
  const _id = EJSON.parse(id);
  const client = await getClient(connectionId);
  const result = await client.db(db).collection(collection).deleteOne({ _id });
  if (result.deletedCount === 0) return res.status(404).json({ error: 'Document not found' });
  res.json({ ok: true });
}));

module.exports = router;
