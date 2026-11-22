'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { canonicalJson, checkSeal, isHash, seal } = require('./final-corpus-lib');
const { localPath, localPaths } = require('./maintenance-local-path');
const { parseUnambiguousJson } = require('./maintenance-observed-live-transport');

const REGISTRY = 'https://registry.npmjs.org';
const ADVISORIES = '/-/npm/v1/security/advisories/bulk';
const KEYS = '/-/npm/v1/keys';
const MAX_JSON = 32 * 1024 * 1024;
const MAX_TARBALL = 128 * 1024 * 1024;
const MAX_PACKAGES = 5000;
const P256 = 'ecdsa-sha2-nistp256';
const UMOCI_SHA256 = 'b51c267ec394499e42c6fde47f240b7b7dba57ea49df0b5acd304378b82a3b71';
const NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const INSTALLER_SUPPRESSED = ['dev', 'optional', 'devOptional'];
const MAINTAINER_FINDINGS = [
  {
    name: 'express-rate-limit', versions: ['8.7.1', '8.7.4'],
    id: 'GHSA-cppf-2hm6-mrvm', severity: 'moderate',
    title: 'Prototype pollution can disable rate limiting',
    url: 'https://github.com/express-rate-limit/express-rate-limit/security/advisories/GHSA-cppf-2hm6-mrvm',
  },
  {
    name: 'express-rate-limit', versions: ['8.7.1'],
    id: 'GHSA-j3cq-92fq-qg5f', severity: 'low',
    title: 'MemoryStore counter can be decremented after its window resets',
    url: 'https://github.com/express-rate-limit/express-rate-limit/security/advisories/GHSA-j3cq-92fq-qg5f',
  },
];

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = bytes => parseUnambiguousJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
const same = (a, b) => canonicalJson(a) === canonicalJson(b);

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function tarballPath(name, version) {
  return `/${name}/-/${name.split('/').at(-1)}-${version}.tgz`;
}

function base64(value, label) {
  requireCondition(typeof value === 'string' && value.length <= 512, `Invalid ${label}`);
  const bytes = Buffer.from(value, 'base64');
  requireCondition(bytes.length > 0 && bytes.toString('base64') === value, `Invalid ${label}`);
  return bytes;
}

function integrity(value) {
  requireCondition(typeof value === 'string' && value.startsWith('sha512-') &&
    base64(value.slice(7), 'SHA-512 integrity').length === 64, 'Expected a single SHA-512 SRI');
  return value;
}

function date(value) {
  requireCondition(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, 'Invalid registry timestamp');
  return Date.parse(value);
}

function sshFingerprint(key) {
  // npm IDs hash the SSH wire representation, while the supplied key is DER.
  const { x, y } = key.export({ format: 'jwk' });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(x, 'base64url'), Buffer.from(y, 'base64url')]);
  const hash = crypto.createHash('sha256');
  for (const field of [Buffer.from(P256), Buffer.from('nistp256'), point]) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(field.length);
    hash.update(length).update(field);
  }
  return 'SHA256:' + hash.digest('base64').replace(/=+$/, '');
}

function registryKeys(body) {
  requireCondition(Array.isArray(body?.keys) && body.keys.length > 0 && body.keys.length <= 20,
    'Registry signing keys are missing');
  const keys = new Map();
  for (const record of body.keys) {
    requireCondition(record?.keytype === P256 && record.scheme === P256, 'Unsupported registry signing key');
    const der = base64(record.key, 'registry public key');
    const key = crypto.createPublicKey({ key: der, type: 'spki', format: 'der' });
    requireCondition(key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails.namedCurve === 'prime256v1',
      'Expected an ECDSA P-256 registry public key');
    requireCondition(record.keyid === sshFingerprint(key) && !keys.has(record.keyid), 'Invalid or repeated registry key ID');
    keys.set(record.keyid, { key, expires: record.expires === null ? Infinity : date(record.expires) });
  }
  return keys;
}

function verifyManifest(packument, identity, keys) {
  const { name, version } = identity;
  const manifest = packument?.versions?.[version];
  requireCondition(packument?.name === name && manifest?.name === name && manifest.version === version,
    `Registry manifest identity mismatch for ${name}@${version}`);
  const published = packument.time?.[version];
  const mintedAt = date(published);
  const dist = manifest.dist;
  const expectedPath = tarballPath(name, version);
  requireCondition(dist?.tarball === REGISTRY + expectedPath && Array.isArray(dist.signatures) &&
    dist.signatures.length > 0 && dist.signatures.length <= 20, `Missing registry tarball or signature for ${name}@${version}`);
  const signedIntegrity = integrity(dist.integrity);
  const signed = Buffer.from(`${name}@${version}:${signedIntegrity}`);
  const signerKeyIds = new Set();
  for (const signature of dist.signatures) {
    const record = keys.get(signature?.keyid);
    requireCondition(record && mintedAt < record.expires &&
      crypto.verify('sha256', signed, record.key, base64(signature.sig, 'registry signature')),
    `Registry signature failed for ${name}@${version}`);
    signerKeyIds.add(signature.keyid);
  }
  return { published, integrity: signedIntegrity, signerKeyIds: [...signerKeyIds].sort(), tarballPath: expectedPath };
}

function packageState(image) {
  requireCondition(isHash(image?.lockfileSha256) && image.lockfile?.lockfileVersion === 3 &&
    object(image.lockfile.packages) && Array.isArray(image.installed) && image.installed.length <= MAX_PACKAGES,
  'An image must contain an npm v3 lock and an installed inventory');
  const installed = new Map();
  for (const item of image.installed) {
    requireCondition(typeof item.path === 'string' && !installed.has(item.path) &&
      isHash(item.fileTreeSha256) && Number.isSafeInteger(item.fileCount) && item.fileCount > 0,
    'Invalid installed package measurement');
    installed.set(item.path, item);
  }
  const locked = new Map();
  for (const [location, entry] of Object.entries(image.lockfile.packages)) {
    if (location === '') continue;
    const chain = location.split(/(?:^|\/)node_modules\//);
    const name = chain.at(-1);
    requireCondition(chain[0] === '' && chain.length > 1 && chain.slice(1).every(part => NAME.test(part)) &&
      object(entry) && !entry.link && (entry.name === undefined || entry.name === name) &&
      name.length <= 214 && typeof entry.version === 'string' && entry.version.length <= 128 && VERSION.test(entry.version),
    `Unsupported lockfile dependency at ${location}`);
    const present = installed.get(location);
    requireCondition(present ? present.name === name && present.version === entry.version
      : INSTALLER_SUPPRESSED.some(flag => entry[flag] === true), `Installed package does not match lock at ${location}`);
    locked.set(location, {
      name, version: entry.version, resolved: entry.resolved ?? null, integrity: entry.integrity ?? null,
      installed: present ? { fileCount: present.fileCount, fileTreeSha256: present.fileTreeSha256 } : null,
    });
    installed.delete(location);
  }
  requireCondition(installed.size === 0 && locked.size > 0 && locked.size <= MAX_PACKAGES, 'Unmatched installed dependency');
  return locked;
}

function dependencyChanges(baseline, candidate, classification) {
  const previous = packageState(baseline);
  const next = packageState(candidate);
  const changes = [];
  const observed = [];
  for (const location of [...new Set([...previous.keys(), ...next.keys()])].sort()) {
    const before = previous.get(location) ?? null;
    const after = next.get(location) ?? null;
    const bare = entry => entry?.installed ? { path: location, name: entry.name, version: entry.version } : null;
    const beforeId = bare(before);
    const afterId = bare(after);
    if (!same(beforeId, afterId)) {
      observed.push({ path: location, baseline: beforeId, candidate: afterId,
        change: !beforeId ? 'added' : !afterId ? 'removed' : 'changed' });
    }
    if (!same(before, after)) changes.push({ path: location, before, after });
  }
  requireCondition(same(observed, classification.packageDiff), 'Installed dependency changes disagree with Checkpoint A');
  return changes;
}

function advisory(row, name, source) {
  requireCondition(object(row) && (row.name === undefined || row.name === name) &&
    (typeof row.id === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(row.id) || Number.isSafeInteger(row.id)) &&
    ['info', 'low', 'moderate', 'high', 'critical'].includes(row.severity) &&
    typeof row.title === 'string' && row.title.length > 0 && row.title.length <= 400 &&
    typeof row.url === 'string' && row.url.length <= 500, `Invalid advisory for ${name}`);
  const url = new URL(row.url);
  requireCondition(url.protocol === 'https:' && !url.username && !url.password, `Invalid advisory source for ${name}`);
  const ghsa = url.pathname.match(/\/(GHSA-[a-z0-9-]+)$/i)?.[1];
  return { id: ghsa ?? String(row.id), title: row.title, severity: row.severity, url: row.url, source };
}

function addSupplement(versions, supplemental, source) {
  requireCondition(Array.isArray(supplemental) && supplemental.length <= 100, 'Invalid supplemental advisory list');
  for (const entry of supplemental) {
    requireCondition(Array.isArray(entry?.versions) && entry.versions.length > 0 &&
      entry.versions.every(version => typeof version === 'string' && VERSION.test(version)),
    'Supplemental advisories must name the exact affected versions');
    const finding = advisory(entry, entry.name, source);
    let matched = false;
    for (const version of entry.versions) {
      const target = versions.get(`${entry.name}@${version}`);
      if (!target) continue;
      requireCondition(!target.advisories.some(row => row.id === finding.id && row.source === finding.source),
        'Duplicate supplemental advisory');
      target.advisories.push(finding);
      matched = true;
    }
    requireCondition(matched || source === 'maintainer', 'Supplemental advisory does not match any reviewed version');
  }
}

async function reviewDependencies({ classification, images, pair, supplemental }, capture, inspectTarballs) {
  const changes = dependencyChanges(...images, classification);
  const versions = new Map();
  for (const { before, after } of changes) {
    for (const entry of [before, after].filter(Boolean)) {
      const id = `${entry.name}@${entry.version}`;
      const previous = versions.get(id);
      requireCondition(entry.resolved === REGISTRY + tarballPath(entry.name, entry.version) &&
        (!previous || previous.integrity === entry.integrity), `Unexpected lockfile resolution for ${id}`);
      if (!previous) versions.set(id, { name: entry.name, version: entry.version,
        integrity: integrity(entry.integrity), advisories: [] });
    }
  }
  requireCondition(versions.size <= 200, 'Too many changed dependency versions for one review');

  const packuments = new Map();
  const keys = versions.size ? await capture(KEYS) : null;
  const signers = keys && registryKeys(json(keys.bytes));
  const tarballs = [];
  for (const [id, entry] of versions) {
    const { name, version } = entry;
    if (!packuments.has(name)) {
      const retained = await capture('/' + encodeURIComponent(name));
      packuments.set(name, { body: json(retained.bytes), sha256: retained.sha256 });
    }
    const packument = packuments.get(name);
    const signed = verifyManifest(packument.body, entry, signers);
    requireCondition(entry.integrity === signed.integrity, `Signed registry integrity disagrees with lock for ${id}`);
    const tarball = await capture(signed.tarballPath, { tarball: true });
    const actual = 'sha512-' + crypto.createHash('sha512').update(tarball.bytes).digest('base64');
    requireCondition(actual === entry.integrity, `Registry tarball integrity failed for ${id}`);
    tarballs.push({ path: tarball.path, sha256: tarball.sha256 });
    const query = { [name]: [version] };
    const audit = await capture(ADVISORIES, { query });
    const hits = json(audit.bytes);
    requireCondition(object(hits) && Object.keys(hits).every(key => key === name) &&
      (!Object.hasOwn(hits, name) || Array.isArray(hits[name]) && hits[name].length <= 100),
    `Invalid npm advisory response for ${id}`);
    for (const row of hits[name] ?? []) {
      requireCondition(typeof row?.vulnerable_versions === 'string' && row.vulnerable_versions.length > 0 &&
        row.vulnerable_versions.length <= 500, `Missing npm advisory range for ${id}`);
      entry.advisories.push({ ...advisory(row, name, 'npm'), range: row.vulnerable_versions });
    }
    Object.assign(entry, { signerKeyIds: signed.signerKeyIds, published: signed.published,
      packumentSha256: packument.sha256, tarballSha256: tarball.sha256, npmAdvisorySha256: audit.sha256 });
  }
  // Preserve published findings that npm's live feed omits for these exact versions.
  addSupplement(versions, MAINTAINER_FINDINGS, 'maintainer');
  addSupplement(versions, supplemental, 'supplemental');
  if (tarballs.length) {
    const measured = await inspectTarballs(tarballs);
    requireCondition(measured.length === versions.size, 'Incomplete registry tarball measurements');
    let index = 0;
    for (const entry of versions.values()) {
      const { name, version, ...files } = measured[index++];
      requireCondition(name === entry.name && version === entry.version, 'Registry tarball manifest identity mismatch');
      Object.assign(entry, files);
    }
  }

  const blockers = [];
  const dependencies = changes.map(({ path: location, before, after }) => {
    const evidence = entry => entry && versions.get(`${entry.name}@${entry.version}`);
    const previous = evidence(before);
    const next = evidence(after);
    for (const [arm, entry, reference] of [['baseline', before, previous], ['candidate', after, next]]) {
      if (entry?.installed && (entry.installed.fileTreeSha256 !== reference.fileTreeSha256 ||
          entry.installed.fileCount !== reference.fileCount)) {
        blockers.push({ kind: 'installed-content-mismatch', path: location, arm });
      }
    }
    const scriptChange = !same(previous?.scripts ?? {}, next?.scripts ?? {});
    if (after?.installed && (scriptChange || !before?.installed) && Object.keys(next?.scripts ?? {}).length) {
      blockers.push({ kind: 'install-script-changes', path: location });
    }
    const introduced = [...new Set((next?.advisories ?? []).map(row => row.id))]
      .filter(id => !before?.installed || !(previous?.advisories ?? []).some(row => row.id === id));
    if (after?.installed && introduced.length) {
      blockers.push({ kind: 'new-runtime-advisory', path: location, ids: introduced });
    }
    return { path: location, change: !before ? 'added' : !after ? 'removed' : 'changed', before, after,
      scriptChange, introducedAdvisories: introduced };
  });
  return seal({
    v: 1, kind: 'dependency-review', pair, measuredAt: new Date().toISOString(),
    baseline: { image: classification.baseline.image, lockfileSha256: images[0].lockfileSha256 },
    candidate: { image: classification.candidate.image, lockfileSha256: images[1].lockfileSha256 },
    classificationHash: classification.hash, registry: REGISTRY, registryKeysSha256: keys?.sha256 ?? null,
    dependencies, versions: [...versions.values()], blockers,
    status: blockers.length ? 'stopped' : 'awaiting-owner-review', promotionEligible: false,
  });
}

async function registryRequest(route, { query, tarball } = {}) {
  const url = new URL(route, REGISTRY);
  requireCondition(url.origin === REGISTRY && !url.username && !url.password && !url.search && !url.hash,
    'npm registry is the only allowed network destination');
  const limit = tarball ? MAX_TARBALL : MAX_JSON;
  const response = await fetch(url, {
    redirect: 'error', signal: AbortSignal.timeout(60_000),
    ...(query ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(query) } : {}),
  });
  requireCondition(response.ok && response.body, `npm registry returned HTTP ${response.status} for ${route}`);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    requireCondition(length <= limit, 'Registry response exceeded size bound');
    chunks.push(chunk);
  }
  requireCondition(length > 0, 'Empty npm registry response');
  return Buffer.concat(chunks, length);
}

function readJson(file) {
  requireCondition(fs.statSync(file).isFile() && fs.statSync(file).size <= MAX_JSON, 'Expected bounded local JSON');
  return json(fs.readFileSync(file));
}

function wslPath(absolute) {
  return '/mnt/' + absolute[0].toLowerCase() + absolute.slice(2).replaceAll('\\', '/');
}

function runInspector(mode, input) {
  const windows = process.env.SystemRoot;
  requireCondition(typeof windows === 'string' && /^[a-z]:\\Windows$/i.test(windows), 'Trusted Windows WSL required');
  const helper = wslPath(localPath(path.join(__dirname, 'dependency-review-image.py')));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(SystemRoot|WINDIR|PATH|TMP|TEMP)$/i.test(name)));
  const result = spawnSync(path.join(windows, 'System32', 'wsl.exe'),
    ['--user', 'root', '--exec', '/usr/bin/python3', '-I', helper, mode],
    { input: JSON.stringify(input), windowsHide: true, env, maxBuffer: MAX_JSON, timeout: 900_000 });
  if (result.error) throw result.error;
  requireCondition(result.status === 0, `Dependency inspection failed: ${result.stderr.toString('utf8').trim()}`);
  return json(result.stdout);
}

async function main(args) {
  const [pair, inputFile, classificationFile, outputDirectory, supplementalFile] = args;
  requireCondition(['activation', 'recovery'].includes(pair) && [4, 5].includes(args.length),
    'Usage: node tools/dependency-review.js <activation|recovery> <checkpoint-a-input.json> <classification.json> <new-output-dir> [supplemental-advisories.json]');
  const inputs = readJson(localPath(inputFile));
  const classification = readJson(localPath(classificationFile));
  const errors = [];
  checkSeal(classification, 'Checkpoint A', errors);
  requireCondition(!errors.length && classification.kind === 'dependency-release-classification' &&
    classification.offlineOnly === true && ['D', 'E'].includes(classification.classification), 'Expected a verified Checkpoint A report');
  const arms = [inputs.baseline, inputs.candidate];
  const archives = localPaths(arms.map(arm => arm.archivePath));
  const images = arms.map((arm, index) => {
    const { image } = arm;
    requireCondition(same(image, classification[index === 0 ? 'baseline' : 'candidate'].image) &&
      isHash(image.sha256) && /^sha256:[0-9a-f]{64}$/.test(image.manifestDigest) &&
      Number.isSafeInteger(image.bytes) && image.bytes > 0 && image.bytes <= 1_000_000_000, 'Invalid OCI image binding');
    return { ...image, archivePath: wslPath(archives[index]) };
  });
  const { imageLauncherSha256, umociPath, umociSha256 } = inputs.imageRuntime;
  requireCondition(isHash(imageLauncherSha256) && umociSha256 === UMOCI_SHA256 &&
    /^\/[A-Za-z0-9_./-]+$/.test(umociPath) && !umociPath.split('/').includes('..'), 'Expected approved OCI tools');
  const supplemental = supplementalFile ? readJson(localPath(supplementalFile)) : [];
  const inspected = runInspector('images', { imageLauncherSha256, umociPath, umociSha256, images });
  const out = localPath(outputDirectory, { allowMissing: true });
  fs.mkdirSync(out);
  const artifacts = path.join(out, 'evidence');
  fs.mkdirSync(artifacts);
  async function capture(route, options) {
    const bytes = await registryRequest(route, options);
    const hash = sha256(bytes);
    const file = path.join(artifacts, hash);
    if (!fs.existsSync(file)) fs.writeFileSync(file, bytes, { flag: 'wx' });
    else requireCondition(sha256(fs.readFileSync(file)) === hash, 'Registry attachment was modified');
    return { bytes, sha256: hash, path: wslPath(file) };
  }
  const report = await reviewDependencies({ classification, images: inspected, pair, supplemental }, capture,
    tarballs => runInspector('tarballs', tarballs));
  fs.writeFileSync(path.join(out, 'dependency-review.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(`Dependency review ${pair}: ${report.status} (${report.dependencies.length} changed paths, ${report.versions.length} reviewed versions)`);
  if (report.blockers.length) process.exitCode = 2;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { reviewDependencies };
