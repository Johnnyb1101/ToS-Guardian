const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { AsyncLocalStorage } = require('node:async_hooks');
const { replayOne } = require('../tools/replay');
const { SECTIONS } = require('../tools/jury-lib');

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`  ok    ${label}`);
}

const hash = text => crypto.createHash('sha256').update(text).digest('hex');

function runTool(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function verdictRaw() {
  return JSON.stringify({
    sections: Object.fromEntries(SECTIONS.map(name => [name, { accuracy: 'correct', completeness: 'complete', notes: '' }])),
    bottomLine: { fair: true, notes: '' },
    riskLevel: { summary: 'High', jury: 'High', notes: '' },
    fabrications: [], omissions: []
  });
}

(async () => {
  console.log('Evaluation evidence capture');
  const stateStore = new AsyncLocalStorage();
  const analyzerPromptHash = hash('analyzer prompt returned by proxy');
  const criticPromptHash = hash('critic prompt returned by proxy');
  const criticLessonsHash = hash('fixed critic lessons');
  const analysisSource = '=== PRIVACY POLICY ===\nWe share data with affiliates.';
  const summary = '🧭 RISK LEVEL\nHigh';
  const fakeHost = {
    runState: stateStore,
    newRunState: () => ({ controller: new AbortController(), usage: [], logs: [], analyses: [], critics: [], evidence: [], events: [], lastResult: null }),
    run: (state, fn) => stateStore.run(state, fn),
    context: {
      runOrchestrator: async () => {
        const state = stateStore.getStore();
        state.analyses.push({ escalated: false, result: { status: 'ok', model: 'analyzer-model', providerTag: 'anthropic', promptHash: analyzerPromptHash, lessonsHash: hash('no analyzer lessons'), analysisSource, summary } });
        state.evidence.push({ operation: 'analyzer', provider: 'anthropic', model: 'analyzer-model', promptHash: analyzerPromptHash, lessonsHash: hash('no analyzer lessons') });
        state.evidence.push({ operation: 'critic', provider: 'anthropic', model: 'critic-model', promptHash: criticPromptHash, lessonsHash: criticLessonsHash });
        state.critics.push(Object.fromEntries(SECTIONS.map(name => [name, 'grounded'])));
      }
    }
  };
  const { artifact } = await replayOne(fakeHost, { domain: 'acorns.com', split: 'work', docType: 'financial', textHash: hash('frozen legal text') }, { pageUrl: 'https://acorns.com/legal' }, 1, { timeout: 1000 }, 'capture-run');
  check('replayOne persists analyzer response identity and fixed critic evidence', () => {
    assert.equal(artifact.analyzer.promptHash, analyzerPromptHash);
    assert.deepEqual(artifact.criticConfig, { provider: 'anthropic', model: 'critic-model', promptHash: criticPromptHash, lessonsHash: criticLessonsHash });
    assert.equal(artifact.analyzer.providerTag, 'anthropic');
    assert.equal(artifact.analysisSource, analysisSource);
    assert.equal(artifact.summary, summary);
  });

  const tempRun = fs.mkdtempSync(path.join(os.tmpdir(), 'tos-evaluation-capture-'));
  const artifactPath = path.join(tempRun, 'artifacts', 'acorns.com.1.json');
  fs.mkdirSync(path.dirname(artifactPath));
  fs.writeFileSync(path.join(tempRun, 'run.json'), JSON.stringify({ runId: 'capture-run' }));
  fs.writeFileSync(artifactPath, JSON.stringify(artifact));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: verdictRaw(), model: 'jury-model', promptHash: hash('jury prompt returned by proxy'), rubricHash: hash('jury rubric returned by proxy'), stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 } }));
  });
  try {
    const proxy = await listen(server);
    const grade = await runTool(path.resolve(__dirname, '..', 'tools', 'jury.js'), ['grade', tempRun, '--proxy', proxy, '--delay', '0']);
    check('jury CLI grades through the local fake proxy', () => {
      assert.equal(grade.code, 0, grade.stderr || grade.stdout);
      assert.match(grade.stdout, /Graded 1, failed 0/);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, '/v2/analyze');
      assert.equal(requests[0].body.operation, 'jury');
      assert.equal(requests[0].body.sourceText, analysisSource);
      assert.equal(requests[0].body.analysisSummary, summary);
    });
    const graded = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    check('jury CLI persists response identity and hashes of the exact request content', () => {
      assert.equal(graded.jury.anthropic.model, 'jury-model');
      assert.equal(graded.jury.anthropic.promptHash, hash('jury prompt returned by proxy'));
      assert.equal(graded.jury.anthropic.rubricHash, hash('jury rubric returned by proxy'));
      assert.equal(graded.jury.anthropic.sourceHash, hash(requests[0].body.sourceText));
      assert.equal(graded.jury.anthropic.summaryHash, hash(requests[0].body.analysisSummary));
      assert.equal(graded.jury.anthropic.score.score, 100);
    });
    fs.writeFileSync(path.join(tempRun, 'proof.json'), JSON.stringify({ runId: 'capture-run', diagnosticOnly: true, promotionEligible: false, proven: true }));
    const before = requests.length;
    const status = await runTool(path.resolve(__dirname, '..', 'tools', 'lessons.js'), ['status', 'lsn_0123456789abcdef', 'promoted', '--proxy', proxy, '--proof', tempRun]);
    check('diagnostic proof cannot emit a promotion request', () => {
      assert.notEqual(status.code, 0);
      assert.match(status.stderr, /Diagnostic and historical proofs cannot authorize/);
      assert.equal(requests.length, before);
    });
    const legacyProof = JSON.stringify({ runId: 'capture-run', proven: true, summary: 'Historical proof preserved' });
    fs.writeFileSync(path.join(tempRun, 'proof.json'), legacyProof);
    fs.mkdirSync(path.join(tempRun, 'step1a', 'evaluation'), { recursive: true });
    fs.writeFileSync(path.join(tempRun, 'step1a', 'evaluation', 'evaluation.json'), JSON.stringify({ diagnosticOnly: true, proven: false }));
    const stale = await runTool(path.resolve(__dirname, '..', 'tools', 'lessons.js'), ['status', 'lsn_0123456789abcdef', 'promoted', '--proxy', proxy, '--proof', tempRun]);
    check('a new diagnostic report cannot fall back to a preserved historical passing proof', () => {
      assert.notEqual(stale.code, 0);
      assert.match(stale.stderr, /Diagnostic and historical proofs cannot authorize/);
      assert.equal(requests.length, before);
    });
    const critic = await runTool(path.resolve(__dirname, '..', 'tools', 'prove-critic.js'), [tempRun, '--control', tempRun]);
    check('critic CLI preserves historical proof and labels its separate output diagnostic', () => {
      assert.equal(critic.code, 2, critic.stderr || critic.stdout);
      assert.equal(fs.readFileSync(path.join(tempRun, 'proof.json'), 'utf8'), legacyProof);
      const result = JSON.parse(fs.readFileSync(path.join(tempRun, 'step1a', 'critic-evaluation', 'evaluation.json'), 'utf8'));
      assert.equal(result.proven, false);
      assert.equal(result.evaluationPassed, false);
      assert.equal(result.diagnosticOnly, true);
      assert.equal(result.promotionEligible, false);
      assert.match(critic.stdout, /# Diagnostic critic comparison/);
      assert.doesNotMatch(critic.stdout, /Rule: proven when|Proven:/);
    });
  } finally {
    if (server.listening) await close(server);
    if (path.resolve(tempRun).startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(tempRun, { recursive: true, force: true });
  }
  console.log(`\nSummary: ${passed} passed, 0 failed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
