const fs = require('fs');
const os = require('os');
const path = require('path');

// ponytail: plaintext URI storage in a local JSON file; move to OS keychain if it matters.
// npx/global installs live in a throwaway dir, so config belongs in the home dir; an
// existing repo-local file still wins so dev checkouts keep the connections they have.
const LOCAL = path.join(__dirname, '..', 'connections.json');
const FILE = fs.existsSync(LOCAL) ? LOCAL : path.join(os.homedir(), '.mangodesk.json');

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
