'use strict';

// Hypothetical signed observations for offline verifier tests only. These keys
// never leave process memory and do not sign a release or authorize spending.
const crypto = require('node:crypto');
const C = require('../tools/final-corpus-lib');
const M = require('../tools/maintenance-evaluation-lib');
const F = require('../tools/maintenance-final-evidence');
const { makeRelease, reseal } = require('./final-test-fixtures');
const { releaseConfigHash } = require('../tools/sites-lib');

function makeFinalFixture({ mode = 'fixture', baselineRelease = null, candidateRelease = null, compactBytes = false, buildArtifacts = {} } = {}) {
  const attachments = {}, keys = {}, trustedReviewers = {};
  const attachment = text => {
    if (compactBytes && !/^(baseline artifact|candidate artifact|held-out source)/.test(text)) text = 'shared test-only evidence bytes';
    const bytes = Buffer.from(text), sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    attachments[sha256] = bytes;
    return { sha256, bytes: bytes.length };
  };
  for (const role of F.ROLES) {
    keys[role] = crypto.generateKeyPairSync('ed25519');
    trustedReviewers[role] = { publicKey: keys[role].publicKey.export({ type: 'spki', format: 'pem' }).toString(), roles: [role] };
  }
  const release = seed => {
    const r = makeRelease([]);
    r.config.policy.versions.serverPipeline = C.hashText(seed);
    r.config.policy.versions.migrationManifest = C.hashText(`migration-manifest-${seed}`);
    r.config.policy.cache = { shared: 'disabled' };
    r.configHash = releaseConfigHash(r.config); return r;
  };
  const builds = {
    baseline: { release: baselineRelease || release('baseline-fixture'), artifact: attachment(buildArtifacts.baseline || 'baseline artifact fixture'), runtime: { node: '22.23.3', npm: '10.9.8', platform: 'linux', arch: 'x64' } },
    candidate: { release: candidateRelease || release('candidate-fixture'), artifact: attachment(buildArtifacts.candidate || 'candidate artifact fixture'), runtime: { node: '22.23.3', npm: '10.9.8', platform: 'linux', arch: 'x64' } }
  };
  const modelPolicy = builds.candidate.release.config.policy.models;
  const provider = Object.keys(modelPolicy)[0];
  const stageModels = Object.fromEntries(F.STAGES.map(stage => {
    const tier = stage === 'judge' ? 'jury' : 'default';
    return [stage, { provider, tier, model: modelPolicy[provider][tier] }];
  }));
  const protocol = F.createFinalProtocol(M.createProtocol(builds.baseline, builds.candidate), {
    mode, declaredAt: '2026-11-17T10:00:00.000Z',
    corpus: { purpose: 'maintenance-evaluation-only', learningAllowed: false, samples: ['social', 'commerce'].map((tag, i) => ({ id: `sample-${i}`, coverage: [tag], source: attachment(`held-out source fixture ${i}`), provenance: { url: `https://fixture-${i}.example/privacy`, capturedAt: '2026-11-17T09:00:00.000Z', method: mode === 'observed' ? 'official-capture' : 'fixture' } })) },
    sampleCount: 2, repetitions: 2, requiredCoverage: ['social', 'commerce'],
    criteria: { minAccuracy: 0.9, minCompleteness: 0.9, maxFabrications: 0, maxMeanRegression: 0 },
    rubric: attachment('independent quality rubric fixture'),
    judge: { provider: 'openai', model: 'mock-independent-judge', prompt: attachment('independent quality judge prompt fixture') },
    stageModels, reviewers: Object.fromEntries(F.ROLES.map(role => [role, role]))
  });
  const sign = (role, kind, fields, observedAt = '2026-11-17T10:02:00.000Z') => {
    const payload = C.seal({ v: 1, kind, protocolHash: protocol.hash, reviewer: role, observedAt, ...fields });
    return { payload, signature: crypto.sign(null, Buffer.from(F.observationMessage(payload)), keys[role].privateKey).toString('base64') };
  };
  const resign = (envelope, updates) => {
    const payload = reseal({ ...envelope.payload, ...updates });
    return { payload, signature: crypto.sign(null, Buffer.from(F.observationMessage(payload)), keys[payload.reviewer].privateKey).toString('base64') };
  };
  const preregistration = sign('protocol', 'preregistration', { outcome: 'pass', attachment: attachment('protocol preregistration and held-out corpus review fixture') }, protocol.declaredAt);
  const runs = [], grades = [];
  for (const arm of ['baseline', 'candidate']) for (const sample of protocol.corpus.samples) for (let repetition = 1; repetition <= protocol.repetitions; repetition++) {
    const label = `${arm}/${sample.id}/${repetition}`;
    const stages = Object.fromEntries(F.STAGES.map(stage => [stage, {
      provider: stageModels[stage].provider, model: stageModels[stage].model, requestId: `fixture-${label}/${stage}`,
      request: attachment(`original request fixture ${label}/${stage}`), response: attachment(`original response fixture ${label}/${stage}`), output: attachment(`pipeline output fixture ${label}/${stage}`)
    }]));
    const run = sign('execution', 'pipeline-run', { arm, sampleId: sample.id, repetition, buildHash: C.digest(builds[arm]), sourceHash: sample.source.sha256, outcome: 'pass', origin: mode === 'fixture' ? 'fixture' : 'captured-runtime', stages, log: attachment(`execution log fixture ${label}`) });
    runs.push(run);
    for (const role of ['human', 'judge']) grades.push(sign(role, 'quality-grade', {
      role, runHash: run.payload.hash, rubricHash: protocol.rubric.sha256,
      judgeHash: role === 'judge' ? C.digest(protocol.judge) : null,
      request: role === 'judge' ? attachment(`independent judge request fixture ${label}`) : null,
      response: role === 'judge' ? attachment(`independent judge response fixture ${label}`) : null,
      accuracy: 1, completeness: 1, fabrications: 0, outcome: 'pass', attachment: attachment(`${role} quality review fixture ${label}`)
    }, '2026-11-17T10:03:00.000Z'));
  }
  const tests = ['baseline', 'candidate'].flatMap(arm => (arm === 'candidate' ? F.TESTS : M.TESTS).map(id => sign('execution', 'full-test', { arm, id, buildHash: C.digest(builds[arm]), command: `fixture-test ${id}`, exitCode: 0, passed: 10, failed: 0, skipped: 0, outcome: 'pass', log: attachment(`full test output fixture ${arm}/${id}`) })));
  const observationsHash = C.digest({ preregistration, runs, grades, tests });
  const reviews = F.REVIEWS.map(id => sign(id === 'maintenance-scope' ? 'scope' : 'code', 'independent-review', { id, baselineBuildHash: C.digest(builds.baseline), candidateBuildHash: C.digest(builds.candidate), observationsHash, outcome: 'pass', attachment: attachment(`final ${id} fixture`) }, '2026-11-17T10:04:00.000Z'));
  return { protocol, evidence: C.seal({ v: 1, kind: 'maintenance-final-evidence', protocolHash: protocol.hash, preregistration, runs, grades, tests, reviews }),
    context: { attachments, trustedReviewers, now: '2026-11-17T12:00:00.000Z' }, keys, attachment, sign, resign, builds };
}

module.exports = { makeFinalFixture };
