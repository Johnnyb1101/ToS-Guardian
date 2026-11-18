'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require('../tools/final-corpus-lib');
const E = require('../tools/final-evaluation-lib');
const R = require('../tools/final-review-lib');
const { makeFixture, makeGrade, reseal } = require('./final-test-fixtures');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok ${name}`); }
const report = input => E.evaluatePreparation(input);

test('complete perfect mock evidence remains diagnostic with all decisions unapproved', () => {
  const result = report(makeFixture());
  assert.deepEqual(result.reasons, []);
  assert.equal(result.evidenceValid, true);
  assert.equal(result.evaluationPassed, false); assert.equal(result.promotionEligible, false); assert.equal(result.diagnosticOnly, true);
  for (const key of E.UNAPPROVED_FIELDS) assert.ok(result.blockers.some(reason => reason.includes(key)));
  assert.equal(result.metrics.arms.control.accuracy, 1);
});
test('null approval fields cannot be silently replaced or status approved', () => {
  for (const key of E.UNAPPROVED_FIELDS) {
    const protocol = E.createDraftProtocol(); protocol[key] = 1;
    assert.equal(E.validateProtocol(reseal(protocol)).valid, false);
  }
  const p = E.createDraftProtocol(); p.status = 'APPROVED';
  assert.equal(E.validateProtocol(reseal(p)).valid, false);
});
test('missing and duplicate artifacts/grades are explicit failures', () => {
  for (const mutate of [f => f.artifacts.pop(), f => f.artifacts.push(f.artifacts[0]), f => f.grades.pop(), f => f.grades.push(f.grades[0])]) {
    const f = makeFixture(); mutate(f);
    assert.equal(report(f).evidenceValid, false);
    assert.match(report(f).reasons.join(';'), /missing|duplicate|append-only/);
  }
});
test('changed evidence and stale protocol cannot pass even after resealing artifact', () => {
  for (const mutate of [a => { a.summary += ' fabricated'; }, a => { a.analysisSource += ' altered'; }, a => { a.critic = { changed: true }; }, a => { a.protocolHash = C.hashText('stale'); }, a => { a.configHash = C.hashText('wrong'); }, a => { a.analyzerLessonsHash = C.hashText('wrong lessons'); }]) {
    const f = makeFixture(); mutate(f.artifacts[0]); f.artifacts[0] = reseal(f.artifacts[0]);
    assert.equal(report(f).evidenceValid, false);
  }
});
test('independent grade binds exact content and planned reviewer', () => {
  for (const mutate of [g => { g.summaryHash = C.hashText('wrong'); }, g => { g.reviewer.model = 'different'; }, g => { g.accuracy = 2; }, g => { g.fabrications = -1; }]) {
    const f = makeFixture(); mutate(f.grades[0]); f.grades[0] = reseal(f.grades[0]);
    assert.equal(report(f).evidenceValid, false);
  }
});
test('nonmock artifact is rejected; no real-provider final eligibility path', () => {
  const f = makeFixture(); f.artifacts[0].mock = false; f.artifacts[0] = reseal(f.artifacts[0]);
  assert.match(report(f).reasons.join(';'), /mock artifacts only/);
});
test('runtime identity and independent provider cannot be inferred or substituted', () => {
  for (const mutate of [a => { delete a.analyzer; }, a => { a.analyzer.provider = 'openai'; }, a => { a.analyzer.model = 'wrong'; }, a => { a.analyzer.promptHash = C.hashText('different prompt'); }, a => { a.criticConfig.model = 'wrong'; }, a => { a.docType = 'health'; }]) {
    const f = makeFixture(); mutate(f.artifacts[0]); f.artifacts[0] = reseal(f.artifacts[0]);
    assert.equal(report(f).evidenceValid, false);
  }
  const f = makeFixture(); f.protocol.judge.provider = 'anthropic'; f.protocol = reseal(f.protocol);
  f.artifacts = f.artifacts.map(a => reseal({ ...a, protocolHash: f.protocol.hash })); f.grades = f.artifacts.map(a => makeGrade(a, f.protocol));
  assert.match(report(f).reasons.join(';'), /different provider/);
});
test('final artifacts are rejected by work-learning selector and Step 1 validator', () => {
  const f = makeFixture();
  const { selectWorkArtifacts } = require('../tools/reflect-lib');
  assert.throws(() => selectWorkArtifacts(f.artifacts, { sites: {} }, 'anthropic'), /domain and sample/);
  const withDomain = { ...f.artifacts[0], domain: f.corpus.sites[0].domain };
  assert.throws(() => selectWorkArtifacts([withDomain], { sites: {} }, 'anthropic'), /unknown artifact split/);
  const { validateEvidence } = require('../tools/evaluation-lib');
  const old = validateEvidence({ controlArtifacts: [withDomain], treatmentArtifacts: [], controlMeta: { release: f.controlRelease, configHash: f.controlRelease.configHash }, treatmentMeta: { release: f.treatmentRelease, configHash: f.treatmentRelease.configHash }, juror: 'anthropic' });
  assert.ok(old.reasons.length > 0); assert.equal(old.valid.control.length, 0); assert.equal(old.valid.treatment.length, 0);
  f.artifacts[0].split = 'work'; f.artifacts[0] = reseal(f.artifacts[0]);
  assert.match(report(f).reasons.join(';'), /final-only/);
});
test('unknown usage and latency remain null instead of free or instantaneous', () => {
  const f = makeFixture(); const r = report(f);
  assert.equal(r.metrics.arms.control.costUsd, null); assert.equal(r.metrics.arms.control.latencyMs, null);
  assert.equal(r.metrics.arms.control.unknownUsageAttempts, 1);
  assert.equal(r.metrics.arms.control.independentJudgeUsage.costUsd, null); assert.equal(r.metrics.arms.control.independentJudgeUsage.unknownUsageAttempts, 1);
  f.artifacts[0].usage = { inputTokens: 3, outputTokens: 5, costUsd: 0.25 }; f.artifacts[0].latencyMs = 23; f.artifacts[0] = reseal(f.artifacts[0]);
  f.grades[0] = makeGrade(f.artifacts[0], f.protocol);
  assert.equal(report(f).metrics.arms.control.costUsd, 0.25); assert.equal(report(f).metrics.arms.control.latencyMs, 23);
  f.grades[0] = makeGrade(f.artifacts[0], f.protocol, { usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.05 }, latencyMs: 30 });
  assert.equal(report(f).metrics.arms.control.independentJudgeUsage.costUsd, 0.05); assert.equal(report(f).metrics.arms.control.independentJudgeUsage.latencyMs, 30);
});
test('all retries retained for costs/failures while latest slot supplies quality score', () => {
  const f = makeFixture(); const first = f.artifacts[0];
  const retry = reseal({ ...first, artifactId: 'retry-control', attempt: 2, previousAttemptHash: first.hash, usage: { inputTokens: 3, outputTokens: 1, costUsd: 0.1 }, latencyMs: 4 });
  f.artifacts.push(retry); f.grades.push(makeGrade(retry, f.protocol, { accuracy: 0.5 }));
  const r = report(f);
  assert.deepEqual(r.reasons, []); assert.equal(r.metrics.arms.control.attempts, 2); assert.equal(r.metrics.arms.control.graded, 1); assert.equal(r.metrics.arms.control.accuracy, 0.5);
  assert.equal(r.completeness.human.pending, 2, 'superseded success is not another review slot');
  assert.equal(r.metrics.arms.control.costUsd, null); assert.equal(r.metrics.arms.control.knownCostUsd, 0.1);
  f.artifacts[2].previousAttemptHash = null; f.artifacts[2] = reseal(f.artifacts[2]);
  assert.match(report(f).reasons.join(';'), /append-only/);
});
test('failed attempts remain explicit and cannot be replaced by earlier success', () => {
  const f = makeFixture(), first = f.artifacts[0];
  f.artifacts.push(reseal({ ...first, artifactId: 'failed-retry', status: 'failed', error: 'mock timeout', attempt: 2, previousAttemptHash: first.hash }));
  const r = report(f);
  assert.equal(r.metrics.arms.control.failures, 1); assert.equal(r.metrics.arms.control.accuracy, null); assert.equal(r.completeness.successfulSlots, 1); assert.equal(r.completeness.latestFailedSlots, 1);
  assert.equal(r.completeness.human.pending, 1, 'latest failure cannot expose an earlier successful output for review');
});
test('source-grounded human reviews preserve uncertainty and append-only revisions', () => {
  const f = makeFixture(); const bundle = R.buildReviewPackage({ artifacts: f.artifacts, seed: C.hashText('test seed') });
  const item = bundle.publicPackage.items[0], reviewDir = fs.mkdtempSync(path.join(os.tmpdir(), 'final-human-'));
  const submission = { itemId: item.itemId, finding: 'claim', verdict: 'unsure', subject: item.summary, sourceEvidence: 'We collect email addresses.', note: 'Need a second look.' };
  try {
    R.appendAttempt(reviewDir, submission, bundle.publicPackage, bundle.privateBindings, f.artifacts);
    f.humanReviews = R.readAttempts(reviewDir, bundle.publicPackage, bundle.privateBindings, f.artifacts);
    const r = report(f); assert.deepEqual(r.reasons, []); assert.equal(r.completeness.human.unsure, 1); assert.equal(r.completeness.human.pending, 1);
    const original = f.humanReviews[0];
    f.humanReviews[0] = reseal({ ...original, promotionEligible: true });
    assert.match(report(f).reasons.join(';'), /promotionEligible must be false/);
    f.humanReviews[0] = original;
    const priorArtifact = f.artifacts.find(a => a.hash === original.artifactHash);
    f.artifacts.push(reseal({ ...priorArtifact, artifactId: 'reviewed-then-failed', attempt: 2, previousAttemptHash: priorArtifact.hash, status: 'failed', error: 'mock late failure' }));
    assert.match(report(f).reasons.join(';'), /missing current successful artifact head/);
    f.artifacts.pop();
    R.appendAttempt(reviewDir, { ...submission, verdict: 'supported', note: '' }, bundle.publicPackage, bundle.privateBindings, f.artifacts);
    f.humanReviews = R.readAttempts(reviewDir, bundle.publicPackage, bundle.privateBindings, f.artifacts);
    assert.equal(report(f).completeness.human.accepted, 2); assert.equal(report(f).completeness.human.unsure, 0); assert.equal(report(f).completeness.human.judgments.claim.supported, 1);
    f.humanReviews[0].sourceHash = C.hashText('unrelated source'); f.humanReviews[0] = reseal(f.humanReviews[0]);
    assert.equal(report(f).evidenceValid, false);
  } finally { fs.rmSync(reviewDir, { recursive: true, force: true }); }
});
test('missing inputs produce a sealed diagnostic report, not a crash or false pass', () => {
  const r = report({ protocol: E.createDraftProtocol(), corpus: null, history: null });
  assert.equal(r.evidenceValid, false); assert.equal(r.evaluationPassed, false); assert.equal(r.hash, C.bodyHash(r));
});
console.log(`${passed} final evaluation tests passed`);
