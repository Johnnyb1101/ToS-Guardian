'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { bodyHash } = require('../tools/final-corpus-lib');
const { reviewDependencies } = require('../tools/dependency-review');

const EMPTY_NPM_ADVISORIES = Buffer.from('{}');
const NAME = '@example/review-fixture';
const REGISTRY = 'https://registry.npmjs.org';
const KEY_TYPE = 'ecdsa-sha2-nistp256';
const PUBLISHED = '2026-01-10T00:00:00.000Z';
const FILE_HASH = 'a'.repeat(64);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fixture({ expires = null, added = false, removed = false, entering = false } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const sshHeader = Buffer.from('0000001365636473612d736861322d6e69737470323536000000086e6973747032353600000041', 'hex');
  const wireKey = Buffer.concat([sshHeader, der.subarray(-65)]);
  const keyid = 'SHA256:' + crypto.createHash('sha256').update(wireKey).digest('base64').replace(/=+$/, '');
  const keys = { keys: [{ keyid, key: der.toString('base64'), keytype: KEY_TYPE, scheme: KEY_TYPE, expires }] };
  const path = 'node_modules/' + NAME;
  const versions = {};
  const tarballs = {};
  const selected = entering ? ['1.1.0', '1.1.0'] : ['1.0.0', '1.1.0'];
  const images = selected.map((version, index) => {
    const tar = Buffer.from('fixture tarball ' + version);
    const integrity = 'sha512-' + crypto.createHash('sha512').update(tar).digest('base64');
    const route = `/${NAME}/-/review-fixture-${version}.tgz`;
    const sig = crypto.sign('sha256', Buffer.from(`${NAME}@${version}:${integrity}`), privateKey).toString('base64');
    tarballs[route] = tar;
    versions[version] = { name: NAME, version, dist: { tarball: REGISTRY + route, integrity, signatures: [{ sig, keyid }] } };
    const absent = added && index === 0 || removed && index === 1;
    const existing = 'node_modules/unchanged';
    const packages = { '': {}, [existing]: { version: '2.0.0' } };
    const installed = [{ name: 'unchanged', version: '2.0.0', path: existing, fileCount: 1, fileTreeSha256: FILE_HASH }];
    if (!absent) {
      packages[path] = { version, integrity, resolved: REGISTRY + route };
      if (entering && index === 0) packages[path].optional = true;
      else installed.push({ name: NAME, version, path, fileCount: 1, fileTreeSha256: FILE_HASH });
    }
    return { lockfileSha256: sha('lock ' + version), lockfile: { lockfileVersion: 3, packages }, installed };
  });
  const classification = { baseline: { image: { sha256: 'b'.repeat(64) } },
    candidate: { image: { sha256: 'c'.repeat(64) } }, hash: 'd'.repeat(64),
    packageDiff: [{ path, change: added || entering ? 'added' : removed ? 'removed' : 'changed',
      baseline: added || entering ? null : { path, name: NAME, version: '1.0.0' },
      candidate: removed ? null : { path, name: NAME, version: '1.1.0' } }] };
  const packument = { name: NAME, versions, time: { '1.0.0': PUBLISHED, '1.1.0': PUBLISHED } };
  return { classification, images, pair: 'activation', supplemental: [], packument, keys, tarballs, path };
}

function run(data, { advisoryResponse = () => EMPTY_NPM_ADVISORIES, scripts = {}, tamper = false } = {}) {
  const requests = [];
  const convert = value => Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const review = reviewDependencies(data, async (route, options) => {
    requests.push({ route, options });
    let bytes;
    if (route === '/-/npm/v1/keys') bytes = convert(data.keys);
    else if (route === '/' + encodeURIComponent(NAME)) bytes = convert(data.packument);
    else if (route === '/-/npm/v1/security/advisories/bulk') bytes = convert(advisoryResponse(options.query[NAME][0]));
    else {
      assert.ok(data.tarballs[route], 'Only the pinned npm tarball was requested');
      bytes = tamper ? Buffer.from('modified tarball') : data.tarballs[route];
    }
    return { bytes, sha256: sha(bytes), path: route };
  }, async files => files.map(file => {
    const version = file.path.split('/-/review-fixture-')[1].replace(/\.tgz$/, '');
    return { name: NAME, version, fileCount: 1, fileTreeSha256: FILE_HASH, scripts: scripts[version] ?? {} };
  }));
  return { review, requests };
}

const finding = { id: 'GHSA-xxxx-xxxx-xxxx', title: 'Offline fixture finding',
  severity: 'moderate', url: 'https://example.com/advisories/GHSA-xxxx-xxxx-xxxx' };

test('binds both exact images and lockfiles and submits one version at a time', async () => {
  const data = fixture();
  const { review, requests } = run(data);
  const report = await review;
  assert.equal(bodyHash(report), report.hash);
  assert.equal(report.status, 'awaiting-owner-review');
  assert.equal(report.promotionEligible, false);
  assert.deepEqual(report.baseline.image, data.classification.baseline.image);
  assert.equal(report.candidate.lockfileSha256, data.images[1].lockfileSha256);
  assert.deepEqual(requests.filter(entry => entry.options?.query).map(entry => entry.options.query),
    [{ [NAME]: ['1.0.0'] }, { [NAME]: ['1.1.0'] }]);
});

test('reports graph additions and removals and flags changed install scripts', async () => {
  const added = await run(fixture({ added: true }), { scripts: { '1.1.0': { postinstall: 'test fixture only' } } }).review;
  assert.equal(added.dependencies[0].change, 'added');
  assert.equal(added.blockers[0].kind, 'install-script-changes');
  const removed = await run(fixture({ removed: true })).review;
  assert.equal(removed.dependencies[0].change, 'removed');
  assert.equal(removed.versions.length, 1);
});

test('flags introduced advisories and adds independently sourced findings even when npm returns empty', async () => {
  const data = fixture();
  const observed = await run(data, { advisoryResponse: version => version === '1.1.0'
    ? { [NAME]: [{ ...finding, vulnerable_versions: '1.1.0' }] } : EMPTY_NPM_ADVISORIES }).review;
  assert.deepEqual(observed.blockers, [{ kind: 'new-runtime-advisory', path: data.path, ids: [finding.id] }]);
  data.supplemental = [{ ...finding, name: NAME, versions: ['1.1.0'] }];
  const supplemented = await run(data).review;
  assert.equal(supplemented.status, 'stopped');
  assert.equal(supplemented.versions[1].advisories[0].source, 'supplemental');
});

test('checks scripts and advisories when an optional package enters the runtime at the same version', async () => {
  const data = fixture({ entering: true });
  const report = await run(data, {
    scripts: { '1.1.0': { install: 'test fixture only' } },
    advisoryResponse: () => ({ [NAME]: [{ ...finding, vulnerable_versions: '1.1.0' }] }),
  }).review;
  assert.deepEqual(report.blockers.map(row => row.kind), ['install-script-changes', 'new-runtime-advisory']);
});
test('uses publication time for signing-key expiration and checks every signature', async () => {
  const before = await run(fixture({ expires: '2026-01-11T00:00:00.000Z' })).review;
  assert.equal(before.blockers.length, 0);
  await assert.rejects(run(fixture({ expires: PUBLISHED })).review, /signature failed/);
  const data = fixture();
  const valid = data.packument.versions['1.1.0'].dist.signatures[0];
  data.packument.versions['1.1.0'].dist.signatures.push({ ...valid, sig: Buffer.from('invalid').toString('base64') });
  await assert.rejects(run(data).review, /signature failed/);
});

test('stops on changed installed bytes and rejects changed lock pins, tarball bytes or audit shape', async () => {
  const changed = fixture();
  changed.images[1].installed[1].fileTreeSha256 = 'f'.repeat(64);
  const report = await run(changed).review;
  assert.deepEqual(report.blockers, [{ arm: 'candidate', kind: 'installed-content-mismatch', path: changed.path }]);
  await assert.rejects(run(fixture(), { tamper: true }).review, /tarball integrity failed/);
  await assert.rejects(run(fixture(), { advisoryResponse: () => [] }).review, /Invalid npm advisory response/);
  const bad = fixture();
  bad.images[1].lockfile.packages[bad.path].resolved = 'https://example.com/other.tgz';
  await assert.rejects(run(bad).review, /Unexpected lockfile resolution/);
  bad.classification.packageDiff = [];
  await assert.rejects(run(bad).review, /disagree with Checkpoint A/);
});
