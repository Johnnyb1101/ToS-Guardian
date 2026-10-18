'use strict';

const C = require('./final-corpus-lib');
const { releaseLessonsHash } = require('./sites-lib');
const FLAGS = Object.freeze({ diagnosticOnly: true, promotionEligible: false, evaluationPassed: false });
const UNAPPROVED_FIELDS = Object.freeze(['siteCount', 'passCriteria', 'independentCoverage', 'humanCoverage', 'spendingCap']);
const ARMS = Object.freeze(['control', 'treatment']);
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;

function createDraftProtocol({ controlRelease = null, treatmentRelease = null, selectedLessonIds = [], corpusHash = null, judge = null } = {}) {
  return C.seal({
    v: 1, kind: 'step2-preparation', status: 'UNAPPROVED', ...FLAGS,
    siteCount: null, passCriteria: null, independentCoverage: null, humanCoverage: null, spendingCap: null,
    repetitions: 1, sourcePolicy: 'exact-frozen-source', controlConfigHash: controlRelease?.configHash || null,
    treatmentConfigHash: treatmentRelease?.configHash || null, selectedLessonIds, corpusHash, judge
  });
}

function validateProtocol(protocol) {
  const reasons = [], blockers = UNAPPROVED_FIELDS.map(field => `${field} is UNAPPROVED`);
  C.checkSeal(protocol, 'protocol', reasons);
  if (protocol?.v !== 1 || protocol?.kind !== 'step2-preparation' || protocol?.status !== 'UNAPPROVED') reasons.push('only an UNAPPROVED Step 2 preparation protocol is supported');
  for (const [key, value] of Object.entries(FLAGS)) if (protocol?.[key] !== value) reasons.push(`protocol ${key} must be ${value}`);
  for (const key of UNAPPROVED_FIELDS) if (protocol?.[key] !== null) reasons.push(`${key} must remain null until a separately approved implementation`);
  if (protocol?.repetitions !== 1) reasons.push('preparation protocol uses exactly one diagnostic repetition; live repetitions are not approved');
  if (protocol?.sourcePolicy !== 'exact-frozen-source') reasons.push('preparation requires exact frozen source text');
  for (const key of ['controlConfigHash', 'treatmentConfigHash', 'corpusHash']) {
    if (protocol?.[key] === null) blockers.push(`${key} has not been frozen`);
    else if (!C.isHash(protocol?.[key])) reasons.push(`invalid protocol ${key}`);
  }
  const ids = protocol?.selectedLessonIds;
  if (!Array.isArray(ids) || ids.some(id => !C.nonempty(id)) || new Set(ids).size !== ids.length || (ids.length !== 0 && ids.length !== 6)) reasons.push('protocol must identify exactly six selected Analyzer lessons');
  else if (!ids.length) blockers.push('selected Analyzer lessons have not been frozen');
  const judge = protocol?.judge;
  if (judge === null) blockers.push('planned independent judge has not been frozen');
  else if (!judge || !['anthropic', 'openai'].includes(judge.provider) || !C.nonempty(judge.model) || !C.isHash(judge.promptHash) || !C.isHash(judge.rubricHash)) reasons.push('planned judge requires provider, model, promptHash, and rubricHash');
  return { valid: !reasons.length, reasons, blockers, ...FLAGS };
}

const artifactHash = C.bodyHash;
const keyOf = a => JSON.stringify([a.arm, a.siteId, a.sample]);
function evidenceBindings(artifact) {
  return Object.fromEntries(['protocolHash', 'sourceHash', 'analysisSourceHash', 'summaryHash', 'criticHash', 'configHash'].map(key => [key, artifact[key]]));
}

function validateArtifacts({ artifacts, protocol, corpus, controlRelease, treatmentRelease }) {
  const reasons = [], valid = [], expected = new Set(), chains = new Map(), ids = new Set();
  const sites = new Map((Array.isArray(corpus?.sites) ? corpus.sites : []).filter(s => s && typeof s === 'object').map(s => [s.siteId, s]));
  const repetitions = protocol?.repetitions === 1 ? 1 : 0;
  for (const siteId of sites.keys()) for (const arm of ARMS) for (let sample = 1; sample <= repetitions; sample++) expected.add(keyOf({ arm, siteId, sample }));
  if (!Array.isArray(artifacts)) return { reasons: ['artifacts must be an array'], valid, expected, chains };
  const releases = { control: controlRelease, treatment: treatmentRelease };
  for (const a of artifacts) {
    const before = reasons.length;
    if (!a || typeof a !== 'object' || Array.isArray(a)) { reasons.push('invalid artifact'); continue; }
    const label = `artifact ${a.artifactId || '(missing ID)'}`;
    C.checkSeal(a, label, reasons);
    if (a.v !== 1 || a.kind !== 'step2-artifact') reasons.push(`${label}: invalid artifact schema`);
    if (a.split !== 'final' || a.purpose !== 'final-evaluation-only' || a.learningAllowed !== false) reasons.push(`${label}: final-only split and disabled learning are required`);
    if (!C.nonempty(a.artifactId) || ids.has(a.artifactId)) reasons.push(`${label}: missing or duplicate artifact ID`);
    ids.add(a.artifactId);
    if (a.mock !== true) reasons.push(`${label}: preparation accepts mock artifacts only; no real provider execution or proof path exists`);
    for (const [key, value] of Object.entries(FLAGS)) if (a[key] !== value) reasons.push(`${label}: ${key} must be ${value}`);
    const key = keyOf(a), site = sites.get(a.siteId), release = releases[a.arm];
    if (!expected.has(key)) reasons.push(`${label}: undeclared arm/site/sample`);
    if (a.protocolHash !== protocol?.hash || !C.isHash(a.protocolHash)) reasons.push(`${label}: stale protocol hash`);
    if (!release || a.configHash !== release.configHash) reasons.push(`${label}: release config hash mismatch`);
    if (!site || a.sourceHash !== site.sourceHash) reasons.push(`${label}: corpus source hash mismatch`);
    if (a.status === 'ok' && site && a.analysisSource !== site.sourceText) reasons.push(`${label}: analyzed source differs from exact frozen source`);
    if (!['ok', 'failed'].includes(a.status)) reasons.push(`${label}: invalid attempt status`);
    if (!positiveInteger(a.attempt)) reasons.push(`${label}: invalid attempt number`);
    const prior = chains.get(key) || [];
    if (a.attempt !== prior.length + 1 || a.previousAttemptHash !== (prior.at(-1)?.hash || null)) reasons.push(`${label}: attempts must be append-only, consecutive and hash-linked`);
    prior.push(a); chains.set(key, prior);
    for (const field of ['analysisSource', 'summary']) {
      if (typeof a[field] !== 'string' || a[`${field}Hash`] !== C.hashText(a[field] || '')) reasons.push(`${label}: ${field} hash mismatch`);
    }
    try { if (a.criticHash !== C.digest(a.critic)) reasons.push(`${label}: critic hash mismatch`); }
    catch (error) { reasons.push(`${label}: invalid critic (${error.message})`); }
    if (a.status === 'ok' && (!C.nonempty(a.analysisSource) || !C.nonempty(a.summary) || !a.critic || typeof a.critic !== 'object' || Array.isArray(a.critic))) reasons.push(`${label}: successful attempt requires captured source, summary and critic`);
    // These fields establish the per-document resolved lessons, rather than
    // assuming a complete release hash proves what was selected at runtime.
    if (site && release && a.status === 'ok') {
      const analyzer = a.analyzer, critic = a.criticConfig, policy = release.config?.policy;
      if (a.docType !== site.docType) reasons.push(`${label}: classified document type differs from frozen declaration`);
      if (!analyzer || !['anthropic', 'openai'].includes(analyzer.provider) || !['default', 'escalated'].includes(analyzer.tier) || !C.nonempty(analyzer.model) || analyzer.model !== policy?.models?.[analyzer.provider]?.[analyzer.tier] || !C.isHash(analyzer.promptHash) || analyzer.promptHash !== policy?.promptHashes?.analyzer) reasons.push(`${label}: Analyzer provider/model/prompt differs from release policy`);
      if (!critic || critic.provider !== analyzer?.provider || !C.nonempty(critic.model) || critic.model !== policy?.models?.[critic.provider]?.default || !C.isHash(critic.promptHash) || critic.promptHash !== policy?.promptHashes?.critic) reasons.push(`${label}: fixed critic provider/model/prompt differs from release policy`);
      if (!protocol?.judge || analyzer?.provider === protocol.judge.provider) reasons.push(`${label}: planned independent judge must use a different provider from Analyzer`);
      try {
        if (a.analyzerLessonsHash !== releaseLessonsHash(release, 'analyzer', site.docType) || a.criticLessonsHash !== releaseLessonsHash(release, 'critic', site.docType)) reasons.push(`${label}: resolved lesson hash mismatch`);
      } catch { reasons.push(`${label}: cannot resolve release lessons`); }
    }
    if (a.status === 'failed' && !C.nonempty(a.error)) reasons.push(`${label}: failed attempt requires an error`);
    if (a.usage !== null && (!a.usage || !Number.isSafeInteger(a.usage.inputTokens) || a.usage.inputTokens < 0 || !Number.isSafeInteger(a.usage.outputTokens) || a.usage.outputTokens < 0 || !nonnegative(a.usage.costUsd))) reasons.push(`${label}: invalid or missing usage (use null for unknown)`);
    if (a.latencyMs !== null && !nonnegative(a.latencyMs)) reasons.push(`${label}: invalid or missing latency (use null for unknown)`);
    if (before === reasons.length) valid.push(a);
  }
  for (const key of expected) if (!chains.has(key)) reasons.push(`missing declared artifact ${key}`);
  // Pair exact evaluated inputs; an arm-specific excerpt is not a paired test.
  for (const siteId of sites.keys()) for (let sample = 1; sample <= repetitions; sample++) {
    const left = chains.get(keyOf({ arm: 'control', siteId, sample }))?.at(-1);
    const right = chains.get(keyOf({ arm: 'treatment', siteId, sample }))?.at(-1);
    if (left?.status === 'ok' && right?.status === 'ok') {
      if (left.analysisSourceHash !== right.analysisSourceHash || left.criticLessonsHash !== right.criticLessonsHash) reasons.push(`${siteId}#${sample}: analyzed source or fixed critic lessons differ between arms`);
      try { if (C.digest(left.criticConfig) !== C.digest(right.criticConfig) || left.analyzer?.provider !== right.analyzer?.provider) reasons.push(`${siteId}#${sample}: fixed provider/critic configuration differs between arms`); }
      catch { reasons.push(`${siteId}#${sample}: missing runtime identity`); }
    }
  }
  return { reasons, valid, expected, chains };
}

function validateGrades(grades, artifacts, protocol) {
  const reasons = [], valid = [], seen = new Set(), ids = new Set();
  const byHash = new Map(artifacts.map(a => [a.hash, a]));
  if (!Array.isArray(grades)) return { reasons: ['grades must be an array'], valid };
  for (const g of grades) {
    const before = reasons.length;
    if (!g || typeof g !== 'object') { reasons.push('invalid independent grade'); continue; }
    const label = `grade ${g.gradeId || '(missing ID)'}`;
    C.checkSeal(g, label, reasons);
    if (g.v !== 1 || g.kind !== 'step2-grade' || !C.nonempty(g.gradeId) || ids.has(g.gradeId)) reasons.push(`${label}: invalid schema or duplicate grade ID`);
    for (const [key, value] of Object.entries(FLAGS)) if (g[key] !== value) reasons.push(`${label}: ${key} must be ${value}`);
    ids.add(g.gradeId);
    const artifact = byHash.get(g.artifactHash);
    if (!artifact || artifact.status !== 'ok') reasons.push(`${label}: missing or invalid successful artifact`);
    else for (const [key, value] of Object.entries(evidenceBindings(artifact))) if (g[key] !== value) reasons.push(`${label}: ${key} mismatch`);
    if (seen.has(g.artifactHash)) reasons.push(`${label}: duplicate grade for artifact`);
    seen.add(g.artifactHash);
    const reviewer = g.reviewer, judge = protocol?.judge;
    if (reviewer?.kind !== 'independent' || !judge || ['provider', 'model', 'promptHash', 'rubricHash'].some(key => reviewer[key] !== judge[key])) reasons.push(`${label}: independent judge differs from frozen plan`);
    for (const field of ['accuracy', 'completeness']) if (!nonnegative(g[field]) || g[field] > 1) reasons.push(`${label}: ${field} must be between zero and one`);
    if (!Number.isSafeInteger(g.fabrications) || g.fabrications < 0) reasons.push(`${label}: fabrications must be a nonnegative count`);
    if (g.usage !== null && (!g.usage || !Number.isSafeInteger(g.usage.inputTokens) || g.usage.inputTokens < 0 || !Number.isSafeInteger(g.usage.outputTokens) || g.usage.outputTokens < 0 || !nonnegative(g.usage.costUsd))) reasons.push(`${label}: invalid or missing judge usage (use null for unknown)`);
    if (g.latencyMs !== null && !nonnegative(g.latencyMs)) reasons.push(`${label}: invalid or missing judge latency (use null for unknown)`);
    if (before === reasons.length) valid.push(g);
  }
  for (const a of artifacts) if (a.status === 'ok' && !seen.has(a.hash)) reasons.push(`missing independent grade for artifact ${a.artifactId}`);
  return { reasons, valid };
}

const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
function metrics(artifacts, grades, selectedHashes) {
  const byHash = new Map(artifacts.map(a => [a.hash, a]));
  const allGrades = grades;
  grades = grades.filter(g => selectedHashes.has(g.artifactHash));
  const arms = {};
  for (const arm of ARMS) {
    const rows = artifacts.filter(a => a.arm === arm), scored = grades.filter(g => byHash.get(g.artifactHash)?.arm === arm);
    const knownCost = rows.filter(a => a.usage !== null), knownLatency = rows.filter(a => a.latencyMs !== null);
    const judgeRows = allGrades.filter(g => byHash.get(g.artifactHash)?.arm === arm), knownJudgeCost = judgeRows.filter(g => g.usage !== null), knownJudgeLatency = judgeRows.filter(g => g.latencyMs !== null);
    arms[arm] = {
      attempts: rows.length, failures: rows.filter(a => a.status === 'failed').length,
      graded: scored.length, accuracy: mean(scored.map(g => g.accuracy)), completeness: mean(scored.map(g => g.completeness)),
      fabrications: scored.length ? scored.reduce((n, g) => n + g.fabrications, 0) : null,
      costUsd: rows.length && knownCost.length === rows.length ? knownCost.reduce((n, a) => n + a.usage.costUsd, 0) : null,
      knownCostUsd: knownCost.length ? knownCost.reduce((n, a) => n + a.usage.costUsd, 0) : null,
      unknownUsageAttempts: rows.length - knownCost.length,
      latencyMs: rows.length && knownLatency.length === rows.length ? mean(knownLatency.map(a => a.latencyMs)) : null,
      knownMeanLatencyMs: mean(knownLatency.map(a => a.latencyMs)), unknownLatencyAttempts: rows.length - knownLatency.length,
      costScope: 'supplied pipeline aggregate, excluding independent judge',
      independentJudgeUsage: {
        attempts: judgeRows.length,
        costUsd: judgeRows.length && judgeRows.length === knownJudgeCost.length ? knownJudgeCost.reduce((n, g) => n + g.usage.costUsd, 0) : null,
        knownCostUsd: knownJudgeCost.length ? knownJudgeCost.reduce((n, g) => n + g.usage.costUsd, 0) : null,
        unknownUsageAttempts: judgeRows.length - knownJudgeCost.length,
        latencyMs: judgeRows.length && judgeRows.length === knownJudgeLatency.length ? mean(knownJudgeLatency.map(g => g.latencyMs)) : null,
        unknownLatencyAttempts: judgeRows.length - knownJudgeLatency.length
      }
    };
  }
  const sites = [...new Set(artifacts.map(a => a.siteId))].sort().map(siteId => {
    const site = {};
    for (const arm of ARMS) {
      const scored = grades.filter(g => byHash.get(g.artifactHash)?.siteId === siteId && byHash.get(g.artifactHash)?.arm === arm);
      site[arm] = { graded: scored.length, accuracy: mean(scored.map(g => g.accuracy)), completeness: mean(scored.map(g => g.completeness)), fabrications: mean(scored.map(g => g.fabrications)) };
    }
    const delta = field => site.control[field] !== null && site.treatment[field] !== null ? site.treatment[field] - site.control[field] : null;
    return { siteId, ...site, treatmentMinusControl: { accuracy: delta('accuracy'), completeness: delta('completeness'), fabrications: delta('fabrications') } };
  });
  const siteClusteredDifference = Object.fromEntries(['accuracy', 'completeness', 'fabrications'].map(field => [field, mean(sites.map(s => s.treatmentMinusControl[field]).filter(v => v !== null))]));
  return { arms, sites, siteClusteredDifference, inference: 'descriptive only; equal weight per paired site; no approved statistical gate' };
}

function validateHumanReviews(records, artifacts) {
  const reasons = [], latestItems = new Map(), judgments = new Map(), ids = new Set();
  const byHash = new Map(artifacts.filter(a => a.status === 'ok').map(a => [a.hash, a]));
  const summary = { supplied: Array.isArray(records) ? records.length : 0, accepted: 0, reviewedArtifacts: 0, pending: byHash.size, unsure: 0, judgments: { claim: { supported: 0, unsupported: 0, unsure: 0 }, omission: { supported: 0, unsupported: 0, unsure: 0 } }, scope: 'qualitative findings only; no numeric score or approved coverage gate' };
  if (!Array.isArray(records)) return { reasons: ['humanReviews must be an array'], summary };
  const { validateSubmission } = require('./final-review-lib');
  const reviewed = new Set();
  for (const record of records) {
    const before = reasons.length;
    if (!record || typeof record !== 'object') { reasons.push('invalid human review'); continue; }
    const label = `human review ${record.reviewId || '(missing ID)'}`;
    C.checkSeal(record, label, reasons);
    if (record.v !== 1 || record.kind !== 'step2-human-review' || !C.nonempty(record.reviewId) || ids.has(record.reviewId)) reasons.push(`${label}: invalid schema or duplicate review ID`);
    for (const [key, value] of Object.entries(FLAGS)) if (record[key] !== value) reasons.push(`${label}: ${key} must be ${value}`);
    ids.add(record.reviewId);
    if (!C.nonempty(record.recordedAt) || !Number.isFinite(Date.parse(record.recordedAt))) reasons.push(`${label}: invalid timestamp`);
    const artifact = byHash.get(record.artifactHash);
    if (!artifact) reasons.push(`${label}: missing current successful artifact head`);
    else {
      for (const [key, value] of Object.entries({ ...evidenceBindings(artifact), arm: artifact.arm, siteId: artifact.siteId, sample: artifact.sample })) if (record[key] !== value) reasons.push(`${label}: ${key} mismatch`);
      try {
        const fields = Object.fromEntries(['itemId', 'finding', 'verdict', 'subject', 'sourceEvidence', 'note'].map(key => [key, record[key]]));
        validateSubmission(fields, { items: [{ itemId: record.itemId, analysisSource: artifact.analysisSource, summary: artifact.summary }] }, { bindings: { [record.itemId]: {} } });
      } catch (error) { reasons.push(`${label}: ${error.message}`); }
    }
    const previous = latestItems.get(record.itemId);
    if (record.attempt !== (previous ? previous.attempt + 1 : 1) || record.previousAttemptHash !== (previous?.hash || null) || (previous && record.artifactHash !== previous.artifactHash)) reasons.push(`${label}: invalid append-only attempt chain`);
    latestItems.set(record.itemId, record);
    if (before === reasons.length) {
      summary.accepted++;
      reviewed.add(record.artifactHash);
      judgments.set(JSON.stringify([record.artifactHash, record.finding, record.subject]), record);
    }
  }
  for (const record of judgments.values()) {
    summary.judgments[record.finding][record.verdict]++;
    if (record.verdict === 'unsure') summary.unsure++;
  }
  summary.reviewedArtifacts = reviewed.size;
  summary.pending = byHash.size - reviewed.size;
  return { reasons, summary };
}

function evaluatePreparation({ protocol, controlRelease, treatmentRelease, corpus, history, artifacts = [], grades = [], humanReviews = [] }) {
  const p = validateProtocol(protocol), c = C.validateCorpus(corpus, history), pair = C.validateReleasePair(controlRelease, treatmentRelease, protocol?.selectedLessonIds);
  const reasons = [...p.reasons, ...c.reasons, ...pair.reasons];
  if (protocol?.corpusHash !== corpus?.hash) reasons.push('protocol corpus hash mismatch');
  for (const [arm, release] of [['control', controlRelease], ['treatment', treatmentRelease]]) if (protocol?.[`${arm}ConfigHash`] !== release?.configHash) reasons.push(`${arm}: protocol release config hash mismatch`);
  const a = validateArtifacts({ artifacts, protocol, corpus, controlRelease, treatmentRelease });
  reasons.push(...a.reasons);
  const g = validateGrades(grades, a.valid, protocol);
  reasons.push(...g.reasons);
  const latest = [...a.chains.values()].map(chain => chain.at(-1));
  const validHashes = new Set(a.valid.map(row => row.hash));
  const selectedHashes = new Set(latest.filter(row => validHashes.has(row.hash) && row.status === 'ok').map(row => row.hash));
  const human = validateHumanReviews(humanReviews, a.valid.filter(row => selectedHashes.has(row.hash)));
  reasons.push(...human.reasons);
  const blockers = [...p.blockers, 'preparation implementation cannot execute providers or produce final eligible proof'];
  return C.seal({
    v: 1, kind: 'step2-preparation-report', ...FLAGS, protocolHash: protocol?.hash || null,
    evidenceValid: !reasons.length, reasons, blockers,
    completeness: { declaredSlots: a.expected.size, suppliedArtifacts: Array.isArray(artifacts) ? artifacts.length : 0, validArtifacts: a.valid.length, successfulSlots: selectedHashes.size, latestFailedSlots: latest.filter(row => row.status === 'failed').length, independentGrades: g.valid.length, human: human.summary },
    metrics: metrics(a.valid, g.valid, selectedHashes), historyCoverage: c.historyCoverage, historyLimitations: c.limitations
  });
}

module.exports = { FLAGS, UNAPPROVED_FIELDS, createDraftProtocol, validateProtocol, artifactHash, evidenceBindings, validateArtifacts, validateGrades, validateHumanReviews, evaluatePreparation, validateCorpus: C.validateCorpus, checkReleasePair: C.validateReleasePair };
