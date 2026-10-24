#!/usr/bin/env node
// Builds a standalone MangoDesk executable for the *current* OS/arch with Node's
// Single Executable Applications (SEA). Run with the Node version you want to ship:
//   npm run build:sea            -> dist/mangodesk (or dist/mangodesk.exe)
// Needs devDependencies esbuild + postject. Cross-compiling is not supported:
// the binary is a copy of the running node executable, so build on each target.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const win = process.platform === 'win32';
const mac = process.platform === 'darwin';
const exe = path.join(dist, win ? 'mangodesk.exe' : 'mangodesk');
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });

async function main() {
  // Node 18.16-20.11 build a SEA without node:sea assets: public/ wouldn't be embedded
  let sea = null;
  try { sea = require('node:sea'); } catch { /* older Node */ }
  if (!sea || typeof sea.getAsset !== 'function') {
    console.error(`build:sea needs Node >= 20.12 (node:sea assets); this is ${process.version}`);
    process.exit(1);
  }
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist);

  // 1. bundle server + routes + lib + node_modules into one CommonJS file
  await require('esbuild').build({
    entryPoints: [path.join(root, 'server.js')],
    outfile: path.join(dist, 'mangodesk.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node' + process.versions.node.split('.')[0],
    minify: false, // keeps stack traces readable; minifying only saves ~1 MB of a ~120 MB binary
    legalComments: 'none',
    logLevel: 'warning',
    // mongodb's optional peer deps: required lazily inside try/catch (lib/deps.js),
    // so leaving them unresolved just disables kerberos/zstd/snappy/AWS/GCP/socks/CSFLE
    external: [
      'kerberos', '@mongodb-js/zstd', '@aws-sdk/credential-providers', 'gcp-metadata',
      'snappy', 'socks', 'aws4', 'mongodb-client-encryption',
    ],
  });

  // 2. SEA config: every file under public/ becomes an asset keyed by its relative path
  const pub = path.join(root, 'public');
  const assets = {};
  for (const rel of fs.readdirSync(pub, { recursive: true })) {
    const abs = path.join(pub, rel);
    if (fs.statSync(abs).isFile()) assets[rel.split(path.sep).join('/')] = abs;
  }
  const config = {
    main: path.join(dist, 'mangodesk.cjs'),
    output: path.join(dist, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useCodeCache: true,
    useSnapshot: false,
    assets,
  };
  const configFile = path.join(dist, 'sea-config.json');
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  run(process.execPath, ['--experimental-sea-config', configFile]);

  // 3. copy the node binary and inject the blob
  fs.copyFileSync(process.execPath, exe);
  fs.chmodSync(exe, 0o755);
  if (mac) run('codesign', ['--remove-signature', exe]);
  // Windows: the official node.exe is Authenticode-signed; postject just warns and the
  // signature becomes invalid, which SmartScreen treats like unsigned. Strip it if signtool is around.
  if (win) { try { run('signtool', ['remove', '/s', exe]); } catch { /* optional */ } }
  await require('postject').inject(exe, 'NODE_SEA_BLOB', fs.readFileSync(config.output), {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    machoSegmentName: mac ? 'NODE_SEA' : undefined,
    overwrite: true,
  });
  if (mac) run('codesign', ['--sign', '-', exe]); // ad-hoc: arm64 macOS refuses unsigned code

  console.log('built', path.relative(root, exe), (fs.statSync(exe).size / 1048576).toFixed(1) + ' MB');
}

main().catch((err) => { console.error(err); process.exit(1); });
