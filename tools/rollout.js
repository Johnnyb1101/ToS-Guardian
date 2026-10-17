const fs = require('fs');
const path = require('path');
const { resolveProxyTarget } = require('./batch-lib');
const lib = require('./sites-lib');

function usage(code) {
  console.log('Usage:');
  console.log('  node tools/rollout.js export --proxy <dev url> --config-hash <hash> --authorization <json> --approval-key <pem> --out <file>');
  console.log('  node tools/rollout.js show <file> [--transport-key <pem>] [--approval-key <pem>]');
  console.log('  node tools/rollout.js import <file> --proxy <url> | --production --transport-key <pem> --approval-key <pem>');
  process.exit(code);
}

const argv = process.argv.slice(2);
const command = argv.shift();
if (!command || command === '--help' || command === '-h') usage(0);
if (!['export', 'show', 'import'].includes(command)) usage(1);

const opts = { proxy: null, production: false, out: null, configHash: null, authorization: null, approvalKey: null, transportKey: null };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--proxy') opts.proxy = argv[++i];
  else if (a === '--production') opts.production = true;
  else if (a === '--out') opts.out = argv[++i];
  else if (a === '--config-hash') opts.configHash = argv[++i];
  else if (a === '--authorization') opts.authorization = argv[++i];
  else if (a === '--approval-key') opts.approvalKey = argv[++i];
  else if (a === '--transport-key') opts.transportKey = argv[++i];
  else if (a.startsWith('--')) { console.error(`Unknown option: ${a}`); process.exit(1); }
  else positional.push(a);
}

async function json(baseUrl, method, route, body) {
  const response = await fetch(`${baseUrl}${route}`, { method, headers: lib.trainerHeaders({ 'Content-Type': 'application/json' }), body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: response.status, data };
}

function readBundle(file) {
  if (!file) usage(1);
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

function readApprovalKey() {
  if (!opts.approvalKey) throw new Error('An explicit --approval-key PEM file is required');
  return fs.readFileSync(path.resolve(opts.approvalKey), 'utf8');
}

function readTransportKey() {
  if (!opts.transportKey) throw new Error('An explicit --transport-key PEM file is required');
  return fs.readFileSync(path.resolve(opts.transportKey), 'utf8');
}

async function exportBundle() {
  const target = resolveProxyTarget({ proxy: opts.proxy, env: process.env });
  if (target.error) { console.error(target.error); process.exit(1); }
  if (target.isProduction) { console.error('Bundles are exported from the dev proxy only.'); process.exit(1); }
  if (!opts.out || !opts.authorization || !/^[a-f0-9]{64}$/.test(opts.configHash || '')) usage(1);
  const approvalKey = readApprovalKey();
  const release = await lib.fetchRelease(target.url, opts.configHash);
  const authorization = JSON.parse(fs.readFileSync(path.resolve(opts.authorization), 'utf8'));
  const authCheck = lib.checkAuthorization(authorization, release, approvalKey);
  if (!authCheck.valid) throw new Error(`Refusing export: ${authCheck.reason}`);
  const status = await json(target.url, 'GET', '/learning/status');
  if (status.status !== 200) { console.error(`status ${status.status}: ${JSON.stringify(status.data)}`); process.exit(1); }
  const published = status.data.signing && status.data.signing.publicKey;
  if (!published) { console.error('The proxy is not signing its ledger (LEDGER_SIGNING_KEY unset); nothing to export.'); process.exit(1); }
  const { status: http, data } = await json(target.url, 'POST', '/learning/export', { configHash: opts.configHash, authorization });
  if (http !== 200) { console.error(`status ${http}: ${JSON.stringify(data)}`); process.exit(1); }
  const check = lib.checkBundle(data.bundle, published, approvalKey);
  if (!check.valid) { console.error(`Refusing to save: ${check.reason}`); process.exit(2); }
  if (lib.strictCanonicalJson(data.bundle.release) !== lib.strictCanonicalJson(release)) throw new Error('Exported release differs from the selected complete config');
  fs.writeFileSync(path.resolve(opts.out), JSON.stringify(data.bundle, null, 2) + '\n', 'utf8');
  console.log(lib.summarizeBundle(data.bundle));
  console.log(`Transport and independent owner signatures verified; signer ${check.signer}; saved to ${path.resolve(opts.out)}`);
}

async function show() {
  const bundle = readBundle(positional[0]);
  const check = lib.checkBundle(bundle, opts.transportKey ? readTransportKey() : null, opts.approvalKey ? readApprovalKey() : null);
  console.log(lib.summarizeBundle(bundle));
  console.log(check.valid ? `Transport signature verifies (${check.signer})${opts.transportKey ? ' against the supplied trusted key' : ' against the bundle-named key only'}; owner approval ${check.ownerVerified ? 'verified against supplied key' : 'not verified'}.` : `INVALID: ${check.reason}`);
  if (!check.valid) process.exit(2);
}

async function importBundle() {
  const bundle = readBundle(positional[0]);
  const target = resolveProxyTarget({ proxy: opts.proxy, production: opts.production, env: process.env });
  if (target.error) { console.error(target.error); process.exit(1); }
  const approvalKey = readApprovalKey();
  const transportKey = readTransportKey();
  const current = await json(target.url, 'GET', '/learning/releases/active');
  if (current.status !== 200) throw new Error(`Cannot verify destination release state (HTTP ${current.status})`);
  const check = lib.checkBundle(bundle, transportKey, approvalKey, { active: current.data.active });
  if (!check.valid) { console.error(`Refusing to send: ${check.reason}`); process.exit(2); }
  console.log(lib.summarizeBundle(bundle));
  console.log(`Sending to ${target.url}${target.isProduction ? ' (PRODUCTION)' : ''} ...`);
  const { status, data } = await json(target.url, 'POST', '/learning/import', { bundle });
  if (status === 404) { console.error('The import route does not exist there: start that proxy with ROLLOUT_PUBLIC_KEY set to the dev key.'); process.exit(1); }
  if (status !== 200) { console.error(`status ${status}: ${JSON.stringify(data)}`); process.exit(1); }
  if (data.status === 'already-applied') { console.log(`Already applied${data.appliedAt ? ` at ${data.appliedAt}` : ''}; nothing changed.`); return; }
  console.log(`Release ${bundle.release.configHash} ${data.status}; generation ${data.active ? data.active.generation : data.generation || '?'}.`);
}

({ export: exportBundle, show, import: importBundle })[command]().catch(err => { console.error(err); process.exit(1); });
