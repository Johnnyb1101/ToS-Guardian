const fs = require('fs');
const path = require('path');
const { resolveProxyTarget, estimateCost, budgetExceeded } = require('./batch-lib');
const { createPipelineHost, withTimeout } = require('./pipeline-host');
const Episode = require('../episode');
const lib = require('./reference-lib');
const { SECTIONS } = require('./jury-lib');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseArgs(args) {
  const opts = {
    proxy: null, split: 'work', type: null, sites: null, limit: Infinity, samples: 1, includeShells: false,
    budget: null, delay: 12000, timeout: 180000, run: null, escalate: false, force: false, verbose: false
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--proxy') opts.proxy = args[++i];
    else if (a === '--split') opts.split = args[++i];
    else if (a === '--type') opts.type = args[++i];
    else if (a === '--sites') opts.sites = String(args[++i]).split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--limit') opts.limit = Number(args[++i]);
    else if (a === '--samples') opts.samples = Number(args[++i]);
    else if (a === '--include-shells') opts.includeShells = true;
    else if (a === '--budget') opts.budget = Number(args[++i]);
    else if (a === '--delay') opts.delay = Number(args[++i]);
    else if (a === '--timeout') opts.timeout = Number(args[++i]);
    else if (a === '--run') opts.run = args[++i];
    else if (a === '--escalate') opts.escalate = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--verbose') opts.verbose = true;
    else { console.error(`Unknown option: ${a}`); process.exit(1); }
  }
  if (!['work', 'holdout', 'all'].includes(opts.split)) { console.error('--split must be work, holdout, or all'); process.exit(1); }
  if (!(Number.isInteger(opts.samples) && opts.samples > 0)) { console.error('--samples must be a positive integer'); process.exit(1); }
  if (opts.budget !== null && !(Number.isFinite(opts.budget) && opts.budget > 0)) { console.error('--budget must be a positive dollar amount.'); process.exit(1); }
  return opts;
}

function selectSites(manifest, opts) {
  let entries = Object.values(manifest.sites).sort((a, b) => a.domain.localeCompare(b.domain));
  if (opts.sites) {
    const wanted = new Set(opts.sites);
    entries = entries.filter(e => wanted.has(e.domain));
  } else {
    if (!opts.includeShells) entries = entries.filter(e => e.looksLegal);
    if (opts.split !== 'all') entries = entries.filter(e => e.split === opts.split);
    if (opts.type) entries = entries.filter(e => lib.effectiveType(e) === opts.type);
  }
  return entries.slice(0, opts.limit);
}

function loadFrozen(entry) {
  const file = path.join(lib.REFERENCE_DIR, entry.sourceFile);
  if (!fs.existsSync(file)) return { error: 'frozen source missing; refreeze the site' };
  const frozen = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (frozen.textHash !== entry.textHash) return { error: 'frozen source does not match the manifest hash; refreeze the site' };
  return { frozen };
}

function stubPipeline(host) {
  const ctx = host.context;
  const frozenOf = () => {
    const state = host.runState.getStore();
    return state && state.frozen ? state.frozen : null;
  };
  ctx.lookupSite = async () => {
    const frozen = frozenOf();
    return frozen && frozen.lookup ? { ...frozen.lookup } : null;
  };
  ctx.fetcherAgent = async () => {
    const frozen = frozenOf();
    if (!frozen) return null;
    const d = frozen.fetched;
    return {
      path: 'frozen',
      text: d.text,
      sourceUrl: d.sourceUrl,
      privacyUrl: d.privacyUrl,
      privacyHtml: null,
      documentLinks: (d.documentUrls || []).filter(u => u !== d.sourceUrl && u !== d.privacyUrl),
      hasSupplementalPrivacy: !!d.hasSupplementalPrivacy,
      unreadablePdfUrls: d.unreadablePdfUrls || [],
      mechanisms: null
    };
  };
  ctx.linkFollowerStub = async (text) => {
    const frozen = frozenOf();
    if (!frozen) return { text, optOutLinks: [], candidates: 0, followed: 0 };
    const e = frozen.enriched;
    return { text: e.text, optOutLinks: e.optOutLinks.slice(), candidates: e.candidates, followed: e.followed };
  };
}

function groundedCount(critic) {
  return SECTIONS.filter(name => critic[name] === 'grounded').length;
}

async function replayOne(host, entry, frozen, sample, opts, runId) {
  const ctx = host.context;
  const episodeId = Episode.newEpisodeId();
  const state = host.newRunState();
  state.frozen = frozen;
  state.events.push(Episode.createEvent(episodeId, 'trigger', {
    source: 'replay', branch: 'replay', controlTag: 'other',
    authForm: false, passwordField: false, knownDomain: false, frame: false
  }));
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let error = '';
  await host.run(state, async () => {
    try {
      await withTimeout(ctx.runOrchestrator(frozen.pageUrl, '', '', { episodeId, mode: 'replay', sample }), opts.timeout, state.controller);
    } catch (e) {
      error = e.message;
    }
  });
  const durationMs = Date.now() - t0;
  const analysis = state.analyses.length ? state.analyses[state.analyses.length - 1] : null;
  const result = analysis ? analysis.result : null;
  const critic = state.critics.length ? state.critics[state.critics.length - 1] : null;
  const verdict = state.lastResult && state.lastResult.domain === entry.domain ? state.lastResult : null;
  const episode = Episode.assembleEpisode(state.events);
  const episodeCheck = episode ? Episode.validateEpisode(episode) : { valid: false, errors: ['no events'] };
  const { cost, unpriced } = estimateCost(state.usage);
  const artifact = {
    v: 1,
    runId,
    domain: entry.domain,
    sample,
    split: entry.split,
    docType: lib.effectiveType(entry),
    textHash: entry.textHash,
    episodeId,
    startedAt,
    durationMs,
    analyzer: result ? {
      status: result.status || (typeof result.summary === 'string' ? 'ok' : 'none'),
      model: result.model || '',
      providerTag: result.providerTag || '',
      stopReason: result.stopReason || '',
      escalated: !!analysis.escalated,
      usage: result.usage || null,
      analysisChars: typeof result.analysisSource === 'string' ? result.analysisSource.length : 0,
      attempts: state.analyses.length
    } : null,
    analysisSource: result && typeof result.analysisSource === 'string' ? result.analysisSource : null,
    summary: result && typeof result.summary === 'string' ? result.summary : null,
    critic,
    verdict: verdict ? {
      label: verdict.label,
      score: verdict.score,
      issues: verdict.issues || [],
      warning: verdict.warning || null,
      optOutLinks: verdict.optOutLinks || [],
      cached: !!verdict.cached,
      risk: episode && episode.stages && episode.stages.verdict ? episode.stages.verdict.risk : null
    } : null,
    usage: state.usage,
    cost,
    unpriced,
    error,
    logTail: state.logs.slice(-8),
    jury: {}
  };
  return { artifact, episode: episodeCheck.valid ? episode : null, episodeErrors: episodeCheck.errors };
}

async function runReplay(args) {
  const opts = parseArgs(args);
  const target = resolveProxyTarget({ proxy: opts.proxy, env: process.env });
  if (target.error) { console.error(target.error); process.exit(1); }
  if (target.isProduction) { console.error('Replay runs against the dev proxy only.'); process.exit(1); }

  const manifest = lib.loadManifest();
  const entries = selectSites(manifest, opts);
  if (entries.length === 0) { console.error('No reference sites match the selection.'); process.exit(1); }

  const runId = opts.run || `replay-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}`;
  const runDir = path.join(lib.RUNS_DIR, runId);
  const artifactsDir = path.join(runDir, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });
  const metaPath = path.join(runDir, 'run.json');
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {
    v: 1, runId, startedAt: new Date().toISOString(), proxy: target.url, manifestUpdatedAt: manifest.updatedAt,
    options: { split: opts.split, type: opts.type, sites: opts.sites, limit: Number.isFinite(opts.limit) ? opts.limit : null, samples: opts.samples, includeShells: opts.includeShells, escalate: opts.escalate },
    sites: entries.map(e => e.domain)
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');

  const host = createPipelineHost({
    proxyUrl: target.url, cache: false, write: false, critic: true, escalate: opts.escalate,
    onLog: opts.verbose ? (line) => console.log('  ' + line) : null
  });
  stubPipeline(host);

  const jobs = [];
  for (const entry of entries) for (let sample = 1; sample <= opts.samples; sample++) jobs.push({ entry, sample });

  console.log(`TOS Guardian replay — ${entries.length} site(s) x ${opts.samples} sample(s), proxy ${target.url}`);
  console.log(`  run: ${runDir}`);
  console.log(`  escalation: ${opts.escalate ? 'ON' : 'off'} | budget: ${opts.budget === null ? 'none' : `$${opts.budget.toFixed(2)}`} | delay ${opts.delay}ms`);
  console.log('');

  let totalCost = 0;
  let done = 0;
  let skipped = 0;
  let problems = 0;
  for (let i = 0; i < jobs.length; i++) {
    const { entry, sample } = jobs[i];
    const artifactPath = path.join(artifactsDir, `${entry.domain}.${sample}.json`);
    process.stdout.write(`[${i + 1}/${jobs.length}] ${entry.domain}#${sample} ... `);
    if (fs.existsSync(artifactPath) && !opts.force) { skipped++; console.log('already replayed'); continue; }
    if (budgetExceeded(totalCost, opts.budget)) { console.log(`budget of $${opts.budget.toFixed(2)} reached ($${totalCost.toFixed(4)}); stopping.`); break; }
    const loaded = loadFrozen(entry);
    if (loaded.error) { problems++; console.log(loaded.error); continue; }

    const { artifact, episode, episodeErrors } = await replayOne(host, entry, loaded.frozen, sample, opts, runId);
    fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + '\n', 'utf8');
    if (episode) fs.appendFileSync(path.join(runDir, 'episodes.ndjson'), JSON.stringify(episode) + '\n', 'utf8');
    totalCost += artifact.cost;
    done++;
    const status = artifact.analyzer ? artifact.analyzer.status : 'none';
    if (status !== 'ok' || artifact.error) problems++;
    const criticNote = artifact.critic ? (artifact.critic.failed ? `critic ${artifact.critic._reason}` : `critic ${groundedCount(artifact.critic)}/6 grounded`) : 'no critic';
    const verdictNote = artifact.verdict ? `${artifact.verdict.label} ${artifact.verdict.score}/100 ${artifact.verdict.risk || ''}`.trim() : 'no verdict';
    console.log(`${verdictNote} — ${(artifact.durationMs / 1000).toFixed(1)}s, $${artifact.cost.toFixed(4)}${artifact.unpriced ? ` (+${artifact.unpriced} unpriced)` : ''}, ${criticNote}${status !== 'ok' ? ` — analyzer ${status}` : ''}${artifact.error ? ` — ${artifact.error}` : ''}`);
    if ((status !== 'ok' || artifact.error) && !opts.verbose) for (const line of artifact.logTail.slice(-4)) console.log('    ' + line);
    if (!episode) console.log(`    episode record invalid: ${episodeErrors.slice(0, 3).join('; ')}`);
    if (i < jobs.length - 1 && opts.delay > 0) await sleep(opts.delay);
  }

  console.log('');
  console.log(`Replayed ${done}, skipped ${skipped}, problems ${problems}, est. cost $${totalCost.toFixed(4)}.`);
  console.log(`Artifacts: ${artifactsDir}`);
  console.log(`Next: node tools/jury.js grade "${runDir}" --proxy ${target.url}`);
}

module.exports = { parseArgs, selectSites, loadFrozen, stubPipeline, replayOne, runReplay };

if (require.main === module) {
  runReplay(process.argv.slice(2)).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
