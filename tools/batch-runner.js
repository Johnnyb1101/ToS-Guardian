// TOS Guardian — Batch Test Runner
//
// Runs the REAL extension pipeline (fetcher → link follower → analyzer →
// critic → evaluator) against a list of domains, headlessly in Node, and
// writes a CSV report plus one episode record per site (episode.js schema,
// ndjson) — the same record the extension produces in observer mode, so
// headless runs and live click-throughs feed the same reports.
//
// The extension-in-a-vm host lives in tools/pipeline-host.js and is shared
// with the reference freezer and replayer; see that file for the two
// substitutions the environment forces (direct document fetch instead of a
// hidden tab, in-memory chrome.storage.local).
//
// The pipeline is keyless: provider keys live on the proxy, which the runner
// must be pointed at explicitly. Use a dev proxy (its own key, its own
// database) for anything that is not a deliberate production check:
//   node tools/batch-runner.js sites.txt --proxy http://localhost:3000
// The proxy reports token usage and the exact model id on every analysis
// response; cost is computed from that (tools/batch-lib.js) and never guessed.
//
// Verdicts are captured via the dev test recorder (tosGuardianDebug →
// tosGuardianLastResult), so the CSV reports the same score/label/issues
// the extension overlay would show.
//
// Usage:
//   node tools/batch-runner.js <sites.txt | domain [domain ...]> [options]
//
// Options:
//   --proxy <url>     proxy to run against (or set TOS_PROXY_URL). Required
//                     unless --production is given.
//   --production      run against the production proxy, spending its key
//   --budget <usd>    stop before the next site once priced cost reaches this
//   --episodes <file> episode ndjson path (default batch-episodes-<timestamp>.ndjson)
//   --no-episodes     do not write episode records
//   --escalate        allow Opus escalation (default: off; cap of 5 still applies)
//   --cache           allow cache reads on the target proxy (default: off)
//   --write           allow cache and learned-site writes on the target proxy
//                     (default: off so batch runs do not mutate a cache)
//   --no-critic       skip the critic/judge LLM pass (cheaper, less strict)
//   --delay <ms>      pause between sites (default 1000)
//   --timeout <ms>    per-site timeout (default 180000)
//   --limit <n>       only run the first n sites from the list
//   --out <file>      CSV output path (default batch-results-<timestamp>.csv)
//   --verbose         stream pipeline console output
//
// Exit codes: 0 finished, 1 usage or fatal error, 3 stopped by --budget.

const fs = require('fs');
const {
  PRICING_AS_OF,
  estimateCost,
  resolveProxyTarget,
  budgetExceeded
} = require('./batch-lib');
const { createPipelineHost, withTimeout, domainsFromInputs } = require('./pipeline-host');
const Episode = require('../episode');

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const opts = {
  proxy: null,
  production: false,
  budget: null,
  episodes: null,
  writeEpisodes: true,
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
    console.log('  --proxy <url>     proxy to run against (or set TOS_PROXY_URL); required unless --production');
    console.log('  --production      run against the production proxy, spending its key');
    console.log('  --budget <usd>    stop before the next site once priced cost reaches this');
    console.log('  --episodes <file> episode ndjson path (default batch-episodes-<timestamp>.ndjson)');
    console.log('  --no-episodes     do not write episode records');
    console.log('  --cache           allow cache reads (default: off)');
    console.log('  --escalate        allow Opus escalation');
    console.log('  --write           allow cache and learned-site writes');
    console.log('  --no-critic       skip the critic/judge pass');
    console.log('  --delay <ms>      pause between sites (default: 1000)');
    console.log('  --timeout <ms>    per-site timeout (default: 180000)');
    console.log('  --limit <n>       only run the first n sites');
    console.log('  --out <file>      CSV output path');
    console.log('  --verbose         stream pipeline logs');
    process.exit(0);
  } else if (a === '--proxy') opts.proxy = args[++i];
  else if (a === '--production') opts.production = true;
  else if (a === '--budget') opts.budget = Number(args[++i]);
  else if (a === '--episodes') opts.episodes = args[++i];
  else if (a === '--no-episodes') opts.writeEpisodes = false;
  else if (a === '--escalate') opts.escalate = true;
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
  console.error('Usage: node tools/batch-runner.js <sites.txt | domain [domain ...]> --proxy <url> | --production [--budget usd] [--episodes file] [--cache] [--escalate] [--write] [--no-critic] [--delay ms] [--timeout ms] [--limit n] [--out file.csv] [--verbose]');
  process.exit(1);
}

if (opts.budget !== null && !(Number.isFinite(opts.budget) && opts.budget > 0)) {
  console.error('--budget must be a positive dollar amount.');
  process.exit(1);
}

const proxyTarget = resolveProxyTarget({ proxy: opts.proxy, production: opts.production, env: process.env });
if (proxyTarget.error) {
  console.error(proxyTarget.error);
  process.exit(1);
}

const domains = domainsFromInputs(inputs, msg => console.warn(msg)).slice(0, opts.limit);
if (domains.length === 0) { console.error('No valid domains to run.'); process.exit(1); }

// ---------------------------------------------------------------------------
// The extension, headless
// ---------------------------------------------------------------------------
const host = createPipelineHost({
  proxyUrl: proxyTarget.url,
  cache: opts.cache,
  write: opts.write,
  critic: opts.critic,
  escalate: opts.escalate,
  onLog: opts.verbose ? (line) => console.log('  ' + line) : null
});
const context = host.context;

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function runSite(domain) {
  const episodeId = Episode.newEpisodeId();
  const state = host.newRunState();
  state.events.push(Episode.createEvent(episodeId, 'trigger', {
    source: 'batch', branch: 'batch', controlTag: 'other',
    authForm: false, passwordField: false, knownDomain: false, frame: false
  }));

  return host.run(state, async () => {
    const pageUrl = `https://${domain}/`;
    const t0 = Date.now();

    let error = '';
    try {
      await withTimeout(
        (async () => {
          // Prefetch the homepage so the fetcher's Step 0/0.5 link scanning
          // works, mirroring what the content script provides from a live page.
          const home = await host.directFetch(pageUrl);
          const pageHtml = home ? home.html : '';
          const pageText = home ? context.stripHtml(home.html).slice(0, 20000) : '';
          await context.runOrchestrator(pageUrl, pageText, pageHtml, { episodeId, mode: 'batch' });
        })(),
        opts.timeout,
        state.controller
      );
    } catch (e) {
      error = e.message;
    }
    const durationMs = Date.now() - t0;
    const verdict = state.lastResult && state.lastResult.domain === domain ? state.lastResult : null;
    const usage = state.usage.slice();
    const { cost, unpriced } = estimateCost(usage);
    const episode = Episode.assembleEpisode(state.events);
    const episodeCheck = episode ? Episode.validateEpisode(episode) : { valid: false, errors: ['no events'] };
    const row = {
      domain,
      episode_id: episodeId,
      label: verdict ? verdict.label : (error ? 'Error' : 'Unknown'),
      score: verdict && verdict.score !== null ? verdict.score : '',
      cached: verdict ? verdict.cached : '',
      duration_ms: durationMs,
      llm_calls: state.llmCalls,
      models: [...new Set(usage.map(u => u.model))].join(' '),
      input_tokens: usage.reduce((n, u) => n + u.input, 0),
      output_tokens: usage.reduce((n, u) => n + u.output, 0),
      cache_read_tokens: usage.reduce((n, u) => n + u.cacheRead, 0),
      est_cost_usd: cost.toFixed(4),
      unpriced_calls: unpriced,
      opt_out_links: verdict ? (verdict.optOutLinks || []).length : 0,
      issues: verdict ? (verdict.issues || []).join('; ') : '',
      error
    };

    if ((row.label === 'Error' || row.label === 'Unknown') && !opts.verbose) {
      for (const line of state.logs.slice(-5)) console.log('    ' + line);
    }
    if (!episodeCheck.valid) {
      console.log(`    episode record invalid: ${episodeCheck.errors.slice(0, 3).join('; ')}`);
    }
    return { row, episode: episodeCheck.valid ? episode : null };
  });
}

(async () => {
  const columns = ['domain', 'episode_id', 'label', 'score', 'cached', 'duration_ms', 'llm_calls', 'models', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'est_cost_usd', 'unpriced_calls', 'opt_out_links', 'issues', 'error'];
  const rows = [];
  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const episodesPath = opts.writeEpisodes ? (opts.episodes || `batch-episodes-${stamp}.ndjson`) : null;
  let totalCost = 0;
  let budgetStopped = false;
  let episodesWritten = 0;

  console.log(`TOS Guardian batch runner — ${domains.length} site(s)`);
  console.log(`  proxy: ${proxyTarget.url}${proxyTarget.isProduction ? '  <-- PRODUCTION: this run spends the production key and counts against its daily fuse' : ''}`);
  console.log(`  cache reads: ${opts.cache ? 'on' : 'OFF'} | cache writes: ${opts.write ? 'ON' : 'off'} | escalation: ${opts.escalate ? 'ON' : 'off'} | critic: ${opts.critic ? 'on' : 'OFF'} | budget: ${opts.budget === null ? 'none' : `$${opts.budget.toFixed(2)}`}`);
  console.log(`  pricing table as of ${PRICING_AS_OF} (tools/batch-lib.js); unpriced calls are reported, never guessed`);
  console.log(`  episodes: ${episodesPath || 'off'}`);
  console.log('');

  for (let i = 0; i < domains.length; i++) {
    if (budgetExceeded(totalCost, opts.budget)) {
      budgetStopped = true;
      console.log(`Budget of $${opts.budget.toFixed(2)} reached after ${i} site(s) ($${totalCost.toFixed(4)}); stopping before ${domains[i]}.`);
      break;
    }
    const domain = domains[i];
    process.stdout.write(`[${i + 1}/${domains.length}] ${domain} ... `);
    const { row, episode } = await runSite(domain);
    rows.push(row);
    totalCost += Number(row.est_cost_usd);
    if (episodesPath && episode) {
      fs.appendFileSync(episodesPath, JSON.stringify(episode) + '\n', 'utf8');
      episodesWritten++;
    }
    const scorePart = row.score !== '' ? ` ${row.score}/100` : '';
    const cachePart = row.cached === true ? ' (cached)' : '';
    const unpricedPart = row.unpriced_calls ? ` (+${row.unpriced_calls} unpriced)` : '';
    console.log(`${row.label}${scorePart}${cachePart} — ${(row.duration_ms / 1000).toFixed(1)}s, $${row.est_cost_usd}${unpricedPart}${row.error ? ` — ${row.error}` : ''}`);
    if (i < domains.length - 1 && opts.delay > 0) {
      await new Promise(r => setTimeout(r, opts.delay));
    }
  }

  // CSV
  const outPath = opts.out || `batch-results-${stamp}.csv`;
  const csv = [columns.join(',')]
    .concat(rows.map(r => columns.map(c => csvEscape(r[c])).join(',')))
    .join('\r\n') + '\r\n';
  fs.writeFileSync(outPath, csv, 'utf8');

  // Summary
  const counts = {};
  for (const r of rows) counts[r.label] = (counts[r.label] || 0) + 1;
  const scored = rows.filter(r => r.score !== '');
  const totalIn = rows.reduce((n, r) => n + r.input_tokens, 0);
  const totalOut = rows.reduce((n, r) => n + r.output_tokens, 0);
  const totalCacheRead = rows.reduce((n, r) => n + r.cache_read_tokens, 0);
  const totalUnpriced = rows.reduce((n, r) => n + r.unpriced_calls, 0);

  console.log('');
  console.log('Summary');
  console.log(`  ${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(' | ') || 'no sites ran'}`);
  if (scored.length) {
    console.log(`  avg score (scored sites): ${(scored.reduce((n, r) => n + Number(r.score), 0) / scored.length).toFixed(1)}`);
  }
  console.log(`  tokens: ${totalIn.toLocaleString()} in / ${totalOut.toLocaleString()} out / ${totalCacheRead.toLocaleString()} cache-read — est. cost $${totalCost.toFixed(4)}${totalUnpriced ? ` (+${totalUnpriced} unpriced call(s): add the model to tools/batch-lib.js)` : ''}`);
  if (budgetStopped) console.log(`  stopped by --budget with ${domains.length - rows.length} site(s) not run`);
  console.log(`  report: ${outPath}`);
  if (episodesPath) console.log(`  episodes: ${episodesPath} (${episodesWritten} record(s)); render with: node tools/report.js ${episodesPath}`);
  if (budgetStopped) process.exit(3);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
