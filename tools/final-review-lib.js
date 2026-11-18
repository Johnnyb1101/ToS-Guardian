'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalJson, digest, hashText } = require('./final-corpus-lib');

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{32}$/;
const FINDINGS = new Set(['claim', 'omission']);
const VERDICTS = new Set(['supported', 'unsupported', 'unsure']);
const MAX_TEXT = 2000;
const FLAGS = Object.freeze({ diagnosticOnly: true, promotionEligible: false, evaluationPassed: false });

function sha256(value) { return hashText(value); }
function sealedHash(value) {
  const { hash, ...body } = value;
  return digest(body);
}
function isHash(value) { return typeof value === 'string' && HASH.test(value); }
function ownKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
}
function hasFlags(value) { return Object.entries(FLAGS).every(([key, expected]) => value?.[key] === expected); }

function selectedHeads(artifacts) {
  if (!Array.isArray(artifacts) || !artifacts.length) throw new Error('artifacts must be a nonempty array');
  const chains = new Map();
  const hashes = new Set();
  const ids = new Set();
  let protocolHash = null;
  for (const artifact of artifacts) {
    if (!artifact || artifact.v !== 1 || artifact.kind !== 'step2-artifact' || artifact.mock !== true || !hasFlags(artifact)) throw new Error('invalid diagnostic artifact');
    if (!['ok', 'failed'].includes(artifact.status)) throw new Error('invalid artifact status');
    for (const key of ['hash', 'configHash', 'protocolHash', 'sourceHash', 'analysisSourceHash', 'summaryHash', 'criticHash']) if (!isHash(artifact[key])) throw new Error(`artifact has invalid ${key}`);
    if (typeof artifact.analysisSource !== 'string' || typeof artifact.summary !== 'string' || sha256(artifact.analysisSource) !== artifact.analysisSourceHash || sha256(artifact.summary) !== artifact.summaryHash || digest(artifact.critic) !== artifact.criticHash || sealedHash(artifact) !== artifact.hash) throw new Error('artifact content or seal hash is stale');
    if (!['control', 'treatment'].includes(artifact.arm) || typeof artifact.siteId !== 'string' || !artifact.siteId || !Number.isSafeInteger(artifact.sample) || artifact.sample < 1) throw new Error('invalid artifact identity');
    if (typeof artifact.artifactId !== 'string' || !artifact.artifactId || ids.has(artifact.artifactId) || hashes.has(artifact.hash)) throw new Error('duplicate or missing artifact identity');
    ids.add(artifact.artifactId);
    hashes.add(artifact.hash);
    if (protocolHash !== null && artifact.protocolHash !== protocolHash) throw new Error('artifacts have different protocol hashes');
    protocolHash = artifact.protocolHash;
    const slot = JSON.stringify([artifact.arm, artifact.siteId, artifact.sample]);
    const previous = chains.get(slot);
    if (!Number.isSafeInteger(artifact.attempt) || artifact.attempt !== (previous ? previous.attempt + 1 : 1) || artifact.previousAttemptHash !== (previous ? previous.hash : null)) throw new Error('artifact attempt chain is invalid');
    if (previous && (previous.configHash !== artifact.configHash || previous.sourceHash !== artifact.sourceHash)) throw new Error('artifact attempt binding changed within slot');
    chains.set(slot, artifact);
  }
  return { artifacts: [...chains.values()].filter(artifact => artifact.status === 'ok'), protocolHash };
}

function artifactBinding(artifact) {
  if (!artifact || artifact.v !== 1 || artifact.kind !== 'step2-artifact' || artifact.status !== 'ok' || artifact.mock !== true) throw new Error('review requires a sealed successful preparation artifact');
  if (!hasFlags(artifact)) throw new Error('artifact is not a diagnostic preparation output');
  for (const key of ['hash', 'configHash', 'protocolHash', 'sourceHash', 'analysisSourceHash', 'summaryHash', 'criticHash']) if (!isHash(artifact[key])) throw new Error(`artifact has invalid ${key}`);
  if (typeof artifact.analysisSource !== 'string' || !artifact.analysisSource || typeof artifact.summary !== 'string' || !artifact.summary) throw new Error('artifact source and summary must be nonempty exact text');
  if (sha256(artifact.analysisSource) !== artifact.analysisSourceHash || sha256(artifact.summary) !== artifact.summaryHash || sealedHash(artifact) !== artifact.hash) throw new Error('artifact content or seal hash is stale');
  if (digest(artifact.critic) !== artifact.criticHash) throw new Error('artifact critic hash is stale');
  if (!['control', 'treatment'].includes(artifact.arm) || typeof artifact.siteId !== 'string' || !artifact.siteId || !Number.isSafeInteger(artifact.sample) || artifact.sample < 1) throw new Error('artifact identity is invalid');
  return {
    artifactHash: artifact.hash, protocolHash: artifact.protocolHash, configHash: artifact.configHash,
    sourceHash: artifact.sourceHash, analysisSourceHash: artifact.analysisSourceHash,
    summaryHash: artifact.summaryHash, criticHash: artifact.criticHash,
    arm: artifact.arm, siteId: artifact.siteId, sample: artifact.sample
  };
}

function buildReviewPackage({ artifacts, seed }) {
  if (!isHash(seed)) throw new Error('seed must be 64 lowercase hex characters');
  const selected = selectedHeads(artifacts);
  if (!selected.artifacts.length) throw new Error('no current successful artifacts to review');
  const items = [];
  const bindings = {};
  for (const artifact of selected.artifacts) {
    const binding = artifactBinding(artifact);
    const itemId = crypto.createHmac('sha256', Buffer.from(seed, 'hex')).update(binding.artifactHash).digest('hex').slice(0, 32);
    if (bindings[itemId]) throw new Error('opaque item ID collision');
    items.push({ itemId, analysisSource: artifact.analysisSource, summary: artifact.summary });
    bindings[itemId] = binding;
  }
  items.sort((a, b) => a.itemId.localeCompare(b.itemId));
  const publicPackage = { v: 1, kind: 'step2-review-package', ...FLAGS, items };
  const privateBindings = { v: 1, kind: 'step2-review-bindings', ...FLAGS, protocolHash: selected.protocolHash, publicHash: digest(publicPackage), bindings };
  return { publicPackage, privateBindings };
}

function validatePackage(publicPackage, privateBindings, artifacts) {
  if (!ownKeys(publicPackage, ['v', 'kind', ...Object.keys(FLAGS), 'items']) || publicPackage.v !== 1 || publicPackage.kind !== 'step2-review-package' || !hasFlags(publicPackage) || !Array.isArray(publicPackage.items)) throw new Error('invalid public review package');
  if (!privateBindings || privateBindings.v !== 1 || privateBindings.kind !== 'step2-review-bindings' || !hasFlags(privateBindings) || !isHash(privateBindings.publicHash) || digest(publicPackage) !== privateBindings.publicHash) throw new Error('review package hash mismatch');
  const selected = selectedHeads(artifacts);
  if (!selected.artifacts.length) throw new Error('no current successful artifacts to review');
  if (privateBindings.protocolHash !== selected.protocolHash || publicPackage.items.length !== selected.artifacts.length) throw new Error('review package and selected artifacts differ');
  const byHash = new Map(selected.artifacts.map(artifact => {
    const binding = artifactBinding(artifact);
    return [binding.artifactHash, { artifact, binding }];
  }));
  if (byHash.size !== selected.artifacts.length) throw new Error('duplicate artifacts');
  const ids = new Set();
  const visitedArtifacts = new Set();
  for (const item of publicPackage.items) {
    if (!ownKeys(item, ['itemId', 'analysisSource', 'summary']) || !ID.test(item.itemId) || ids.has(item.itemId)) throw new Error('invalid or duplicate public item ID');
    ids.add(item.itemId);
    const binding = privateBindings.bindings && privateBindings.bindings[item.itemId];
    const current = binding && byHash.get(binding.artifactHash);
    if (!current || canonicalJson(binding) !== canonicalJson(current.binding) || item.analysisSource !== current.artifact.analysisSource || item.summary !== current.artifact.summary || binding.protocolHash !== privateBindings.protocolHash) throw new Error('stale or tampered review binding');
    if (visitedArtifacts.has(binding.artifactHash)) throw new Error('duplicate artifact binding');
    visitedArtifacts.add(binding.artifactHash);
  }
  if (Object.keys(privateBindings.bindings || {}).length !== ids.size || visitedArtifacts.size !== byHash.size) throw new Error('private binding count differs');
  return true;
}

function validateSubmission(submission, publicPackage, privateBindings) {
  if (!ownKeys(submission, ['itemId', 'finding', 'verdict', 'subject', 'sourceEvidence', 'note'])) throw new Error('unexpected review field');
  const { itemId, finding, verdict, subject, sourceEvidence, note = '' } = submission;
  if (!ID.test(itemId) || !privateBindings.bindings[itemId]) throw new Error('unknown item');
  if (!FINDINGS.has(finding) || !VERDICTS.has(verdict)) throw new Error('invalid finding or verdict');
  if (typeof subject !== 'string' || !subject.trim() || subject.length > MAX_TEXT || typeof sourceEvidence !== 'string' || !sourceEvidence.trim() || sourceEvidence.length > MAX_TEXT || typeof note !== 'string' || note.length > MAX_TEXT) throw new Error('subject, source evidence, or note is invalid');
  const item = publicPackage.items.find(candidate => candidate.itemId === itemId);
  if (!item || !item.analysisSource.includes(sourceEvidence)) throw new Error('source evidence must quote the exact displayed source');
  if (finding === 'claim' && !item.summary.includes(subject)) throw new Error('claim subject must quote the exact displayed summary');
  if ((finding === 'omission' || verdict !== 'supported') && !note.trim()) throw new Error('omission and unresolved or unsupported judgments need a note');
  return { itemId, finding, verdict, subject, sourceEvidence, note };
}

function appendAttempt(reviewDir, submission, publicPackage, privateBindings, artifacts) {
  validatePackage(publicPackage, privateBindings, artifacts);
  const fields = validateSubmission(submission, publicPackage, privateBindings);
  const prior = readAttempts(reviewDir, publicPackage, privateBindings, artifacts);
  const forItem = prior.filter(record => record.itemId === fields.itemId);
  const record = {
    v: 1, kind: 'step2-human-review', ...FLAGS, reviewId: crypto.randomUUID(),
    attempt: forItem.length + 1, previousAttemptHash: forItem.length ? forItem.at(-1).hash : null,
    recordedAt: new Date().toISOString(), ...fields, ...privateBindings.bindings[fields.itemId]
  };
  record.hash = sealedHash(record);
  fs.mkdirSync(reviewDir, { recursive: true });
  fs.appendFileSync(path.join(reviewDir, 'attempts.jsonl'), JSON.stringify(record) + '\n', { encoding: 'utf8', flag: 'a' });
  return record;
}

function readAttempts(reviewDir, publicPackage, privateBindings, artifacts) {
  validatePackage(publicPackage, privateBindings, artifacts);
  const file = path.join(reviewDir, 'attempts.jsonl');
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8');
  if (raw && !raw.endsWith('\n')) throw new Error('review attempts file has an incomplete final record');
  const records = raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const latest = new Map();
  const seenIds = new Set();
  for (const record of records) {
    if (!record || record.v !== 1 || record.kind !== 'step2-human-review' || !hasFlags(record) || !isHash(record.hash) || record.hash !== sealedHash(record) || typeof record.reviewId !== 'string' || !/^[0-9a-f-]{36}$/.test(record.reviewId) || seenIds.has(record.reviewId) || typeof record.recordedAt !== 'string' || !Number.isFinite(Date.parse(record.recordedAt))) throw new Error('tampered review attempt');
    seenIds.add(record.reviewId);
    const fields = (({ itemId, finding, verdict, subject, sourceEvidence, note }) => ({ itemId, finding, verdict, subject, sourceEvidence, note }))(record);
    validateSubmission(fields, publicPackage, privateBindings);
    const binding = privateBindings.bindings[record.itemId];
    if (!ownKeys(record, ['v', 'kind', ...Object.keys(FLAGS), 'reviewId', 'attempt', 'previousAttemptHash', 'recordedAt', 'itemId', 'finding', 'verdict', 'subject', 'sourceEvidence', 'note', ...Object.keys(binding), 'hash'])) throw new Error('unexpected review field');
    for (const [key, value] of Object.entries(binding)) if (record[key] !== value) throw new Error(`stale review ${key}`);
    const previous = latest.get(record.itemId);
    if (record.attempt !== (previous ? previous.attempt + 1 : 1) || record.previousAttemptHash !== (previous ? previous.hash : null)) throw new Error('review attempt chain is invalid');
    latest.set(record.itemId, record);
  }
  return records;
}

function publicAttempts(records) {
  return records.map(({ itemId, finding, verdict, subject, sourceEvidence, note, attempt, recordedAt }) => ({ ...FLAGS, itemId, finding, verdict, subject, sourceEvidence, note, attempt, recordedAt }));
}

module.exports = { buildReviewPackage, validatePackage, validateSubmission, appendAttempt, readAttempts, publicAttempts, artifactBinding, selectedHeads, sealedHash };
