const fs = require('fs');
const os = require('os');
const path = require('path');
const sea = require('./sea');

// ponytail: plaintext URI storage in a local JSON file; move to OS keychain if it matters.
// npx/global installs live in a throwaway dir, so config belongs in the home dir; an
// existing repo-local file still wins so dev checkouts keep the connections they have.
// Release binaries: a connections.json placed next to the executable enables portable
// mode (e.g. on a USB stick); __dirname is meaningless inside a bundled SEA.
const LOCAL = sea.isSea()
  ? path.join(sea.exeDir(), 'connections.json')
  : path.join(__dirname, '..', 'connections.json');
const FILE = process.env.MANGODESK_CONFIG
  || (fs.existsSync(LOCAL) ? LOCAL : path.join(os.homedir(), '.mangodesk.json'));

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
