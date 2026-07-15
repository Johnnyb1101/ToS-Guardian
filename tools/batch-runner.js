// TOS Guardian — Batch Test Runner
//
// Runs the REAL extension pipeline (fetcher → link follower → analyzer →
// critic → evaluator) against a list of domains, headlessly in Node, and
// writes a CSV report: domain, label, score, timing, token usage, cost.
//
// It loads the actual extension source files in a vm context (same approach
// as tests/system.test.js) with two substitutions forced by the environment:
//   - fetchWithHiddenTab: no browser tabs exist in Node, so documents are
//     fetched directly with Node's fetch (PDFs and non-HTML fall through to
//     the Railway proxy, exactly like the extension's proxy fallback path).
//   - chrome.storage.local: in-memory map, seeded with the API key from
//     the ANTHROPIC_API_KEY environment variable.
//
// Verdicts are captured via the dev test recorder (tosGuardianDebug →
// tosGuardianLastResult), so the CSV reports the same score/label/issues
// the extension overlay would show.
//
// Usage:
//   node tools/batch-runner.js <sites.txt | domain [domain ...]> [options]
//
// Options:
//   --escalate      allow Opus escalation (default: off; cap of 5 still applies)
//   --cache         allow Supabase cache reads (default: off for smoke tests)
//   --write         allow Supabase writes (analyses + learned sites). Default
//                   off so batch runs do not mutate the production cache.
//   --no-critic     skip the critic/judge LLM pass (cheaper, less strict)
//   --delay <ms>    pause between sites (default 1000)
//   --timeout <ms>  per-site timeout (default 180000)
//   --limit <n>     only run the first n sites from the list
//   --out <file>    CSV output path (default batch-results-<timestamp>.csv)
//   --verbose       stream pipeline console output
//
// Cost is estimated from API-reported usage at: Haiku 4.5 $1/$5 per MTok,
// Opus 4.8 $5/$25 per MTok.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { AsyncLocalStorage } = require('async_hooks');

const repoRoot = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const opts = {
  escalate: false,
  cache: false,
  write: false,
  critic: true,
  delay: 1000,
  timeout: 180000,
  limit: Infinity,
  out: null,
  verbose: false
};
const inputs = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--help' || a === '-h') {
    console.log('Usage: node tools/batch-runner.js <sites.txt | domain [domain ...]> [options]');
    console.log('');
    console.log('Options:');
    console.log('  --cache         allow Supabase cache reads (default: off)');
    console.log('  --escalate      allow Opus escalation');
    console.log('  --write         allow Supabase and learned-site writes');
    console.log('  --no-critic     skip the critic/judge pass');
    console.log('  --delay <ms>    pause between sites (default: 1000)');
    console.log('  --timeout <ms>  per-site timeout (default: 180000)');
    console.log('  --limit <n>     only run the first n sites');
    console.log('  --out <file>    CSV output path');
    console.log('  --verbose       stream pipeline logs');
    process.exit(0);
  } else if (a === '--escalate') opts.escalate = true;
  else if (a === '--cache') opts.cache = true;
  else if (a === '--no-cache') opts.cache = false;
  else if (a === '--write') opts.write = true;
  else if (a === '--no-critic') opts.critic = false;
  else if (a === '--verbose') opts.verbose = true;
  else if (a === '--delay') opts.delay = Number(args[++i]);
  else if (a === '--timeout') opts.timeout = Number(args[++i]);
  else if (a === '--limit') opts.limit = Number(args[++i]);
  else if (a === '--out') opts.out = args[++i];
  else if (a.startsWith('--')) { console.error(`Unknown option: ${a}`); process.exit(1); }
  else inputs.push(a);
}

if (inputs.length === 0) {
  console.error('Usage: node tools/batch-runner.js <sites.txt | domain [domain ...]> [--cache] [--escalate] [--write] [--no-critic] [--delay ms] [--timeout ms] [--limit n] [--out file.csv] [--verbose]');
  process.exit(1);
}

const apiKey = process.env.ANTHROPIC_API_KEY || '';
if (!apiKey) {
  console.error('ANTHROPIC_API_KEY environment variable is not set. The analyzer cannot run without it.');
  process.exit(1);
}

// Build the domain list: each input is either a file of domains/URLs (one per
// line, # comments allowed) or a literal domain/URL.
function toDomain(entry) {
  const trimmed = entry.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname;
  } catch (e) {
    console.warn(`Skipping unparseable entry: ${trimmed}`);
    return null;
  }
}

let domains = [];
for (const input of inputs) {
  if (fs.existsSync(input) && fs.statSync(input).isFile()) {
    domains.push(...fs.readFileSync(input, 'utf8').split(/\r?\n/)
      .map(l => l.replace(/#.*$/, '').trim()).filter(Boolean).map(toDomain).filter(Boolean));
  } else {
    const d = toDomain(input);
    if (d) domains.push(d);
  }
}
domains = [...new Set(domains)].slice(0, opts.limit);
if (domains.length === 0) { console.error('No valid domains to run.'); process.exit(1); }

// ---------------------------------------------------------------------------
// Token usage tracking + cost
// ---------------------------------------------------------------------------
const PRICING_PER_MTOK = {
  haiku: { input: 1.0, output: 5.0 },   // claude-haiku-4-5
  opus: { input: 5.0, output: 25.0 }    // claude-opus-4-8
};

const runState = new AsyncLocalStorage();

function estimateCost(usage) {
  let cost = 0;
  for (const u of usage) {
    const tier = /opus/i.test(u.model) ? 'opus' : 'haiku';
    cost += (u.input * PRICING_PER_MTOK[tier].input + u.output * PRICING_PER_MTOK[tier].output) / 1e6;
  }
  return cost;
}

const realFetch = globalThis.fetch;

// Wrapped fetch for the vm context: records token usage from Anthropic API
// responses; everything else (proxy, OpenAI, Ollama) passes through.
async function trackedFetch(url, options) {
  const target = String(url);
  const state = runState.getStore();
  const fetchOptions = { ...(options || {}) };
  if (state?.controller && !fetchOptions.signal) {
    fetchOptions.signal = state.controller.signal;
  }
  if (!target.startsWith('https://api.anthropic.com/')) {
    return realFetch(url, fetchOptions);
  }
  if (state) state.llmCalls++;
  const response = await realFetch(url, fetchOptions);
  const data = await response.json().catch(() => ({}));
  if (state && data.usage) {
    let model = '';
    try { model = JSON.parse(fetchOptions.body).model || ''; } catch (e) { /* ignore */ }
    state.usage.push({
      model,
      input: data.usage.input_tokens || 0,
      output: data.usage.output_tokens || 0
    });
  }
  // analyzeWithModel/runCritic only use ok/status/json on this response
  return { ok: response.ok, status: response.status, json: async () => data };
}

// ---------------------------------------------------------------------------
// Direct document fetch — stands in for the extension's hidden tab
// ---------------------------------------------------------------------------
async function directFetch(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const state = runState.getStore();
  const abortFromSite = () => controller.abort();
  if (state?.controller) {
    if (state.controller.signal.aborted) controller.abort();
    else state.controller.signal.addEventListener('abort', abortFromSite, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await realFetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (!response.ok) return null;
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    // PDFs and non-text payloads can't be handled here — return null so the
    // caller falls through to the proxy, which has server-side PDF extraction.
    if (contentType.includes('pdf') || /\.pdf([#?].*)?$/i.test(url)) return null;
    if (contentType && !contentType.includes('html') && !contentType.startsWith('text/')) return null;
    const html = await response.text();
    return html ? { html, text: null /* stripped lazily below */ } : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
    state?.controller?.signal.removeEventListener('abort', abortFromSite);
  }
}

// ---------------------------------------------------------------------------
// VM context with browser shims (mirrors tests/system.test.js)
// ---------------------------------------------------------------------------
let storageData = {
  selectedProvider: 'anthropic',
  apiKey_anthropic: apiKey,
  tosGuardianDebug: true
};
if (!opts.escalate) {
  // Pre-exhaust the escalation cap so the orchestrator never calls Opus.
  storageData.opusEscalationData = { count: 5, resetAt: Date.now() + 365 * 24 * 60 * 60 * 1000 };
}

const storage = {
  get(keys, callback) {
    const result = {};
    const addKey = key => { result[key] = storageData[key]; };
    if (Array.isArray(keys)) keys.forEach(addKey);
    else if (typeof keys === 'string') addKey(keys);
    else if (keys && typeof keys === 'object') {
      for (const [key, defaultValue] of Object.entries(keys)) {
        result[key] = Object.prototype.hasOwnProperty.call(storageData, key) ? storageData[key] : defaultValue;
      }
    } else Object.assign(result, storageData);
    if (callback) callback(result);
    return Promise.resolve(result);
  },
  set(items, callback) {
    const state = runState.getStore();
    const storedItems = { ...items };
    if (state && Object.prototype.hasOwnProperty.call(storedItems, 'tosGuardianLastResult')) {
      state.lastResult = storedItems.tosGuardianLastResult;
      delete storedItems.tosGuardianLastResult;
    }
    Object.assign(storageData, storedItems);
    if (callback) callback();
    return Promise.resolve();
  },
  remove(keys, callback) {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete storageData[key];
    if (callback) callback();
    return Promise.resolve();
  }
};

function logLine(level, args2) {
  const line = `[${level}] ` + args2.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  const state = runState.getStore();
  if (state) state.logs.push(line);
  if (opts.verbose) console.log('  ' + line);
}

const context = {
  console: {
    log: (...a) => logLine('log', a),
    warn: (...a) => logLine('warn', a),
    error: (...a) => logLine('error', a)
  },
  URL,
  Date,
  setTimeout,
  clearTimeout,
  AbortController,
  fetch: trackedFetch,
  importScripts: () => {},
  chrome: undefined,
  browser: {
    storage: { local: storage },
    tabs: {},
    runtime: { onMessage: { addListener: () => {} }, lastError: null }
  }
};
vm.createContext(context);

for (const file of ['vendor/tldts-7.4.8.umd.min.js', 'tosUtils.js', 'evaluator.js', 'critic.js', 'siteDatabase.js', 'orchestrator.js', 'background.js']) {
  vm.runInContext(fs.readFileSync(path.join(repoRoot, file), 'utf8'), context, { filename: file });
}

// --- Post-load overrides (function declarations in background.js land on the
// context's global object, so reassigning the properties here replaces them
// for every call site in the pipeline). ---

// Hidden tabs don't exist in Node: fetch directly, strip with the extension's
// own stripHtml. Returning null makes tryFetchCandidates fall back to the proxy.
context.fetchWithHiddenTab = async (url) => {
  const fetched = await directFetch(url);
  if (!fetched) return null;
  const text = context.stripHtml(fetched.html);
  return { text, html: fetched.html };
};

if (!opts.cache) {
  context.readFromSupabase = async () => null;
}
if (!opts.write) {
  context.writeToSupabase = async () => null;
  context.learnSite = async () => null;
}
if (!opts.critic) {
  context.runCritic = async () => null;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
function withTimeout(promise, ms, controller) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function runSite(domain) {
  const state = {
    controller: new AbortController(),
    usage: [],
    llmCalls: 0,
    logs: [],
    lastResult: null
  };

  return runState.run(state, async () => {
    const pageUrl = `https://${domain}/`;
    const t0 = Date.now();

    let error = '';
    try {
      await withTimeout(
        (async () => {
          // Prefetch the homepage so the fetcher's Step 0/0.5 link scanning
          // works, mirroring what the content script provides from a live page.
          const home = await directFetch(pageUrl);
          const pageHtml = home ? home.html : '';
          const pageText = home ? context.stripHtml(home.html).slice(0, 20000) : '';
          await context.runOrchestrator(pageUrl, pageText, pageHtml);
        })(),
        opts.timeout,
        state.controller
      );
    } catch (e) {
      error = e.message;
    }
    const durationMs = Date.now() - t0;
    const verdict = state.lastResult?.domain === domain ? state.lastResult : null;
    const usage = state.usage.slice();
    const row = {
      domain,
      label: verdict ? verdict.label : (error ? 'Error' : 'Unknown'),
      score: verdict && verdict.score !== null ? verdict.score : '',
      cached: verdict ? verdict.cached : '',
      duration_ms: durationMs,
      llm_calls: state.llmCalls,
      input_tokens: usage.reduce((n, u) => n + u.input, 0),
      output_tokens: usage.reduce((n, u) => n + u.output, 0),
      est_cost_usd: estimateCost(usage).toFixed(4),
      opt_out_links: verdict ? (verdict.optOutLinks || []).length : 0,
      issues: verdict ? (verdict.issues || []).join('; ') : '',
      error
    };

    if ((row.label === 'Error' || row.label === 'Unknown') && !opts.verbose) {
      for (const line of state.logs.slice(-5)) console.log('    ' + line);
    }
    return row;
  });
}

(async () => {
  const columns = ['domain', 'label', 'score', 'cached', 'duration_ms', 'llm_calls', 'input_tokens', 'output_tokens', 'est_cost_usd', 'opt_out_links', 'issues', 'error'];
  const rows = [];
  const startedAt = new Date();

  console.log(`TOS Guardian batch runner — ${domains.length} site(s)`);
  console.log(`  cache reads: ${opts.cache ? 'on' : 'OFF'} | Supabase writes: ${opts.write ? 'ON' : 'off'} | escalation: ${opts.escalate ? 'ON' : 'off'} | critic: ${opts.critic ? 'on' : 'OFF'}`);
  console.log('');

  for (let i = 0; i < domains.length; i++) {
    const domain = domains[i];
    process.stdout.write(`[${i + 1}/${domains.length}] ${domain} ... `);
    const row = await runSite(domain);
    rows.push(row);
    const scorePart = row.score !== '' ? ` ${row.score}/100` : '';
    const cachePart = row.cached === true ? ' (cached)' : '';
    console.log(`${row.label}${scorePart}${cachePart} — ${(row.duration_ms / 1000).toFixed(1)}s, $${row.est_cost_usd}${row.error ? ` — ${row.error}` : ''}`);
    if (i < domains.length - 1 && opts.delay > 0) {
      await new Promise(r => setTimeout(r, opts.delay));
    }
  }

  // CSV
  const stamp = startedAt.toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const outPath = opts.out || `batch-results-${stamp}.csv`;
  const csv = [columns.join(',')]
    .concat(rows.map(r => columns.map(c => csvEscape(r[c])).join(',')))
    .join('\r\n') + '\r\n';
  fs.writeFileSync(outPath, csv, 'utf8');

  // Summary
  const counts = {};
  for (const r of rows) counts[r.label] = (counts[r.label] || 0) + 1;
  const scored = rows.filter(r => r.score !== '');
  const totalCost = rows.reduce((n, r) => n + Number(r.est_cost_usd), 0);
  const totalIn = rows.reduce((n, r) => n + r.input_tokens, 0);
  const totalOut = rows.reduce((n, r) => n + r.output_tokens, 0);

  console.log('');
  console.log('Summary');
  console.log(`  ${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(' | ')}`);
  if (scored.length) {
    console.log(`  avg score (scored sites): ${(scored.reduce((n, r) => n + Number(r.score), 0) / scored.length).toFixed(1)}`);
  }
  console.log(`  tokens: ${totalIn.toLocaleString()} in / ${totalOut.toLocaleString()} out — est. cost $${totalCost.toFixed(4)}`);
  console.log(`  report: ${outPath}`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
