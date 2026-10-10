'use strict';

const crypto = require('crypto');
const { SECTIONS, summarizeRun, parseJuryJson, normalizeVerdict } = require('./jury-lib');
const { mean, bootstrapMeanInterval, DEFAULT_RESAMPLES, num, signed, pct } = require('./prove-lib');

const DEFAULT_MIN_CATCH_GAIN = 0.10;
const DEFAULT_MAX_FALSE_ALARM_RISE = 0.10;
const DEFAULT_MAX_FAILURE_RISE = 0.02;
const DEFAULT_MAX_HOLDOUT_LOSS = 0.10;
const CONCERN_LABELS = Object.freeze(['unsupported', 'vague']);

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function criticLabels(critic) {
  if (!critic || critic.failed) return null;
  return Object.fromEntries(SECTIONS.map(s => [s, typeof critic[s] === 'string' ? critic[s] : null]));
}

function concernCount(critic) {
  return SECTIONS.filter(s => CONCERN_LABELS.includes(critic[s])).length;
}

function juryClean(row, artifact, juror) {
  if (row.fabrications !== 0) return false;
  const stored = artifact.jury && artifact.jury[juror];
  const verdict = stored && typeof stored.raw === 'string' ? normalizeVerdict(parseJuryJson(stored.raw)) : null;
  if (!verdict || !verdict.valid) return false;
  return SECTIONS.every(s => {
    const section = verdict.sections[s];
    return !section || ['correct', 'minor', 'not-applicable'].includes(section.accuracy);
  });
}

function composeCriticArtifact(source, result) {
  const sourceCritic = source.critic && !source.critic.failed ? source.critic : null;
  const evaluation = result.evaluation || null;
  return {
    v: 1,
    runId: result.runId,
    domain: source.domain,
    sample: source.sample,
    split: source.split,
    docType: source.docType,
    textHash: source.textHash,
    episodeId: source.episodeId,
    startedAt: result.startedAt,
    durationMs: result.durationMs,
    analyzer: source.analyzer,
    analysisSource: source.analysisSource,
    summary: source.summary,
    critic: result.critic,
    verdict: evaluation ? {
      label: evaluation.label,
      score: evaluation.score,
      issues: evaluation.issues || [],
      warning: evaluation.warning || null,
      optOutLinks: source.verdict ? source.verdict.optOutLinks || [] : [],
      cached: false,
      risk: source.verdict ? source.verdict.risk || null : null
    } : null,
    usage: result.usage || [],
    cost: result.cost || 0,
    unpriced: result.unpriced || 0,
    error: result.error || '',
    logTail: [],
    jury: source.jury || {},
    criticOf: {
      runId: source.runId,
      failed: !sourceCritic,
      labels: criticLabels(source.critic),
      lessonsHash: sourceCritic && typeof sourceCritic._lessonsHash === 'string' ? sourceCritic._lessonsHash : '',
      verdict: source.verdict ? { label: source.verdict.label, score: source.verdict.score } : null
    }
  };
}

function signalsFor(row, artifact, juror = 'anthropic') {
  const critic = row.criticFailed ? null : artifact.critic;
  const concerns = critic ? concernCount(critic) : null;
  return {
    failed: row.criticFailed ? 1 : 0,
    caught: critic && row.fabrications > 0 ? (concerns > 0 ? 1 : 0) : null,
    noticed: critic && row.fabrications > 0 ? (concerns > 0 || (Array.isArray(critic.flags) && critic.flags.length > 0) ? 1 : 0) : null,
    falseAlarm: critic && juryClean(row, artifact, juror) ? (concerns > 0 ? 1 : 0) : null,
    agreement: critic && typeof row.criticAgreement === 'number' ? row.criticAgreement : null,
    concerns,
    label: row.label || null,
    labelBefore: artifact.criticOf && artifact.criticOf.verdict ? artifact.criticOf.verdict.label : null,
    lessonsHash: critic && typeof critic._lessonsHash === 'string' ? critic._lessonsHash : ''
  };
}

function perSiteCritic(artifacts, juror) {
  const summary = summarizeRun(artifacts, { juror });
  const byKey = new Map(artifacts.map(a => [`${a.domain}#${a.sample}`, a]));
  const sites = {};
  const verdicts = [];
  for (const row of summary.rows) {
    const artifact = byKey.get(`${row.domain}#${row.sample}`);
    if (!artifact) continue;
    const s = signalsFor(row, artifact, juror);
    verdicts.push({ domain: row.domain, sample: row.sample, split: row.split, summaryHash: sha256(artifact.summary), ...s });
    const site = sites[row.domain] = sites[row.domain] || { domain: row.domain, split: row.split, docType: row.docType, failed: [], caught: [], noticed: [], falseAlarm: [], agreement: [], concerns: [], labelChanged: [], lessonsHashes: new Set() };
    site.failed.push(s.failed);
    if (s.caught !== null) site.caught.push(s.caught);
    if (s.noticed !== null) site.noticed.push(s.noticed);
    if (s.falseAlarm !== null) site.falseAlarm.push(s.falseAlarm);
    if (s.agreement !== null) site.agreement.push(s.agreement);
    if (s.concerns !== null) site.concerns.push(s.concerns);
    if (s.label && s.labelBefore) site.labelChanged.push(s.label === s.labelBefore ? 0 : 1);
    if (s.lessonsHash) site.lessonsHashes.add(s.lessonsHash);
  }
  for (const site of Object.values(sites)) {
    site.failedRate = mean(site.failed);
    site.catchRate = mean(site.caught);
    site.noticeRate = mean(site.noticed);
    site.falseAlarmRate = mean(site.falseAlarm);
    site.agreementRate = mean(site.agreement);
    site.concernRate = mean(site.concerns);
    site.labelChangedRate = mean(site.labelChanged);
    site.lessonsHashes = [...site.lessonsHashes];
  }
  return { summary, sites, verdicts };
}

function pairedSiteDeltas(control, treatment, metric) {
  const deltas = [];
  for (const domain of Object.keys(treatment.sites)) {
    const t = treatment.sites[domain];
    const c = control.sites[domain];
    if (!c || typeof t[metric] !== 'number' || typeof c[metric] !== 'number') continue;
    deltas.push({ domain, split: t.split, docType: t.docType, control: c[metric], treatment: t[metric], delta: t[metric] - c[metric] });
  }
  return deltas.sort((a, b) => a.domain.localeCompare(b.domain));
}

function splitStats(deltas, split, resamples, seed) {
  const values = deltas.filter(d => split === 'all' || d.split === split).map(d => d.delta);
  const interval = bootstrapMeanInterval(values, resamples, seed);
  return { n: values.length, mean: mean(values), lower: interval.lower, upper: interval.upper, improved: values.filter(v => v > 0).length, worsened: values.filter(v => v < 0).length };
}

function labelFlips(treatment) {
  const flips = {};
  let compared = 0;
  let changed = 0;
  for (const v of treatment.verdicts) {
    if (!v.label || !v.labelBefore) continue;
    compared++;
    if (v.label === v.labelBefore) continue;
    changed++;
    const key = `${v.labelBefore} to ${v.label}`;
    flips[key] = (flips[key] || 0) + 1;
  }
  return { compared, changed, flips };
}

function proveCritic({ controlArtifacts, treatmentArtifacts, juror = 'anthropic', minCatchGain = DEFAULT_MIN_CATCH_GAIN, maxFalseAlarmRise = DEFAULT_MAX_FALSE_ALARM_RISE, maxFailureRise = DEFAULT_MAX_FAILURE_RISE, maxHoldoutLoss = DEFAULT_MAX_HOLDOUT_LOSS, resamples = DEFAULT_RESAMPLES, meta = {} }) {
  const control = perSiteCritic(controlArtifacts, juror);
  const treatment = perSiteCritic(treatmentArtifacts, juror);
  const controlHashes = new Map(control.verdicts.map(v => [`${v.domain}#${v.sample}`, v.summaryHash]));
  let paired = 0;
  let mismatched = 0;
  for (const v of treatment.verdicts) {
    const h = controlHashes.get(`${v.domain}#${v.sample}`);
    if (!h) continue;
    paired++;
    if (h !== v.summaryHash) mismatched++;
  }
  const metrics = {};
  for (const [metric, higherIsBetter] of [['catchRate', true], ['noticeRate', true], ['falseAlarmRate', false], ['agreementRate', true], ['failedRate', false], ['concernRate', null]]) {
    const deltas = pairedSiteDeltas(control, treatment, metric);
    metrics[metric] = { higherIsBetter, all: splitStats(deltas, 'all', resamples, 1), work: splitStats(deltas, 'work', resamples, 2), holdout: splitStats(deltas, 'holdout', resamples, 3), sites: deltas };
  }
  const failedOverall = (run) => mean(run.verdicts.map(v => v.failed));
  const failure = { control: failedOverall(control), treatment: failedOverall(treatment) };
  const catchRate = metrics.catchRate;
  const falseAlarm = metrics.falseAlarmRate;
  const reasons = [];
  if (paired === 0) reasons.push('no paired verdicts between the two runs');
  if (mismatched > 0) reasons.push(`analyses differ on ${mismatched} of ${paired} paired verdict(s); a critic proof needs the same analyses in both arms`);
  if (catchRate.work.n < 5) reasons.push(`only ${catchRate.work.n} paired work site(s) with jury fabrications; need at least 5`);
  if (catchRate.work.lower === null || catchRate.work.lower <= 0) reasons.push(`work-split catch-rate gain is inside the noise (mean ${signed(catchRate.work.mean * 100, 0)} pts, 95% interval ${num(catchRate.work.lower * 100, 0)} to ${num(catchRate.work.upper * 100, 0)} pts)`);
  if (catchRate.work.mean !== null && catchRate.work.mean < minCatchGain) reasons.push(`work-split catch-rate gain ${signed(catchRate.work.mean * 100, 0)} pts is below the ${Math.round(minCatchGain * 100)}-point floor`);
  if (falseAlarm.all.n >= 3 && falseAlarm.all.upper !== null && falseAlarm.all.upper > maxFalseAlarmRise) reasons.push(`false alarms may have risen by up to ${num(falseAlarm.all.upper * 100, 0)} pts (limit ${Math.round(maxFalseAlarmRise * 100)})`);
  if (failure.treatment !== null && failure.control !== null && failure.treatment > failure.control + maxFailureRise) reasons.push(`critic failed to parse on ${pct(failure.treatment)} of treatment verdicts against ${pct(failure.control)} in control`);
  if (catchRate.holdout.n >= 3 && catchRate.holdout.lower !== null && catchRate.holdout.lower < -maxHoldoutLoss) reasons.push(`holdout catch rate may have regressed (95% interval ${num(catchRate.holdout.lower * 100, 0)} to ${num(catchRate.holdout.upper * 100, 0)} pts)`);
  const treatmentHashes = new Set(Object.values(treatment.sites).flatMap(s => s.lessonsHashes));
  const controlHashSet = new Set(Object.values(control.sites).flatMap(s => s.lessonsHashes));
  if (treatmentHashes.size !== 1) reasons.push(`treatment critic ran under ${treatmentHashes.size} lesson sets; a proof needs exactly one`);
  const proven = reasons.length === 0;
  const flips = labelFlips(treatment);
  return {
    v: 1,
    kind: 'critic',
    provenAt: new Date().toISOString(),
    controlRunId: meta.controlRunId || null,
    runId: meta.runId || null,
    juror,
    thresholds: { minCatchGain, maxFalseAlarmRise, maxFailureRise, maxHoldoutLoss, resamples },
    lessonsHash: treatmentHashes.size === 1 ? [...treatmentHashes][0] : null,
    controlLessonsHashes: [...controlHashSet],
    samples: { control: control.verdicts.length, treatment: treatment.verdicts.length, paired, mismatched },
    cost: { treatment: treatmentArtifacts.reduce((n, a) => n + (typeof a.cost === 'number' ? a.cost : 0), 0) },
    failure,
    labelFlips: flips,
    metrics,
    proven,
    reasons,
    summary: proven
      ? `Proven: critic catch rate ${signed(catchRate.work.mean * 100, 0)} pts on ${catchRate.work.n} work sites (95% ${num(catchRate.work.lower * 100, 0)} to ${num(catchRate.work.upper * 100, 0)}), false alarms ${signed(falseAlarm.all.mean * 100, 0)} pts, holdout ${catchRate.holdout.n ? `${signed(catchRate.holdout.mean * 100, 0)} pts on ${catchRate.holdout.n}` : 'not compared'}.`
      : `Not proven: ${reasons.join('; ')}.`
  };
}

function renderCriticProof(proof) {
  const lines = [];
  lines.push(`# Critic proof — ${proof.runId || 'treatment'} against ${proof.controlRunId || 'control'}`);
  lines.push('');
  lines.push(proof.summary);
  lines.push('');
  lines.push(`Critic lesson set ${proof.lessonsHash ? proof.lessonsHash.slice(0, 12) : 'mixed or none'} against control set(s) ${proof.controlLessonsHashes.length ? proof.controlLessonsHashes.map(h => h.slice(0, 12)).join(', ') : 'none recorded'}. Juror ${proof.juror}. ${proof.samples.treatment} treatment verdicts, ${proof.samples.control} control verdicts, ${proof.samples.paired} paired on identical analyses${proof.samples.mismatched ? ` (${proof.samples.mismatched} differ)` : ''}; treatment critic calls cost $${num(proof.cost.treatment, 2)}.`);
  lines.push(`Catch rate counts a section labelled unsupported or vague on a verdict where the jury found a fabrication; notice rate also counts a flag with no section label changed, which the evaluator ignores.`);
  lines.push(`Rule: proven when the paired work-split catch rate gains at least ${Math.round(proof.thresholds.minCatchGain * 100)} points with a 95% bootstrap interval above zero, false alarms (a concern on a verdict the jury found clean) do not rise by more than ${Math.round(proof.thresholds.maxFalseAlarmRise * 100)} points, the critic's parse failures do not rise by more than ${Math.round(proof.thresholds.maxFailureRise * 100)} points, and the holdout catch rate does not fall by more than ${Math.round(proof.thresholds.maxHoldoutLoss * 100)}.`);
  lines.push(`Parse failures: ${pct(proof.failure.control)} control, ${pct(proof.failure.treatment)} treatment.`);
  if (proof.labelFlips.compared) {
    const detail = Object.entries(proof.labelFlips.flips).map(([k, n]) => `${k} ${n}`).join(', ');
    lines.push(`Evaluator label changed on ${proof.labelFlips.changed} of ${proof.labelFlips.compared} verdicts${detail ? ` (${detail})` : ''}.`);
  }
  lines.push('');
  lines.push('| metric | split | sites | control | treatment | delta | 95% interval | better / worse |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const [metric, m] of Object.entries(proof.metrics)) {
    for (const split of ['work', 'holdout', 'all']) {
      const s = m[split];
      if (!s.n) continue;
      const rows = m.sites.filter(d => split === 'all' || d.split === split);
      const c = mean(rows.map(d => d.control));
      const t = mean(rows.map(d => d.treatment));
      const rate = metric !== 'concernRate';
      const fmt = rate ? pct : (v) => num(v, 2);
      const better = m.higherIsBetter === null ? '-' : m.higherIsBetter ? s.improved : s.worsened;
      const worse = m.higherIsBetter === null ? '-' : m.higherIsBetter ? s.worsened : s.improved;
      lines.push(`| ${metric} | ${split} | ${s.n} | ${fmt(c)} | ${fmt(t)} | ${rate ? `${signed(s.mean * 100, 0)} pts` : signed(s.mean, 2)} | ${rate ? `${num(s.lower * 100, 0)} to ${num(s.upper * 100, 0)} pts` : `${num(s.lower, 2)} to ${num(s.upper, 2)}`} | ${better} / ${worse} |`);
    }
  }
  lines.push('');
  lines.push('## Sites (catch rate)');
  lines.push('');
  lines.push('| site | split | type | control | treatment | delta |');
  lines.push('|---|---|---|---|---|---|');
  for (const d of [...proof.metrics.catchRate.sites].sort((a, b) => a.delta - b.delta)) lines.push(`| ${d.domain} | ${d.split} | ${d.docType} | ${pct(d.control)} | ${pct(d.treatment)} | ${signed(d.delta * 100, 0)} pts |`);
  if (proof.reasons.length) {
    lines.push('');
    lines.push('## Why not proven');
    lines.push('');
    for (const r of proof.reasons) lines.push(`- ${r}`);
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = { DEFAULT_MIN_CATCH_GAIN, DEFAULT_MAX_FALSE_ALARM_RISE, DEFAULT_MAX_FAILURE_RISE, DEFAULT_MAX_HOLDOUT_LOSS, CONCERN_LABELS, concernCount, composeCriticArtifact, signalsFor, perSiteCritic, pairedSiteDeltas, proveCritic, renderCriticProof };
