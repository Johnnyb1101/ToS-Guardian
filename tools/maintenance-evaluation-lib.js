'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const C = require('./final-corpus-lib');
const { checkRelease } = require('./sites-lib');
const { localPath } = require('./maintenance-local-path');

const FLAGS = Object.freeze({ diagnosticOnly: true, evaluationPassed: false, promotionEligible: false });
const TESTS = Object.freeze(['windows-tests', 'linux-tests', 'release-db', 'baseline-db', 'native-modules']);
const REVIEWS = Object.freeze(['maintenance-scope', 'independent-code-review']);
const KEYS = ['v', 'kind', 'diagnosticOnly', 'evaluationPassed', 'promotionEligible', 'baseline', 'candidate', 'allowedPolicyChanges', 'requiredTests', 'requiredReviews', 'liveProtocol', 'hash'];

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function hashFile(file) {
  const resolved = localPath(file);
  if (!fs.statSync(resolved).isFile()) throw new Error('Expected a regular local file');
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(resolved, 'r');
  const buffer = Buffer.alloc(65536);
  let bytes = 0;
  try {
    for (let count; (count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) {
      hash.update(buffer.subarray(0, count)); bytes += count;
    }
  } finally { fs.closeSync(fd); }
  if (!bytes) throw new Error('Empty build or evidence file');
  return { sha256: hash.digest('hex'), bytes };
}

function bindBuild(release, artifactFile, runtime) {
  const check = checkRelease(release);
  if (!check.valid) throw new Error(check.reason);
  if (!exactKeys(runtime, ['node', 'npm', 'platform', 'arch']) || Object.values(runtime).some(v => !C.nonempty(v))) throw new Error('Declare exact node, npm, platform and arch for the build');
  return { release, artifact: hashFile(artifactFile), runtime: { ...runtime } };
}

function createProtocol(baseline, candidate) {
  return C.seal({ v: 1, kind: 'maintenance-preparation', ...FLAGS, baseline, candidate,
    allowedPolicyChanges: ['versions.serverPipeline'], requiredTests: [...TESTS], requiredReviews: [...REVIEWS],
    liveProtocol: null });
}

function validateProtocol(protocol) {
  const reasons = [];
  C.checkSeal(protocol, 'protocol', reasons);
  if (!exactKeys(protocol, KEYS) || protocol.v !== 1 || protocol.kind !== 'maintenance-preparation') reasons.push('Unsupported preparation protocol');
  for (const [key, value] of Object.entries(FLAGS)) if (protocol?.[key] !== value) reasons.push(`protocol ${key} must remain ${value}`);
  if (protocol?.liveProtocol !== null) reasons.push('Live protocol is not approved or implemented');
  for (const [key, expected] of [['allowedPolicyChanges', ['versions.serverPipeline']], ['requiredTests', TESTS], ['requiredReviews', REVIEWS]]) {
    if (JSON.stringify(protocol?.[key]) !== JSON.stringify(expected)) reasons.push(`${key} cannot be reduced or expanded in this preparation`);
  }
  for (const arm of ['baseline', 'candidate']) {
    const build = protocol?.[arm];
    if (!exactKeys(build, ['release', 'artifact', 'runtime'])) { reasons.push(`${arm}: missing build binding`); continue; }
    const check = checkRelease(build.release);
    if (!check.valid) reasons.push(`${arm}: ${check.reason}`);
    if (!C.isHash(build.release?.config?.policy?.versions?.serverPipeline)) reasons.push(`${arm}: server runtime fingerprint required`);
    if (build.release?.config?.policy?.cache?.shared !== 'disabled') reasons.push(`${arm}: this preparation requires shared cache disabled`);
    if (!exactKeys(build.artifact, ['sha256', 'bytes']) || !C.isHash(build.artifact.sha256) || !Number.isSafeInteger(build.artifact.bytes) || build.artifact.bytes <= 0) reasons.push(`${arm}: invalid build artifact`);
    if (!exactKeys(build.runtime, ['node', 'npm', 'platform', 'arch']) || Object.values(build.runtime).some(v => !C.nonempty(v))) reasons.push(`${arm}: incomplete declared runtime`);
  }
  if (!reasons.length) {
    const fixed = build => {
      const config = JSON.parse(C.canonicalJson(build.release.config));
      delete config.policy.versions.serverPipeline;
      return config;
    };
    if (C.digest(fixed(protocol.baseline)) !== C.digest(fixed(protocol.candidate))) reasons.push('Lessons, sites, prompts, models, cache or other fixed policy changed');
  }
  return { valid: reasons.length === 0, reasons };
}

function evaluatePreparation(protocol, records = []) {
  const validation = validateProtocol(protocol);
  const reasons = [...validation.reasons], pending = [], seen = new Set();
  if (!Array.isArray(records)) { reasons.push('Evidence must be an array'); records = []; }
  for (const record of records) {
    const before = reasons.length;
    C.checkSeal(record, 'evidence', reasons);
    if (!exactKeys(record, ['v', 'kind', 'id', 'protocolHash', 'candidateConfigHash', 'candidateArtifactHash', 'outcome', 'author', 'summary', 'attachment', 'hash']) || record?.v !== 1 || !['test', 'review'].includes(record?.kind)) {
      reasons.push('Unsupported evidence record'); continue;
    }
    const required = record.kind === 'test' ? TESTS : REVIEWS;
    const key = `${record.kind}:${record.id}`;
    if (!required.includes(record.id) || seen.has(key)) reasons.push(`Unknown or duplicate evidence ${key}`);
    seen.add(key);
    if (record.protocolHash !== protocol?.hash || record.candidateConfigHash !== protocol?.candidate?.release?.configHash || record.candidateArtifactHash !== protocol?.candidate?.artifact?.sha256) reasons.push(`${key}: stale protocol, configuration or build binding`);
    if (!['pass', 'fail', 'skipped', 'unresolved'].includes(record.outcome)) reasons.push(`${key}: invalid outcome`);
    if (!C.nonempty(record.author) || !C.nonempty(record.summary)) reasons.push(`${key}: author and explanation required`);
    if (!exactKeys(record.attachment, ['sha256', 'bytes']) || !C.isHash(record.attachment.sha256) || !Number.isSafeInteger(record.attachment.bytes) || record.attachment.bytes <= 0) reasons.push(`${key}: nonempty evidence attachment required`);
    if (record.outcome !== 'pass' || before !== reasons.length) pending.push(key);
  }
  for (const [kind, ids] of [['test', TESTS], ['review', REVIEWS]]) for (const id of ids) if (!seen.has(`${kind}:${id}`)) pending.push(`${kind}:${id}`);
  return C.seal({ v: 1, kind: 'maintenance-preparation-report', ...FLAGS,
    protocolHash: C.isHash(protocol?.hash) ? protocol.hash : null,
    suppliedEvidenceCount: records.length, structurallyComplete: !reasons.length && !pending.length,
    reasons, pending, blockers: ['Offline preparation cannot establish real evaluation success or authorize signing, activation or deployment', 'Live protocol, sample coverage, model choices and spending remain unapproved'],
    limitations: ['File hashes bind supplied bytes, not build provenance or successful execution', 'Runtime labels and test/review outcomes are supplied attestations, not independently authenticated claims', 'No provider, human-quality, fresh-document or production-health test is performed'] });
}

function recordEvidence(protocol, { kind, id, outcome, author, summary, attachmentFile }) {
  const validation = validateProtocol(protocol);
  if (!validation.valid) throw new Error(validation.reasons.join('; '));
  return C.seal({ v: 1, kind, id, protocolHash: protocol.hash,
    candidateConfigHash: protocol.candidate.release.configHash, candidateArtifactHash: protocol.candidate.artifact.sha256,
    outcome, author, summary, attachment: hashFile(attachmentFile) });
}

function checkLocalFile(file, expected) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Local binding requires an absolute file path');
  if (C.digest(hashFile(file)) !== C.digest(expected)) throw new Error('Local build or evidence bytes changed; create a new preparation or evidence record');
}

module.exports = { FLAGS, TESTS, REVIEWS, hashFile, bindBuild, createProtocol, validateProtocol, evaluatePreparation, recordEvidence, checkLocalFile };
