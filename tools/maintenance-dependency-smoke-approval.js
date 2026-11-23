'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const C = require('./final-corpus-lib');
const { observationMessage } = require('./maintenance-dependency-evidence');
const { parseUnambiguousJson } = require('./maintenance-observed-live-transport');
const { localPaths } = require('./maintenance-local-path');
const { CHECKPOINT_E_SMOKE_CAP } = require('./maintenance-dependency-smoke-policy');

const DAY = 24 * 60 * 60 * 1000;
const PURPOSE = 'tos-guardian.maintenance-dependency-smoke-live-approval.v1\n';
const RECOVERY_PURPOSE = 'tos-guardian.maintenance-dependency-smoke-recovery.v1\n';
const approvalFields = ['v', 'kind', 'protocolHash', 'budgetHash', 'maximumMicrodollars',
  'preregistrationHash', 'accounts', 'executionKeyFingerprint', 'journalDirectory',
  'outputDirectory', 'issuedAt', 'expiresAt', 'billingEvidence', 'hash'];
const recoveryFields = ['v', 'kind', 'incident', 'successorApprovalHash', 'launcherCommit', 'hash'];
const incidentFields = ['priorApprovalHash', 'budgetHash', 'journalHash', 'journalTailHash', 'callId', 'requestHash',
  'failureEvidence', 'dispatchLog'];
const recoveryScopeFields = ['protocolHash', 'budgetHash', 'maximumMicrodollars', 'preregistrationHash',
  'accounts', 'executionKeyFingerprint', 'journalDirectory'];
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const date = value => typeof value === 'string' && /^\d{4}-/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const copy = value => JSON.parse(C.canonicalJson(value));

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

function sameLocalDirectory(left, right) {
  if (left.toLowerCase() === right.toLowerCase()) return true;
  const options = { bigint: true, throwIfNoEntry: false };
  const first = fs.statSync(left, options);
  const second = fs.statSync(right, options);
  if (!first || !second) return false;
  requireThat(first.isDirectory() && second.isDirectory() && first.ino !== 0n && second.ino !== 0n,
    'Could not verify local directory identities');
  return first.dev === second.dev && first.ino === second.ino;
}

function dependencySmokeApprovalMessage(payload) {
  return PURPOSE + C.canonicalJson(payload);
}

function dependencySmokeRecoveryMessage(payload) {
  return RECOVERY_PURPOSE + C.canonicalJson(payload);
}

function verifyEnvelope(envelope, fields, publicKey, message, label) {
  requireThat(exact(envelope, ['payload', 'signature']) && exact(envelope.payload, fields),
    label + ': invalid envelope or payload fields');
  const { payload, signature } = envelope;
  requireThat(C.bodyHash(payload) === payload.hash, label + ': invalid payload seal');
  const bytes = Buffer.from(typeof signature === 'string' ? signature : '', 'base64');
  requireThat(bytes.length === 64 && bytes.toString('base64') === signature &&
    crypto.verify(null, Buffer.from(message(payload)), publicKey, bytes), label + ': invalid signature');
  return payload;
}

function publicKey(pem) {
  requireThat(typeof pem === 'string' && pem.startsWith('-----BEGIN PUBLIC KEY-----'),
    'An independently configured public key is required');
  const key = crypto.createPublicKey(pem);
  requireThat(key.asymmetricKeyType === 'ed25519', 'Ed25519 public keys required');
  return key;
}

function fingerprint(key) {
  return sha(key.export({ type: 'spki', format: 'der' }));
}

function retainedBytes(descriptor, bytes, limit, label) {
  requireThat(exact(descriptor, ['sha256', 'bytes']) && Buffer.isBuffer(bytes) &&
    bytes.length > 0 && bytes.length <= limit && bytes.length === descriptor.bytes, label + ': missing or invalid bytes');
  const snapshot = Buffer.from(bytes);
  requireThat(C.isHash(descriptor.sha256) && sha(snapshot) === descriptor.sha256, label + ': hash mismatch');
  return snapshot;
}

function verifyDependencySmokeApproval({ approval, operatorTrust, protocol, preregistration, preregistrationBytes,
  budgetHash, outputDirectory, billingEvidenceBytes }, now = new Date().toISOString()) {
  requireThat(exact(operatorTrust, ['ownerPublicKey', 'executionPublicKey', 'journalDirectory']),
    'Independent operator trust configuration required');
  const owner = publicKey(operatorTrust.ownerPublicKey);
  const execution = fingerprint(publicKey(operatorTrust.executionPublicKey));
  requireThat(execution !== fingerprint(owner), 'Owner and execution keys must be independent');

  const p = verifyEnvelope(copy(approval), approvalFields, owner, dependencySmokeApprovalMessage, 'Live spending approval');
  requireThat(p.v === 1 && p.kind === 'maintenance-dependency-smoke-live-approval' &&
    p.executionKeyFingerprint === execution && C.isHash(budgetHash) && p.budgetHash === budgetHash &&
    p.maximumMicrodollars === CHECKPOINT_E_SMOKE_CAP && protocol.smokeCapMicros === CHECKPOINT_E_SMOKE_CAP && protocol.mode === 'observed' &&
    p.protocolHash === protocol.hash && C.bodyHash(protocol) === p.protocolHash, 'Approval scope mismatch');
  requireThat(date(now) && date(p.issuedAt) && date(p.expiresAt) && p.issuedAt <= now && now < p.expiresAt &&
    Date.parse(p.expiresAt) - Date.parse(p.issuedAt) <= DAY, 'Approval expired, future-dated or exceeds 24 hours');
  requireThat(exact(p.accounts, ['anthropic', 'openai']) && typeof p.accounts.anthropic === 'string' &&
    /^wrkspc_[A-Za-z0-9_-]{1,190}$/.test(p.accounts.anthropic) && typeof p.accounts.openai === 'string' &&
    /^proj_[A-Za-z0-9_-]{1,195}$/.test(p.accounts.openai), 'Invalid provider account identifiers');

  const prereg = copy(preregistration);
  requireThat(p.preregistrationHash === C.digest(prereg), 'Preregistration envelope hash mismatch');
  const declaration = verifyEnvelope(prereg, ['v', 'kind', 'protocolHash', 'reviewer', 'observedAt',
    'outcome', 'attachment', 'hash'], owner, observationMessage, 'Owner preregistration');
  requireThat(declaration.v === 1 && declaration.kind === 'preregistration' && declaration.outcome === 'pass' &&
    declaration.protocolHash === p.protocolHash && declaration.reviewer === protocol.reviewers.owner &&
    date(declaration.observedAt) && date(protocol.declaredAt) && protocol.declaredAt <= declaration.observedAt &&
    declaration.observedAt <= p.issuedAt, 'Invalid or stale owner preregistration');
  retainedBytes(declaration.attachment, preregistrationBytes, 128 * 1024 * 1024, 'Preregistration attachment');

  const billed = retainedBytes(p.billingEvidence, billingEvidenceBytes, 64 * 1024, 'Billing preflight');
  const billing = parseUnambiguousJson(new TextDecoder('utf-8', { fatal: true }).decode(billed));
  requireThat(exact(billing, ['v', 'kind', 'anthropicWorkspaceId', 'openaiProjectId', 'anthropicStandardOnly',
    'openaiDefaultStandard', 'checkedAt']) && billing.v === 1 && billing.kind === 'dependency-smoke-billing-preflight' &&
    billing.anthropicWorkspaceId === p.accounts.anthropic && billing.openaiProjectId === p.accounts.openai &&
    billing.anthropicStandardOnly === true && billing.openaiDefaultStandard === true && date(billing.checkedAt) &&
    billing.checkedAt <= p.issuedAt && Date.parse(now) - Date.parse(billing.checkedAt) <= DAY,
  'Billing preflight requires current Standard pricing for both authorized accounts');

  requireThat(p.outputDirectory === outputDirectory && p.journalDirectory === operatorTrust.journalDirectory,
    'Signed output or journal directory mismatch');
  const [output, journal] = localPaths([outputDirectory, operatorTrust.journalDirectory]);
  requireThat(p.outputDirectory === output && p.journalDirectory === journal && !sameLocalDirectory(output, journal),
    'Distinct canonical local output and journal directories required');
  Object.freeze(p.accounts);
  Object.freeze(p.billingEvidence);
  return Object.freeze(p);
}

function verifyDependencySmokeRecovery({ recovery, priorApproval, successor, operatorTrust, expectedIncident,
  failureEvidenceBytes, dispatchLogBytes, launcherCommit }) {
  const owner = publicKey(operatorTrust.ownerPublicKey);
  const authorization = verifyEnvelope(copy(recovery), recoveryFields, owner, dependencySmokeRecoveryMessage, 'Smoke recovery');
  const prior = verifyEnvelope(copy(priorApproval), approvalFields, owner, dependencySmokeApprovalMessage, 'Prior spending approval');
  const { incident } = authorization;
  requireThat(authorization.v === 1 && authorization.kind === 'maintenance-dependency-smoke-recovery' &&
    typeof launcherCommit === 'string' && /^[a-f0-9]{40}$/.test(launcherCommit) && authorization.launcherCommit === launcherCommit &&
    exact(incident, incidentFields) && C.canonicalJson(incident) === C.canonicalJson(expectedIncident) &&
    ['priorApprovalHash', 'budgetHash', 'journalHash', 'journalTailHash', 'requestHash'].every(key => C.isHash(incident[key])) &&
    incident.callId === 'anthropic:analyzer' && incident.priorApprovalHash === prior.hash &&
    incident.budgetHash === successor.budgetHash && authorization.successorApprovalHash === successor.hash,
  'Smoke recovery authorization does not match the reviewed incident, launcher, or successor');
  requireThat(prior.v === 1 && prior.kind === successor.kind && date(prior.issuedAt) &&
    prior.issuedAt <= successor.issuedAt && typeof prior.outputDirectory === 'string' &&
    /^[A-Za-z]:\\/.test(prior.outputDirectory) && !sameLocalDirectory(prior.outputDirectory, successor.outputDirectory) &&
    recoveryScopeFields.every(key => C.canonicalJson(prior[key]) === C.canonicalJson(successor[key])),
  'Smoke recovery successor must preserve the original signed scope and use different output');
  retainedBytes(incident.failureEvidence, failureEvidenceBytes, 64 * 1024, 'Smoke recovery failure evidence');
  retainedBytes(incident.dispatchLog, dispatchLogBytes, 64 * 1024, 'Smoke recovery dispatch log');
  return Object.freeze({ journalHash: incident.journalHash, journalTailHash: incident.journalTailHash,
    requestHash: incident.requestHash, authorizationHash: authorization.hash });
}

module.exports = { dependencySmokeApprovalMessage, dependencySmokeRecoveryMessage,
  sameLocalDirectory, verifyDependencySmokeApproval, verifyDependencySmokeRecovery };
