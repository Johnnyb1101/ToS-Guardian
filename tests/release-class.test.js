'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { bodyHash, hashText } = require('../tools/final-corpus-lib');
const { releaseConfigHash } = require('../tools/sites-lib');
const { classifyRelease } = require('../tools/release-class-lib');

function file(path, text = path) {
  return { path, kind: 'file', mode: 0o644, bytes: Buffer.byteLength(text), sha256: hashText(text) };
}

function release(config) {
  return { v: 2, configHash: releaseConfigHash(config), config };
}

function pair() {
  const config = {
    lessons: [], sites: [],
    policy: {
      models: { analyzer: 'test-model' },
      promptHashes: { analyzer: hashText('analyzer'), critic: hashText('critic'), jury: hashText('jury') },
      limits: { maxLessonsPerTarget: 12, maxTokens: 5 },
      selection: { order: 'explicit' },
      rubricHash: hashText('rubric'),
      versions: {
        resolver: '1', classifier: '1', excerpt: '1', escalation: '1', evaluator: '1', siteLookup: '1', pipeline: '1',
        serverPipeline: hashText('server'), storageSchema: hashText('storage'), baselineSchema: hashText('baseline schema'),
      },
    },
  };
  const baseline = {
    image: { sha256: hashText('archive A'), bytes: 1000, manifestDigest: `sha256:${hashText('manifest A')}` },
    release: release(config),
    inventory: {
      files: [file('index.js'), file('package.json'), file('package-lock.json'), file('llmRelay.js')],
      packages: [{ path: 'node_modules/example', name: 'example', version: '1.0.0' }],
    },
  };
  const candidate = structuredClone(baseline);
  candidate.image.sha256 = hashText('archive B');
  candidate.image.manifestDigest = hashText('manifest B');
  candidate.release.config.policy.versions.serverPipeline = hashText('server B');
  candidate.release = release(candidate.release.config);
  candidate.inventory.files[1] = file('package.json', 'updated package');
  candidate.inventory.packages[0].version = '1.0.1';
  const providers = ['anthropic', 'openai'];
  const comparison = id => ({ id, baseline: hashText(id), candidate: hashText(id) });
  const requests = Array.from({ length: 6 }, (_, i) => providers.flatMap(provider =>
    ['analyzer', 'critic', 'judge', 'escalation'].map(stage => comparison('case-' + i + ':' + provider + ':' + stage)))).flat();
  const fixtures = {
    malformed: 'malformed-json', truncated: 'truncated', 'fenced-json': 'fenced-json',
    refusal: 'refusal', ordinary: 'parsed',
  };
  const replayInputs = providers.flatMap(provider => [
    ...Object.entries(fixtures).map(([name, expected]) => {
      const id = provider + ':' + name;
      return { id, origin: 'synthetic', inputDigest: hashText(id), expected, outcomes: [expected, expected] };
    }),
    { id: provider + ':recorded-prior', origin: 'recorded', inputDigest: hashText(provider), expected: null,
      outcomes: ['parsed', 'parsed'] },
  ]);
  return {
    baseline, candidate, requests, replayInputs, replays: replayInputs.map(({ id }) => comparison(id)),
  };
}

test('classifies package changes and seals ordered identities and diffs', () => {
  const input = pair();
  input.baseline.inventory.packages.push({ path: 'node_modules/old', name: 'old', version: '0.1.0' });
  input.candidate.inventory.packages.push({ path: 'node_modules/example/node_modules/@scope/new', name: '@scope/new', version: '2.3.4-alpha.0' });
  const result = classifyRelease(input);
  assert.equal(result.classification, 'D');
  assert.equal(result.structuralClass, 'D');
  assert.equal(result.promotionEligible, false);
  assert.equal(result.offlineOnly, true);
  assert.equal(bodyHash(result), result.hash);
  assert.equal(result.candidate.image.manifestDigest, `sha256:${input.candidate.image.manifestDigest}`);
  assert.deepEqual(result.fileDiff.map(entry => [entry.path, entry.change]), [['package.json', 'changed']]);
  assert.deepEqual(result.packageDiff.map(entry => entry.change), ['changed', 'added', 'removed']);
  assert.deepEqual(result.releaseDiff.map(entry => entry.path), [['policy', 'versions', 'serverPipeline']]);
  input.candidate.inventory.files.reverse();
  input.candidate.inventory.packages.reverse();
  assert.equal(classifyRelease(input).hash, result.hash);
});

test('classifies server code and a migration fingerprint as E with unchanged schemas', () => {
  const input = pair();
  input.candidate.inventory.files[0] = file('index.js', 'revised server route');
  input.candidate.inventory.files.push(file('release-policy.js'));
  input.candidate.release.config.policy.versions.migrationManifest = hashText('migration inventory');
  input.candidate.release = release(input.candidate.release.config);
  const report = classifyRelease(input);
  assert.equal(report.classification, 'E');
  assert.deepEqual(report.fileDiff.map(entry => [entry.path, entry.change]), [
    ['index.js', 'changed'], ['package.json', 'changed'], ['release-policy.js', 'added'],
  ]);
  assert.equal(report.releaseDiff[0].change, 'added');
});

test('policy changes affecting quality and ambiguous dotted keys force Q', () => {
  const changes = [
    policy => { policy.promptHashes.analyzer = hashText('changed prompt'); },
    policy => { policy.models.analyzer = 'different-model'; },
    policy => { policy.limits.maxTokens = 6; },
    policy => { policy.versions.pipeline = '2'; },
    policy => { policy.versions.storageSchema = hashText('changed storage'); },
    policy => { policy.versions.baselineSchema = hashText('changed baseline'); },
    policy => { policy.rubricHash = hashText('changed rubric'); },
    policy => { policy.toString = 'added own property'; },
    policy => { policy['versions.serverPipeline'] = hashText('ambiguous version'); },
  ];
  for (const change of changes) {
    const input = pair();
    change(input.candidate.release.config.policy);
    input.candidate.release = release(input.candidate.release.config);
    assert.equal(classifyRelease(input).reason, 'release-configuration-outside-allowlist');
  }
});

test('migration fingerprint changes require positive evidence for both unchanged schemas', () => {
  const input = pair();
  delete input.baseline.release.config.policy.versions.storageSchema;
  delete input.candidate.release.config.policy.versions.storageSchema;
  input.candidate.release.config.policy.versions.migrationManifest = hashText('new inventory');
  for (const arm of [input.baseline, input.candidate]) arm.release = release(arm.release.config);
  assert.equal(classifyRelease(input).reason, 'schema-fingerprints-unavailable-for-migration-change');

  const removal = pair();
  removal.baseline.release.config.policy.versions.migrationManifest = hashText('old inventory');
  removal.baseline.release = release(removal.baseline.release.config);
  assert.equal(classifyRelease(removal).reason, 'release-configuration-outside-allowlist');
});

test('unallowlisted file changes and metadata changes are retained and force Q', () => {
  const input = pair();
  const [removed] = input.candidate.inventory.files.splice(3, 1);
  input.candidate.inventory.files.push(file('added.js'));
  const result = classifyRelease(input);
  assert.equal(result.classification, 'Q');
  assert.deepEqual(result.fileDiff[0], { path: 'added.js', change: 'added', baseline: null, candidate: file('added.js') });
  assert.deepEqual(result.fileDiff[1], { path: 'llmRelay.js', change: 'removed', baseline: removed, candidate: null });
  const modeChanged = pair();
  modeChanged.candidate.inventory.files[1].mode = 0o755;
  assert.equal(classifyRelease(modeChanged).classification, 'Q');
});

test('missing, partial, or unequal observations prevent D and E', () => {
  const checks = [
    [input => { delete input.requests; }, 'request-evidence-unavailable'],
    [input => { input.requests.pop(); }, 'request-evidence-incomplete'],
    [input => { delete input.replays; }, 'replay-evidence-unavailable'],
    [input => { delete input.replayInputs; }, 'replay-evidence-incomplete'],
    [input => { input.replays.pop(); input.replayInputs.pop(); }, 'replay-evidence-incomplete'],
    [input => { input.replayInputs.at(-1).outcomes = ['provider-error', 'provider-error']; }, 'replay-evidence-incomplete'],
    [input => { input.requests[0].candidate = hashText('requesT'); }, 'request-bytes-differ'],
    [input => { input.replays[0].candidate = hashText('replaY'); }, 'replay-bytes-differ'],
  ];
  for (const [change, reason] of checks) {
    for (const structuralClass of ['D', 'E']) {
      const input = pair();
      if (structuralClass === 'E') input.candidate.inventory.files[0] = file('index.js', 'changed');
      change(input);
      const report = classifyRelease(input);
      assert.equal(report.structuralClass, structuralClass);
      assert.equal(report.classification, 'Q');
      assert.equal(report.reason, reason);
    }
  }
});

test('rejects duplicate evidence, invalid inventory entries, and invalid identities', () => {
  const checks = [
    [input => { input.requests.push(input.requests[0]); }, /Duplicate request/],
    [input => { input.replays.push(input.replays[0]); }, /Duplicate replay/],
    [input => { input.candidate.inventory.files.push(file('package.json')); }, /Duplicate candidate file/],
    [input => { input.candidate.inventory.files.push(file('../index.js')); }, /Invalid candidate file descriptor/],
    [input => { input.baseline.image.bytes = 1_000_000_001; }, /Invalid baseline image identity/],
    [input => { input.candidate.release.configHash = hashText('unbound release'); }, /Invalid candidate release/],
  ];
  for (const [change, pattern] of checks) {
    const input = pair();
    change(input);
    assert.throws(() => classifyRelease(input), pattern);
  }
});
