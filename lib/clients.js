const { MongoClient } = require('mongodb');
const store = require('./store');

const clients = new Map(); // connectionId -> Promise<MongoClient>

// Cache the promise, not the client: concurrent callers share one connect
// instead of racing and leaking the loser.
function getClient(connectionId) {
  if (!clients.has(connectionId)) {
    const p = connect(connectionId);
    p.catch(() => clients.delete(connectionId));
    clients.set(connectionId, p);
  }
  return clients.get(connectionId);
}

async function connect(connectionId) {
  const conn = store.load().find((c) => c.id === connectionId);
  if (!conn) throw Object.assign(new Error('Unknown connection: ' + connectionId), { status: 404 });
  const client = new MongoClient(conn.uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  return client;
}

async function closeClient(connectionId) {
  const p = clients.get(connectionId);
  if (!p) return;
  clients.delete(connectionId);
  const client = await p.catch(() => null);
  if (client) await client.close().catch(() => {});
}

module.exports = { getClient, closeClient };
