'use strict';

// Disposable verifier and PostgreSQL fixtures. The credentials are generated in memory.
const crypto = require('node:crypto');
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

function createArms(retain, className, builds) {
  function file(path, text = path) {
    return { path, kind: 'file', mode: 0o644, ...retain(text) };
  }
  return ['baseline', 'candidate'].map((arm, index) => {
    const build = builds?.[index];
    const id = build?.id ?? arm;
    const release = makeRelease([]);
    release.config.policy.models.openai = { default: 'mock-openai', escalated: 'mock-openai-escalation', jury: 'mock-openai-jury' };
    release.config.policy.versions.serverPipeline = hashText(id);
    if (build?.migrationManifestHash) {
      release.config.policy.versions.migrationManifest = build.migrationManifestHash;
      release.config.policy.cache = { shared: 'disabled' };
    }
    release.configHash = S.releaseConfigHash(release.config);
    const version = build?.version ?? (index === 0 ? '1.0.0' : '1.0.1');
    const files = [file('index.js', build?.indexSource ?? (className === 'E' ? arm : 'index.js')), file('package.json', version),
      file('package-lock.json', JSON.stringify(lockfile(version))), file('llmRelay.js', className === 'Q' ? arm : 'llmRelay.js')];
    return {
      image: { ...retain('fictional image ' + id), manifestDigest: 'sha256:' + hashText('manifest ' + id) },
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

async function fixture({ className = 'D', mode = 'observed', smokeCapMicros = 1_000, builds, ownerKey } = {}) {
  const { attachments, retain } = attachmentStore();
  const arms = createArms(retain, className, builds);
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
    keys[role] = role === 'owner' && ownerKey ? ownerKey : crypto.generateKeyPairSync('ed25519');
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

module.exports = { fixture, createArms, createClassification, attachmentStore, DECLARED, OBSERVED, NOW, NAME };
