'use strict';

const { SECTIONS, summarizeRun } = require('./jury-lib');

const DEFAULT_MIN_GAIN = 3;
const DEFAULT_MAX_HOLDOUT_LOSS = 5;
const DEFAULT_RESAMPLES = 5000;

function mean(values) {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrapMeanInterval(values, resamples = DEFAULT_RESAMPLES, seed = 7) {
  if (values.length < 2) return { lower: null, upper: null };
  const random = mulberry32(seed);
  const means = [];
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[Math.floor(random() * values.length)];
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  return { lower: means[Math.floor(0.025 * resamples)], upper: means[Math.ceil(0.975 * resamples) - 1] };
}

function perSite(artifacts, juror) {
  const summary = summarizeRun(artifacts, { juror });
  const sites = {};
  for (const row of summary.rows) {
    if (typeof row.juryScore !== 'number') continue;
    const site = sites[row.domain] = sites[row.domain] || { domain: row.domain, split: row.split, docType: row.docType, scores: [], fabrications: [], incomplete: [], criticAgreement: [], lessonsHashes: new Set() };
    site.scores.push(row.juryScore);
    site.fabrications.push(row.fabrications);
    const applicable = SECTIONS.filter(s => row.sectionScores[s] !== null);
    const partial = applicable.filter(s => row.sectionScores[s] !== null && row.sectionScores[s] < 1 && row.sectionScores[s] >= 0.6).length;
    site.incomplete.push(applicable.length ? partial / applicable.length : 0);
    if (typeof row.criticAgreement === 'number') site.criticAgreement.push(row.criticAgreement);
  }
  for (const artifact of artifacts) {
    const site = sites[artifact.domain];
    if (site && artifact.analyzer && artifact.analyzer.lessonsHash) site.lessonsHashes.add(artifact.analyzer.lessonsHash);
  }
  for (const site of Object.values(sites)) {
    site.score = mean(site.scores);
    site.fabricationRate = mean(site.fabrications);
    site.incompleteRate = mean(site.incomplete);
    site.critic = mean(site.criticAgreement);
    site.lessonsHashes = [...site.lessonsHashes];
  }
  return { summary, sites };
}

function pairedDeltas(control, treatment, metric) {
  const deltas = [];
  for (const domain of Object.keys(treatment.sites)) {
    const t = treatment.sites[domain];
    const c = control.sites[domain];
    if (!c || typeof t[metric] !== 'number' || typeof c[metric] !== 'number') continue;
    deltas.push({ domain, split: t.split, docType: t.docType, control: c[metric], treatment: t[metric], delta: t[metric] - c[metric] });
  }
  return deltas;
}

function splitStats(deltas, split, resamples, seed) {
  const values = deltas.filter(d => split === 'all' || d.split === split).map(d => d.delta);
  const interval = bootstrapMeanInterval(values, resamples, seed);
  return { n: values.length, mean: mean(values), lower: interval.lower, upper: interval.upper, improved: values.filter(v => v > 0).length, worsened: values.filter(v => v < 0).length };
}

function prove({ controlArtifacts, treatmentArtifacts, juror = 'anthropic', minGain = DEFAULT_MIN_GAIN, maxHoldoutLoss = DEFAULT_MAX_HOLDOUT_LOSS, resamples = DEFAULT_RESAMPLES, meta = {} }) {
  const control = perSite(controlArtifacts, juror);
  const treatment = perSite(treatmentArtifacts, juror);
  const metrics = {};
  for (const [metric, higherIsBetter] of [['score', true], ['fabricationRate', false], ['incompleteRate', false], ['critic', true]]) {
    const deltas = pairedDeltas(control, treatment, metric);
    metrics[metric] = {
      higherIsBetter,
      all: splitStats(deltas, 'all', resamples, 1),
      work: splitStats(deltas, 'work', resamples, 2),
      holdout: splitStats(deltas, 'holdout', resamples, 3),
      sites: deltas.sort((a, b) => a.domain.localeCompare(b.domain))
    };
  }
  const score = metrics.score;
  const reasons = [];
  if (score.work.n < 5) reasons.push(`only ${score.work.n} paired work site(s); need at least 5`);
  if (score.work.lower === null || score.work.lower <= 0) reasons.push(`work-split gain is inside the noise (mean ${num(score.work.mean)}, 95% interval ${num(score.work.lower)} to ${num(score.work.upper)})`);
  if (score.work.mean !== null && score.work.mean < minGain) reasons.push(`work-split mean gain ${num(score.work.mean)} is below the ${minGain}-point floor`);
  if (score.holdout.n >= 3 && score.holdout.lower !== null && score.holdout.lower < -maxHoldoutLoss) reasons.push(`holdout may have regressed (95% interval ${num(score.holdout.lower)} to ${num(score.holdout.upper)})`);
  if (score.holdout.n >= 3 && score.holdout.mean !== null && score.holdout.mean < 0 && score.holdout.upper !== null && score.holdout.upper < 0) reasons.push(`holdout mean fell by ${num(-score.holdout.mean)} with the interval below zero`);
  const treatmentHashes = new Set(Object.values(treatment.sites).flatMap(s => s.lessonsHashes));
  const controlHashes = new Set(Object.values(control.sites).flatMap(s => s.lessonsHashes));
  if (treatmentHashes.size !== 1) reasons.push(`treatment ran under ${treatmentHashes.size} lesson sets; a proof needs exactly one`);
  const proven = reasons.length === 0;
  return {
    v: 1,
    provenAt: new Date().toISOString(),
    controlRunId: meta.controlRunId || null,
    runId: meta.runId || null,
    juror,
    thresholds: { minGain, maxHoldoutLoss, resamples },
    lessonsHash: treatmentHashes.size === 1 ? [...treatmentHashes][0] : null,
    controlLessonsHashes: [...controlHashes],
    samples: { control: control.summary.graded, treatment: treatment.summary.graded },
    cost: { control: control.summary.cost.total, treatment: treatment.summary.cost.total },
    metrics,
    proven,
    reasons,
    summary: proven
      ? `Proven: jury score +${num(score.work.mean)} on ${score.work.n} work sites (95% ${num(score.work.lower)} to ${num(score.work.upper)}), holdout ${score.holdout.n ? `${signed(score.holdout.mean)} on ${score.holdout.n}` : 'not graded'}.`
      : `Not proven: ${reasons.join('; ')}.`
  };
}

function num(v, digits = 1) {
  return v === null || v === undefined ? 'n/a' : Number(v).toFixed(digits);
}

function signed(v, digits = 1) {
  if (v === null || v === undefined) return 'n/a';
  return `${v >= 0 ? '+' : ''}${Number(v).toFixed(digits)}`;
}

function pct(v) {
  return v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(0)}%`;
}

function renderProof(proof) {
  const lines = [];
  lines.push(`# Proof — ${proof.runId || 'treatment'} against ${proof.controlRunId || 'control'}`);
  lines.push('');
  lines.push(proof.summary);
  lines.push('');
  lines.push(`Lesson set ${proof.lessonsHash ? proof.lessonsHash.slice(0, 12) : 'mixed or none'} against control set(s) ${proof.controlLessonsHashes.length ? proof.controlLessonsHashes.map(h => h.slice(0, 12)).join(', ') : 'none recorded'}. Juror ${proof.juror}. ${proof.samples.treatment} treatment verdicts, ${proof.samples.control} control verdicts; treatment cost $${num(proof.cost.treatment, 2)}.`);
  lines.push(`Rule: proven when the paired work-split jury gain is at least ${proof.thresholds.minGain} points with a 95% bootstrap interval above zero, and the holdout interval does not fall below -${proof.thresholds.maxHoldoutLoss}.`);
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
      const fmt = metric === 'score' ? (v) => num(v) : metric === 'fabricationRate' ? (v) => num(v, 2) : pct;
      const better = m.higherIsBetter ? s.improved : s.worsened;
      const worse = m.higherIsBetter ? s.worsened : s.improved;
      lines.push(`| ${metric} | ${split} | ${s.n} | ${fmt(c)} | ${fmt(t)} | ${metric === 'score' ? signed(s.mean) : metric === 'fabricationRate' ? signed(s.mean, 2) : signed(s.mean * 100, 0) + ' pts'} | ${metric === 'score' ? `${num(s.lower)} to ${num(s.upper)}` : metric === 'fabricationRate' ? `${num(s.lower, 2)} to ${num(s.upper, 2)}` : `${num(s.lower * 100, 0)} to ${num(s.upper * 100, 0)} pts`} | ${better} / ${worse} |`);
    }
  }
  lines.push('');
  lines.push('## Sites (jury score)');
  lines.push('');
  lines.push('| site | split | type | control | treatment | delta |');
  lines.push('|---|---|---|---|---|---|');
  for (const d of [...proof.metrics.score.sites].sort((a, b) => a.delta - b.delta)) lines.push(`| ${d.domain} | ${d.split} | ${d.docType} | ${num(d.control)} | ${num(d.treatment)} | ${signed(d.delta)} |`);
  if (proof.reasons.length) {
    lines.push('');
    lines.push('## Why not proven');
    lines.push('');
    for (const r of proof.reasons) lines.push(`- ${r}`);
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = { DEFAULT_MIN_GAIN, DEFAULT_MAX_HOLDOUT_LOSS, DEFAULT_RESAMPLES, mean, mulberry32, bootstrapMeanInterval, perSite, pairedDeltas, prove, renderProof, num, signed, pct };
