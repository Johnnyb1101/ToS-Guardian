'use strict';

const { estimateCost } = require('./batch-lib');

const SECTIONS = Object.freeze(['dataCollection', 'dataSelling', 'optOutRights', 'howToOptOut', 'autoRenewal', 'dataDeletion']);
const ACCURACY_POINTS = Object.freeze({ correct: 1, minor: 0.5, major: 0, fabricated: 0 });
const COMPLETENESS_POINTS = Object.freeze({ complete: 1, partial: 0.5, missing: 0 });
const RISK_LEVELS = Object.freeze(['Low', 'Moderate', 'High']);
const NOT_APPLICABLE = 'not-applicable';
const FABRICATION_PENALTY = 10;
const ACCURACY_WEIGHT = 0.6;

function parseJuryJson(text) {
  if (typeof text !== 'string') return null;
  let candidate = text.trim();
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidate = fence[1].trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  const body = candidate.slice(start, end + 1);
  // models routinely drop one closing brace at the end; repair rather than discard
  for (let missing = 0; missing <= 3; missing++) {
    try {
      return JSON.parse(body + '}'.repeat(missing));
    } catch (e) {
      if (missing === 3) return null;
    }
  }
  return null;
}

function normalizeLabel(value) {
  const label = String(value || '').trim().toLowerCase();
  if (label === 'n/a' || label === 'na' || label === 'not applicable' || label === 'not_applicable') return NOT_APPLICABLE;
  return label;
}

function normalizeRisk(value) {
  const label = String(value || '').trim().toLowerCase();
  const match = RISK_LEVELS.find(level => level.toLowerCase() === label);
  return match || (label ? 'missing' : 'missing');
}

function normalizeVerdict(parsed) {
  const errors = [];
  const out = { valid: false, errors, sections: {}, bottomLine: { fair: null, notes: '' }, riskLevel: { summary: 'missing', jury: 'missing', notes: '' }, fabrications: [], omissions: [] };
  if (!parsed || typeof parsed !== 'object') {
    errors.push('verdict is not an object');
    return out;
  }
  const sections = parsed.sections && typeof parsed.sections === 'object' ? parsed.sections : {};
  // a missing brace after the last section nests the trailing fields inside sections
  for (const key of ['bottomLine', 'riskLevel', 'fabrications', 'omissions']) {
    if (parsed[key] === undefined && sections[key] !== undefined) parsed[key] = sections[key];
  }
  for (const name of SECTIONS) {
    const section = sections[name] && typeof sections[name] === 'object' ? sections[name] : {};
    const accuracy = normalizeLabel(section.accuracy);
    const completeness = normalizeLabel(section.completeness);
    if (!(accuracy in ACCURACY_POINTS) && accuracy !== NOT_APPLICABLE) errors.push(`${name}.accuracy "${accuracy}" is not a verdict`);
    if (!(completeness in COMPLETENESS_POINTS) && completeness !== NOT_APPLICABLE) errors.push(`${name}.completeness "${completeness}" is not a verdict`);
    out.sections[name] = { accuracy, completeness, notes: typeof section.notes === 'string' ? section.notes.slice(0, 500) : '' };
  }
  if (parsed.bottomLine && typeof parsed.bottomLine === 'object') {
    out.bottomLine.fair = typeof parsed.bottomLine.fair === 'boolean' ? parsed.bottomLine.fair : null;
    out.bottomLine.notes = typeof parsed.bottomLine.notes === 'string' ? parsed.bottomLine.notes.slice(0, 500) : '';
  }
  if (parsed.riskLevel && typeof parsed.riskLevel === 'object') {
    out.riskLevel.summary = normalizeRisk(parsed.riskLevel.summary);
    out.riskLevel.jury = normalizeRisk(parsed.riskLevel.jury);
    out.riskLevel.notes = typeof parsed.riskLevel.notes === 'string' ? parsed.riskLevel.notes.slice(0, 500) : '';
  }
  if (out.riskLevel.jury === 'missing') errors.push('riskLevel.jury is missing');
  const stringList = (value) => Array.isArray(value) ? value.filter(v => typeof v === 'string').map(v => v.slice(0, 300)).slice(0, 20) : [];
  out.fabrications = stringList(parsed.fabrications);
  out.omissions = stringList(parsed.omissions);
  out.valid = errors.length === 0;
  return out;
}

function scoreVerdict(verdict) {
  const sectionScores = {};
  let sum = 0;
  let applicable = 0;
  let accuracySum = 0;
  let completenessSum = 0;
  for (const name of SECTIONS) {
    const section = verdict.sections[name];
    if (!section || section.accuracy === NOT_APPLICABLE || section.completeness === NOT_APPLICABLE ||
        !(section.accuracy in ACCURACY_POINTS) || !(section.completeness in COMPLETENESS_POINTS)) {
      sectionScores[name] = null;
      continue;
    }
    const accuracy = ACCURACY_POINTS[section.accuracy];
    const completeness = COMPLETENESS_POINTS[section.completeness];
    const score = ACCURACY_WEIGHT * accuracy + (1 - ACCURACY_WEIGHT) * completeness;
    sectionScores[name] = score;
    sum += score;
    accuracySum += accuracy;
    completenessSum += completeness;
    applicable++;
  }
  const fabrications = verdict.fabrications.length;
  if (applicable === 0) return { score: null, applicable, sectionScores, fabrications, accuracyMean: null, completenessMean: null };
  const base = Math.round((sum / applicable) * 100);
  return {
    score: Math.max(0, base - FABRICATION_PENALTY * fabrications),
    applicable,
    sectionScores,
    fabrications,
    accuracyMean: accuracySum / applicable,
    completenessMean: completenessSum / applicable
  };
}

function riskFromSummary(summary) {
  if (typeof summary !== 'string') return 'missing';
  const match = summary.match(/RISK LEVEL[^A-Za-z]*(Low|Moderate|High)\b/i);
  return match ? normalizeRisk(match[1]) : 'missing';
}

function riskDistance(a, b) {
  const ia = RISK_LEVELS.indexOf(a);
  const ib = RISK_LEVELS.indexOf(b);
  if (ia === -1 || ib === -1) return null;
  return Math.abs(ia - ib);
}

function criticAcceptable(label) {
  return label === 'grounded' || label === 'skipped';
}

function juryAcceptable(section) {
  return section.accuracy === 'correct' || section.accuracy === 'minor' || section.accuracy === NOT_APPLICABLE;
}

function criticAgreement(critic, verdict) {
  const perSection = {};
  let compared = 0;
  let agreed = 0;
  for (const name of SECTIONS) {
    const criticLabel = critic && typeof critic[name] === 'string' ? critic[name] : null;
    const section = verdict && verdict.sections ? verdict.sections[name] : null;
    if (!criticLabel || !section) { perSection[name] = null; continue; }
    const agree = criticAcceptable(criticLabel) === juryAcceptable(section);
    perSection[name] = agree ? 'agree' : 'disagree';
    compared++;
    if (agree) agreed++;
  }
  return { compared, agreed, rate: compared ? agreed / compared : null, perSection };
}

function stats(values) {
  const nums = values.filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return { n: 0, mean: null, median: null, min: null, max: null };
  const mean = nums.reduce((s, v) => s + v, 0) / nums.length;
  const median = nums.length % 2 ? nums[(nums.length - 1) / 2] : (nums[nums.length / 2 - 1] + nums[nums.length / 2]) / 2;
  return { n: nums.length, mean, median, min: nums[0], max: nums[nums.length - 1] };
}

function groupBy(items, keyFn) {
  const groups = {};
  for (const item of items) {
    const key = keyFn(item);
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return groups;
}

function juryResult(artifact, juror) {
  const stored = artifact && artifact.jury && artifact.jury[juror] ? artifact.jury[juror] : null;
  if (!stored || typeof stored.raw !== 'string') return stored;
  const parsed = parseJuryJson(stored.raw);
  const verdict = normalizeVerdict(parsed);
  return {
    ...stored,
    error: stored.error && !/no JSON/.test(stored.error) ? stored.error : (parsed ? undefined : 'jury returned no JSON'),
    verdict,
    score: verdict.valid ? scoreVerdict(verdict) : null
  };
}

function summarizeRun(artifacts, options = {}) {
  const juror = options.juror || 'anthropic';
  const rows = [];
  const problems = [];
  for (const artifact of artifacts) {
    const jury = juryResult(artifact, juror);
    const analyzerOk = artifact.analyzer && artifact.analyzer.status === 'ok' && typeof artifact.summary === 'string';
    if (!analyzerOk) {
      problems.push({ domain: artifact.domain, sample: artifact.sample, problem: `analyzer ${artifact.analyzer ? artifact.analyzer.status : 'missing'}${artifact.error ? `: ${artifact.error}` : ''}` });
      continue;
    }
    if (!jury) { problems.push({ domain: artifact.domain, sample: artifact.sample, problem: 'not graded' }); continue; }
    if (jury.error || !jury.verdict || !jury.verdict.valid) {
      problems.push({ domain: artifact.domain, sample: artifact.sample, problem: jury.error || `jury verdict invalid: ${(jury.verdict && jury.verdict.errors || []).join('; ')}` });
      continue;
    }
    const scored = jury.score || scoreVerdict(jury.verdict);
    const agreement = criticAgreement(artifact.critic && !artifact.critic.failed ? artifact.critic : null, jury.verdict);
    const displayedRisk = artifact.verdict && artifact.verdict.risk ? artifact.verdict.risk : 'missing';
    rows.push({
      domain: artifact.domain,
      sample: artifact.sample,
      split: artifact.split,
      docType: artifact.docType,
      label: artifact.verdict ? artifact.verdict.label : null,
      evaluatorScore: artifact.verdict && typeof artifact.verdict.score === 'number' ? artifact.verdict.score : null,
      juryScore: scored.score,
      applicable: scored.applicable,
      sectionScores: scored.sectionScores,
      fabrications: jury.verdict.fabrications.length,
      omissions: jury.verdict.omissions.length,
      bottomLineFair: jury.verdict.bottomLine.fair,
      riskDisplayed: displayedRisk,
      riskStated: riskFromSummary(artifact.summary),
      riskJury: jury.verdict.riskLevel.jury,
      riskDistance: riskDistance(displayedRisk, jury.verdict.riskLevel.jury),
      criticAgreement: agreement,
      criticFailed: !!(artifact.critic && artifact.critic.failed) || !artifact.critic,
      sections: jury.verdict.sections,
      replayCost: typeof artifact.cost === 'number' ? artifact.cost : 0,
      juryUsageRecord: jury.usageRecord || null,
      analyzerModel: artifact.analyzer.model,
      juryModel: jury.model || ''
    });
  }

  const sectionStats = {};
  for (const name of SECTIONS) {
    const accuracy = {};
    const completeness = {};
    let applicable = 0;
    let errors = 0;
    let incomplete = 0;
    for (const row of rows) {
      const section = row.sections[name];
      accuracy[section.accuracy] = (accuracy[section.accuracy] || 0) + 1;
      completeness[section.completeness] = (completeness[section.completeness] || 0) + 1;
      if (section.accuracy === NOT_APPLICABLE || section.completeness === NOT_APPLICABLE) continue;
      applicable++;
      if (section.accuracy === 'major' || section.accuracy === 'fabricated') errors++;
      if (section.completeness === 'partial' || section.completeness === 'missing') incomplete++;
    }
    sectionStats[name] = { accuracy, completeness, applicable, errorRate: applicable ? errors / applicable : null, incompleteRate: applicable ? incomplete / applicable : null };
  }

  const agreementPerSection = {};
  for (const name of SECTIONS) {
    let compared = 0;
    let agreed = 0;
    for (const row of rows) {
      const value = row.criticAgreement.perSection[name];
      if (!value) continue;
      compared++;
      if (value === 'agree') agreed++;
    }
    agreementPerSection[name] = { compared, agreed, rate: compared ? agreed / compared : null };
  }
  const agreementCompared = rows.reduce((n, r) => n + r.criticAgreement.compared, 0);
  const agreementAgreed = rows.reduce((n, r) => n + r.criticAgreement.agreed, 0);

  const risk = { exact: 0, adjacent: 0, far: 0, missing: 0, statedExact: 0, statedCompared: 0 };
  for (const row of rows) {
    if (row.riskDistance === null) risk.missing++;
    else if (row.riskDistance === 0) risk.exact++;
    else if (row.riskDistance === 1) risk.adjacent++;
    else risk.far++;
    const statedDistance = riskDistance(row.riskStated, row.riskJury);
    if (statedDistance !== null) { risk.statedCompared++; if (statedDistance === 0) risk.statedExact++; }
  }

  const byDomain = groupBy(rows, r => r.domain);
  const spreads = Object.values(byDomain).filter(list => list.length > 1).map(list => {
    const scores = list.map(r => r.juryScore).filter(v => typeof v === 'number');
    return scores.length > 1 ? Math.max(...scores) - Math.min(...scores) : null;
  }).filter(v => v !== null);

  const juryCost = estimateCost(artifacts.map(a => juryResult(a, juror)).filter(j => j && j.usageRecord).map(j => j.usageRecord));
  const replayCost = rows.reduce((n, r) => n + r.replayCost, 0) + artifacts.filter(a => !rows.some(r => r.domain === a.domain && r.sample === a.sample)).reduce((n, a) => n + (typeof a.cost === 'number' ? a.cost : 0), 0);

  const fabricationRows = rows.filter(r => r.fabrications > 0).sort((a, b) => b.fabrications - a.fabrications);
  const bottomLineKnown = rows.filter(r => typeof r.bottomLineFair === 'boolean');

  return {
    juror,
    graded: rows.length,
    artifacts: artifacts.length,
    problems,
    overall: stats(rows.map(r => r.juryScore)),
    bySplit: Object.fromEntries(Object.entries(groupBy(rows, r => r.split)).map(([k, list]) => [k, stats(list.map(r => r.juryScore))])),
    byType: Object.fromEntries(Object.entries(groupBy(rows, r => r.docType)).map(([k, list]) => [k, stats(list.map(r => r.juryScore))])),
    byLabel: Object.fromEntries(Object.entries(groupBy(rows, r => r.label || 'none')).map(([k, list]) => [k, stats(list.map(r => r.juryScore))])),
    sections: sectionStats,
    criticAgreement: { compared: agreementCompared, agreed: agreementAgreed, rate: agreementCompared ? agreementAgreed / agreementCompared : null, perSection: agreementPerSection, criticFailed: rows.filter(r => r.criticFailed).length },
    risk,
    bottomLine: { compared: bottomLineKnown.length, fair: bottomLineKnown.filter(r => r.bottomLineFair).length },
    fabrications: { total: rows.reduce((n, r) => n + r.fabrications, 0), sites: fabricationRows.length, top: fabricationRows.slice(0, 5).map(r => ({ domain: r.domain, sample: r.sample, count: r.fabrications })) },
    omissions: { total: rows.reduce((n, r) => n + r.omissions, 0), sites: rows.filter(r => r.omissions > 0).length },
    samples: { perDomain: Object.values(byDomain).length ? rows.length / Object.values(byDomain).length : 0, spread: stats(spreads) },
    cost: { replay: replayCost, jury: juryCost.cost, juryUnpriced: juryCost.unpriced, total: replayCost + juryCost.cost },
    models: { analyzer: [...new Set(rows.map(r => r.analyzerModel).filter(Boolean))], jury: [...new Set(rows.map(r => r.juryModel).filter(Boolean))] },
    rows: rows.map(r => ({
      domain: r.domain, sample: r.sample, split: r.split, docType: r.docType, label: r.label, evaluatorScore: r.evaluatorScore,
      juryScore: r.juryScore, fabrications: r.fabrications, omissions: r.omissions, bottomLineFair: r.bottomLineFair,
      riskDisplayed: r.riskDisplayed, riskJury: r.riskJury, criticAgreement: r.criticAgreement.rate, criticFailed: r.criticFailed,
      sectionScores: r.sectionScores, replayCost: r.replayCost
    }))
  };
}

function pct(value, digits = 0) {
  return value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(digits)}%`;
}

function num(value, digits = 1) {
  return value === null || value === undefined ? 'n/a' : Number(value).toFixed(digits);
}

function money(value) {
  return `$${Number(value || 0).toFixed(4)}`;
}

function statsLine(s) {
  if (!s || s.n === 0) return 'no graded sites';
  return `n ${s.n}, mean ${num(s.mean)}, median ${num(s.median)}, min ${num(s.min, 0)}, max ${num(s.max, 0)}`;
}

function renderReport(summary, meta = {}) {
  const lines = [];
  lines.push(`# Jury baseline — ${meta.runId || 'run'}`);
  lines.push('');
  lines.push(`Juror: ${summary.juror} (${summary.models.jury.join(', ') || 'no model recorded'}). Analyzer: ${summary.models.analyzer.join(', ') || 'none'}.`);
  if (meta.proxy) lines.push(`Proxy: ${meta.proxy}. Replayed: ${meta.startedAt || 'unknown'}.`);
  lines.push(`Graded ${summary.graded} of ${summary.artifacts} replay artifact(s); ${summary.problems.length} not graded.`);
  lines.push(`Cost: replay ${money(summary.cost.replay)}, jury ${money(summary.cost.jury)}${summary.cost.juryUnpriced ? ` (+${summary.cost.juryUnpriced} unpriced)` : ''}, total ${money(summary.cost.total)}.`);
  lines.push('');
  lines.push('## Scores');
  lines.push('');
  lines.push(`Overall: ${statsLine(summary.overall)}.`);
  lines.push('');
  lines.push('| split | sites | mean | median | min | max |');
  lines.push('|---|---|---|---|---|---|');
  for (const [split, s] of Object.entries(summary.bySplit).sort()) lines.push(`| ${split} | ${s.n} | ${num(s.mean)} | ${num(s.median)} | ${num(s.min, 0)} | ${num(s.max, 0)} |`);
  lines.push('');
  lines.push('| type | sites | mean | median | min | max |');
  lines.push('|---|---|---|---|---|---|');
  for (const [type, s] of Object.entries(summary.byType).sort((a, b) => b[1].n - a[1].n)) lines.push(`| ${type} | ${s.n} | ${num(s.mean)} | ${num(s.median)} | ${num(s.min, 0)} | ${num(s.max, 0)} |`);
  lines.push('');
  lines.push('| evaluator label | sites | jury mean |');
  lines.push('|---|---|---|');
  for (const [label, s] of Object.entries(summary.byLabel).sort((a, b) => b[1].n - a[1].n)) lines.push(`| ${label} | ${s.n} | ${num(s.mean)} |`);
  if (summary.samples.spread.n > 0) {
    lines.push('');
    lines.push(`Samples per site: ${num(summary.samples.perDomain)}; score spread across samples of the same site: mean ${num(summary.samples.spread.mean)}, max ${num(summary.samples.spread.max, 0)}.`);
  }
  lines.push('');
  lines.push('## Sections');
  lines.push('');
  lines.push('Error rate counts major and fabricated accuracy verdicts; incomplete counts partial and missing completeness verdicts. Both are over applicable sections.');
  lines.push('');
  lines.push('| section | applicable | error rate | incomplete | correct | minor | major | fabricated | complete | partial | missing |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const name of SECTIONS) {
    const s = summary.sections[name];
    const a = s.accuracy;
    const c = s.completeness;
    lines.push(`| ${name} | ${s.applicable} | ${pct(s.errorRate)} | ${pct(s.incompleteRate)} | ${a.correct || 0} | ${a.minor || 0} | ${a.major || 0} | ${a.fabricated || 0} | ${c.complete || 0} | ${c.partial || 0} | ${c.missing || 0} |`);
  }
  lines.push('');
  lines.push('## Critic against the jury');
  lines.push('');
  lines.push(`Agreement on whether a section is acceptable: ${pct(summary.criticAgreement.rate)} of ${summary.criticAgreement.compared} section verdicts. Critic failed or absent on ${summary.criticAgreement.criticFailed} site(s).`);
  lines.push('');
  lines.push('| section | compared | agreement |');
  lines.push('|---|---|---|');
  for (const name of SECTIONS) {
    const s = summary.criticAgreement.perSection[name];
    lines.push(`| ${name} | ${s.compared} | ${pct(s.rate)} |`);
  }
  lines.push('');
  lines.push('## Risk and bottom line');
  lines.push('');
  const r = summary.risk;
  lines.push(`Displayed risk against the jury's: exact ${r.exact}, one step off ${r.adjacent}, two steps off ${r.far}, not comparable ${r.missing}. The summary's own stated risk matched the jury on ${r.statedExact} of ${r.statedCompared}.`);
  lines.push(`Bottom line judged fair on ${summary.bottomLine.fair} of ${summary.bottomLine.compared}.`);
  lines.push(`Fabrications: ${summary.fabrications.total} across ${summary.fabrications.sites} site(s)${summary.fabrications.top.length ? `; most: ${summary.fabrications.top.map(t => `${t.domain} (${t.count})`).join(', ')}` : ''}. Omissions: ${summary.omissions.total} across ${summary.omissions.sites} site(s).`);
  lines.push('');
  lines.push('## Sites');
  lines.push('');
  lines.push('| domain | sample | split | type | evaluator | jury | fabrications | omissions | risk shown/jury | critic agreement |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const row of [...summary.rows].sort((a, b) => (a.juryScore ?? -1) - (b.juryScore ?? -1) || a.domain.localeCompare(b.domain))) {
    lines.push(`| ${row.domain} | ${row.sample} | ${row.split} | ${row.docType} | ${row.label || 'none'}${typeof row.evaluatorScore === 'number' ? ` ${row.evaluatorScore}` : ''} | ${row.juryScore === null ? 'n/a' : row.juryScore} | ${row.fabrications} | ${row.omissions} | ${row.riskDisplayed}/${row.riskJury} | ${row.criticFailed ? 'critic failed' : pct(row.criticAgreement)} |`);
  }
  if (summary.problems.length) {
    lines.push('');
    lines.push('## Not graded');
    lines.push('');
    for (const p of summary.problems) lines.push(`- ${p.domain} sample ${p.sample}: ${p.problem}`);
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  SECTIONS,
  ACCURACY_POINTS,
  COMPLETENESS_POINTS,
  RISK_LEVELS,
  NOT_APPLICABLE,
  FABRICATION_PENALTY,
  parseJuryJson,
  normalizeVerdict,
  scoreVerdict,
  riskFromSummary,
  riskDistance,
  criticAgreement,
  summarizeRun,
  renderReport
};
