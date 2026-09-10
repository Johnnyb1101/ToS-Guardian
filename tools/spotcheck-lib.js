'use strict';

const { SECTIONS, normalizeVerdict, parseJuryJson, scoreVerdict, riskFromSummary, RISK_LEVELS } = require('./jury-lib');

const HEADERS = Object.freeze([
  { key: 'bottomLine', title: 'Bottom line', pattern: /^bottom line$/i },
  { key: 'riskLevel', title: 'Risk level', pattern: /^risk level$/i },
  { key: 'dataCollection', title: 'What they collect', pattern: /^what (?:data )?(?:they|we) collect$/i },
  { key: 'dataSelling', title: 'Data selling & sharing', pattern: /^data (?:selling|sharing)\s*(?:&|and)\s*(?:sharing|selling)$/i },
  { key: 'optOutRights', title: 'Opt-out rights', pattern: /^opt[- ]?out rights$/i },
  { key: 'howToOptOut', title: 'How to opt out right now', pattern: /^how to opt out(?: right now)?$/i },
  { key: 'autoRenewal', title: 'Auto-renewal & billing', pattern: /^auto[- ]?renewal\s*(?:&|and)\s*billing$/i },
  { key: 'dataDeletion', title: 'Data deletion rights', pattern: /^data deletion rights$/i }
]);

const MARKS = Object.freeze(['supported', 'not-supported', 'unsure']);

function headerKey(line) {
  const bare = line.replace(/[^\p{L}\p{N}&' -]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!bare) return null;
  const match = HEADERS.find(h => h.pattern.test(bare));
  return match ? match.key : null;
}

function itemText(line) {
  return line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();
}

function parseSummary(text) {
  const result = { bottomLine: '', riskLevel: 'missing', sections: {}, unknown: [] };
  for (const h of HEADERS) if (h.key !== 'bottomLine' && h.key !== 'riskLevel') result.sections[h.key] = { title: h.title, items: [] };
  if (typeof text !== 'string') return result;
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const key = headerKey(line);
    if (key) { current = key; continue; }
    if (!current) { result.unknown.push(line); continue; }
    if (current === 'bottomLine') { result.bottomLine = result.bottomLine ? `${result.bottomLine} ${line}` : line; continue; }
    if (current === 'riskLevel') {
      const word = line.replace(/[^A-Za-z]/g, '');
      const level = RISK_LEVELS.find(l => l.toLowerCase() === word.toLowerCase());
      if (level && result.riskLevel === 'missing') result.riskLevel = level;
      continue;
    }
    result.sections[current].items.push(itemText(line));
  }
  if (result.riskLevel === 'missing') result.riskLevel = riskFromSummary(text);
  return result;
}

function emptyMarks(runId) {
  return { v: 1, runId, updatedAt: null, sites: {} };
}

function validateMarks(marks) {
  if (!marks || typeof marks !== 'object' || Array.isArray(marks)) return 'marks must be an object';
  if (marks.v !== 1) return 'marks.v must be 1';
  if (!marks.sites || typeof marks.sites !== 'object' || Array.isArray(marks.sites)) return 'marks.sites must be an object';
  for (const [id, site] of Object.entries(marks.sites)) {
    if (!/^[a-z0-9.-]+\.\d+$/.test(id)) return `bad site id ${id}`;
    if (!site || typeof site !== 'object') return `site ${id} must be an object`;
    const sections = site.sections && typeof site.sections === 'object' ? site.sections : {};
    for (const [key, section] of Object.entries(sections)) {
      if (!SECTIONS.includes(key)) return `unknown section ${key}`;
      if (section.items && (typeof section.items !== 'object' || Array.isArray(section.items))) return `${id}.${key}.items must be an object`;
      for (const mark of Object.values(section.items || {})) if (!MARKS.includes(mark)) return `${id}.${key} has an unknown mark`;
      if (section.completeness !== undefined && section.completeness !== null && !['complete', 'missing'].includes(section.completeness)) return `${id}.${key}.completeness is not a mark`;
      if (section.note !== undefined && typeof section.note !== 'string') return `${id}.${key}.note must be a string`;
    }
    if (site.risk !== undefined && site.risk !== null && !RISK_LEVELS.includes(site.risk)) return `${id}.risk is not a level`;
    if (site.bottomLineFair !== undefined && site.bottomLineFair !== null && typeof site.bottomLineFair !== 'boolean') return `${id}.bottomLineFair must be a boolean`;
  }
  return null;
}

function juryFor(artifact, juror) {
  const stored = artifact.jury && artifact.jury[juror];
  if (!stored) return null;
  const verdict = typeof stored.raw === 'string' ? normalizeVerdict(parseJuryJson(stored.raw)) : (stored.verdict || null);
  if (!verdict || !verdict.valid) return null;
  return { verdict, score: scoreVerdict(verdict).score };
}

function siteId(artifact) {
  return `${artifact.domain}.${artifact.sample}`;
}

function buildPageModel(artifacts, options = {}) {
  const juror = options.juror || 'anthropic';
  return artifacts
    .filter(a => a.analyzer && a.analyzer.status === 'ok' && typeof a.summary === 'string')
    .sort((a, b) => a.domain.localeCompare(b.domain) || a.sample - b.sample)
    .map(a => {
      const jury = juryFor(a, juror);
      return {
        id: siteId(a),
        domain: a.domain,
        sample: a.sample,
        split: a.split,
        docType: a.docType,
        evaluator: a.verdict ? { label: a.verdict.label, score: a.verdict.score, risk: a.verdict.risk, issues: a.verdict.issues || [] } : null,
        critic: a.critic && !a.critic.failed ? Object.fromEntries(SECTIONS.map(s => [s, a.critic[s] || null])) : null,
        summary: parseSummary(a.summary),
        source: a.analysisSource || '',
        jury: jury ? { score: jury.score, sections: jury.verdict.sections, bottomLine: jury.verdict.bottomLine, riskLevel: jury.verdict.riskLevel, fabrications: jury.verdict.fabrications, omissions: jury.verdict.omissions } : null
      };
    });
}

function humanSectionAcceptable(section) {
  const marks = Object.values((section && section.items) || {});
  if (marks.length === 0) return null;
  return marks.every(m => m !== 'not-supported');
}

function rate(agreed, compared) {
  return compared ? agreed / compared : null;
}

function computeAgreement(artifacts, marks, options = {}) {
  const juror = options.juror || 'anthropic';
  const sites = marks && marks.sites ? marks.sites : {};
  const rows = [];
  const unmarked = [];
  const perSection = Object.fromEntries(SECTIONS.map(s => [s, { compared: 0, agreed: 0, completenessCompared: 0, completenessAgreed: 0, criticCompared: 0, criticAgreed: 0 }]));
  const totals = { compared: 0, agreed: 0, completenessCompared: 0, completenessAgreed: 0, riskCompared: 0, riskExact: 0, bottomCompared: 0, bottomAgreed: 0, criticCompared: 0, criticAgreed: 0, itemsMarked: 0, itemsNotSupported: 0 };
  for (const artifact of artifacts) {
    const id = siteId(artifact);
    const mark = sites[id];
    const jury = juryFor(artifact, juror);
    if (!mark || !Object.keys(mark.sections || {}).length) { unmarked.push(id); continue; }
    const row = { id, domain: artifact.domain, sample: artifact.sample, split: artifact.split, compared: 0, agreed: 0, risk: null, bottomLine: null, juryScore: jury ? jury.score : null, notSupported: 0 };
    for (const key of SECTIONS) {
      const section = mark.sections[key];
      if (!section) continue;
      const items = Object.values(section.items || {});
      totals.itemsMarked += items.length;
      const notSupported = items.filter(m => m === 'not-supported').length;
      totals.itemsNotSupported += notSupported;
      row.notSupported += notSupported;
      const human = humanSectionAcceptable(section);
      if (human !== null && jury) {
        const j = jury.verdict.sections[key];
        const juryOk = j.accuracy === 'correct' || j.accuracy === 'minor' || j.accuracy === 'not-applicable';
        perSection[key].compared++; totals.compared++; row.compared++;
        if (juryOk === human) { perSection[key].agreed++; totals.agreed++; row.agreed++; }
      }
      if (section.completeness && jury) {
        const j = jury.verdict.sections[key];
        if (j.completeness !== 'not-applicable') {
          const juryIncomplete = j.completeness === 'partial' || j.completeness === 'missing';
          perSection[key].completenessCompared++; totals.completenessCompared++;
          if (juryIncomplete === (section.completeness === 'missing')) { perSection[key].completenessAgreed++; totals.completenessAgreed++; }
        }
      }
      if (human !== null && artifact.critic && !artifact.critic.failed && typeof artifact.critic[key] === 'string') {
        const criticOk = artifact.critic[key] === 'grounded' || artifact.critic[key] === 'skipped';
        perSection[key].criticCompared++; totals.criticCompared++;
        if (criticOk === human) { perSection[key].criticAgreed++; totals.criticAgreed++; }
      }
    }
    if (mark.risk && jury && RISK_LEVELS.includes(jury.verdict.riskLevel.jury)) {
      totals.riskCompared++;
      row.risk = `${mark.risk}/${jury.verdict.riskLevel.jury}`;
      if (mark.risk === jury.verdict.riskLevel.jury) totals.riskExact++;
    }
    if (typeof mark.bottomLineFair === 'boolean' && jury && typeof jury.verdict.bottomLine.fair === 'boolean') {
      totals.bottomCompared++;
      row.bottomLine = `${mark.bottomLineFair ? 'fair' : 'unfair'}/${jury.verdict.bottomLine.fair ? 'fair' : 'unfair'}`;
      if (mark.bottomLineFair === jury.verdict.bottomLine.fair) totals.bottomAgreed++;
    }
    rows.push(row);
  }
  return {
    juror,
    marked: rows.length,
    unmarked,
    accuracy: { compared: totals.compared, agreed: totals.agreed, rate: rate(totals.agreed, totals.compared) },
    completeness: { compared: totals.completenessCompared, agreed: totals.completenessAgreed, rate: rate(totals.completenessAgreed, totals.completenessCompared) },
    critic: { compared: totals.criticCompared, agreed: totals.criticAgreed, rate: rate(totals.criticAgreed, totals.criticCompared) },
    risk: { compared: totals.riskCompared, exact: totals.riskExact, rate: rate(totals.riskExact, totals.riskCompared) },
    bottomLine: { compared: totals.bottomCompared, agreed: totals.bottomAgreed, rate: rate(totals.bottomAgreed, totals.bottomCompared) },
    items: { marked: totals.itemsMarked, notSupported: totals.itemsNotSupported },
    perSection: Object.fromEntries(SECTIONS.map(s => [s, { ...perSection[s], rate: rate(perSection[s].agreed, perSection[s].compared), completenessRate: rate(perSection[s].completenessAgreed, perSection[s].completenessCompared), criticRate: rate(perSection[s].criticAgreed, perSection[s].criticCompared) }])),
    rows
  };
}

function pct(value) {
  return value === null || value === undefined ? 'n/a' : `${Math.round(value * 100)}%`;
}

function renderAgreement(result, meta = {}) {
  const lines = [];
  lines.push(`# Spot-check agreement — ${meta.runId || 'run'}`);
  lines.push('');
  lines.push(`Sites marked: ${result.marked}${result.unmarked.length ? ` (not marked: ${result.unmarked.join(', ')})` : ''}. Juror: ${result.juror}.`);
  lines.push(`Items marked: ${result.items.marked}, of which ${result.items.notSupported} not supported.`);
  lines.push('');
  lines.push('Agreement is on whether a section is acceptable (no unsupported claim), on whether it is complete, on the risk level, and on the bottom line.');
  lines.push('');
  lines.push('| measure | compared | agreement |');
  lines.push('|---|---|---|');
  lines.push(`| section acceptable, you vs jury | ${result.accuracy.compared} | ${pct(result.accuracy.rate)} |`);
  lines.push(`| section complete, you vs jury | ${result.completeness.compared} | ${pct(result.completeness.rate)} |`);
  lines.push(`| section acceptable, you vs critic | ${result.critic.compared} | ${pct(result.critic.rate)} |`);
  lines.push(`| risk level, you vs jury | ${result.risk.compared} | ${pct(result.risk.rate)} |`);
  lines.push(`| bottom line fair, you vs jury | ${result.bottomLine.compared} | ${pct(result.bottomLine.rate)} |`);
  lines.push('');
  lines.push('| section | vs jury | complete vs jury | vs critic |');
  lines.push('|---|---|---|---|');
  for (const key of SECTIONS) {
    const s = result.perSection[key];
    lines.push(`| ${key} | ${pct(s.rate)} (${s.compared}) | ${pct(s.completenessRate)} (${s.completenessCompared}) | ${pct(s.criticRate)} (${s.criticCompared}) |`);
  }
  lines.push('');
  lines.push('| site | sections compared | agreed | unsupported items | risk you/jury | bottom line you/jury | jury score |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const row of result.rows) {
    lines.push(`| ${row.domain} #${row.sample} | ${row.compared} | ${row.agreed} | ${row.notSupported} | ${row.risk || 'n/a'} | ${row.bottomLine || 'n/a'} | ${row.juryScore === null ? 'n/a' : row.juryScore} |`);
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = { HEADERS, MARKS, parseSummary, emptyMarks, validateMarks, buildPageModel, computeAgreement, renderAgreement, siteId };
