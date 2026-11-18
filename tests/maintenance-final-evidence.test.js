'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const C = require('../tools/final-corpus-lib');
const F = require('../tools/maintenance-final-evidence');
const M = require('../tools/maintenance-evaluation-lib');
const { releaseConfigHash } = require('../tools/sites-lib');
const { reseal } = require('./final-test-fixtures');
const { makeFinalFixture } = require('./maintenance-final-fixtures');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok ${name}`); }
const report = fixture => F.validateFinalEvidence(fixture.protocol, fixture.evidence, fixture.context);
function rejected(fixture, expression) {
  const checked = report(fixture);
  assert.equal(checked.contractSatisfied, false, JSON.stringify(checked));
  assert.equal(checked.evaluationPassed, false);
  assert.equal(checked.promotionEligible, false);
  if (expression) assert.match(checked.reasons.join('; '), expression);
}
function changeRecord(fixture, list, index, updates) {
  fixture.evidence[list][index] = fixture.resign(fixture.evidence[list][index], updates);
  fixture.evidence = reseal(fixture.evidence);
}

test('complete offline fixture satisfies only the structural contract and returns an immutable diagnostic report', () => {
  const fixture = makeFinalFixture(), checked = report(fixture);
  assert.equal(F.validateFinalProtocol(fixture.protocol).valid, true);
  assert.equal(checked.contractSatisfied, true, checked.reasons.join('; '));
  assert.equal(checked.verifiedRuns, 8); assert.equal(checked.verifiedGrades, 16);
  assert.equal(checked.diagnosticOnly, true); assert.equal(checked.evaluationPassed, false); assert.equal(checked.promotionEligible, false);
  assert.throws(() => F.authorizationEvidence(checked), /observed maintenance-final/);
  assert.throws(() => { checked.promotionEligible = true; }, TypeError);
  assert.throws(() => checked.reasons.push('changed'), TypeError);
  assert.equal(report(fixture).hash, checked.hash);
});

test('hypothetical observed contract is tested using ephemeral keys and fixture bytes only', () => {
  const fixture = makeFinalFixture({ mode: 'observed' }), checked = report(fixture);
  assert.equal(checked.contractSatisfied, true, checked.reasons.join('; '));
  assert.equal(checked.evaluationPassed, true);
  assert.deepEqual(F.authorizationEvidence(checked), { phase: 'maintenance-final', configHash: fixture.builds.candidate.release.configHash,
    evidenceHash: checked.hash, protocolHash: fixture.protocol.hash, corpusHash: C.digest(fixture.protocol.corpus),
    diagnosticOnly: false, evaluationPassed: true, promotionEligible: true });
  assert.equal(checked.baselineArtifactHash, fixture.builds.baseline.artifact.sha256);
  assert.equal(checked.candidateArtifactHash, fixture.builds.candidate.artifact.sha256);
});

test('predeclaration cannot reduce tests, reviews, corpus, repetitions, coverage or model bindings', () => {
  for (const mutate of [
    p => p.requiredTests.pop(), p => p.requiredReviews.pop(), p => { p.sampleCount = 1; }, p => { p.repetitions = 0; },
    p => p.requiredCoverage.push('uncovered'), p => { p.corpus.samples[1].id = p.corpus.samples[0].id; },
    p => { p.corpus.samples[1].source = p.corpus.samples[0].source; }, p => { p.corpus.learningAllowed = true; },
    p => { p.stageModels.analyzer.model = 'unapproved-upgrade'; }, p => { p.judge.prompt.bytes = 0; },
    p => { p.criteria.maxFabrications = 1; }, p => { p.criteria.minAccuracy = 0; }, p => { p.unexpected = true; },
    p => { p.preparation.candidate.artifact = p.preparation.baseline.artifact; p.preparation = reseal(p.preparation); }
  ]) {
    const fixture = makeFinalFixture(); mutate(fixture.protocol); fixture.protocol = reseal(fixture.protocol);
    assert.equal(F.validateFinalProtocol(fixture.protocol).valid, false);
  }
});

test('final build pairs allow only the four reviewed runtime/schema paths while diagnostic preparation stays narrow', () => {
  const fixture = makeFinalFixture(), pair = fixture.protocol.preparation;
  delete pair.baseline.release.config.policy.versions.migrationManifest;
  for (const arm of ['baseline', 'candidate']) {
    for (const key of ['storageSchema', 'baselineSchema']) pair[arm].release.config.policy.versions[key] = C.hashText(`${arm}/${key}`);
    pair[arm].release.configHash = releaseConfigHash(pair[arm].release.config);
  }
  assert.equal(F.validateFinalPreparation(reseal(pair)).valid, true);
  assert.equal(M.validateProtocol(M.createProtocol(pair.baseline, pair.candidate)).valid, false);
  const missing = makeFinalFixture().protocol.preparation;
  delete missing.candidate.release.config.policy.versions.migrationManifest;
  missing.candidate.release.configHash = releaseConfigHash(missing.candidate.release.config);
  assert.equal(F.validateFinalPreparation(reseal(missing)).valid, false);
  const widened = makeFinalFixture().protocol.preparation;
  widened.allowedPolicyChanges.push('policy.models'); assert.equal(F.validateFinalPreparation(reseal(widened)).valid, false);
  const changed = makeFinalFixture().protocol.preparation;
  changed.candidate.release.config.policy.promptHashes.analyzer = C.hashText('unapproved prompt');
  changed.candidate.release.configHash = releaseConfigHash(changed.candidate.release.config);
  assert.equal(F.validateFinalPreparation(reseal(changed)).valid, false);
});

test('all actual build, source, rubric, prompt, output and log bytes are mandatory and rehashed', () => {
  for (const select of [f => f.builds.baseline.artifact, f => f.builds.candidate.artifact, f => f.protocol.corpus.samples[0].source,
    f => f.protocol.rubric, f => f.protocol.judge.prompt, f => f.evidence.preregistration.payload.attachment,
    f => f.evidence.runs[0].payload.stages.analyzer.output, f => f.evidence.runs[0].payload.stages.critic.request,
    f => f.evidence.runs[0].payload.stages.judge.response, f => f.evidence.runs[0].payload.log,
    f => f.evidence.tests[0].payload.log, f => f.evidence.grades[0].payload.attachment,
    f => f.evidence.grades[1].payload.response, f => f.evidence.reviews[0].payload.attachment]) {
    for (const tamper of ['missing', 'changed']) {
      const fixture = makeFinalFixture(), attachment = select(fixture);
      if (tamper === 'missing') delete fixture.context.attachments[attachment.sha256];
      else fixture.context.attachments[attachment.sha256] = Buffer.from('tampered evidence bytes');
      rejected(fixture, /actual bytes/);
    }
  }
});

test('an externally pinned reviewer registry and trusted current time are mandatory', () => {
  for (const modify of [f => { delete f.context.trustedReviewers; }, f => { f.context.trustedReviewers = {}; },
    f => { delete f.context.now; }, f => { f.context.now = 'invalid'; }, f => { f.context.now = '2026-11-17T09:00:00.000Z'; },
    f => { f.context.trustedReviewers.execution.roles = ['human']; }]) {
    const fixture = makeFinalFixture(); modify(fixture); rejected(fixture);
  }
});

test('reviewer ID aliases do not make execution, human, judge or code keys independent', () => {
  for (const [left, right] of [['execution', 'human'], ['execution', 'judge'], ['execution', 'code'], ['execution', 'scope'], ['human', 'judge']]) {
    const fixture = makeFinalFixture(); fixture.context.trustedReviewers[right].publicKey = fixture.context.trustedReviewers[left].publicKey;
    rejected(fixture, /independent keys/);
  }
  const fixture = makeFinalFixture(); fixture.protocol.reviewers.human = fixture.protocol.reviewers.execution;
  fixture.protocol = reseal(fixture.protocol); assert.equal(F.validateFinalProtocol(fixture.protocol).valid, false);
  const scope = makeFinalFixture(); scope.protocol.reviewers.scope = scope.protocol.reviewers.execution;
  scope.protocol = reseal(scope.protocol); assert.equal(F.validateFinalProtocol(scope.protocol).valid, false);
});

test('signature forgery, stale protocol, changed run bytes and evidence-carried keys are rejected', () => {
  for (const mutate of [
    f => { f.evidence.runs[0].signature = Buffer.alloc(64).toString('base64'); },
    f => { f.evidence.runs[0].payload.outcome = 'pass-again'; },
    f => { f.evidence.runs[0] = f.resign(f.evidence.runs[0], { protocolHash: C.hashText('stale') }); },
    f => { f.evidence.runs[0].publicKey = f.context.trustedReviewers.execution.publicKey; }
  ]) {
    const fixture = makeFinalFixture(); mutate(fixture); fixture.evidence = reseal(fixture.evidence); rejected(fixture);
  }
});

test('all Cartesian coordinates must appear exactly once, with no failed or substituted executions', () => {
  for (const updates of [{ arm: 'other' }, { sampleId: 'unknown' }, { repetition: 3 }, { repetition: 1.5 },
    { buildHash: C.hashText('other build') }, { sourceHash: C.hashText('other source') }, { outcome: 'fail' },
    { outcome: 'skipped' }, { origin: 'captured-runtime' }]) {
    const fixture = makeFinalFixture(); changeRecord(fixture, 'runs', 0, updates); rejected(fixture);
  }
  for (const modify of [f => f.evidence.runs.pop(), f => { f.evidence.runs[1] = f.evidence.runs[0]; }]) {
    const fixture = makeFinalFixture(); modify(fixture); fixture.evidence = reseal(fixture.evidence); rejected(fixture);
  }
});

test('observation timestamps must follow preregistration and precede trusted now', () => {
  for (const time of ['2026-11-17T09:59:59.000Z', '2026-11-17T12:00:01.000Z', '2026-11-17', 'invalid']) {
    const fixture = makeFinalFixture(); changeRecord(fixture, 'runs', 0, { observedAt: time }); rejected(fixture, /window/);
  }
  const fixture = makeFinalFixture(); changeRecord(fixture, 'grades', 0, { observedAt: '2026-11-17T10:01:00.000Z' }); rejected(fixture, /premature/);
});

test('every run needs both genuine independent quality roles and threshold checks', () => {
  for (const updates of [{ accuracy: 0.8 }, { completeness: 0.8 }, { fabrications: 1 }, { accuracy: '1' },
    { completeness: -1 }, { fabrications: 0.5 }, { outcome: 'unresolved' }, { runHash: C.hashText('other output') },
    { rubricHash: C.hashText('other rubric') }, { role: 'execution' }]) {
    const fixture = makeFinalFixture(); changeRecord(fixture, 'grades', 0, updates); rejected(fixture);
  }
  for (const modify of [f => f.evidence.grades.pop(), f => { f.evidence.grades[1] = f.evidence.grades[0]; }]) {
    const fixture = makeFinalFixture(); modify(fixture); fixture.evidence = reseal(fixture.evidence); rejected(fixture);
  }
});

test('independent judge provenance binds model and prompt while human reviews cannot impersonate it', () => {
  const fixture = makeFinalFixture(); changeRecord(fixture, 'grades', 1, { judgeHash: C.hashText('unapproved judge') }); rejected(fixture, /model\/prompt/);
  const human = makeFinalFixture(); changeRecord(human, 'grades', 0, { judgeHash: C.digest(human.protocol.judge) }); rejected(human, /impersonate/);
});

test('mean regression can fail even when every candidate sample clears absolute thresholds', () => {
  const fixture = makeFinalFixture();
  const candidateHashes = new Set(fixture.evidence.runs.filter(run => run.payload.arm === 'candidate').map(run => run.payload.hash));
  fixture.evidence.grades = fixture.evidence.grades.map(grade => candidateHashes.has(grade.payload.runHash) ? fixture.resign(grade, { accuracy: 0.95 }) : grade);
  fixture.evidence = reseal(fixture.evidence); rejected(fixture, /mean regression/);
});

test('full tests require real logs, exact arms and no skipped, failed or stale results', () => {
  for (const updates of [{ skipped: 1 }, { failed: 1 }, { exitCode: 1 }, { passed: 0 }, { passed: 1.5 },
    { command: '' }, { outcome: 'skipped' }, { buildHash: C.hashText('wrong build') }, { id: 'partial-suite' }]) {
    const fixture = makeFinalFixture(); changeRecord(fixture, 'tests', 0, updates); rejected(fixture);
  }
  const fixture = makeFinalFixture(); fixture.evidence.tests[1] = fixture.evidence.tests[0]; fixture.evidence = reseal(fixture.evidence); rejected(fixture);
});

test('final candidate denial matrix is mandatory without imposing new protections on the legacy baseline', () => {
  const fixture = makeFinalFixture();
  assert.equal(fixture.evidence.tests.filter(e => e.payload.id === 'final-controller-sql-denial-matrix').length, 1);
  assert.equal(fixture.evidence.tests.find(e => e.payload.id === 'final-controller-sql-denial-matrix').payload.arm, 'candidate');
  const index = fixture.evidence.tests.findIndex(e => e.payload.id === 'final-controller-sql-denial-matrix');
  changeRecord(fixture, 'tests', index, { arm: 'baseline', buildHash: C.digest(fixture.builds.baseline) }); rejected(fixture);
});

test('final independent reviews bind both builds and all observed results', () => {
  for (const updates of [{ outcome: 'fail' }, { observationsHash: C.hashText('different execution') }, { candidateBuildHash: C.hashText('different build') }, { observedAt: '2026-11-17T10:01:00.000Z' }]) {
    const fixture = makeFinalFixture(); changeRecord(fixture, 'reviews', 0, updates); rejected(fixture);
  }
  const fixture = makeFinalFixture(); fixture.evidence.reviews[1] = fixture.evidence.reviews[0]; fixture.evidence = reseal(fixture.evidence); rejected(fixture);
});

test('observed and fixture modes cannot be relabeled after preregistration', () => {
  const fixture = makeFinalFixture(); fixture.protocol.mode = 'observed'; fixture.protocol = reseal(fixture.protocol); rejected(fixture);
});

test('malformed JSON and unsupported fields fail closed instead of throwing or passing', () => {
  for (const input of [null, {}, [], { v: 1 }]) assert.equal(F.validateFinalEvidence(input, input).contractSatisfied, false);
  const fixture = makeFinalFixture(); fixture.evidence.extra = true; fixture.evidence = reseal(fixture.evidence); rejected(fixture);
  const nan = makeFinalFixture(); nan.evidence.grades[0].payload.accuracy = NaN; rejected(nan, /finite/);
});

test('RSA keys and noncanonical signature encodings cannot impersonate pinned Ed25519 reviewers', () => {
  const fixture = makeFinalFixture(); fixture.context.trustedReviewers.execution.publicKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }); rejected(fixture, /Ed25519/);
  const padded = makeFinalFixture(); padded.evidence.runs[0].signature += '\n'; padded.evidence = reseal(padded.evidence); rejected(padded, /signature/);
});

console.log(`${passed} maintenance-final offline verifier tests passed (synthetic fixtures only)`);
