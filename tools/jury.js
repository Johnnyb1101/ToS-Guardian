const fs = require('fs');
const path = require('path');
const { resolveProxyTarget, usageRecordFromProxyResponse, estimateCost, budgetExceeded } = require('./batch-lib');
const J = require('./jury-lib');

const args = process.argv.slice(2);
const command = args.shift();

function usage(code) {
  console.log('Usage:');
  console.log('  node tools/jury.js grade <runDir> --proxy <url> [--juror anthropic|openai] [--budget usd] [--delay ms] [--limit n] [--force]');
  console.log('  node tools/jury.js report <runDir> [--juror anthropic|openai]');
  process.exit(code);
}

if (!command || command === '--help' || command === '-h') usage(0);
if (command !== 'grade' && command !== 'report') usage(1);

const opts = { proxy: null, juror: 'anthropic', budget: null, delay: 6000, limit: Infinity, force: false };
let runDir = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--proxy') opts.proxy = args[++i];
  else if (a === '--juror') opts.juror = args[++i];
  else if (a === '--budget') opts.budget = Number(args[++i]);
  else if (a === '--delay') opts.delay = Number(args[++i]);
  else if (a === '--limit') opts.limit = Number(args[++i]);
  else if (a === '--force') opts.force = true;
  else if (a.startsWith('--')) { console.error(`Unknown option: ${a}`); process.exit(1); }
  else runDir = a;
}
if (!runDir) usage(1);
if (opts.juror !== 'anthropic' && opts.juror !== 'openai') { console.error('--juror must be anthropic or openai'); process.exit(1); }
if (opts.budget !== null && !(Number.isFinite(opts.budget) && opts.budget > 0)) { console.error('--budget must be a positive dollar amount.'); process.exit(1); }

runDir = path.resolve(runDir);
const artifactsDir = path.join(runDir, 'artifacts');
if (!fs.existsSync(artifactsDir)) { console.error(`No artifacts directory at ${artifactsDir}`); process.exit(1); }

function loadRunMeta() {
  const metaPath = path.join(runDir, 'run.json');
  return fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
}

function loadArtifacts() {
  return fs.readdirSync(artifactsDir).filter(f => f.endsWith('.json')).sort().map(f => {
    const file = path.join(artifactsDir, f);
    return { file, artifact: JSON.parse(fs.readFileSync(file, 'utf8')) };
  });
}

function writeReport(meta) {
  const artifacts = loadArtifacts().map(a => a.artifact);
  const summary = J.summarizeRun(artifacts, { juror: opts.juror });
  const markdown = J.renderReport(summary, { runId: meta.runId || path.basename(runDir), proxy: meta.proxy, startedAt: meta.startedAt });
  fs.writeFileSync(path.join(runDir, `report.${opts.juror}.md`), markdown, 'utf8');
  fs.writeFileSync(path.join(runDir, `report.${opts.juror}.json`), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  return { summary, markdown };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function askJury(proxyUrl, artifact) {
  const response = await fetch(`${proxyUrl}/v2/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation: 'jury', provider: opts.juror, analysisSummary: artifact.summary, sourceText: artifact.analysisSource })
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, data };
}

async function grade() {
  const target = resolveProxyTarget({ proxy: opts.proxy, env: process.env });
  if (target.error) { console.error(target.error); process.exit(1); }
  const meta = loadRunMeta();
  const entries = loadArtifacts();
  const pending = entries.filter(({ artifact }) => {
    if (!artifact.summary || !artifact.analysisSource || !artifact.analyzer || artifact.analyzer.status !== 'ok') return false;
    return opts.force || !(artifact.jury && artifact.jury[opts.juror] && !artifact.jury[opts.juror].error);
  }).slice(0, opts.limit);

  console.log(`TOS Guardian jury — ${pending.length} artifact(s) to grade in ${runDir}, juror ${opts.juror}, proxy ${target.url}`);
  console.log('');
  let totalCost = 0;
  let graded = 0;
  let failures = 0;
  for (let i = 0; i < pending.length; i++) {
    const { file, artifact } = pending[i];
    if (budgetExceeded(totalCost, opts.budget)) {
      console.log(`Budget of $${opts.budget.toFixed(2)} reached after ${i} artifact(s) ($${totalCost.toFixed(4)}); stopping.`);
      break;
    }
    process.stdout.write(`[${i + 1}/${pending.length}] ${artifact.domain}#${artifact.sample} ... `);
    let outcome;
    try {
      outcome = await askJury(target.url, artifact);
      if (outcome.status === 429 && outcome.data.error !== 'daily_limit_reached') {
        process.stdout.write('rate limited, waiting 65s ... ');
        await sleep(65000);
        outcome = await askJury(target.url, artifact);
      }
    } catch (e) {
      outcome = { status: 0, ok: false, data: { error: 'network', reason: e.message } };
    }
    if (outcome.status === 429 && outcome.data.error === 'daily_limit_reached') {
      console.log('stopped: the proxy\'s daily unit limit is reached (raise LLM_DAILY_UNIT_LIMIT on the dev proxy and rerun)');
      break;
    }
    const result = { juror: opts.juror, gradedAt: new Date().toISOString() };
    if (!outcome.ok) {
      result.error = `relay ${outcome.status}: ${outcome.data.error || 'unknown'}${outcome.data.reason ? ` (${outcome.data.reason})` : ''}`;
      failures++;
      console.log(result.error);
    } else {
      const parsed = J.parseJuryJson(outcome.data.text);
      const verdict = J.normalizeVerdict(parsed);
      result.model = typeof outcome.data.model === 'string' ? outcome.data.model : '';
      result.stopReason = typeof outcome.data.stopReason === 'string' ? outcome.data.stopReason : '';
      result.usageRecord = usageRecordFromProxyResponse(outcome.data);
      result.raw = outcome.data.text;
      result.verdict = verdict;
      const cost = result.usageRecord ? estimateCost([result.usageRecord]).cost : 0;
      totalCost += cost;
      if (!parsed) {
        result.error = 'jury returned no JSON';
        failures++;
        console.log(`${result.error}  $${cost.toFixed(4)}`);
      } else if (!verdict.valid) {
        failures++;
        console.log(`verdict invalid: ${verdict.errors.slice(0, 2).join('; ')}  $${cost.toFixed(4)}`);
      } else {
        result.score = J.scoreVerdict(verdict);
        graded++;
        console.log(`${result.score.score}/100  fabrications ${verdict.fabrications.length}, risk ${verdict.riskLevel.jury}  $${cost.toFixed(4)}`);
      }
    }
    artifact.jury = artifact.jury || {};
    artifact.jury[opts.juror] = result;
    fs.writeFileSync(file, JSON.stringify(artifact, null, 2) + '\n', 'utf8');
    if (i < pending.length - 1 && opts.delay > 0) await sleep(opts.delay);
  }
  console.log('');
  console.log(`Graded ${graded}, failed ${failures}, jury cost $${totalCost.toFixed(4)}.`);
  const { markdown } = writeReport(meta);
  console.log('');
  console.log(markdown);
  console.log(`Report written to ${path.join(runDir, `report.${opts.juror}.md`)}`);
}

if (command === 'report') {
  const { markdown } = writeReport(loadRunMeta());
  console.log(markdown);
  process.exit(0);
}

grade().catch(err => {
  console.error(err);
  process.exit(1);
});
