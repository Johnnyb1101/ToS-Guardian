const fs = require('fs');
const path = require('path');
const { resolveProxyTarget, estimateCost, budgetExceeded } = require('./batch-lib');
const { createPipelineHost, withTimeout } = require('./pipeline-host');
const lib = require('./reference-lib');
const { composeCriticArtifact, concernCount } = require('./critic-lib');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function usage(code) {
  console.log('Usage: node tools/critic-replay.js <sourceRunDir> --proxy <url> --run <runId> --lessons none|<ids> [--juror anthropic] [--sites a,b] [--limit n] [--budget $] [--delay ms] [--timeout ms] [--force] [--verbose]');
  console.log('Re-runs only the critic over the analyses stored in a graded run, so critic lessons can be compared against the same jury verdicts.');
  process.exit(code);
}

function parseLessons(value) {
  const raw = String(value || '').trim();
  if (raw === 'none') return 'none';
  const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (ids.length && ids.every(id => /^lsn_[0-9a-f]{16}$/.test(id))) return { ids };
  console.error('--lessons must be none or a comma-separated list of lesson ids');
  process.exit(1);
}

function parseArgs(args) {
  const opts = { source: null, proxy: null, run: null, lessons: null, juror: 'anthropic', sites: null, limit: Infinity, budget: null, delay: 5500, timeout: 120000, force: false, verbose: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--proxy') opts.proxy = args[++i];
    else if (a === '--run') opts.run = args[++i];
    else if (a === '--lessons') opts.lessons = parseLessons(args[++i]);
    else if (a === '--juror') opts.juror = args[++i];
    else if (a === '--sites') opts.sites = String(args[++i]).split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--limit') opts.limit = Number(args[++i]);
    else if (a === '--budget') opts.budget = Number(args[++i]);
    else if (a === '--delay') opts.delay = Number(args[++i]);
    else if (a === '--timeout') opts.timeout = Number(args[++i]);
    else if (a === '--force') opts.force = true;
    else if (a === '--verbose') opts.verbose = true;
    else if (a.startsWith('--')) { console.error(`Unknown option: ${a}`); process.exit(1); }
    else opts.source = a;
  }
  if (!opts.source || !opts.run || opts.lessons === null) usage(1);
  if (opts.budget !== null && !(Number.isFinite(opts.budget) && opts.budget > 0)) { console.error('--budget must be a positive dollar amount.'); process.exit(1); }
  return opts;
}

function loadSourceArtifacts(sourceDir, opts) {
  const dir = path.join(sourceDir, 'artifacts');
  if (!fs.existsSync(dir)) { console.error(`No artifacts directory at ${dir}`); process.exit(1); }
  const wanted = opts.sites ? new Set(opts.sites) : null;
  const out = [];
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    const artifact = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (wanted && !wanted.has(artifact.domain)) continue;
    const eligible = artifact.analyzer && artifact.analyzer.status === 'ok' && typeof artifact.summary === 'string' && typeof artifact.analysisSource === 'string' && artifact.jury && artifact.jury[opts.juror];
    out.push({ artifact, eligible });
  }
  return out;
}

async function criticOne(host, source, opts, runId) {
  const ctx = host.context;
  const state = host.newRunState();
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let critic = null;
  let error = '';
  await host.run(state, async () => {
    try {
      critic = await withTimeout(ctx.runCritic(source.summary, source.analysisSource), opts.timeout, state.controller);
    } catch (e) {
      error = e.message;
    }
  });
  const criticFailed = !!(critic && critic.failed);
  const evaluation = ctx.capForUnverifiedCritic(ctx.validateEvaluation(ctx.evaluateAnalysis(source.summary, criticFailed ? null : critic)), criticFailed);
  const { cost, unpriced } = estimateCost(state.usage);
  return composeCriticArtifact(source, { runId, critic: critic && typeof critic === 'object' ? { ...critic } : critic, evaluation, usage: state.usage, cost, unpriced, error, durationMs: Date.now() - t0, startedAt });
}

async function runCriticReplay(args) {
  const opts = parseArgs(args);
  const target = resolveProxyTarget({ proxy: opts.proxy, env: process.env });
  if (target.error) { console.error(target.error); process.exit(1); }
  if (target.isProduction) { console.error('Critic replay runs against the dev proxy only.'); process.exit(1); }

  const sourceDir = path.resolve(opts.source);
  const sourceMetaPath = path.join(sourceDir, 'run.json');
  const sourceRunId = fs.existsSync(sourceMetaPath) ? JSON.parse(fs.readFileSync(sourceMetaPath, 'utf8')).runId || path.basename(sourceDir) : path.basename(sourceDir);
  const sources = loadSourceArtifacts(sourceDir, opts);
  const jobs = sources.filter(s => s.eligible).slice(0, opts.limit);
  if (!jobs.length) { console.error('No graded analyses to re-check in the source run.'); process.exit(1); }

  const runDir = path.join(lib.RUNS_DIR, opts.run);
  const artifactsDir = path.join(runDir, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });
  const metaPath = path.join(runDir, 'run.json');
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {
    v: 1, runId: opts.run, startedAt: new Date().toISOString(), proxy: target.url, criticOf: sourceRunId,
    options: { lessons: opts.lessons, juror: opts.juror, sites: opts.sites, limit: Number.isFinite(opts.limit) ? opts.limit : null },
    sites: [...new Set(jobs.map(j => j.artifact.domain))]
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');

  const host = createPipelineHost({ proxyUrl: target.url, cache: false, write: false, critic: true, escalate: false, lessonSet: opts.lessons, runTag: opts.run, onLog: opts.verbose ? (line) => console.log('  ' + line) : null });

  console.log(`TOS Guardian critic replay — ${jobs.length} analyses from ${sourceRunId} (${sources.length - jobs.length} skipped), proxy ${target.url}`);
  console.log(`  run: ${runDir}`);
  console.log(`  lessons: ${opts.lessons === 'none' ? 'none' : opts.lessons.ids.join(',')} | budget: ${opts.budget === null ? 'none' : `$${opts.budget.toFixed(2)}`} | delay ${opts.delay}ms`);
  console.log('');

  let totalCost = 0;
  let done = 0;
  let skipped = 0;
  let problems = 0;
  for (let i = 0; i < jobs.length; i++) {
    const source = jobs[i].artifact;
    const artifactPath = path.join(artifactsDir, `${source.domain}.${source.sample}.json`);
    process.stdout.write(`[${i + 1}/${jobs.length}] ${source.domain}#${source.sample} ... `);
    if (fs.existsSync(artifactPath) && !opts.force) { skipped++; console.log('already checked'); continue; }
    if (budgetExceeded(totalCost, opts.budget)) { console.log(`budget of $${opts.budget.toFixed(2)} reached ($${totalCost.toFixed(4)}); stopping.`); break; }
    const artifact = await criticOne(host, source, opts, opts.run);
    fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + '\n', 'utf8');
    totalCost += artifact.cost;
    done++;
    const failed = !artifact.critic || artifact.critic.failed;
    if (failed || artifact.error) problems++;
    const before = artifact.criticOf.verdict ? artifact.criticOf.verdict.label : '?';
    const after = artifact.verdict ? artifact.verdict.label : '?';
    const note = failed ? `critic ${artifact.critic ? artifact.critic._reason : 'absent'}` : `concerns ${concernCount(artifact.critic)}/6`;
    console.log(`${note} — ${(artifact.durationMs / 1000).toFixed(1)}s, $${artifact.cost.toFixed(4)}${artifact.unpriced ? ` (+${artifact.unpriced} unpriced)` : ''}, label ${before}${after === before ? '' : ` to ${after}`}${artifact.error ? ` — ${artifact.error}` : ''}`);
    if (i < jobs.length - 1 && opts.delay > 0) await sleep(opts.delay);
  }

  console.log('');
  console.log(`Checked ${done}, skipped ${skipped}, problems ${problems}, est. cost $${totalCost.toFixed(4)}.`);
  console.log(`Next: node tools/prove-critic.js "${runDir}" --control "${sourceDir}"`);
}

module.exports = { parseArgs, loadSourceArtifacts, criticOne, runCriticReplay };

if (require.main === module) {
  runCriticReplay(process.argv.slice(2)).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
