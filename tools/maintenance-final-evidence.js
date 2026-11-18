'use strict';

// An offline verifier, not an execution, signing or provider adapter. Public keys
// and the verification clock are supplied by the independently trusted caller.
const crypto = require('node:crypto');
const C = require('./final-corpus-lib');
const M = require('./maintenance-evaluation-lib');
const { checkRelease } = require('./sites-lib');

const PURPOSE = 'tos-guardian.maintenance-observation.v1\n';
const TESTS = Object.freeze([...M.TESTS, 'final-controller-sql-denial-matrix']);
const REVIEWS = M.REVIEWS;
const ROLES = Object.freeze(['protocol', 'execution', 'human', 'judge', 'scope', 'code']);
const STAGES = Object.freeze(['analyzer', 'critic', 'judge']);
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_BUILD_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 768 * 1024 * 1024;
const MAX_RUNS = 10000;
const ALLOWED_POLICY_CHANGES = Object.freeze(['policy.versions.serverPipeline', 'policy.versions.storageSchema', 'policy.versions.baselineSchema', 'policy.versions.migrationManifest']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && C.canonicalJson(Object.keys(value).sort()) === C.canonicalJson([...keys].sort());
const same = (a, b) => C.canonicalJson(a) === C.canonicalJson(b);
const clone = value => JSON.parse(C.canonicalJson(value));
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const finiteUnit = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const descriptor = value => exact(value, ['sha256', 'bytes']) && C.isHash(value.sha256) && Number.isSafeInteger(value.bytes) && value.bytes > 0;
const freeze = value => { if (object(value) || Array.isArray(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

function observationMessage(payload) { return PURPOSE + C.canonicalJson(payload); }

function createFinalPreparation(baseline, candidate) {
  return C.seal({ v: 1, kind: 'maintenance-final-build-pair', baseline, candidate, allowedPolicyChanges: [...ALLOWED_POLICY_CHANGES] });
}

function validateFinalPreparation(preparation) {
  const reasons = [];
  try {
    C.checkSeal(preparation, 'final build pair', reasons);
    if (!exact(preparation, ['v', 'kind', 'baseline', 'candidate', 'allowedPolicyChanges', 'hash']) || preparation.v !== 1 || preparation.kind !== 'maintenance-final-build-pair' || !same(preparation.allowedPolicyChanges, ALLOWED_POLICY_CHANGES)) throw Error('Unsupported maintenance-final build pair or changed fixed policy scope');
    for (const arm of ['baseline', 'candidate']) {
      const build = preparation[arm];
      if (!exact(build, ['release', 'artifact', 'runtime'])) throw Error(`${arm}: complete release, artifact and runtime required`);
      const checked = checkRelease(build.release);
      if (!checked.valid) throw Error(`${arm}: ${checked.reason}`);
      if (!descriptor(build.artifact) || build.artifact.bytes > MAX_BUILD_BYTES || !exact(build.runtime, ['node', 'npm', 'platform', 'arch']) || Object.values(build.runtime).some(value => !C.nonempty(value))) throw Error(`${arm}: bounded build artifact and complete declared runtime required`);
      const policy = build.release.config.policy;
      if (!C.isHash(policy.versions.serverPipeline) || policy.cache?.shared !== 'disabled') throw Error(`${arm}: hashed server runtime and disabled shared cache required`);
      for (const field of ['storageSchema', 'baselineSchema', 'migrationManifest']) if (Object.hasOwn(policy.versions, field) && !C.isHash(policy.versions[field])) throw Error(`${arm}: invalid ${field} fingerprint`);
    }
    if (!C.isHash(preparation.candidate.release.config.policy.versions.migrationManifest)) throw Error('Candidate must bind the complete migration manifest hash');
    const fixed = build => {
      const config = clone(build.release.config);
      for (const field of ['serverPipeline', 'storageSchema', 'baselineSchema', 'migrationManifest']) delete config.policy.versions[field];
      return config;
    };
    if (!same(fixed(preparation.baseline), fixed(preparation.candidate))) throw Error('Lessons, sites, prompts, models, cache or other fixed policy changed');
  } catch (error) { reasons.push(error.message); }
  return { valid: reasons.length === 0, reasons };
}

function createFinalProtocol(preparation, spec) {
  const finalPair = preparation?.kind === 'maintenance-final-build-pair' ? preparation : createFinalPreparation(preparation?.baseline, preparation?.candidate);
  return C.seal({ v: 1, kind: 'maintenance-final-protocol', ...clone(spec), preparation: finalPair, requiredTests: [...TESTS], requiredReviews: [...REVIEWS] });
}

function validateFinalProtocol(protocol) {
  const reasons = [];
  try {
    C.checkSeal(protocol, 'final protocol', reasons);
    if (!exact(protocol, ['v', 'kind', 'preparation', 'mode', 'declaredAt', 'corpus', 'sampleCount', 'repetitions', 'requiredCoverage', 'criteria', 'rubric', 'judge', 'stageModels', 'reviewers', 'requiredTests', 'requiredReviews', 'hash']) || protocol.v !== 1 || protocol.kind !== 'maintenance-final-protocol') throw Error('Unsupported maintenance-final protocol');
    const pair = validateFinalPreparation(protocol.preparation);
    reasons.push(...pair.reasons.map(reason => `preparation: ${reason}`));
    if (!['fixture', 'observed'].includes(protocol.mode)) reasons.push('Explicit fixture or observed mode required');
    if (!timestamp(protocol.declaredAt)) reasons.push('Canonical preregistration time required');
    if (!same(protocol.requiredTests, TESTS) || !same(protocol.requiredReviews, REVIEWS)) reasons.push('Final full-test and independent-review requirements cannot change');
    if (!exact(protocol.reviewers, ROLES) || Object.values(protocol.reviewers).some(id => !identifier(id))) reasons.push('All predeclared reviewer identities required');
    else {
      const r = protocol.reviewers;
      if (r.execution === r.human || r.execution === r.judge || r.execution === r.code || r.execution === r.scope || r.human === r.judge) reasons.push('Execution, human, judge and final reviews require independent identities');
    }
    if (!Number.isSafeInteger(protocol.sampleCount) || protocol.sampleCount < 1 || !Number.isSafeInteger(protocol.repetitions) || protocol.repetitions < 1 || protocol.sampleCount * protocol.repetitions * 2 > MAX_RUNS) reasons.push('Positive bounded sample and repetition counts required');
    if (!Array.isArray(protocol.requiredCoverage) || !protocol.requiredCoverage.length || protocol.requiredCoverage.some(tag => !identifier(tag)) || new Set(protocol.requiredCoverage).size !== protocol.requiredCoverage.length) reasons.push('Unique explicit coverage tags required');
    const criteria = protocol.criteria;
    if (!exact(criteria, ['minAccuracy', 'minCompleteness', 'maxFabrications', 'maxMeanRegression']) || !finiteUnit(criteria.minAccuracy) || !finiteUnit(criteria.minCompleteness) || criteria.minAccuracy <= 0 || criteria.minCompleteness <= 0 || criteria.maxFabrications !== 0 || !finiteUnit(criteria.maxMeanRegression)) reasons.push('Predeclare finite quality thresholds, zero fabrications and allowed mean regression');
    if (!descriptor(protocol.rubric) || protocol.rubric.bytes > MAX_BYTES) reasons.push('Bounded rubric bytes required');
    if (!exact(protocol.judge, ['provider', 'model', 'prompt']) || !C.nonempty(protocol.judge.provider) || !C.nonempty(protocol.judge.model) || !descriptor(protocol.judge.prompt) || protocol.judge.prompt.bytes > MAX_BYTES) reasons.push('Predeclared independent judge model and prompt bytes required');
    if (!exact(protocol.stageModels, STAGES)) reasons.push('Predeclare every pipeline stage model');
    else for (const stage of STAGES) {
      const model = protocol.stageModels[stage];
      if (!exact(model, ['provider', 'tier', 'model']) || !C.nonempty(model.provider) || !C.nonempty(model.model) || !['default', 'escalated', 'jury'].includes(model.tier) || (stage === 'judge' && model.tier !== 'jury') || (stage !== 'judge' && model.tier === 'jury')) { reasons.push(`${stage}: invalid fixed model selection`); continue; }
      for (const arm of ['baseline', 'candidate']) if (model.model !== protocol.preparation?.[arm]?.release?.config?.policy?.models?.[model.provider]?.[model.tier]) reasons.push(`${arm}/${stage}: model differs from bound release policy`);
    }
    const corpus = protocol.corpus;
    if (!exact(corpus, ['purpose', 'learningAllowed', 'samples']) || corpus.purpose !== 'maintenance-evaluation-only' || corpus.learningAllowed !== false || !Array.isArray(corpus.samples) || corpus.samples.length !== protocol.sampleCount) throw Error('Frozen maintenance-only held-out corpus and exact sample count required');
    const ids = new Set(), sources = new Set(), covered = new Set();
    for (const sample of corpus.samples) {
      if (!exact(sample, ['id', 'coverage', 'source', 'provenance']) || !identifier(sample.id) || ids.has(sample.id)) { reasons.push('Malformed or duplicate corpus sample'); continue; }
      ids.add(sample.id);
      if (!Array.isArray(sample.coverage) || !sample.coverage.length || sample.coverage.some(tag => !protocol.requiredCoverage.includes(tag)) || new Set(sample.coverage).size !== sample.coverage.length) reasons.push(`${sample.id}: invalid coverage`);
      else sample.coverage.forEach(tag => covered.add(tag));
      if (!descriptor(sample.source) || sample.source.bytes > MAX_BYTES) reasons.push(`${sample.id}: bounded nonempty source required`);
      else if (sources.has(sample.source.sha256)) reasons.push(`${sample.id}: duplicate source; use repetitions for repeated documents`);
      else sources.add(sample.source.sha256);
      const p = sample.provenance;
      if (!exact(p, ['url', 'capturedAt', 'method']) || !timestamp(p.capturedAt) || Date.parse(p.capturedAt) > Date.parse(protocol.declaredAt) || !C.nonempty(p.method)) reasons.push(`${sample.id}: source provenance must precede preregistration`);
      let url;
      try { url = new URL(p?.url); } catch { reasons.push(`${sample.id}: invalid source URL`); }
      if (url && (url.protocol !== 'https:' || url.username || url.password || url.hash)) reasons.push(`${sample.id}: canonical credential-free HTTPS source URL required`);
      if (protocol.mode === 'observed' && p?.method !== 'official-capture') reasons.push(`${sample.id}: observed corpus requires independently reviewed official capture`);
    }
    for (const tag of protocol.requiredCoverage || []) if (!covered.has(tag)) reasons.push(`Missing predeclared coverage ${tag}`);
    if (pair.valid) {
      const { baseline, candidate } = protocol.preparation;
      if (baseline.release.configHash === candidate.release.configHash || baseline.artifact.sha256 === candidate.artifact.sha256) reasons.push('Distinct baseline and candidate configuration and artifact identities required');
    }
  } catch (error) { reasons.push(error.message); }
  return { valid: reasons.length === 0, reasons };
}

function validateFinalEvidence(inputProtocol, inputEvidence, context = {}) {
  const reasons = [], runMap = new Map(), gradeMap = new Map();
  let protocol, evidence, attachmentMap, trust;
  try {
    protocol = clone(inputProtocol); evidence = clone(inputEvidence);
    if (Buffer.byteLength(C.canonicalJson(evidence)) > MAX_BYTES) throw Error('Evidence metadata exceeds verifier byte limit');
    const check = validateFinalProtocol(protocol);
    reasons.push(...check.reasons);
    if (!check.valid) throw Error('Invalid maintenance-final protocol');
    if (!exact(context, ['attachments', 'trustedReviewers', 'now']) || !timestamp(context.now)) throw Error('Externally trusted attachments, reviewer registry and canonical verification time required');
    if (Date.parse(protocol.declaredAt) > Date.parse(context.now)) throw Error('Protocol is later than trusted verification time');
    if (!object(context.attachments) || !object(context.trustedReviewers)) throw Error('Attachment bytes and external reviewer registry required');
    attachmentMap = new Map(); trust = new Map();
    // Snapshot actual buffers before inspecting them. Never trust supplied hashes
    // or file names as a substitute for the bytes used in this verification.
    let totalBytes = 0;
    for (const [hash, bytes] of Object.entries(context.attachments)) {
      if (!C.isHash(hash) || !(Buffer.isBuffer(bytes) || typeof bytes === 'string')) throw Error('Attachments must map SHA-256 to actual bytes');
      totalBytes += Buffer.isBuffer(bytes) ? bytes.length : Buffer.byteLength(bytes);
      if (totalBytes > MAX_TOTAL_BYTES) throw Error('Total retained attachment bytes exceed verifier limit');
      attachmentMap.set(hash, Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(bytes, 'utf8'));
    }
    for (const role of ROLES) {
      const id = protocol.reviewers[role], entry = context.trustedReviewers[id];
      if (!exact(entry, ['publicKey', 'roles']) || !Array.isArray(entry.roles) || !entry.roles.includes(role) || entry.roles.some(r => !ROLES.includes(r))) throw Error(`External trusted ${role} reviewer required`);
      const key = crypto.createPublicKey(entry.publicKey);
      if (key.asymmetricKeyType !== 'ed25519') throw Error('Only independent Ed25519 observation keys supported');
      trust.set(role, { id, key, fingerprint: crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex') });
    }
    for (const [left, right] of [['execution', 'human'], ['execution', 'judge'], ['execution', 'code'], ['execution', 'scope'], ['human', 'judge']]) if (trust.get(left).fingerprint === trust.get(right).fingerprint) throw Error(`${left} and ${right} must use independent keys`);
    const bytesFor = (attachment, label, largeBuild = false) => {
      if (!descriptor(attachment) || attachment.bytes > (largeBuild ? MAX_BUILD_BYTES : MAX_BYTES)) throw Error(`${label}: invalid attachment descriptor`);
      const bytes = attachmentMap.get(attachment.sha256);
      if (!bytes || bytes.length !== attachment.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== attachment.sha256) throw Error(`${label}: missing or changed actual bytes`);
      return bytes;
    };
    const signed = (envelope, role, kind, keys, earliest = protocol.declaredAt) => {
      if (!exact(envelope, ['payload', 'signature'])) throw Error(`${kind}: signed observation envelope required`);
      const p = envelope.payload;
      if (!exact(p, ['v', 'kind', 'protocolHash', 'reviewer', 'observedAt', ...keys, 'hash']) || p.v !== 1 || p.kind !== kind || p.protocolHash !== protocol.hash || p.reviewer !== trust.get(role).id) throw Error(`${kind}: malformed or stale signed observation`);
      const sealErrors = []; C.checkSeal(p, kind, sealErrors);
      if (sealErrors.length) throw Error(sealErrors.join('; '));
      if (!timestamp(p.observedAt) || Date.parse(p.observedAt) < Date.parse(earliest) || Date.parse(p.observedAt) > Date.parse(context.now)) throw Error(`${kind}: observation outside preregistered verification window`);
      const signature = Buffer.from(String(envelope.signature), 'base64');
      if (signature.length !== 64 || signature.toString('base64') !== envelope.signature || !crypto.verify(null, Buffer.from(observationMessage(p)), trust.get(role).key, signature)) throw Error(`${kind}: independent observation signature does not verify`);
      return p;
    };
    C.checkSeal(evidence, 'final evidence', reasons);
    if (!exact(evidence, ['v', 'kind', 'protocolHash', 'preregistration', 'runs', 'grades', 'tests', 'reviews', 'hash']) || evidence.v !== 1 || evidence.kind !== 'maintenance-final-evidence' || evidence.protocolHash !== protocol.hash) throw Error('Unsupported or stale final evidence');
    for (const arm of ['baseline', 'candidate']) bytesFor(protocol.preparation[arm].artifact, `${arm} artifact`, true);
    bytesFor(protocol.rubric, 'quality rubric');
    bytesFor(protocol.judge.prompt, 'independent judge prompt');
    for (const sample of protocol.corpus.samples) bytesFor(sample.source, `source ${sample.id}`);
    const preregistration = signed(evidence.preregistration, 'protocol', 'preregistration', ['outcome', 'attachment']);
    if (preregistration.outcome !== 'pass') throw Error('Independent preregistration approval required');
    bytesFor(preregistration.attachment, 'preregistration approval');
    const expectedRuns = protocol.sampleCount * protocol.repetitions * 2;
    if (!Array.isArray(evidence.runs) || evidence.runs.length !== expectedRuns || !Array.isArray(evidence.grades) || evidence.grades.length !== expectedRuns * 2 || !Array.isArray(evidence.tests) || evidence.tests.length !== M.TESTS.length * 2 + 1 || !Array.isArray(evidence.reviews) || evidence.reviews.length !== REVIEWS.length) throw Error('Missing or extra runs, human/judge grades, full tests or independent reviews');
    const samples = new Map(protocol.corpus.samples.map(sample => [sample.id, sample]));
    let lastObservation = preregistration.observedAt;
    const rememberTime = p => { if (Date.parse(p.observedAt) > Date.parse(lastObservation)) lastObservation = p.observedAt; };
    for (const envelope of evidence.runs) {
      const p = signed(envelope, 'execution', 'pipeline-run', ['arm', 'sampleId', 'repetition', 'buildHash', 'sourceHash', 'outcome', 'origin', 'stages', 'log'], preregistration.observedAt);
      const sample = samples.get(p.sampleId), key = `${p.arm}:${p.sampleId}:${p.repetition}`;
      if (!['baseline', 'candidate'].includes(p.arm) || !sample || !Number.isSafeInteger(p.repetition) || p.repetition < 1 || p.repetition > protocol.repetitions || runMap.has(key)) throw Error('Unknown or duplicate arm/sample/repetition');
      if (p.buildHash !== C.digest(protocol.preparation[p.arm]) || p.sourceHash !== sample.source.sha256 || p.outcome !== 'pass' || p.origin !== (protocol.mode === 'fixture' ? 'fixture' : 'captured-runtime')) throw Error(`${key}: failed, skipped, fixture or stale runtime execution`);
      if (!exact(p.stages, STAGES)) throw Error(`${key}: all pipeline stages required`);
      for (const stage of STAGES) {
        const output = p.stages[stage];
        if (!exact(output, ['provider', 'model', 'requestId', 'request', 'response', 'output']) || output.provider !== protocol.stageModels[stage].provider || output.model !== protocol.stageModels[stage].model || !C.nonempty(output.requestId)) throw Error(`${key}/${stage}: fixed provider model, request identity and original request/response required`);
        for (const part of ['request', 'response', 'output']) bytesFor(output[part], `${key}/${stage}/${part}`);
      }
      bytesFor(p.log, `${key}: execution log`); runMap.set(key, p); rememberTime(p);
    }
    // Cardinality plus unique valid coordinates establishes the exact product.
    const runsByHash = new Map([...runMap.values()].map(run => [run.hash, run]));
    for (const envelope of evidence.grades) {
      const role = envelope?.payload?.role;
      if (!['human', 'judge'].includes(role)) throw Error('Every run needs an independent human and judge grade');
      const p = signed(envelope, role, 'quality-grade', ['role', 'runHash', 'rubricHash', 'judgeHash', 'request', 'response', 'accuracy', 'completeness', 'fabrications', 'outcome', 'attachment'], preregistration.observedAt);
      const run = runsByHash.get(p.runHash), key = `${p.runHash}:${role}`;
      if (!run || gradeMap.has(key) || p.rubricHash !== protocol.rubric.sha256 || Date.parse(p.observedAt) < Date.parse(run.observedAt)) throw Error('Duplicate, missing, stale or premature quality review');
      if (!finiteUnit(p.accuracy) || !finiteUnit(p.completeness) || !Number.isSafeInteger(p.fabrications) || p.fabrications < 0 || p.outcome !== 'pass') throw Error('Finite independent quality metrics and passing outcome required');
      if (p.accuracy < protocol.criteria.minAccuracy || p.completeness < protocol.criteria.minCompleteness || p.fabrications > protocol.criteria.maxFabrications) throw Error('Per-sample independent quality acceptance criteria failed');
      if (role === 'judge') {
        if (p.judgeHash !== C.digest(protocol.judge)) throw Error('Independent judge model/prompt binding changed');
        bytesFor(p.request, 'independent judge original request'); bytesFor(p.response, 'independent judge original response');
      } else if (p.judgeHash !== null || p.request !== null || p.response !== null) throw Error('Human review cannot impersonate an independent model judge');
      bytesFor(p.attachment, `${role} quality review`); gradeMap.set(key, p); rememberTime(p);
    }
    for (const run of runMap.values()) for (const role of ['human', 'judge']) if (!gradeMap.has(`${run.hash}:${role}`)) throw Error('Incomplete human and independent judge quality coverage');
    for (const role of ['human', 'judge']) for (const metric of ['accuracy', 'completeness']) {
      const mean = arm => [...runMap.values()].filter(run => run.arm === arm).reduce((sum, run) => sum + gradeMap.get(`${run.hash}:${role}`)[metric], 0) / (expectedRuns / 2);
      if (mean('baseline') - mean('candidate') > protocol.criteria.maxMeanRegression + Number.EPSILON * expectedRuns) throw Error(`${role} ${metric}: candidate mean regression exceeds predeclared tolerance`);
    }
    const tests = new Set();
    for (const envelope of evidence.tests) {
      const p = signed(envelope, 'execution', 'full-test', ['arm', 'id', 'buildHash', 'command', 'exitCode', 'passed', 'failed', 'skipped', 'outcome', 'log'], preregistration.observedAt);
      const key = `${p.arm}:${p.id}`;
      if (!['baseline', 'candidate'].includes(p.arm) || !(M.TESTS.includes(p.id) || (p.arm === 'candidate' && p.id === 'final-controller-sql-denial-matrix')) || tests.has(key) || p.buildHash !== C.digest(protocol.preparation[p.arm]) || !C.nonempty(p.command) || p.exitCode !== 0 || !Number.isSafeInteger(p.passed) || p.passed < 1 || p.failed !== 0 || p.skipped !== 0 || p.outcome !== 'pass') throw Error(`${key}: full test failure, skip, duplicate or stale build binding`);
      bytesFor(p.log, `${key}: full test output`); tests.add(key); rememberTime(p);
    }
    const observationsHash = C.digest({ preregistration: evidence.preregistration, runs: evidence.runs, grades: evidence.grades, tests: evidence.tests });
    const reviews = new Set();
    for (const envelope of evidence.reviews) {
      const id = envelope?.payload?.id, role = id === 'maintenance-scope' ? 'scope' : 'code';
      const p = signed(envelope, role, 'independent-review', ['id', 'baselineBuildHash', 'candidateBuildHash', 'observationsHash', 'outcome', 'attachment'], lastObservation);
      if (!REVIEWS.includes(id) || reviews.has(id) || p.baselineBuildHash !== C.digest(protocol.preparation.baseline) || p.candidateBuildHash !== C.digest(protocol.preparation.candidate) || p.observationsHash !== observationsHash || p.outcome !== 'pass') throw Error('Missing, duplicate, stale or unresolved final independent review');
      bytesFor(p.attachment, `${id}: final review`); reviews.add(id);
    }
  } catch (error) { reasons.push(error.message); }
  const contractSatisfied = reasons.length === 0, observed = protocol?.mode === 'observed';
  return freeze(C.seal({ v: 1, kind: 'maintenance-final-report', phase: 'maintenance-final',
    mode: protocol?.mode || null, protocolHash: C.isHash(protocol?.hash) ? protocol.hash : null,
    corpusHash: protocol?.corpus ? C.digest(protocol.corpus) : null,
    configHash: protocol?.preparation?.candidate?.release?.configHash || null,
    baselineConfigHash: protocol?.preparation?.baseline?.release?.configHash || null,
    baselineArtifactHash: protocol?.preparation?.baseline?.artifact?.sha256 || null,
    candidateArtifactHash: protocol?.preparation?.candidate?.artifact?.sha256 || null,
    migrationManifestHash: protocol?.preparation?.candidate?.release?.config?.policy?.versions?.migrationManifest || null,
    inputEvidenceHash: C.isHash(evidence?.hash) ? evidence.hash : null,
    contractSatisfied, diagnosticOnly: !observed || !contractSatisfied, evaluationPassed: observed && contractSatisfied,
    promotionEligible: observed && contractSatisfied, verifiedRuns: runMap.size, verifiedGrades: gradeMap.size,
    reasons, limitations: ['Independent signatures authenticate attestations, not provider origin or honesty', 'This verifier does not execute builds, tests, models, SQL, signing, activation or deployment', 'Fixture mode never establishes observed evaluation success'] }));
}

function authorizationEvidence(report) {
  const reasons = []; C.checkSeal(report, 'maintenance report', reasons);
  if (reasons.length || report?.kind !== 'maintenance-final-report' || report.phase !== 'maintenance-final' || report.mode !== 'observed' || report.contractSatisfied !== true || report.diagnosticOnly !== false || report.evaluationPassed !== true || report.promotionEligible !== true) throw Error('Complete independently verified observed maintenance-final evidence required');
  return freeze({ phase: 'maintenance-final', configHash: report.configHash, evidenceHash: report.hash, protocolHash: report.protocolHash, corpusHash: report.corpusHash, evaluationPassed: true, promotionEligible: true, diagnosticOnly: false });
}

module.exports = { PURPOSE, TESTS, REVIEWS, ROLES, STAGES, MAX_BYTES, MAX_BUILD_BYTES, MAX_TOTAL_BYTES, ALLOWED_POLICY_CHANGES, observationMessage, createFinalPreparation, validateFinalPreparation, createFinalProtocol, validateFinalProtocol, validateFinalEvidence, authorizationEvidence };
