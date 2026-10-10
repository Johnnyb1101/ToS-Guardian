const fs = require('fs');
const path = require('path');
const { resolveProxyTarget } = require('./batch-lib');
const lib = require('./sites-lib');

function usage(code) {
  console.log('Usage:');
  console.log('  node tools/rollout.js export --proxy <dev url> --out <file>        fetch the dev proxy\'s signed bundle of promoted lessons and learned sites');
  console.log('  node tools/rollout.js show <file>                                   print what a bundle holds and whether it verifies');
  console.log('  node tools/rollout.js import <file> --proxy <url> | --production    apply a bundle on a proxy started with ROLLOUT_PUBLIC_KEY');
  process.exit(code);
}

const argv = process.argv.slice(2);
const command = argv.shift();
if (!command || command === '--help' || command === '-h') usage(0);
if (!['export', 'show', 'import'].includes(command)) usage(1);

const opts = { proxy: null, production: false, out: null };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--proxy') opts.proxy = argv[++i];
  else if (a === '--production') opts.production = true;
  else if (a === '--out') opts.out = argv[++i];
  else if (a.startsWith('--')) { console.error(`Unknown option: ${a}`); process.exit(1); }
  else positional.push(a);
}

async function json(baseUrl, method, route, body) {
  const response = await fetch(`${baseUrl}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: response.status, data };
}

function readBundle(file) {
  if (!file) usage(1);
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

async function exportBundle() {
  const target = resolveProxyTarget({ proxy: opts.proxy, env: process.env });
  if (target.error) { console.error(target.error); process.exit(1); }
  if (target.isProduction) { console.error('Bundles are exported from the dev proxy only.'); process.exit(1); }
  if (!opts.out) usage(1);
  const status = await json(target.url, 'GET', '/learning/status');
  if (status.status !== 200) { console.error(`status ${status.status}: ${JSON.stringify(status.data)}`); process.exit(1); }
  const published = status.data.signing && status.data.signing.publicKey;
  if (!published) { console.error('The proxy is not signing its ledger (LEDGER_SIGNING_KEY unset); nothing to export.'); process.exit(1); }
  const { status: http, data } = await json(target.url, 'GET', '/learning/export');
  if (http !== 200) { console.error(`status ${http}: ${JSON.stringify(data)} (the export route exists only on a proxy with TRAINER_OPERATIONS=1)`); process.exit(1); }
  const check = lib.checkBundle(data.bundle, published);
  if (!check.valid) { console.error(`Refusing to save: ${check.reason}`); process.exit(2); }
  fs.writeFileSync(path.resolve(opts.out), JSON.stringify(data.bundle, null, 2) + '\n', 'utf8');
  console.log(lib.summarizeBundle(data.bundle));
  console.log(`Verified against the proxy's published key ${check.signer}; exported as ledger seq ${data.ledgerSeq}; saved to ${path.resolve(opts.out)}`);
}

async function show() {
  const bundle = readBundle(positional[0]);
  const check = lib.checkBundle(bundle);
  console.log(lib.summarizeBundle(bundle));
  console.log(check.valid ? `Hash and signature verify against the key the bundle names (${check.signer}); the importing proxy must trust that key.` : `INVALID: ${check.reason}`);
  if (!check.valid) process.exit(2);
}

async function importBundle() {
  const bundle = readBundle(positional[0]);
  const target = resolveProxyTarget({ proxy: opts.proxy, production: opts.production, env: process.env });
  if (target.error) { console.error(target.error); process.exit(1); }
  const check = lib.checkBundle(bundle);
  if (!check.valid) { console.error(`Refusing to send: ${check.reason}`); process.exit(2); }
  console.log(lib.summarizeBundle(bundle));
  console.log(`Sending to ${target.url}${target.isProduction ? ' (PRODUCTION)' : ''} ...`);
  const { status, data } = await json(target.url, 'POST', '/learning/import', { bundle });
  if (status === 404) { console.error('The import route does not exist there: start that proxy with ROLLOUT_PUBLIC_KEY set to the dev key.'); process.exit(1); }
  if (status !== 200) { console.error(`status ${status}: ${JSON.stringify(data)}`); process.exit(1); }
  if (data.status === 'already-applied') { console.log(`Already applied${data.appliedAt ? ` at ${data.appliedAt}` : ''}; nothing changed.`); return; }
  console.log(`Applied: lessons imported ${data.lessons.imported}, unchanged ${data.lessons.unchanged}, refused ${data.lessons.refused.length}; sites imported ${data.sites.imported}, unchanged ${data.sites.unchanged}, refused ${data.sites.refused.length}; ledger seq ${data.ledgerSeq}.`);
  for (const r of data.lessons.refused) console.log(`  lesson ${r.id || '?'} refused: ${r.reason}`);
  for (const r of data.sites.refused) console.log(`  site ${r.domain || '?'} refused: ${r.reason}`);
}

({ export: exportBundle, show, import: importBundle })[command]().catch(err => { console.error(err); process.exit(1); });
