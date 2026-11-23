'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { digest, hashText, seal } = require('../tools/final-corpus-lib');
const M = require('../tools/maintenance-dependency-evidence');
const S = require('../tools/sites-lib');
const { reseal } = require('./final-test-fixtures');

const { fixture, createArms, createClassification, attachmentStore, DECLARED, OBSERVED, NOW, NAME } = require('./maintenance-dependency-fixtures');

function verify(data) {
  return M.validateDependencyEvidence(data.protocol, data.evidence, data.context);
}

function reject(data, reason) {
  data.evidence = reseal(data.evidence);
  const report = verify(data);
  assert.equal(report.promotionEligible, false, JSON.stringify(report));
  if (reason) assert.match(report.reasons.join('\n'), reason);
  assert.throws(() => M.authorizationEvidence(report));
}

test('observed D and E evidence authorizes only the exact recomputed release', async () => {
  for (const className of ['D', 'E']) {
    const data = await fixture({ className });
    const report = verify(data);
    assert.equal(report.promotionEligible, true, JSON.stringify(report));
    assert.equal(report.class, className);
    assert.equal(report.configHash, data.arms[1].release.configHash);
    assert.equal(report.baselineConfigHash, data.arms[0].release.configHash);
    assert.equal(report.totalSmokeMicros, 44);
    assert.equal(verify(data).hash, report.hash);
    assert.equal(M.authorizationEvidence(report).evidenceHash, report.hash);
  }
});

test('fixture-mode evidence remains diagnostic even with valid signatures and attachments', async () => {
  const data = await fixture({ mode: 'fixture' });
  const report = verify(data);
  assert.equal(report.contractSatisfied, true, JSON.stringify(report));
  assert.equal(report.diagnosticOnly, true);
  assert.equal(report.promotionEligible, false);
  assert.throws(() => M.authorizationEvidence(report));
});

test('missing or failed candidate tests, reviews, and provider smokes block promotion', async () => {
  for (const change of [
    d => { d.evidence.tests.pop(); },
    d => { d.evidence.tests[0] = d.resign(d.evidence.tests[0], { exitCode: 1, passed: 9, failed: 1, outcome: 'fail' }); },
    d => { d.evidence.tests[0] = d.resign(d.evidence.tests[0], { skipped: 1 }); },
    d => { d.evidence.codeReview = null; },
    d => { d.evidence.dependencyReview = d.resign(d.evidence.dependencyReview, { outcome: 'fail' }); },
    d => { d.evidence.dependencyReview = d.resign(d.evidence.dependencyReview, { acceptedAdvisories: ['GHSA-2222-3333-4444'] }); },
    d => { d.evidence.smokes.pop(); },
    d => { d.evidence.smokes[0] = d.resign(d.evidence.smokes[0], { outcome: 'fail' }); },
    d => { d.evidence.smokes[0] = d.resign(d.evidence.smokes[0], { origin: 'fixture' }); },
    d => { d.evidence.smokes[0] = d.resign(d.evidence.smokes[0], { attemptCount: 2 }); },
    d => { d.evidence.tests[0] = d.resign(d.evidence.tests[0], { imageSha256: d.arms[0].image.sha256 }); },
    d => { d.evidence.equivalence = d.resign(d.evidence.equivalence, { measurementHash: hashText('different classification input') }); },
    d => { d.evidence.preregistration = d.resign(d.evidence.preregistration, { observedAt: '2026-11-17T10:03:00.000Z' }); },
    d => { d.evidence.codeReview.signature = d.evidence.dependencyReview.signature; },
  ]) {
    const data = await fixture({ className: 'E' });
    change(data);
    reject(data);
  }
});

test('observed mode rejects same-key roles, stale dependency reports, and class Q', async () => {
  const shared = await fixture();
  shared.context.trustedReviewers.execution.publicKey = shared.context.trustedReviewers.owner.publicKey;
  reject(shared, /keys must be independent/);
  const stale = await fixture();
  const dependencyReport = stale.evidence.dependencyReport = reseal({
    ...stale.evidence.dependencyReport, measuredAt: '2026-11-16T10:00:00.000Z',
    candidate: stale.evidence.dependencyReport.baseline,
  });
  stale.evidence.dependencyReview = stale.resign(stale.evidence.dependencyReview, { reportHash: dependencyReport.hash });
  reject(stale, /image or lockfile binding changed/);
  const { retain } = attachmentStore();
  const build = createArms(retain, 'Q');
  const { input, report } = createClassification(build, retain);
  assert.equal(report.classification, 'Q');
  assert.throws(() => M.createDependencyProtocol(input, report, {
    mode: shared.protocol.mode, declaredAt: DECLARED, smokeSampleId: 'case-0',
    smokeCapMicros: 1_000, rates: shared.context.trustedRates, reviewers: { execution: 'execution', owner: 'owner' },
  }));
});

test('smoke cost must reconcile with trusted prices and stay under the predeclared cap', async () => {
  const overCap = await fixture({ smokeCapMicros: 43 });
  reject(overCap, /exceeds approved cap/);
  const atCap = verify(await fixture({ smokeCapMicros: 44 }));
  assert.equal(atCap.promotionEligible, true, JSON.stringify(atCap));
  const altered = await fixture();
  altered.context.trustedRates = structuredClone(altered.context.trustedRates);
  altered.context.trustedRates.openai.inputMicrodollarsPerMillion++;
  reject(altered, /externally trusted rates/);
  const understated = await fixture();
  const smoke = understated.evidence.smokes[0];
  const stages = structuredClone(smoke.payload.stages);
  stages.analyzer.costMicros--;
  understated.evidence.smokes[0] = understated.resign(smoke, { stages });
  reject(understated, /computed cost disagrees with receipt/);
});

test('the full-context exception is unavailable to other Class E releases', async () => {
  const existing = await fixture({ className: 'E' });
  const { evidence, protocol } = existing;
  assert.throws(() => M.createDependencyProtocol(evidence.classificationInput, evidence.classificationReport, {
    mode: protocol.mode, declaredAt: protocol.declaredAt, smokeSampleId: protocol.smokeSampleId,
    smokeCapMicros: 6_080_000, rates: protocol.rates, reviewers: protocol.reviewers,
  }), /approved release scope/);
});

test('the verifier rehashes original bytes and checks smoke output against the provider response', async () => {
  for (const select of [
    d => d.evidence.tests[0].payload.log.sha256,
    d => d.evidence.smokes[0].payload.stages.analyzer.request.sha256,
    d => d.evidence.smokes[1].payload.stages.critic.response.sha256,
    d => d.evidence.dependencyReport.registryKeysSha256,
  ]) {
    const data = await fixture();
    const sha256 = select(data);
    data.context.attachments[sha256] = Buffer.from('tampered bytes');
    reject(data, /evidence hash mismatch/);
  }
  const missing = await fixture();
  missing.context.attachments = {};
  reject(missing, /Missing retained evidence bytes/);
  const mismatched = await fixture();
  const smoke = mismatched.evidence.smokes[0];
  const stages = structuredClone(smoke.payload.stages);
  stages.analyzer.output = mismatched.retain({ summary: 'Different summary' });
  mismatched.evidence.smokes[0] = mismatched.resign(smoke, { stages });
  reject(mismatched);
});

test('an owner signature cannot substitute for complete dependency report coverage', async () => {
  function attest(data, updates) {
    const report = data.evidence.dependencyReport = reseal({ ...data.evidence.dependencyReport, ...updates });
    data.evidence.dependencyReview = data.resign(data.evidence.dependencyReview, { reportHash: report.hash });
  }
  const omittedVersion = await fixture();
  attest(omittedVersion, { versions: omittedVersion.evidence.dependencyReport.versions.slice(1) });
  reject(omittedVersion, /Unverified dependency content or metadata/);

  const omittedSource = await fixture();
  attest(omittedSource, { sourceChecks: omittedSource.evidence.dependencyReport.sourceChecks.filter(row =>
    row.source !== 'github-repository') });
  reject(omittedSource, /Missing advisory or registry coverage/);

  const inconsistentSource = await fixture();
  const advisory = inconsistentSource.retain({ [NAME]: [{
    id: 'GHSA-2222-3333-4444', title: 'Offline fixture finding', severity: 'moderate',
    url: 'https://example.com/advisories/GHSA-2222-3333-4444', vulnerable_versions: '1.0.1',
  }] });
  attest(inconsistentSource, { sourceChecks: inconsistentSource.evidence.dependencyReport.sourceChecks.map(row =>
    row.source === 'npm' && row.query[NAME][0] === '1.0.1' ? { ...row, sha256: advisory.sha256 } : row) });
  reject(inconsistentSource, /responses disagree with Checkpoint B findings/);

  const wrongPin = await fixture();
  const dependencies = structuredClone(wrongPin.evidence.dependencyReport.dependencies);
  dependencies[0].after.resolved = 'https://example.com/review-fixture-1.0.1.tgz';
  attest(wrongPin, { dependencies });
  reject(wrongPin, /disagrees with verified lockfile/);
});

test('sites authorization requires full evidence, the prior config, and the same external owner key', async () => {
  const data = await fixture();
  const report = verify(data);
  const { now, ...context } = data.context;
  const dependencyEvidence = { protocol: data.protocol, evidence: data.evidence, ...context };
  const [baseline, candidate] = data.arms;
  const payload = {
    v: 2, kind: 'release-activation', authorizationId: 'fixture-authorization-id', action: 'activate',
    environment: 'staging', configHash: candidate.release.configHash, expectedGeneration: 1,
    expectedConfigHash: baseline.release.configHash, expectedHeadHash: hashText('prior head'),
    issuedAt: OBSERVED, expiresAt: '2026-11-17T13:00:00.000Z', evidence: M.authorizationEvidence(report),
  };
  function check(options, updates = {}, keys = data.keys.owner) {
    const changed = { ...payload, ...updates };
    const signature = crypto.sign(null, Buffer.from(S.AUTHORIZATION_PURPOSE + S.strictCanonicalJson(changed)), keys.privateKey).toString('base64');
    const ownerPublicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    return S.checkAuthorization({ payload: changed, signature }, candidate.release, ownerPublicKey, { now, ...options });
  }
  const valid = check({ dependencyEvidence });
  assert.equal(valid.valid, true, valid.reason);
  assert.equal(check({}).valid, false);
  assert.equal(check({ dependencyEvidence: { ...dependencyEvidence, attachments: {} } }).valid, false);
  assert.equal(check({ dependencyEvidence }, { expectedConfigHash: hashText('different config') }).valid, false);
  assert.equal(check({ dependencyEvidence }, {}, crypto.generateKeyPairSync('ed25519')).valid, false);
  assert.equal(check({ dependencyEvidence }, { evidence: { ...payload.evidence, evidenceHash: hashText('substituted report') } }).valid, false);
});
