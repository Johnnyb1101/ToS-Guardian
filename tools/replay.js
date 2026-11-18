const fs = require('fs');
const path = require('path');
const { resolveProxyTarget, estimateCost, budgetExceeded } = require('./batch-lib');
const { createPipelineHost, withTimeout } = require('./pipeline-host');
const Episode = require('../episode');
const lib = require('./reference-lib');
const { SECTIONS } = require('./jury-lib');
const releases = require('./sites-lib');
const { hash, EVALUATION_PROTOCOL, EVALUATION_PROTOCOL_HASH } = require('./evaluation-lib');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseArgs(args) {
  const opts = {
    proxy: null, split: 'work', type: null, sites: null, limit: Infinity, samples: 1, includeShells: false,
    budget: null, delay: 12000, timeout: 180000, run: null, escalate: false, force: false, verbose: false, configHash: null
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
    else if (a === '--config-hash') opts.configHash = args[++i];
    else if (a === '--lessons') throw new Error('Per-lesson replay selection is retired; use --config-hash for a complete release');
    else if (a === '--force') opts.force = true;
    else if (a === '--verbose') opts.verbose = true;
    else { console.error(`Unknown option: ${a}`); process.exit(1); }
  }
  if (!['work', 'holdout', 'all'].includes(opts.split)) { console.error('--split must be work, holdout, or all'); process.exit(1); }
  if (!(Number.isInteger(opts.samples) && opts.samples > 0)) { console.error('--samples must be a positive integer'); process.exit(1); }
  if (opts.budget !== null && !(Number.isFinite(opts.budget) && opts.budget > 0)) { console.error('--budget must be a positive dollar amount.'); process.exit(1); }
  if (opts.configHash !== null && !/^[a-f0-9]{64}$/.test(opts.configHash)) throw new Error('--config-hash must be a 64-character lowercase SHA-256 hash');
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
  if (frozen.textHash !== entry.textHash || !frozen.fetched || typeof frozen.fetched.text !== 'string' || lib.sha256Hex(frozen.fetched.text) !== entry.textHash) return { error: 'frozen source does not match the manifest hash; refreeze the site' };
  if (entry.domain && frozen.domain !== entry.domain) return { error: 'frozen source domain does not match the manifest; refreeze the site' };
  return { frozen };
}

function stubPipeline(host) {
  const ctx = host.context;
  if (!/^[a-f0-9]{64}$/.test(host.configHash || '')) throw new Error('Frozen replay requires a complete configHash');
  ctx.beginReleaseSession = async () => ({ configHash: host.configHash, releaseToken: null });
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

function evaluationSet(entries, samples) {
  return entries.map(entry => ({ domain: entry.domain, split: entry.split === 'holdout' ? 'validation' : entry.split, docType: lib.effectiveType(entry), textHash: entry.textHash, samples: Array.from({ length: samples }, (_, i) => i + 1) }));
}

function replayMeta(existing, entries, opts, runId, proxy, manifestUpdatedAt, release) {
  if (!/^[a-f0-9]{64}$/.test(opts.configHash || '')) throw new Error('Replay declaration requires a complete configHash');
  const releaseCheck = releases.checkRelease(release, opts.configHash);
  if (!releaseCheck.valid) throw new Error(releaseCheck.reason);
  const declared = evaluationSet(entries, opts.samples);
  const options = { split: opts.split, type: opts.type, sites: opts.sites, limit: Number.isFinite(opts.limit) ? opts.limit : null, samples: opts.samples, includeShells: opts.includeShells, escalate: opts.escalate, configHash: opts.configHash };
  if (existing) {
    if (existing.runId !== runId || existing.proxy !== proxy || existing.configHash !== opts.configHash || existing.evaluationProtocolHash !== EVALUATION_PROTOCOL_HASH || JSON.stringify(existing.release) !== JSON.stringify(release) || JSON.stringify(existing.evaluationSet) !== JSON.stringify(declared) || JSON.stringify(existing.options) !== JSON.stringify(options)) {
      throw new Error('Replay declaration or options changed, or historical run lacks evaluation metadata; use a new run id.');
    }
    return existing;
  }
  return { v: 3, runId, startedAt: new Date().toISOString(), proxy, manifestUpdatedAt, configHash: opts.configHash, release, evaluationProtocol: EVALUATION_PROTOCOL, evaluationProtocolHash: EVALUATION_PROTOCOL_HASH, options, sites: entries.map(e => e.domain), evaluationSet: declared };
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
    configHash: opts.configHash || null,
    evaluationProtocolHash: EVALUATION_PROTOCOL_HASH,
    episodeId,
    startedAt,
    durationMs,
    analyzer: result ? {
      status: result.status || (typeof result.summary === 'string' ? 'ok' : 'none'),
      model: result.model || '',
      promptHash: result.promptHash || '',
      providerTag: result.providerTag || '',
      stopReason: result.stopReason || '',
      escalated: !!analysis.escalated,
      usage: result.usage || null,
      analysisChars: typeof result.analysisSource === 'string' ? result.analysisSource.length : 0,
      attempts: state.analyses.length,
      lessonsHash: typeof result.lessonsHash === 'string' ? result.lessonsHash : '',
      lessonsArm: typeof result.lessonsArm === 'string' ? result.lessonsArm : 'none',
      docType: typeof result.docType === 'string' ? result.docType : ''
    } : null,
    analysisSource: result && typeof result.analysisSource === 'string' ? result.analysisSource : null,
    summary: result && typeof result.summary === 'string' ? result.summary : null,
    critic,
    criticConfig: state.evidence.filter(e => e.operation === 'critic').map(({ provider, model, promptHash, lessonsHash, docType, configHash }) => ({ provider, model, promptHash, lessonsHash, ...(docType ? { docType } : {}), ...(configHash ? { configHash } : {}) })).pop() || null,
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
  artifact.analyzerConfigHash = state.evidence.filter(e => e.operation === 'analyzer').map(e => e.configHash).pop() || null;
  artifact.clientPolicyHash = state.evidence.filter(e => e.operation === 'analyzer').map(e => e.clientPolicyHash).pop() || null;
  artifact.criticClientPolicyHash = state.evidence.filter(e => e.operation === 'critic').map(e => e.clientPolicyHash).pop() || null;
  artifact.evidenceHashes = {
    analysisSource: typeof artifact.analysisSource === 'string' ? hash(artifact.analysisSource) : null,
    summary: typeof artifact.summary === 'string' ? hash(artifact.summary) : null,
    critic: artifact.critic ? releases.sha256(artifact.critic) : null
  };
  return { artifact, episode: episodeCheck.valid ? episode : null, episodeErrors: episodeCheck.errors };
}

async function runReplay(args) {
  const opts = parseArgs(args);
  const target = resolveProxyTarget({ proxy: opts.proxy, env: process.env });
  if (target.error) { console.error(target.error); process.exit(1); }
  if (target.isProduction) { console.error('Replay runs against the dev proxy only.'); process.exit(1); }
  if (!opts.configHash) throw new Error('Replay requires --config-hash for a complete immutable release');
  const release = await releases.fetchRelease(target.url, opts.configHash);

  const manifest = lib.loadManifest();
  const entries = selectSites(manifest, opts);
  if (entries.length === 0) { console.error('No reference sites match the selection.'); process.exit(1); }

  const runId = opts.run || `replay-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}`;
  const runDir = path.join(lib.RUNS_DIR, runId);
  const artifactsDir = path.join(runDir, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });
  const metaPath = path.join(runDir, 'run.json');
  const meta = replayMeta(fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : null, entries, opts, runId, target.url, manifest.updatedAt, release);

  const host = createPipelineHost({
    proxyUrl: target.url, cache: false, write: false, critic: true, escalate: opts.escalate, configHash: opts.configHash, expectedClientPolicyHash: release.config.policy.versions.pipeline, runTag: runId,
    onLog: opts.verbose ? (line) => console.log('  ' + line) : null
  });
  if (await host.clientPolicyHash !== release.config.policy.versions.pipeline) throw new Error('Client pipeline policy hash differs from the complete release');
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  stubPipeline(host);

  const jobs = [];
  for (const entry of entries) for (let sample = 1; sample <= opts.samples; sample++) jobs.push({ entry, sample });

  console.log(`TOS Guardian replay — ${entries.length} site(s) x ${opts.samples} sample(s), proxy ${target.url}`);
  console.log(`  run: ${runDir}`);
  console.log(`  escalation: ${opts.escalate ? 'ON' : 'off'} | config: ${opts.configHash} | budget: ${opts.budget === null ? 'none' : `$${opts.budget.toFixed(2)}`} | delay ${opts.delay}ms`);
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

module.exports = { parseArgs, selectSites, loadFrozen, stubPipeline, replayOne, runReplay, evaluationSet, replayMeta };

if (require.main === module) {
  runReplay(process.argv.slice(2)).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
