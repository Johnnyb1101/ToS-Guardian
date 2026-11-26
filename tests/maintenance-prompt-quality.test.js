'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Q = require('../tools/maintenance-prompt-quality');
const F = require('../tools/maintenance-final-evidence');
const C = require('../tools/final-corpus-lib');
const { releaseConfigHash } = require('../tools/sites-lib');
const { ANTHROPIC_INPUT_CHECK: anthropicInputCheck, createQualityFixture } = require('./maintenance-prompt-quality-fixtures');

const fixture = createQualityFixture();
const guardedFixture = createQualityFixture(undefined, { checkAnthropicInput: true });
const guardedProtocol = guardedFixture.protocol;
assert.deepEqual(Q.validatePromptQualityProtocol(fixture.protocol), { valid: true, reasons: [] });
assert.equal(Object.hasOwn(fixture.protocol, 'anthropicInputCheck'), false);
assert.equal(guardedProtocol.v, fixture.protocol.v);
assert.deepEqual(guardedProtocol.anthropicInputCheck, anthropicInputCheck);
assert.notEqual(guardedProtocol.hash, fixture.protocol.hash);
assert.throws(() => Q.verifyPromptQualityPreregistration({ ...fixture, protocol: guardedProtocol }), /preregistration declaration/);
assert.deepEqual(Q.verifyPromptQualityPreregistration(guardedFixture), guardedFixture.preregistration.payload);
for (const malformed of [
  null, { method: 'count-tokens' }, { ...anthropicInputCheck, method: 'local-estimate' },
  { ...anthropicInputCheck, maxEstimatedInputTokens: 56_001 }, { ...anthropicInputCheck, maxInputTokens: 64_001 },
  { ...anthropicInputCheck, extra: true },
]) {
  assert.throws(() => Q.createPromptQualityProtocol({ ...fixture.spec, anthropicInputCheck: malformed }));
}
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
    const guardedPricing = guardedFixture.pricing;
    const guardedInput = { ...input, protocol: guardedProtocol, pricing: guardedPricing };
    const guardedPlan = Q.createPromptQualityPlan(guardedInput);
    assert.deepEqual(Q.validatePromptQualityPlan(guardedPlan, guardedPlan.hash), guardedPlan);
    assert.equal(guardedPlan.calls.length, plan.calls.length);
    assert.notEqual(guardedPlan.hash, plan.hash);
    for (const [index, call] of guardedPlan.calls.entries()) {
      if (call.id.startsWith('anthropic:') && !call.id.endsWith(':independent')) {
        assert.deepEqual(call, { ...plan.calls[index], maxInputTokens: 64_000 });
      } else {
        assert.deepEqual(call, plan.calls[index]);
      }
    }
    assert.ok(guardedPlan.budget.totalMicrodollars < plan.budget.totalMicrodollars);
    for (const stage of ['analyzer', 'critic', 'judge']) {
      for (const maxInputTokens of [63_999, 64_001]) {
        const pricing = structuredClone(guardedPricing);
        pricing.anthropic[stage].maxInputTokens = maxInputTokens;
        assert.throws(() => Q.createPromptQualityPlan({ ...guardedInput, pricing }));
      }
    }
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
