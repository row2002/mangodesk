#!/usr/bin/env node
// CLI entry: flags, port selection, browser auto-open, shutdown. The app is in lib/app.js.
const cli = require('./lib/cli');
const sea = require('./lib/sea');

let started = false;

// Double-clicked Windows binary: the console closes with the process, so keep the
// message on screen until the user has read it.
function fatal(err) {
  if (started) console.error('\nMangoDesk stopped after an unexpected error:\n', err);
  else console.error(`\nMangoDesk could not start: ${err && err.message ? err.message : err}\n`);
  if (sea.isSea() && process.platform === 'win32' && process.stdin.isTTY) {
    console.error('Press Enter to close this window.');
    process.stdin.resume();
    process.stdin.once('data', () => process.exit(1));
  } else {
    process.exit(1);
  }
}

async function main() {
  const opts = cli.parseArgs(process.argv.slice(2), process.env);
  if (opts.error) { console.error(`${opts.error}\n\n${cli.HELP}`); process.exit(2); }
  const { version } = require('./package.json');
  if (opts.version) { console.log(version); return; }
  if (opts.help) { console.log(`MangoDesk v${version}\n\n${cli.HELP}`); return; }
  const open = opts.open && cli.hasDisplay();

  const { createApp } = require('./lib/app');
  const store = require('./lib/store');
  const clients = require('./lib/clients');
  const res = await cli.listen(createApp(), { ...opts, configFile: store.FILE });
  const url = `http://localhost:${res.port}`;
  if (res.reused) {
    console.log(`MangoDesk is already running at ${url}`);
    if (open) cli.openBrowser(url);
    return; // nothing left on the loop: exits 0
  }
  // before the banner: whoever reads 'Press Ctrl+C' may press it right away
  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(0); // second Ctrl+C: don't wait
    stopping = true;
    setTimeout(() => process.exit(0), 2000).unref(); // a stuck socket or mongo close mustn't hang us
    res.server.close();
    if (res.server.closeAllConnections) res.server.closeAllConnections(); // keep-alive sockets (Node 18.2+)
    clients.closeAll().finally(() => process.exit(0));
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, stop);

  if (!opts.explicitPort && res.port !== opts.port) {
    // localStorage is per origin, so UI settings and history don't follow to another port
    console.warn(`Port ${opts.port} is used by another program; using ${res.port} instead.`);
  }
  console.log(`MangoDesk v${version} running at ${url}`);
  console.log(`Connections file: ${store.FILE}`);
  try { store.load(); } catch (e) { console.warn(`Warning: ${e.message}`); } // still start: the UI shows it too
  console.log('Press Ctrl+C to stop.');
  started = true;
  if (open) cli.openBrowser(url);
}

process.on('uncaughtException', fatal);
main().catch(fatal);
