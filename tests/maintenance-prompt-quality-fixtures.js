'use strict';

const crypto = require('node:crypto');
const C = require('../tools/final-corpus-lib');
const Q = require('../tools/maintenance-prompt-quality');
const { releaseConfigHash } = require('../tools/sites-lib');
const { makeRelease } = require('./final-test-fixtures');

function createQualityFixture(journalDirectory) {
  const attachments = new Map(), builds = {}, archives = {};
  function retain(text) {
    const bytes = Buffer.from(text);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    attachments.set(sha256, bytes);
    return { bytes: bytes.length, sha256 };
  }
  for (const arm of Q.ARMS) {
    const release = makeRelease([]);
    const policy = release.config.policy;
    policy.cache = { shared: 'disabled' };
    policy.models = {
      anthropic: { default: 'claude-sonnet-4-6', escalated: 'claude-opus-4-8', jury: 'claude-opus-5' },
      openai: { default: 'gpt-4o-mini', escalated: 'gpt-4o', jury: 'gpt-4o' },
    };
    policy.promptHashes.analyzer = C.hashText(arm + ' analyzer');
    policy.versions.promptComposition = C.hashText(arm + ' prompt composition');
    policy.versions.serverPipeline = C.hashText(arm + ' server pipeline');
    release.configHash = releaseConfigHash(release.config);
    const artifact = retain(arm + ' fixture archive');
    archives[arm] = attachments.get(artifact.sha256);
    builds[arm] = { release, commit: C.hashText(arm + ' commit').slice(0, 40),
      runtime: { node: 'v22.23.3', npm: '10.9.9', platform: 'linux', arch: 'x64' },
      artifact: { ...artifact, manifestDigest: 'sha256:' + C.hashText(arm + ' manifest') } };
  }
  const reviewers = {}, reviewerRegistry = {};
  let signer;
  for (const role of ['protocol', 'execution', 'human', 'judge', 'scope', 'code']) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    reviewers[role] = role;
    reviewerRegistry[role] = { roles: [role], publicKey: publicKey.export({ type: 'spki', format: 'pem' }) };
    if (role === 'protocol') signer = privateKey;
  }
  const now = '2026-11-26T12:00:00.000Z';
  const spec = { mode: 'fixture', declaredAt: now, builds, offlineComparisonHash: C.hashText('fixture offline package'),
    corpus: { samples: [{ id: 'sample', coverage: ['privacy'], source: retain('Our service collects an email address.'),
      provenance: { url: 'https://example.test/privacy', capturedAt: now, method: 'fixture' } }], requiredCoverage: ['privacy'] },
    repetitions: 1, criteria: { minAccuracy: 0.8, minCompleteness: 0.8, maxFabrications: 0, maxMeanRegression: 0 },
    rubric: retain('Evaluate accuracy and completeness against the source.'),
    independentJudge: { model: 'gpt-6-luna', prompt: retain('Evaluate the summary using only the supplied source and rubric.') }, reviewers };
  const protocol = Q.createPromptQualityProtocol(spec);
  const payload = C.seal({ v: 1, kind: 'preregistration', protocolHash: protocol.hash, reviewer: 'protocol', observedAt: now,
    outcome: 'pass', attachment: retain('Offline fixture declaration') });
  const preregistration = { payload, signature: crypto.sign(null, Buffer.from(Q.promptQualityPreregistrationMessage(payload)), signer).toString('base64') };
  const rate = (responseModel, maxOutputTokens) => ({ responseModel, maxOutputTokens, maxInputTokens: 128000,
    inputMicrodollarsPerMillion: 1000, outputMicrodollarsPerMillion: 2000 });
  const pricing = { independent: rate(spec.independentJudge.model, 8000) };
  for (const provider of Q.PROVIDERS) {
    const models = builds.baseline.release.config.policy.models[provider];
    pricing[provider] = { analyzer: rate(models.default, 1200), critic: rate(models.default, 1000), judge: rate(models.jury, 8000) };
  }
  const planInput = { approvalId: 'quality-fixture', limitMicrodollars: 100000, overheadMicrodollars: 10, journalDirectory, protocol, pricing };
  const plan = journalDirectory ? Q.createPromptQualityPlan(planInput) : undefined;
  return { spec, protocol, planInput, plan, pricing, preregistration, reviewerRegistry, attachments, now, archives };
}

module.exports = { createQualityFixture };
