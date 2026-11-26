'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Q = require('../tools/maintenance-prompt-quality');
const F = require('../tools/maintenance-final-evidence');
const C = require('../tools/final-corpus-lib');
const { releaseConfigHash } = require('../tools/sites-lib');
const { createQualityFixture } = require('./maintenance-prompt-quality-fixtures');

const fixture = createQualityFixture();
assert.deepEqual(Q.validatePromptQualityProtocol(fixture.protocol), { valid: true, reasons: [] });
assert.equal(F.validateFinalProtocol(fixture.protocol).valid, false);
const oldEvidence = F.validateFinalEvidence(fixture.protocol, {}, {});
assert.equal(oldEvidence.evaluationPassed, false);
assert.throws(() => F.authorizationEvidence(oldEvidence));
for (const mutate of [
  s => { s.mode = 'observed'; },
  s => { s.corpus.samples.push({ ...s.corpus.samples[0], id: 'duplicate' }); },
  s => { s.corpus.samples[0].provenance.capturedAt = '2026-12-01T00:00:00.000Z'; },
  s => { s.corpus.requiredCoverage.push('missing'); },
  s => { s.reviewers.protocol = s.reviewers.human; },
  s => { s.repetitions = 10000; },
  s => { s.criteria.maxFabrications = 2; },
  s => { s.builds.candidate.release.config.policy.cache.shared = 'enabled';
    s.builds.candidate.release.configHash = releaseConfigHash(s.builds.candidate.release.config); },
  s => { s.builds.candidate.release.config.policy.versions.promptComposition = s.builds.baseline.release.config.policy.versions.promptComposition;
    s.builds.candidate.release.configHash = releaseConfigHash(s.builds.candidate.release.config); },
]) {
  const spec = structuredClone(fixture.spec);
  mutate(spec);
  assert.throws(() => Q.createPromptQualityProtocol(spec));
}
assert.deepEqual(Q.verifyPromptQualityPreregistration(fixture), fixture.preregistration.payload);
assert.notEqual(Q.promptQualityPreregistrationMessage(fixture.preregistration.payload), F.observationMessage(fixture.preregistration.payload));
const { preregistration, reviewerRegistry } = fixture;
assert.throws(() => Q.verifyPromptQualityPreregistration({ ...fixture, now: '2026-11-25T00:00:00.000Z' }));
assert.throws(() => Q.verifyPromptQualityPreregistration({ ...fixture, attachments: new Map() }));
assert.throws(() => Q.verifyPromptQualityPreregistration({ ...fixture, preregistration: { ...preregistration, signature: Buffer.alloc(64).toString('base64') } }));
assert.throws(() => Q.verifyPromptQualityPreregistration({ ...fixture, reviewerRegistry: { ...reviewerRegistry,
  human: { ...reviewerRegistry.human, publicKey: reviewerRegistry.execution.publicKey } } }));
if (process.platform === 'win32') {
  const journalDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-quality-plan-'));
  try {
    const input = { ...fixture.planInput, journalDirectory };
    const plan = Q.createPromptQualityPlan(input);
    assert.deepEqual(Q.validatePromptQualityPlan(plan, plan.hash), plan);
    assert.equal(plan.runs.length, 4);
    assert.equal(plan.calls.length, 16);
    assert.equal(plan.budget.planHash, plan.hash);
    assert.deepEqual(plan.calls, plan.budget.calls);
    assert.throws(() => Q.validatePromptQualityPlan({ ...plan, runs: [] }, plan.hash));
    assert.throws(() => Q.validatePromptQualityPlan(plan, C.hashText('other plan')));
    assert.throws(() => Q.createPromptQualityPlan({ ...input, limitMicrodollars: 1 }));
    for (const mutate of [
      p => { p.openai.analyzer.maxOutputTokens = 1; }, p => { p.independent.inputMicrodollarsPerMillion = 0; },
      p => { p.anthropic.judge.responseModel = 'different-model'; }, p => { delete p.independent; },
    ]) {
      const pricing = structuredClone(input.pricing);
      mutate(pricing);
      assert.throws(() => Q.createPromptQualityPlan({ ...input, pricing }));
    }
    assert.deepEqual(fs.readdirSync(journalDirectory), []);
  } finally { fs.rmdirSync(journalDirectory); }
}
console.log('PASS prompt quality protocol, preregistration, release-scope isolation and plan checks');
