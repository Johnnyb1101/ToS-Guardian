'use strict';

const { canonicalJson, digest, isHash, seal } = require('./final-corpus-lib');
const { checkRelease } = require('./sites-lib');

const MAX_ARCHIVE_BYTES = 1_000_000_000;
const MAX_INVENTORY_ENTRIES = 100_000;
const MAX_COMPARISONS = 10_000;
const DEPENDENCY_FILES = new Set(['package.json', 'package-lock.json']);
const SERVER_FILES = new Set(['index.js', 'release-policy.js']);
const VERSION_PATH = ['policy', 'versions'];
const SCHEMA_FIELDS = ['storageSchema', 'baselineSchema'];
const PROVIDERS = ['anthropic', 'openai'];
const STAGES = ['analyzer', 'critic', 'judge', 'escalation'];
const FIXTURE_OUTCOMES = {
  malformed: 'malformed-json', truncated: 'truncated', 'fenced-json': 'fenced-json',
  refusal: 'refusal', ordinary: 'parsed',
};

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value, fields, label) {
  if (!isObject(value) || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) {
    throw Error(`Invalid ${label} fields`);
  }
}

function boundedInteger(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function relativePath(path) {
  return typeof path === 'string' && path.length <= 4096 && !/[\\\x00-\x1f\x7f]/.test(path) &&
    path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

function records(entries, key, limit, label, validate) {
  if (!Array.isArray(entries) || entries.length > limit) throw Error(`Invalid ${label} list`);
  const byKey = new Map();
  for (const entry of entries) {
    validate(entry);
    if (byKey.has(entry[key])) throw Error(`Duplicate ${label}: ${entry[key]}`);
    byKey.set(entry[key], entry);
  }
  return new Map([...byKey.keys()].sort().map(name => [name, byKey.get(name)]));
}

function normalizeArm(arm, label) {
  exact(arm, ['image', 'release', 'inventory'], label);
  const { image, release, inventory } = arm;
  exact(image, ['sha256', 'bytes', 'manifestDigest'], `${label} image`);
  if (!isHash(image.sha256) || !boundedInteger(image.bytes, 1, MAX_ARCHIVE_BYTES) ||
      typeof image.manifestDigest !== 'string' || !/^(?:sha256:)?[a-f0-9]{64}$/.test(image.manifestDigest)) {
    throw Error(`Invalid ${label} image identity`);
  }
  const result = checkRelease(release);
  if (!result.valid) throw Error(`Invalid ${label} release: ${result.reason}`);
  const versions = release.config.policy.versions;
  if (!isHash(versions.serverPipeline) || [...SCHEMA_FIELDS, 'migrationManifest'].some(field => Object.hasOwn(versions, field) && !isHash(versions[field]))) {
    throw Error(`Invalid ${label} release fingerprint`);
  }

  exact(inventory, ['files', 'packages'], `${label} inventory`);
  const files = records(inventory.files, 'path', MAX_INVENTORY_ENTRIES, `${label} file`, file => {
    exact(file, ['path', 'kind', 'mode', 'bytes', 'sha256'], 'file');
    if (!relativePath(file.path) || file.path.split('/').includes('node_modules') || !['file', 'symlink'].includes(file.kind) ||
        !boundedInteger(file.mode, 0, 0o7777) || !boundedInteger(file.bytes, 0, MAX_ARCHIVE_BYTES) || !isHash(file.sha256)) {
      throw Error(`Invalid ${label} file descriptor`);
    }
  });
  if (!files.size) throw Error(`Empty ${label} application inventory`);
  const packages = records(inventory.packages, 'path', MAX_INVENTORY_ENTRIES, `${label} package`, entry => {
    exact(entry, ['path', 'name', 'version'], 'package');
    if (!relativePath(entry.path) || !entry.path.split('/').slice(0, -1).includes('node_modules') ||
        typeof entry.name !== 'string' || !/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]{1,214}$/.test(entry.name) ||
        typeof entry.version !== 'string' || !/^[0-9A-Za-z.+-]{1,256}$/.test(entry.version)) {
      throw Error(`Invalid ${label} package descriptor`);
    }
  });
  const identity = {
    image: { ...image, manifestDigest: `sha256:${image.manifestDigest.replace(/^sha256:/, '')}` },
    configHash: result.configHash,
    inventoryHash: digest({ files: [...files.values()], packages: [...packages.values()] }),
  };
  return { identity, config: release.config, files, packages };
}

function normalizeComparisons(entries, label) {
  return [...records(entries, 'id', MAX_COMPARISONS, label, entry => {
    exact(entry, ['id', 'baseline', 'candidate'], label);
    if (typeof entry.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(entry.id) ||
        !isHash(entry.baseline) || !isHash(entry.candidate)) throw Error(`Invalid ${label} observation`);
  }).values()];
}

function requestCoverage(requests) {
  const byCase = new Map();
  for (const { id } of requests) {
    const [sample, provider, stage, extra] = id.split(':');
    if (!sample || !PROVIDERS.includes(provider) || !STAGES.includes(stage) || extra !== undefined) return false;
    if (!byCase.has(sample)) byCase.set(sample, 0);
    byCase.set(sample, byCase.get(sample) + 1);
  }
  return byCase.size >= 6 && [...byCase.values()].every(count => count === PROVIDERS.length * STAGES.length);
}

function normalizeReplayInputs(entries) {
  return records(entries, 'id', MAX_COMPARISONS, 'replay input', entry => {
    exact(entry, ['id', 'inputDigest', 'origin', 'expected', 'outcomes'], 'replay input');
    if (typeof entry.id !== 'string' || !/^(?:anthropic|openai):[a-z0-9-]+$/.test(entry.id) ||
        !isHash(entry.inputDigest) || !['synthetic', 'recorded'].includes(entry.origin) ||
        !Array.isArray(entry.outcomes) || entry.outcomes.length !== 2 ||
        entry.outcomes.some(outcome => ![...Object.values(FIXTURE_OUTCOMES), 'provider-error'].includes(outcome)) ||
        (entry.origin === 'synthetic' ? !Object.values(FIXTURE_OUTCOMES).includes(entry.expected) : entry.expected !== null)) {
      throw Error('Invalid replay input evidence');
    }
  });
}

function replayCoverage(replays, inputs) {
  if (replays.length !== inputs.size || replays.some(({ id }) => !inputs.has(id))) return false;
  return PROVIDERS.every(provider =>
    Object.entries(FIXTURE_OUTCOMES).every(([id, expected]) => {
      const entry = inputs.get(provider + ':' + id);
      return entry?.origin === 'synthetic' && entry.expected === expected && entry.outcomes.every(value => value === expected);
    }) &&
    [...inputs.values()].some(entry => entry.id.startsWith(provider + ':recorded-') && entry.origin === 'recorded' &&
      entry.outcomes.every(value => value === 'parsed' || value === 'fenced-json'))
  );
}

function inventoryDiff(baseline, candidate) {
  const paths = [...new Set([...baseline.keys(), ...candidate.keys()])].sort();
  return paths.flatMap(path => {
    const before = baseline.get(path) ?? null;
    const after = candidate.get(path) ?? null;
    if (canonicalJson(before) === canonicalJson(after)) return [];
    return [{ path, change: before === null ? 'added' : after === null ? 'removed' : 'changed', baseline: before, candidate: after }];
  });
}

function configDiff(baseline, candidate, path = []) {
  if (isObject(baseline) && isObject(candidate)) {
    const keys = [...new Set([...Object.keys(baseline), ...Object.keys(candidate)])].sort();
    return keys.flatMap(key => configDiff(
      Object.hasOwn(baseline, key) ? baseline[key] : undefined,
      Object.hasOwn(candidate, key) ? candidate[key] : undefined,
      [...path, key],
    ));
  }
  if (baseline === undefined || candidate === undefined) {
    const change = baseline === undefined ? 'added' : 'removed';
    return [{ path, change, baseline: baseline ?? null, candidate: candidate ?? null }];
  }
  if (canonicalJson(baseline) === canonicalJson(candidate)) return [];
  return [{ path, change: 'changed', baseline, candidate }];
}

function versionChange({ path }, field) {
  return path.length === VERSION_PATH.length + 1 && path.at(-1) === field &&
    VERSION_PATH.every((part, index) => path[index] === part);
}

function structuralDecision(baseline, fileDiff, packageDiff, releaseDiff) {
  const unsupportedFile = fileDiff.some(({ path, baseline: before, candidate: after }) =>
    (!DEPENDENCY_FILES.has(path) && !SERVER_FILES.has(path)) ||
    (before && before.kind !== 'file') || (after && after.kind !== 'file') ||
    (before && after && before.mode !== after.mode));
  if (unsupportedFile) return ['Q', 'application-file-outside-allowlist'];

  const unsupportedConfig = releaseDiff.some(change =>
    !versionChange(change, 'serverPipeline') &&
    !(versionChange(change, 'migrationManifest') && change.change !== 'removed'));
  if (unsupportedConfig) return ['Q', 'release-configuration-outside-allowlist'];
  const migrationChanged = releaseDiff.some(change => versionChange(change, 'migrationManifest'));
  if (migrationChanged && SCHEMA_FIELDS.some(field => !isHash(baseline.config.policy.versions[field]))) {
    return ['Q', 'schema-fingerprints-unavailable-for-migration-change'];
  }
  if (migrationChanged || fileDiff.some(({ path }) => SERVER_FILES.has(path))) return ['E', 'allowlisted-server-or-migration-change'];
  if (fileDiff.length || packageDiff.length || releaseDiff.length) return ['D', 'allowlisted-dependency-change'];
  return ['Q', 'no-measured-release-change'];
}

function classifyRelease(input) {
  canonicalJson(input);
  const optional = ['requests', 'replays', 'replayInputs'].filter(key => Object.hasOwn(input, key));
  exact(input, ['baseline', 'candidate', ...optional], 'classification input');
  const { requests = [], replays = [], replayInputs = [] } = input;
  const baseline = normalizeArm(input.baseline, 'baseline');
  const candidate = normalizeArm(input.candidate, 'candidate');
  if (baseline.identity.image.sha256 === candidate.identity.image.sha256) throw Error('Distinct archive digests required');
  const fileDiff = inventoryDiff(baseline.files, candidate.files);
  const packageDiff = inventoryDiff(baseline.packages, candidate.packages);
  const releaseDiff = configDiff(baseline.config, candidate.config);
  const observedRequests = normalizeComparisons(requests, 'request');
  const observedReplays = normalizeComparisons(replays, 'replay');
  const replayInputRecords = normalizeReplayInputs(replayInputs);
  const comparisons = { requests: observedRequests, replays: observedReplays,
    replayInputs: [...replayInputRecords.values()], completeReplayEvidence: replayCoverage(observedReplays, replayInputRecords) };

  const [structuralClass, structuralReason] = structuralDecision(baseline, fileDiff, packageDiff, releaseDiff);
  let classification = structuralClass;
  let reason = structuralReason;
  if (structuralClass !== 'Q') {
    if (!comparisons.requests.length) reason = 'request-evidence-unavailable';
    else if (!requestCoverage(comparisons.requests)) reason = 'request-evidence-incomplete';
    else if (comparisons.requests.some(entry => entry.baseline !== entry.candidate)) reason = 'request-bytes-differ';
    else if (!comparisons.replays.length) reason = 'replay-evidence-unavailable';
    else if (comparisons.replays.some(entry => entry.baseline !== entry.candidate)) reason = 'replay-bytes-differ';
    else if (!comparisons.completeReplayEvidence) reason = 'replay-evidence-incomplete';
    if (reason !== structuralReason) classification = 'Q';
  }

  return seal({
    v: 1, kind: 'dependency-release-classification', offlineOnly: true, promotionEligible: false,
    classification, reason, structuralClass, structuralReason,
    baseline: baseline.identity, candidate: candidate.identity,
    fileDiff, packageDiff, releaseDiff, comparisons,
  });
}

module.exports = { classifyRelease };
