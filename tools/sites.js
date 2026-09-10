const { resolveProxyTarget } = require('./batch-lib');
const lib = require('./sites-lib');
const refLib = require('./reference-lib');

function usage(code) {
  console.log('Usage:');
  console.log('  node tools/sites.js propose --proxy <url> [--sites a,b] [--limit n] [--delay ms]   propose frozen sites as the trainer');
  console.log('  node tools/sites.js status --proxy <url>');
  console.log('  node tools/sites.js ledger --proxy <url> [--after seq]                           fetch and verify the learning ledger');
  console.log('  node tools/sites.js halt --proxy <url> --reason "..." | node tools/sites.js resume --proxy <url>');
  process.exit(code);
}

const argv = process.argv.slice(2);
const command = argv.shift();
if (!command || command === '--help' || command === '-h') usage(0);
if (!['propose', 'status', 'ledger', 'halt', 'resume'].includes(command)) usage(1);

const opts = { proxy: null, sites: null, limit: Infinity, delay: 2000, after: 0, reason: '' };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--proxy') opts.proxy = argv[++i];
  else if (a === '--sites') opts.sites = String(argv[++i]).split(',').map(s => s.trim()).filter(Boolean);
  else if (a === '--limit') opts.limit = Number(argv[++i]);
  else if (a === '--delay') opts.delay = Number(argv[++i]);
  else if (a === '--after') opts.after = Number(argv[++i]);
  else if (a === '--reason') opts.reason = argv[++i];
  else { console.error(`Unknown option: ${a}`); process.exit(1); }
}

const target = resolveProxyTarget({ proxy: opts.proxy, env: process.env });
if (target.error) { console.error(target.error); process.exit(1); }
if (target.isProduction && command !== 'status' && command !== 'ledger') { console.error('Trainer proposals and halts go to the dev proxy only.'); process.exit(1); }

async function json(method, path, body) {
  const response = await fetch(`${target.url}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: response.status, data };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function propose() {
  const manifest = refLib.loadManifest();
  let entries = Object.values(manifest.sites).sort((a, b) => a.domain.localeCompare(b.domain));
  if (opts.sites) { const wanted = new Set(opts.sites); entries = entries.filter(e => wanted.has(e.domain)); }
  entries = entries.slice(0, opts.limit);
  console.log(`TOS Guardian site proposals — ${entries.length} manifest site(s), proxy ${target.url}`);
  const counts = {};
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const proposal = lib.proposalFromManifestEntry(entry);
    process.stdout.write(`[${i + 1}/${entries.length}] ${entry.domain} ... `);
    if (!proposal) { counts.skipped = (counts.skipped || 0) + 1; console.log('skipped (no legal document urls)'); continue; }
    try {
      const { status, data } = await json('POST', '/site', proposal);
      const key = data.status || data.error || `http ${status}`;
      counts[key] = (counts[key] || 0) + 1;
      console.log(`${key}${data.reason ? ` — ${data.reason}` : ''}${data.expiresAt ? ` until ${data.expiresAt.slice(0, 10)}` : ''}${data.needed ? ` (${data.needed} more day(s))` : ''}`);
    } catch (e) {
      counts.network = (counts.network || 0) + 1;
      console.log(`network error — ${e.message}`);
    }
    if (i < entries.length - 1 && opts.delay > 0) await sleep(opts.delay);
  }
  console.log('');
  console.log(`Outcomes: ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', ')}`);
}

async function status() {
  const { status, data } = await json('GET', '/learning/status');
  if (status !== 200) { console.error(`status ${status}: ${JSON.stringify(data)}`); process.exit(1); }
  console.log(`Learning ${data.halted ? `HALTED (${data.reasons.join(', ')})` : 'active'} on ${target.url}`);
  console.log(`  evidence floor ${data.agreementDays} day(s), expiry ${data.ttlDays} day(s), proposals ${data.proposals}, learned sites ${data.learnedSites}, ledger ${data.ledger.length} entr${data.ledger.length === 1 ? 'y' : 'ies'}${data.ledger.head ? ` (head ${data.ledger.head.slice(0, 12)})` : ''}`);
}

async function ledger() {
  const entries = [];
  let after = opts.after;
  for (;;) {
    const { status, data } = await json('GET', `/learning/ledger?after=${after}&limit=200`);
    if (status !== 200) { console.error(`status ${status}: ${JSON.stringify(data)}`); process.exit(1); }
    entries.push(...data.entries);
    if (data.entries.length < 200) break;
    after = data.entries[data.entries.length - 1].seq;
  }
  const verification = lib.verifyLedger(entries);
  console.log(lib.renderLedger(entries, verification));
  if (!verification.valid) process.exit(2);
}

async function halt(on) {
  const { status, data } = await json('POST', '/learning/halt', { halt: on, reason: opts.reason || (on ? 'owner halt' : 'owner resume') });
  if (status !== 200) { console.error(`status ${status}: ${JSON.stringify(data)} (the halt route exists only on a proxy with TRAINER_OPERATIONS=1)`); process.exit(1); }
  console.log(`Learning ${data.halted ? 'halted' : 'resumed'} (ledger seq ${data.ledgerSeq})`);
}

({ propose, status, ledger, halt: () => halt(true), resume: () => halt(false) })[command]().catch(err => { console.error(err); process.exit(1); });
