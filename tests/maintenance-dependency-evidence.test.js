'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { digest, hashText, seal } = require('../tools/final-corpus-lib');
const M = require('../tools/maintenance-dependency-evidence');
const { reviewDependencies } = require('../tools/dependency-review');
const { replayFixtures, requestBytes } = require('../tools/release-class');
const { classifyRelease } = require('../tools/release-class-lib');
const S = require('../tools/sites-lib');
const { makeRelease, reseal } = require('./final-test-fixtures');

const DECLARED = '2026-11-17T10:00:00.000Z';
const MEASURED = '2026-11-17T10:01:00.000Z';
const OBSERVED = '2026-11-17T10:02:00.000Z';
const NOW = '2026-11-17T12:00:00.000Z';
const REGISTRY = 'https://registry.npmjs.org';
const PROVIDERS = ['anthropic', 'openai'];
const NAME = 'review-fixture';
const PATH = 'node_modules/' + NAME;

function packagePin(version) {
  const route = `/${NAME}/-/${NAME}-${version}.tgz`;
  const bytes = Buffer.from('test-only tarball ' + version);
  const integrity = 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64');
  return { route, bytes, pin: { version, integrity, resolved: REGISTRY + route } };
}

function lockfile(version) {
  return { lockfileVersion: 3, packages: { '': {}, [PATH]: packagePin(version).pin } };
}

function attachmentStore() {
  const attachments = {};
  function retain(value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    attachments[sha256] = bytes;
    return { sha256, bytes: bytes.length };
  }
  return { attachments, retain };
}

function createArms(retain, className) {
  function file(path, text = path) {
    return { path, kind: 'file', mode: 0o644, ...retain(text) };
  }
  return ['baseline', 'candidate'].map((arm, index) => {
    const release = makeRelease([]);
    release.config.policy.models.openai = { default: 'mock-openai', escalated: 'mock-openai-escalation', jury: 'mock-openai-jury' };
    release.config.policy.versions.serverPipeline = hashText(arm);
    release.configHash = S.releaseConfigHash(release.config);
    const version = index === 0 ? '1.0.0' : '1.0.1';
    const files = [file('index.js', className === 'E' ? arm : 'index.js'), file('package.json', version),
      file('package-lock.json', JSON.stringify(lockfile(version))), file('llmRelay.js', className === 'Q' ? arm : 'llmRelay.js')];
    return {
      image: { ...retain('fictional image ' + arm), manifestDigest: 'sha256:' + hashText('manifest ' + arm) },
      release, inventory: { files, packages: [{ path: PATH, name: NAME, version }] },
    };
  });
}

function createClassification(arms, retain) {
  const corpus = Array.from({ length: 6 }, (_, i) => ({
    id: 'case-' + i, documentType: i < 4 ? 'terms-of-service' : 'privacy-policy',
    url: 'https://example.com/policy-' + i, source: retain('Fictional policy ' + i),
  }));
  const comparison = (id, value) => {
    const { sha256 } = retain(value);
    return { id, baseline: sha256, candidate: sha256 };
  };
  const requests = corpus.flatMap(({ id }) => PROVIDERS.flatMap(provider =>
    ['analyzer', 'critic', 'judge', 'escalation'].map(stage => {
      const requestId = id + ':' + provider + ':' + stage;
      const anthropic = provider === 'anthropic';
      return comparison(requestId, requestBytes({
        url: anthropic ? 'https://api.anthropic.com/v1/messages' : 'https://api.openai.com/v1/chat/completions',
        headers: { 'content-type': 'application/json', ...(anthropic ? { 'anthropic-version': '2023-06-01' } : {}) },
        body: JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: requestId }] }),
      }, provider));
    })));
  const replayInputs = replayFixtures().map(({ id, provider, body, expected }) => ({
    id: provider + ':' + id, origin: 'synthetic', inputDigest: retain(body).sha256,
    expected, outcomes: [expected, expected],
  }));
  for (const provider of PROVIDERS) {
    replayInputs.push({ id: provider + ':recorded-prior', origin: 'recorded', expected: null, outcomes: ['parsed', 'parsed'],
      inputDigest: retain(provider === 'anthropic' ? {
        id: 'msg_fixture', type: 'message', role: 'assistant', model: 'mock-analyzer', stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Fictional prior result' }], usage: { input_tokens: 5, output_tokens: 3 },
      } : {
        id: 'chatcmpl-fixture', object: 'chat.completion', created: 1, model: 'mock-openai',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Fictional prior result' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }).sha256 });
  }
  const replays = replayInputs.map(({ id, outcomes: [outcome] }) => comparison(id, {
    outcome, parsed: { text: 'Fictional prior result' }, usage: null,
  }));
  const [baseline, candidate] = arms;
  const input = { baseline, candidate, requests, replays, replayInputs };
  const { hash, ...core } = classifyRelease(input);
  return { input, report: seal({
    ...core, corpus, recordedProviders: PROVIDERS, fixtureCoverage: true,
    comparisonScope: {
      request: 'Exact serialized request body and public headers in image order. Synthetic authentication is excluded.',
      response: 'Exact relay parse result and normalized usage. Provider receipt identity and timestamp metadata are outside the relay output.',
      fixedPrior: 'Offline equivalence fixture. The source describes its own terms.',
    },
  }) };
}

async function dependencyReport(arms, classification, retain, attachments) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const sshHeader = Buffer.from('0000001365636473612d736861322d6e69737470323536000000086e6973747032353600000041', 'hex');
  const wireKey = Buffer.concat([sshHeader, der.subarray(-65)]);
  const keyid = 'SHA256:' + crypto.createHash('sha256').update(wireKey).digest('base64').replace(/=+$/, '');
  const scheme = 'ecdsa-sha2-nistp256';
  const packument = { name: NAME, versions: {}, time: {} };
  const sources = {
    '/-/npm/v1/keys': { keys: [{ keyid, key: der.toString('base64'), keytype: scheme, scheme, expires: null }] },
    ['/' + NAME]: packument,
  };
  const images = arms.map(arm => {
    const { version } = arm.inventory.packages[0];
    const { route, bytes, pin: { integrity, resolved } } = packagePin(version);
    sources[route] = bytes;
    const sig = crypto.sign('sha256', Buffer.from(NAME + '@' + version + ':' + integrity), privateKey).toString('base64');
    packument.versions[version] = { name: NAME, version, dist: { tarball: resolved, integrity, signatures: [{ sig, keyid }] } };
    packument.time[version] = '2026-01-10T00:00:00.000Z';
    return {
      lockfileSha256: arm.inventory.files.find(entry => entry.path === 'package-lock.json').sha256,
      lockfile: lockfile(version),
      installed: [{ path: PATH, name: NAME, version, fileCount: 1, fileTreeSha256: hashText(version) }],
    };
  });
  const report = await reviewDependencies({ classification, images, pair: 'activation', supplemental: [] }, async (route, options) => {
    const value = sources[route] ?? (options.source?.startsWith('github-') ? [] : {});
    const { sha256 } = retain(value);
    return { bytes: attachments[sha256], sha256, path: route, status: 200 };
  }, async files => files.map(file => {
    const version = file.path.match(/-(\d+\.\d+\.\d+)\.tgz$/)[1];
    return { name: NAME, version, fileCount: 1, fileTreeSha256: hashText(version),
      scripts: {}, repository: 'https://github.com/example/review-fixture.git' };
  }));
  return reseal({ ...report, measuredAt: MEASURED });
}

async function fixture({ className = 'D', mode = 'observed', smokeCapMicros = 1_000 } = {}) {
  const { attachments, retain } = attachmentStore();
  const arms = createArms(retain, className);
  const { input, report } = createClassification(arms, retain);
  const rates = Object.fromEntries(PROVIDERS.map(provider => {
    const model = arms[1].release.config.policy.models[provider].default;
    return [provider, { model, responseModel: model, inputMicrodollarsPerMillion: 1_000_000,
      outputMicrodollarsPerMillion: 2_000_000 }];
  }));
  const reviewers = { execution: 'execution', owner: 'owner' };
  const trustedReviewers = {};
  const keys = {};
  for (const role of Object.keys(reviewers)) {
    keys[role] = crypto.generateKeyPairSync('ed25519');
    trustedReviewers[role] = { publicKey: keys[role].publicKey.export({ type: 'spki', format: 'pem' }).toString(), roles: [role] };
  }
  const protocol = M.createDependencyProtocol(input, report, {
    mode, declaredAt: DECLARED, smokeSampleId: 'case-0', smokeCapMicros, rates, reviewers,
  });
  const envelope = payload => ({
    payload, signature: crypto.sign(null, Buffer.from(M.observationMessage(payload)), keys[payload.reviewer].privateKey).toString('base64'),
  });
  const sign = (reviewer, kind, fields, observedAt = OBSERVED) =>
    envelope(seal({ v: 1, kind, protocolHash: protocol.hash, reviewer, observedAt, ...fields }));
  const resign = (record, updates) => envelope(reseal({ ...record.payload, ...updates }));
  const review = (kind, fields, at) => sign('owner', kind, {
    outcome: 'pass', attachment: retain(kind + ' fixture notes'), ...fields,
  }, at);
  const depReport = await dependencyReport(arms, report, retain, attachments);
  const imageSha256 = arms[1].image.sha256;
  const tests = M.TESTS.map(id => sign('execution', 'full-test', {
    id, imageSha256, command: 'fixture-test ' + id, exitCode: 0,
    passed: 10, failed: 0, skipped: 0, outcome: 'pass', log: retain('test log ' + id),
  }));
  const smokes = PROVIDERS.map(provider => {
    const { model } = rates[provider];
    const stages = Object.fromEntries(['analyzer', 'critic'].map(stage => {
      const output = stage === 'analyzer' ? { summary: [
        '🧭 BOTTOM LINE\nFixture summary.', '🧭 RISK LEVEL\nLow', '📥 WHAT THEY COLLECT\nNothing here.',
        '🔴 DATA SELLING & SHARING\nNot covered.', '🔴 OPT-OUT RIGHTS\nNot covered.',
        '📋 HOW TO OPT OUT RIGHT NOW\nNo specific steps.', '🟡 AUTO-RENEWAL & BILLING\nNot covered.',
        '🟢 DATA DELETION RIGHTS\nNot covered.',
      ].join('\n\n') } : { dataCollection: 'grounded', dataSelling: 'skipped', optOutRights: 'skipped',
        howToOptOut: 'vague', autoRenewal: 'skipped', dataDeletion: 'skipped', flags: [] };
      const content = stage === 'analyzer' ? output.summary : JSON.stringify(output);
      const requestId = provider + '-fixture-' + stage;
      const messages = [{ role: 'user', content: 'Fictional policy 0' }];
      const request = retain({ model, max_tokens: 50, messages });
      const response = retain(provider === 'anthropic' ? {
        id: requestId + '-response', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: content }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 3 },
      } : {
        id: requestId + '-response', object: 'chat.completion', created: Date.parse(OBSERVED) / 1000, model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });
      return [stage, { model, requestId, request, response, output: retain(output),
        usage: { inputTokens: 5, outputTokens: 3 }, costMicros: 11 }];
    }));
    return sign('execution', 'smoke', { provider, sampleId: 'case-0', imageSha256, outcome: 'pass',
      origin: mode === 'fixture' ? 'fixture' : 'captured-runtime', attemptCount: 1, stages, log: retain('smoke log ' + provider) });
  });
  const evidence = seal({
    v: 1, kind: 'maintenance-dependency-evidence', protocolHash: protocol.hash,
    classificationInput: input, classificationReport: report,
    preregistration: review('preregistration', {}, DECLARED),
    equivalence: sign('execution', 'equivalence', { measurementHash: digest(input), reportHash: report.hash, outcome: 'pass' }),
    dependencyReport: depReport,
    dependencyReview: review('dependency-review', { reportHash: depReport.hash, acceptedAdvisories: [] }),
    codeReview: className === 'E' ? review('code-review', { reportHash: report.hash }) : null,
    tests, smokes,
  });
  return { protocol, evidence, context: { attachments, trustedReviewers, trustedRates: rates, now: NOW }, retain, keys, resign, arms };
}

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
