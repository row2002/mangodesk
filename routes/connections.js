const express = require('express');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const store = require('../lib/store');
const clients = require('../lib/clients');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.get('/api/connections', (req, res) => {
  res.json(store.load());
});

router.post('/api/connections', (req, res) => {
  const { name, uri, settings } = req.body || {};
  if (!name || !uri) return res.status(400).json({ error: 'name and uri are required' });
  const record = { id: crypto.randomUUID(), name, uri, settings };
  const list = store.load();
  list.push(record);
  store.save(list);
  res.json(record);
});

router.put('/api/connections/:id', wrap(async (req, res) => {
  const list = store.load();
  const record = list.find((c) => c.id === req.params.id);
  if (!record) return res.status(404).json({ error: 'connection not found' });
  const { name, uri, settings } = req.body || {};
  if (!name || !uri) return res.status(400).json({ error: 'name and uri are required' });
  Object.assign(record, { name, uri, settings });
  store.save(list);
  await clients.closeClient(record.id); // reconnect with new uri on next use
  res.json(record);
}));

// Test an arbitrary (unsaved) uri — used by the connection form's Test button.
router.post('/api/connections/test', wrap(async (req, res) => {
  const { uri } = req.body || {};
  if (!uri) return res.status(400).json({ error: 'uri is required' });
  res.json(await testUri(uri));
}));

router.delete('/api/connections/:id', wrap(async (req, res) => {
  const list = store.load();
  const idx = list.findIndex((c) => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'connection not found' });
  list.splice(idx, 1);
  store.save(list);
  await clients.closeClient(req.params.id);
  res.json({ ok: true });
}));

router.post('/api/connections/:id/test', wrap(async (req, res) => {
  const record = store.load().find((c) => c.id === req.params.id);
  if (!record) return res.status(404).json({ error: 'connection not found' });
  res.json(await testUri(record.uri));
}));

async function testUri(uri) {
  let client;
  try {
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 4000 }); // throws sync on malformed uri
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

module.exports = router;
