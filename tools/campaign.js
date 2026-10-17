const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./campaign-lib');
const refLib = require('./reference-lib');
const releases = require('./sites-lib');

function usage(code) {
  console.log('Usage:');
  console.log('  node tools/campaign.js go <spec.json>      run a campaign end to end (resumes a stopped one)');
  console.log('  node tools/campaign.js status <name>       print the state and report of a campaign');
  console.log('A spec names the proxy, control run, complete treatmentConfigHash, lessons to register, an optional screen, the diagnostic proof, and an optional notification url.');
  process.exit(code);
}

const argv = process.argv.slice(2);
const command = argv.shift();
if (!command || command === '--help' || command === '-h') usage(0);
if (!['go', 'status'].includes(command)) usage(1);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const TOOLS = __dirname;

function campaignDir(name) {
  return path.join(refLib.RUNS_DIR, name);
}

function saveState(state) {
  fs.mkdirSync(campaignDir(state.name), { recursive: true });
  fs.writeFileSync(path.join(campaignDir(state.name), 'campaign.json'), JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(campaignDir(state.name), 'report.md'), lib.renderReport(state), 'utf8');
}

function appendLog(state, text) {
  fs.appendFileSync(path.join(campaignDir(state.name), 'campaign.log'), text.endsWith('\n') ? text : text + '\n', 'utf8');
}

function runTool(state, label, args, { stream = false } = {}) {
  appendLog(state, `\n=== ${label}: node ${args.join(' ')} (${new Date().toISOString()})`);
  let result;
  if (stream) {
    // long steps write straight into the campaign log so progress is visible while they run
    const fd = fs.openSync(path.join(campaignDir(state.name), 'campaign.log'), 'a');
    try {
      result = spawnSync(process.execPath, args.map(String), { cwd: path.join(TOOLS, '..'), stdio: ['ignore', fd, fd] });
    } finally {
      fs.closeSync(fd);
    }
  } else {
    result = spawnSync(process.execPath, args.map(String), { cwd: path.join(TOOLS, '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.stdout) appendLog(state, result.stdout);
    if (result.stderr) appendLog(state, result.stderr);
  }
  appendLog(state, `=== ${label}: exit ${result.status}`);
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

async function json(baseUrl, method, route, body, attempts = 4) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`${baseUrl}${route}`, { method, headers: releases.trainerHeaders({ 'Content-Type': 'application/json' }), body: body ? JSON.stringify(body) : undefined });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      return { status: response.status, data };
    } catch (e) {
      if (attempt >= attempts) throw e;
      await sleep(3000 * attempt);
    }
  }
}

function loadArtifacts(runDir) {
  const dir = path.join(runDir, 'artifacts');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

function runCost(runDir) {
  const file = path.join(runDir, 'report.anthropic.json');
  if (!fs.existsSync(file)) return 0;
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  return report.cost && typeof report.cost.total === 'number' ? report.cost.total : 0;
}

function artifactsCost(runDir) {
  return loadArtifacts(runDir).reduce((n, a) => n + (typeof a.cost === 'number' ? a.cost : 0), 0);
}

async function assertNotHalted(spec) {
  const { status, data } = await json(spec.proxy, 'GET', '/learning/status');
  if (status !== 200) throw new Error(`proxy status ${status}: ${JSON.stringify(data).slice(0, 200)}`);
  if (data.halted) throw new Error(`learning is halted (${data.reasons.join(', ')})`);
  return data;
}

const steps = {
  async health(state) {
    const spec = state.spec;
    const data = await assertNotHalted(spec);
    if (!fs.existsSync(path.join(refLib.RUNS_DIR, spec.control, 'artifacts'))) throw new Error(`control run ${spec.control} has no artifacts`);
    const controlMetaPath = path.join(refLib.RUNS_DIR, spec.control, 'run.json');
    const controlMeta = fs.existsSync(controlMetaPath) ? JSON.parse(fs.readFileSync(controlMetaPath, 'utf8')) : null;
    if (!controlMeta || !releases.checkRelease(controlMeta.release, controlMeta.configHash).valid) throw new Error('control run lacks a complete pinned release');
    if (spec.controlConfigHash && spec.controlConfigHash !== controlMeta.configHash) throw new Error('controlConfigHash differs from the control run');
    const treatmentRelease = await releases.fetchRelease(spec.proxy, spec.treatmentConfigHash);
    if (releases.sha256(controlMeta.release.config.policy) !== releases.sha256(treatmentRelease.config.policy)) throw new Error('control and treatment semantic policy versions differ');
    if (spec.proof.kind === 'critic' && !fs.existsSync(path.join(refLib.RUNS_DIR, spec.proof.source, 'artifacts'))) throw new Error(`critic source run ${spec.proof.source} has no artifacts`);
    const lessonsRoute = await json(spec.proxy, 'GET', '/lessons');
    if (lessonsRoute.status !== 200) throw new Error('the proxy does not expose the lessons routes (TRAINER_OPERATIONS=1 needed)');
    return { status: 'done', note: `ledger ${data.ledger.length} entries, signing ${data.signing && data.signing.enabled ? 'on' : 'off'}, lessons ${JSON.stringify(data.lessons)}` };
  },

  async register(state) {
    const spec = state.spec;
    const registered = [];
    let writes = 0;
    const paced = async () => { writes++; if (writes % 10 === 0) { appendLog(state, 'pausing 65s for the proxy write limiter'); await sleep(65000); } };
    for (const [group, underTest] of [[spec.lessons.carry, false], [spec.lessons.create, true]]) {
      if (!group) continue;
      for (const candidateId of group.ids) {
        const out = runTool(state, `create ${candidateId}`, [path.join(TOOLS, 'lessons.js'), 'create', path.join(refLib.RUNS_DIR, group.run), '--proxy', spec.proxy, '--ids', candidateId]);
        const match = out.stdout.match(/->\s+(\w+)\s+(lsn_[0-9a-f]{16})/);
        registered.push({ candidateId, id: match ? match[2] : null, status: match ? match[1] : `failed (${out.stdout.trim().split('\n').pop() || out.stderr.trim()})`, underTest });
        if (!match) throw new Error(`could not register ${candidateId}`);
        await paced();
      }
    }
    for (const r of spec.lessons.revise) {
      const args = [path.join(TOOLS, 'lessons.js'), 'revise', path.join(refLib.RUNS_DIR, r.run), r.candidateId, '--proxy', spec.proxy, '--text', r.text];
      if (r.id) args.push('--id', r.id);
      if (r.after) args.push('--after', r.after);
      const out = runTool(state, `revise ${r.candidateId}`, args);
      const match = out.stdout.match(/->\s+(\w+)\s+(lsn_[0-9a-f]{16})/);
      registered.push({ candidateId: r.id || `${r.candidateId}r`, id: match ? match[2] : null, status: match ? match[1] : `failed (${out.stdout.trim().split('\n').pop() || out.stderr.trim()})`, underTest: true });
      if (!match) throw new Error(`could not register the revision of ${r.candidateId}`);
      await paced();
    }
    const { status, data } = await json(spec.proxy, 'GET', '/lessons');
    if (status !== 200) throw new Error('could not list lessons after registration');
    for (const r of registered) if (data.lessons.find(l => l.id === r.id && l.status === 'retired')) throw new Error(`lesson ${r.id} (${r.candidateId}) is retired on this proxy`);
    const release = await releases.fetchRelease(spec.proxy, spec.treatmentConfigHash);
    const included = new Set(release.config.lessons.map(lesson => lesson.id));
    for (const r of registered) if (r.underTest && !included.has(r.id)) throw new Error(`registered candidate ${r.candidateId} is absent from the complete treatment release`);
    state.lessons.registered = registered;
    state.lessons.pinned = [...included].sort();
    return { status: 'done', note: `${registered.length} registered, ${state.lessons.pinned.length} in the complete release` };
  },

  async 'screen-replay'(state) {
    const spec = state.spec;
    await assertNotHalted(spec);
    const ids = lib.runIds(spec);
    const out = runTool(state, 'screen replay', [path.join(TOOLS, 'reference.js'), 'replay', '--proxy', spec.proxy, '--sites', spec.screen.sites.join(','), '--samples', spec.screen.samples, '--run', ids.screen, '--config-hash', spec.treatmentConfigHash, '--budget', lib.budgetSplit(spec.screen.budget).replay, '--delay', spec.delayMs], { stream: true });
    if (out.code !== 0) throw new Error(`screen replay exited ${out.code}`);
    return { status: 'done' };
  },

  async 'screen-jury'(state) {
    const spec = state.spec;
    const ids = lib.runIds(spec);
    const out = runTool(state, 'screen jury', [path.join(TOOLS, 'jury.js'), 'grade', path.join(refLib.RUNS_DIR, ids.screen), '--proxy', spec.proxy, '--budget', lib.budgetSplit(spec.screen.budget).jury], { stream: true });
    if (out.code !== 0) throw new Error(`screen jury exited ${out.code}`);
    state.cost.screen = runCost(path.join(refLib.RUNS_DIR, ids.screen));
    return { status: 'done', note: `$${state.cost.screen.toFixed(2)}` };
  },

  async 'screen-decide'(state) {
    const spec = state.spec;
    const ids = lib.runIds(spec);
    const decision = lib.screenDecision({
      controlArtifacts: loadArtifacts(path.join(refLib.RUNS_DIR, spec.control)),
      treatmentArtifacts: loadArtifacts(path.join(refLib.RUNS_DIR, ids.screen)),
      sites: spec.screen.sites, maxFabricationRise: spec.screen.maxFabricationRise, maxScoreDrop: spec.screen.maxScoreDrop
    });
    state.screen = decision;
    if (!decision.proceed) {
      state.decision = 'stopped-at-screen';
      for (const step of ['proof-replay', 'proof-jury', 'prove']) lib.markStep(state, step, { status: 'skipped', note: 'stopped at the screen' });
    }
    return { status: 'done', note: decision.proceed ? 'passed' : `stopped: ${decision.reasons.join('; ')}` };
  },

  async 'proof-replay'(state) {
    const spec = state.spec;
    await assertNotHalted(spec);
    const ids = lib.runIds(spec);
    const out = runTool(state, 'proof replay', [path.join(TOOLS, 'reference.js'), 'replay', '--proxy', spec.proxy, '--split', 'all', '--samples', spec.proof.samples, '--run', ids.proof, '--config-hash', spec.treatmentConfigHash, '--budget', lib.budgetSplit(spec.proof.budget).replay, '--delay', spec.delayMs], { stream: true });
    if (out.code !== 0) throw new Error(`proof replay exited ${out.code}`);
    return { status: 'done' };
  },

  async 'proof-jury'(state) {
    const spec = state.spec;
    const ids = lib.runIds(spec);
    const out = runTool(state, 'proof jury', [path.join(TOOLS, 'jury.js'), 'grade', path.join(refLib.RUNS_DIR, ids.proof), '--proxy', spec.proxy, '--budget', lib.budgetSplit(spec.proof.budget).jury], { stream: true });
    if (out.code !== 0) throw new Error(`proof jury exited ${out.code}`);
    state.cost.proof = runCost(path.join(refLib.RUNS_DIR, ids.proof));
    return { status: 'done', note: `$${state.cost.proof.toFixed(2)}` };
  },

  async prove(state) {
    const spec = state.spec;
    const ids = lib.runIds(spec);
    const runDir = path.join(refLib.RUNS_DIR, ids.proof);
    const out = runTool(state, 'prove', [path.join(TOOLS, 'prove.js'), runDir, '--control', path.join(refLib.RUNS_DIR, spec.control)]);
    if (out.code !== 0 && out.code !== 2) throw new Error(`prove exited ${out.code}`);
    const proof = JSON.parse(fs.readFileSync(path.join(runDir, 'step1a', 'evaluation', 'evaluation.json'), 'utf8'));
    state.proof = { kind: 'jury', proven: false, diagnosticOnly: true, promotionEligible: false, evaluationPassed: proof.evaluationPassed === true, summary: proof.summary, configHash: proof.configHash, controlConfigHash: proof.controlConfigHash, evaluationProtocolHash: proof.evaluationProtocolHash, evidenceHash: proof.evidenceHash, lessonsHash: proof.lessonsHash, runDir: path.relative(path.join(TOOLS, '..'), runDir).replace(/\\/g, '/'), reportFile: 'step1a/evaluation/evaluation.md' };
    state.decision = proof.evaluationPassed ? 'evaluation-passed' : 'evaluation-failed';
    return { status: 'done', note: state.decision };
  },

  async 'critic-replay'(state) {
    const spec = state.spec;
    await assertNotHalted(spec);
    const ids = lib.runIds(spec);
    const out = runTool(state, 'critic replay', [path.join(TOOLS, 'critic-replay.js'), path.join(refLib.RUNS_DIR, spec.proof.source), '--proxy', spec.proxy, '--run', ids.critic, '--config-hash', spec.treatmentConfigHash, '--budget', spec.proof.budget], { stream: true });
    if (out.code !== 0) throw new Error(`critic replay exited ${out.code}`);
    state.cost.proof = artifactsCost(path.join(refLib.RUNS_DIR, ids.critic));
    return { status: 'done', note: `$${state.cost.proof.toFixed(2)}` };
  },

  async 'prove-critic'(state) {
    const spec = state.spec;
    const ids = lib.runIds(spec);
    const runDir = path.join(refLib.RUNS_DIR, ids.critic);
    const out = runTool(state, 'prove critic', [path.join(TOOLS, 'prove-critic.js'), runDir, '--control', path.join(refLib.RUNS_DIR, spec.control)]);
    if (out.code !== 0 && out.code !== 2) throw new Error(`prove-critic exited ${out.code}`);
    const proof = JSON.parse(fs.readFileSync(path.join(runDir, 'step1a', 'critic-evaluation', 'evaluation.json'), 'utf8'));
    state.proof = { kind: 'critic', proven: false, diagnosticOnly: true, promotionEligible: false, evaluationPassed: proof.evaluationPassed === true, summary: proof.summary, lessonsHash: proof.lessonsHash, runDir: path.relative(path.join(TOOLS, '..'), runDir).replace(/\\/g, '/'), reportFile: 'step1a/critic-evaluation/evaluation.md' };
    state.decision = proof.evaluationPassed ? 'evaluation-passed' : 'evaluation-failed';
    return { status: 'done', note: state.decision };
  },

  async report(state) {
    state.finishedAt = new Date().toISOString();
    return { status: 'done', note: path.join(campaignDir(state.name), 'report.md') };
  },

  async notify(state) {
    const url = (state.spec.notify && state.spec.notify.url) || process.env.CAMPAIGN_NOTIFY_URL || '';
    if (!url) return { status: 'done', note: 'no notification url' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain', Title: `ToS Guardian campaign ${state.name}` }, body: lib.notificationText(state), signal: controller.signal });
      return { status: 'done', note: `http ${response.status}` };
    } catch (e) {
      return { status: 'done', note: `notification failed: ${e.message}` };
    } finally {
      clearTimeout(timer);
    }
  }
};

async function go() {
  const specFile = argv[0];
  if (!specFile) usage(1);
  const parsed = lib.validateSpec(JSON.parse(fs.readFileSync(path.resolve(specFile), 'utf8')));
  if (!parsed.valid) { console.error(`Invalid campaign spec:\n- ${parsed.errors.join('\n- ')}`); process.exit(1); }
  const spec = parsed.spec;
  const stateFile = path.join(campaignDir(spec.name), 'campaign.json');
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : lib.initialState(spec);
  state.spec = spec;
  state.failure = null;
  const plan = lib.planSteps(spec);
  console.log(`TOS Guardian campaign ${spec.name} — ${plan.length} steps, proxy ${spec.proxy}, control ${spec.control}, proof ${spec.proof.kind}`);
  console.log(`  state: ${stateFile}`);
  saveState(state);
  for (;;) {
    const step = lib.nextStep(state, plan);
    if (!step) break;
    process.stdout.write(`[${plan.indexOf(step) + 1}/${plan.length}] ${step} ... `);
    try {
      const result = await steps[step](state);
      lib.markStep(state, step, result);
      console.log(`${result.status}${result.note ? ` — ${result.note}` : ''}`);
    } catch (e) {
      lib.markStep(state, step, { status: 'failed', note: e.message });
      state.failure = `${step}: ${e.message}`;
      console.log(`failed — ${e.message}`);
      saveState(state);
      if (step !== 'notify') await steps.notify(state).catch(() => null);
      console.log(`Stopped. Fix the cause and run the same command again to resume. Log: ${path.join(campaignDir(state.name), 'campaign.log')}`);
      process.exit(1);
    }
    saveState(state);
  }
  console.log('');
  console.log(lib.renderReport(state));
  process.exit(state.decision === 'evaluation-passed' ? 0 : 2);
}

async function status() {
  const name = argv[0];
  if (!name) usage(1);
  const stateFile = path.join(campaignDir(name), 'campaign.json');
  if (!fs.existsSync(stateFile)) { console.error(`No campaign named ${name}.`); process.exit(1); }
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  console.log(lib.renderReport(state));
}

({ go, status })[command]().catch(err => { console.error(err); process.exit(1); });
