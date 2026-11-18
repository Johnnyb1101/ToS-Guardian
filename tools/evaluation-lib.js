'use strict';

const crypto = require('crypto');
const J = require('./jury-lib');
const { splitFor } = require('./reference-lib');
const { DOCUMENT_TYPES } = require('./doctype');
const { sha256, checkRelease, releaseLessonsHash } = require('./sites-lib');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const isDomain = value => typeof value === 'string' && value.length <= 253 && value.split('.').every(label => label.length <= 63) && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(value);
const normalizeSplit = split => split === 'holdout' ? 'validation' : split;
const keyOf = (domain, sample) => JSON.stringify([domain, sample]);
const EVALUATION_PROTOCOL = Object.freeze({ v: 1, kind: 'step1a-diagnostic', evidence: 'declared-paired-raw-jury-v1', critic: 'fixed-per-paired-type-across-arms', minWorkSites: 5, minValidationSites: 3, minSamplesPerSite: 3 });
const EVALUATION_PROTOCOL_HASH = sha256(EVALUATION_PROTOCOL);

function declaredSet(meta, arm, reasons) {
  const expected = new Map();
  const sites = new Set();
  if (!meta || !nonempty(meta.runId)) reasons.push(`${arm}: missing runId`);
  if (!meta || !Array.isArray(meta.evaluationSet) || !meta.evaluationSet.length) {
    reasons.push(`${arm}: missing declared evaluation set`);
    return expected;
  }
  for (const site of meta.evaluationSet) {
    if (!site || !isDomain(site.domain) || !['work', 'validation'].includes(normalizeSplit(site.split)) || !DOCUMENT_TYPES.includes(site.docType) || !isHash(site.textHash) || !Array.isArray(site.samples) || site.samples.length < 3 || site.samples.some(s => !Number.isSafeInteger(s) || s < 1) || new Set(site.samples).size !== site.samples.length) {
      reasons.push(`${arm}: invalid declared site (need a document hash and at least 3 unique positive sample IDs)`);
      continue;
    }
    if (sites.has(site.domain)) reasons.push(`${arm}: duplicate declared site ${site.domain}`);
    if (normalizeSplit(site.split) !== normalizeSplit(splitFor(site.domain))) reasons.push(`${arm}: declared split for ${site.domain} differs from the fixed corpus split`);
    sites.add(site.domain);
    for (const sample of site.samples) expected.set(keyOf(site.domain, sample), { domain: site.domain, sample, split: normalizeSplit(site.split), docType: site.docType, textHash: site.textHash });
  }
  return expected;
}

function validRawVerdict(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.sections || typeof parsed.sections !== 'object') return null;
  for (const name of J.SECTIONS) {
    const s = parsed.sections[name];
    if (!s || typeof s.accuracy !== 'string' || typeof s.completeness !== 'string' || (!Object.hasOwn(J.ACCURACY_POINTS, s.accuracy) && s.accuracy !== J.NOT_APPLICABLE) || (!Object.hasOwn(J.COMPLETENESS_POINTS, s.completeness) && s.completeness !== J.NOT_APPLICABLE)) return null;
    if ((s.accuracy === J.NOT_APPLICABLE) !== (s.completeness === J.NOT_APPLICABLE)) return null;
  }
  if (!parsed.bottomLine || typeof parsed.bottomLine.fair !== 'boolean' || !parsed.riskLevel || !J.RISK_LEVELS.includes(parsed.riskLevel.summary) || !J.RISK_LEVELS.includes(parsed.riskLevel.jury)) return null;
  if (!['fabrications', 'omissions'].every(k => Array.isArray(parsed[k]) && parsed[k].every(nonempty))) return null;
  const verdict = J.normalizeVerdict(parsed);
  verdict.fabrications = parsed.fabrications;
  verdict.omissions = parsed.omissions;
  return verdict.valid && Number.isFinite(J.scoreVerdict(verdict).score) ? verdict : null;
}

function validateEvidence({ controlArtifacts, treatmentArtifacts, controlMeta, treatmentMeta, juror }) {
  const reasons = [];
  if (!['anthropic', 'openai'].includes(juror)) reasons.push('juror must be anthropic or openai');
  for (const [arm, meta] of [['control', controlMeta], ['treatment', treatmentMeta]]) {
    const releaseCheck = checkRelease(meta && meta.release, meta && meta.configHash);
    if (!releaseCheck.valid || !isHash(meta && meta.configHash)) reasons.push(`${arm}: missing or invalid complete release configHash (${releaseCheck.reason})`);
    if (!meta || meta.evaluationProtocolHash !== EVALUATION_PROTOCOL_HASH || !meta.evaluationProtocol || sha256(meta.evaluationProtocol) !== EVALUATION_PROTOCOL_HASH) reasons.push(`${arm}: missing or incompatible evaluation protocol`);
  }
  if (checkRelease(controlMeta && controlMeta.release).valid && checkRelease(treatmentMeta && treatmentMeta.release).valid && sha256(controlMeta.release.config.policy) !== sha256(treatmentMeta.release.config.policy)) reasons.push('control and treatment semantic policy versions differ');
  const declarations = { control: declaredSet(controlMeta, 'control', reasons), treatment: declaredSet(treatmentMeta, 'treatment', reasons) };
  const canonical = set => JSON.stringify([...set].sort(([a], [b]) => a.localeCompare(b)));
  if (canonical(declarations.control) !== canonical(declarations.treatment)) reasons.push('control and treatment declared evaluation sets are incompatible');
  const valid = { control: [], treatment: [] };
  const configurations = new Set();
  for (const [arm, artifacts, meta] of [['control', controlArtifacts, controlMeta], ['treatment', treatmentArtifacts, treatmentMeta]]) {
    const seen = new Set();
    if (!Array.isArray(artifacts)) { reasons.push(`${arm}: artifacts must be an array`); continue; }
    for (const a of artifacts) {
      const before = reasons.length;
      if (!a || typeof a !== 'object' || Array.isArray(a)) { reasons.push(`${arm}: invalid artifact`); continue; }
      if (!isDomain(a.domain) || !Number.isSafeInteger(a.sample) || a.sample < 1) { reasons.push(`${arm}: invalid artifact domain or sample ID (undeclared record)`); continue; }
      const key = keyOf(a.domain, a.sample);
      const label = `${arm} ${a.domain}#${a.sample}`;
      if (seen.has(key)) reasons.push(`${label}: duplicate record`);
      seen.add(key);
      const declared = declarations[arm].get(key);
      if (!declared) reasons.push(`${label}: undeclared record`);
      else if (['docType', 'textHash'].some(k => a[k] !== declared[k]) || normalizeSplit(a.split) !== declared.split) reasons.push(`${label}: document or split differs from declared evaluation set`);
      if (!meta || a.runId !== meta.runId || !nonempty(a.runId)) reasons.push(`${label}: incompatible runId`);
      if (a.error || !a.analyzer || a.analyzer.status !== 'ok' || !nonempty(a.analysisSource) || !nonempty(a.summary)) reasons.push(`${label}: failed or missing analyzer output`);
      if (a.verdict && (!['Strong', 'Adequate', 'Failed'].includes(a.verdict.label) || !Number.isFinite(a.verdict.score) || a.verdict.score < 0 || a.verdict.score > 100)) reasons.push(`${label}: invalid evaluator verdict`);
      if (a.cost !== undefined && (!Number.isFinite(a.cost) || a.cost < 0)) reasons.push(`${label}: invalid replay cost`);
      const analyzer = a.analyzer || {};
      const critic = a.criticConfig || {};
      const jury = a.jury && a.jury[juror] || {};
      const policy = meta && meta.release && meta.release.config && meta.release.config.policy || {};
      const providerMatch = typeof analyzer.providerTag === 'string' ? /^(anthropic|openai)(-escalated)?$/.exec(analyzer.providerTag) : null;
      const provider = providerMatch && providerMatch[1];
      const tier = providerMatch && providerMatch[2] ? 'escalated' : 'default';
      if (!provider || analyzer.escalated !== (tier === 'escalated')) reasons.push(`${label}: analyzer provider tag or escalation tier is invalid`);
      if (!provider || analyzer.model !== policy.models?.[provider]?.[tier] || critic.provider !== provider || critic.model !== policy.models?.[provider]?.default || jury.model !== policy.models?.[juror]?.jury) reasons.push(`${label}: model or provider differs from declared release policy`);
      if (analyzer.promptHash !== policy.promptHashes?.analyzer || critic.promptHash !== policy.promptHashes?.critic || jury.promptHash !== policy.promptHashes?.jury || jury.rubricHash !== policy.rubricHash) reasons.push(`${label}: prompt or rubric hash differs from declared release policy`);
      if (!DOCUMENT_TYPES.includes(analyzer.docType) || critic.docType !== analyzer.docType) reasons.push(`${label}: missing or incompatible proxy-classified document type`);
      if (meta && checkRelease(meta.release, meta.configHash).valid && DOCUMENT_TYPES.includes(analyzer.docType)) {
        if (analyzer.lessonsHash !== releaseLessonsHash(meta.release, 'analyzer', analyzer.docType)) reasons.push(`${label}: analyzer lessonsHash differs from complete release resolution`);
        if (critic.lessonsHash !== releaseLessonsHash(meta.release, 'critic', analyzer.docType)) reasons.push(`${label}: critic lessonsHash differs from complete release resolution`);
      }
      if (!meta || a.configHash !== meta.configHash || a.analyzerConfigHash !== meta.configHash || critic.configHash !== meta.configHash) reasons.push(`${label}: response configHash differs from run declaration`);
      const pipelineHash = meta && meta.release && meta.release.config && meta.release.config.policy && meta.release.config.policy.versions && meta.release.config.policy.versions.pipeline;
      if (!pipelineHash || a.clientPolicyHash !== pipelineHash || a.criticClientPolicyHash !== pipelineHash) reasons.push(`${label}: client pipeline policy differs from release`);
      if (a.evaluationProtocolHash !== EVALUATION_PROTOCOL_HASH) reasons.push(`${label}: evaluation protocol differs from run declaration`);
      const hashes = a.evidenceHashes || {};
      if (hashes.analysisSource !== (typeof a.analysisSource === 'string' ? hash(a.analysisSource) : null) || hashes.summary !== (typeof a.summary === 'string' ? hash(a.summary) : null) || hashes.critic !== (a.critic ? sha256(a.critic) : null)) reasons.push(`${label}: evidence hashes do not match captured content`);
      if (!nonempty(analyzer.model) || !isHash(analyzer.promptHash) || !isHash(analyzer.lessonsHash)) reasons.push(`${label}: missing or invalid analyzer model, prompt hash, or lessons hash`);
      if (!nonempty(critic.model) || !isHash(critic.promptHash) || !isHash(critic.lessonsHash)) reasons.push(`${label}: missing or invalid fixed critic configuration`);
      if (!a.critic || a.critic.failed || J.SECTIONS.some(s => !['grounded', 'unsupported', 'vague', 'skipped'].includes(a.critic[s]))) reasons.push(`${label}: failed or invalid critic result`);
      if (jury.error || !nonempty(jury.model) || !isHash(jury.promptHash) || !isHash(jury.rubricHash)) reasons.push(`${label}: missing or invalid jury model, prompt hash, or rubric hash`);
      if (jury.usageRecord && (!nonempty(jury.usageRecord.model) || jury.usageRecord.model !== jury.model || ['input', 'output', 'cacheRead', 'cacheWrite'].some(k => !Number.isSafeInteger(jury.usageRecord[k]) || jury.usageRecord[k] < 0))) reasons.push(`${label}: invalid jury usage record`);
      if (!nonempty(a.analysisSource) || jury.sourceHash !== hash(a.analysisSource) || !nonempty(a.summary) || jury.summaryHash !== hash(a.summary)) reasons.push(`${label}: jury source or summary hash does not match graded content`);
      const verdict = typeof jury.raw === 'string' ? validRawVerdict(jury.raw) : null;
      if (!verdict) reasons.push(`${label}: invalid or missing jury verdict`);
      configurations.add(JSON.stringify([analyzer.providerTag, analyzer.model, analyzer.promptHash, critic.provider, critic.model, critic.promptHash, jury.model, jury.promptHash, jury.rubricHash]));
      if (before === reasons.length) valid[arm].push({ ...a, split: normalizeSplit(a.split), jury: { ...a.jury, [juror]: { ...jury, raw: undefined, verdict, score: J.scoreVerdict(verdict) } } });
    }
    for (const [key, row] of declarations[arm]) if (!seen.has(key)) reasons.push(`${arm} ${row.domain}#${row.sample}: missing declared record`);
  }
  const pairedControl = new Map(valid.control.map(a => [keyOf(a.domain, a.sample), a]));
  for (const a of valid.treatment) {
    const control = pairedControl.get(keyOf(a.domain, a.sample));
    if (!control) continue;
    if (control.jury[juror].sourceHash !== a.jury[juror].sourceHash) reasons.push(`${a.domain}#${a.sample}: incompatible analyzed source hashes across arms`);
    if (control.analyzer.docType !== a.analyzer.docType) reasons.push(`${a.domain}#${a.sample}: proxy-classified document types differ across arms`);
    if (control.criticConfig.lessonsHash !== a.criticConfig.lessonsHash) reasons.push(`${a.domain}#${a.sample}: fixed critic lessons differ across arms for classified document type`);
  }
  if (configurations.size !== 1) reasons.push('incompatible analyzer/jury models, prompts, rubric, or fixed critic configuration across evaluation records');
  return { reasons, valid, declarations };
}

module.exports = { hash, normalizeSplit, validRawVerdict, validateEvidence, EVALUATION_PROTOCOL, EVALUATION_PROTOCOL_HASH };
