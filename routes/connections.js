const express = require('express');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const store = require('../lib/store');
const clients = require('../lib/clients');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// optional colour tag shown next to a connection (e.g. red for production)
const COLORS = ['', 'red', 'orange', 'green', 'blue', 'purple'];
const badColor = (body) => body.color !== undefined && !COLORS.includes(body.color);

router.get('/api/connections', (req, res) => {
  res.json(store.load());
});

router.post('/api/connections', (req, res) => {
  const { name, uri, settings, color } = req.body || {};
  if (!name || !uri) return res.status(400).json({ error: 'name and uri are required' });
  if (badColor(req.body)) return res.status(400).json({ error: 'color must be one of: ' + COLORS.slice(1).join(', ') });
  const record = { id: crypto.randomUUID(), name, uri, settings };
  if (color) record.color = color;
  const list = store.load();
  list.push(record);
  store.save(list);
  res.json(record);
});

router.put('/api/connections/:id', wrap(async (req, res) => {
  const list = store.load();
  const record = list.find((c) => c.id === req.params.id);
  if (!record) return res.status(404).json({ error: 'connection not found' });
  const { name, uri, settings, color } = req.body || {};
  if (!name || !uri) return res.status(400).json({ error: 'name and uri are required' });
  if (badColor(req.body)) return res.status(400).json({ error: 'color must be one of: ' + COLORS.slice(1).join(', ') });
  Object.assign(record, { name, uri, settings });
  if (color !== undefined) record.color = color; // omitted: keep the current one
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
