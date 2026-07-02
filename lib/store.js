const fs = require('fs');
const path = require('path');

// ponytail: plaintext URI storage in a local JSON file; move to OS keychain if it matters.
const FILE = path.join(__dirname, '..', 'connections.json');

function load() {
  let raw;
  try { raw = fs.readFileSync(FILE, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  // corrupt file: fail loudly instead of returning [] and wiping it on the next save
  return JSON.parse(raw);
}

function save(list) {
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}

module.exports = { load, save };
