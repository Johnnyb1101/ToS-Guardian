'use strict';

const { SECTIONS } = require('./jury-lib');

const SECTION_TITLES = Object.freeze({
  dataCollection: 'WHAT THEY COLLECT',
  dataSelling: 'DATA SELLING & SHARING',
  optOutRights: 'OPT-OUT RIGHTS',
  howToOptOut: 'HOW TO OPT OUT RIGHT NOW',
  autoRenewal: 'AUTO-RENEWAL & BILLING',
  dataDeletion: 'DATA DELETION RIGHTS'
});

const COMPLETENESS_LESSONS = Object.freeze({
  dataCollection: 'In WHAT THEY COLLECT, cover every category the document itself lists, including where the data comes from (partners, brokers, other users) and any sensitive category it names, before choosing which four bullets to keep.',
  dataSelling: 'In DATA SELLING & SHARING, name every recipient category the document lists and say whether the document claims it does not sell data; do not stop at the first two recipients.',
  optOutRights: 'In OPT-OUT RIGHTS, list each right the document grants, including rights limited to a state or region and browser signals such as Global Privacy Control, and say which sharing cannot be limited.',
  howToOptOut: 'In HOW TO OPT OUT RIGHT NOW, include every channel the document gives (link, setting, phone, mail, email) and any condition the document attaches, such as opt-outs stored per browser or device.',
  autoRenewal: 'In AUTO-RENEWAL & BILLING, mention any charge the document authorizes beyond a subscription, such as fees, damage claims, or price changes, when it says there is no automatic renewal.',
  dataDeletion: 'In DATA DELETION RIGHTS, state how long data is kept, which data survives a deletion request, and whether the right is limited to some residents, using only what the document says.'
});

const FABRICATION_LESSONS = Object.freeze({
  'menu-path': {
    analyzer: 'Give a settings location only in the words the document uses. If the document says "your device settings" or "account settings", say exactly that; never add a menu path such as "Settings → Privacy → Location".',
    critic: 'Treat any menu path, screen name, or button sequence that does not appear in the source as unsupported, even when the rest of the section is grounded.'
  },
  url: {
    analyzer: 'Never write a web address the document does not print. If the document names a page or program without an address, say so and do not supply one.',
    critic: 'Treat any URL or domain that does not appear verbatim in the source as unsupported.'
  },
  phone: {
    analyzer: 'Never state a phone number the document does not print.',
    critic: 'Treat any phone number that does not appear verbatim in the source as unsupported.'
  },
  email: {
    analyzer: 'Never state an email address the document does not print; if the address is redacted or absent, say the document gives no address.',
    critic: 'Treat any email address that does not appear verbatim in the source as unsupported.'
  },
  'generic-advice': {
    analyzer: 'Do not offer generic advice such as "check your account settings" or "log in and cancel" as if the document said it. When the document gives no step, say the document gives no specific steps.',
    critic: 'Treat generic advice ("check your account settings", "use the unsubscribe link") as unsupported unless the source says it.'
  },
  'data-category': {
    analyzer: 'Name a data category only when the document states it. Do not infer purchase history, precise location, or biometrics from the kind of company or from a feature it offers.',
    critic: 'Treat a data category the source does not state as unsupported, even when it is likely for that kind of company.'
  },
  recipient: {
    analyzer: 'Describe recipients exactly as the document scopes them. Do not widen "affiliates" to "all companies", "partners" to "broadly", or a single data type to "your data".',
    critic: 'Treat a recipient or sharing scope wider than the source states as unsupported.'
  },
  scope: {
    analyzer: 'Do not add or drop a jurisdiction the document attaches to a right. A California-only right stays California-only; a right for all users is not narrowed.',
    critic: 'Treat a jurisdiction added to or removed from a right as unsupported.'
  },
  'timeframe-or-amount': {
    analyzer: 'State a period, deadline, or amount only in the figure the document gives.',
    critic: 'Treat a period, deadline, or amount that differs from the source as unsupported.'
  }
});

const IMPACT = Object.freeze({ fabrication: 3, completeness: 2, critic: 2.5, evaluator: 1.5, fetcher: 2, schema: 1.5, risk: 1, prompt: 2.5, proof: 0.5 });

function candidate(fields) {
  return { status: 'candidate', ...fields };
}

function dreamLessons(findings) {
  const out = [];
  let n = 0;
  const id = () => `L${String(++n).padStart(3, '0')}`;
  const graded = findings.totals.graded || 0;

  for (const key of SECTIONS) {
    const section = findings.sections[key];
    if (!section || section.applicable < 10 || section.incompleteRate === null || section.incompleteRate < 0.6) continue;
    const themes = Object.entries(findings.omissions.byTheme)
      .filter(([theme]) => (findings.omissions.themeSections[theme] || []).includes(key))
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 3);
    out.push(candidate({
      id: id(), kind: 'lesson', target: 'analyzer', scope: 'all', section: key,
      text: COMPLETENESS_LESSONS[key],
      why: `${SECTION_TITLES[key]} was partial or missing in ${Math.round(section.incompleteRate * 100)}% of ${section.applicable} applicable verdicts${themes.length ? `; the jury's omissions on this topic cluster in ${themes.map(([t, v]) => `${t} (${v.count})`).join(', ')}` : ''}.`,
      evidence: { verdicts: section.applicable, rate: section.incompleteRate, examples: themes.flatMap(([, v]) => v.examples.slice(0, 1)).slice(0, 3) },
      priority: IMPACT.completeness * section.incompleteRate * Math.min(1, section.applicable / 50)
    }));
    for (const [type, t] of Object.entries(section.byType)) {
      if (t.n >= 6 && t.incompleteRate >= 0.75 && t.incompleteRate >= section.incompleteRate + 0.1) {
        out.push(candidate({
          id: id(), kind: 'lesson', target: 'analyzer', scope: type, section: key,
          text: COMPLETENESS_LESSONS[key],
          why: `For ${type} documents, ${SECTION_TITLES[key]} was incomplete in ${Math.round(t.incompleteRate * 100)}% of ${t.n} verdicts, against ${Math.round(section.incompleteRate * 100)}% overall.`,
          evidence: { verdicts: t.n, rate: t.incompleteRate, examples: [] },
          priority: IMPACT.completeness * t.incompleteRate * Math.min(1, t.n / 30) * 0.8
        }));
      }
    }
  }

  for (const [pattern, p] of Object.entries(findings.fabrications.byPattern).sort((a, b) => b[1].count - a[1].count)) {
    if (p.count < 5 || !FABRICATION_LESSONS[pattern]) continue;
    const share = graded ? p.count / graded : 0;
    out.push(candidate({
      id: id(), kind: 'lesson', target: 'analyzer', scope: 'all', section: null,
      text: FABRICATION_LESSONS[pattern].analyzer,
      why: `${p.count} fabricated ${pattern} claim(s) across ${p.sites} site(s), in a run of ${graded} verdicts.`,
      evidence: { count: p.count, sites: p.sites, examples: p.examples.slice(0, 3) },
      priority: IMPACT.fabrication * Math.min(1, share * 4) + Math.min(0.5, p.sites / 40)
    }));
    out.push(candidate({
      id: id(), kind: 'lesson', target: 'critic', scope: 'all', section: null,
      text: FABRICATION_LESSONS[pattern].critic,
      why: `The critic let ${pattern} fabrications through; see the blind-spot list.`,
      evidence: { count: p.count, sites: p.sites, examples: p.examples.slice(0, 2) },
      priority: IMPACT.critic * Math.min(1, share * 4) * 0.8
    }));
  }

  if ((findings.critic.blindSpots || []).length >= 3) {
    const spots = findings.critic.blindSpots;
    out.push(candidate({
      id: id(), kind: 'calibration', target: 'critic', scope: 'all', section: null,
      text: `Seed the critic calibration set with the ${spots.length} verdict(s) where the critic said grounded and the jury found a fabrication or a major error.`,
      why: `The critic agrees with the jury on acceptability ${Math.round((findings.critic.rate || 0) * 100)}% of the time, but every miss is a fabrication it passed.`,
      evidence: { count: spots.length, sites: new Set(spots.map(s => s.domain)).size, examples: spots.slice(0, 3).map(s => ({ domain: s.domain, text: `${s.section}: ${s.notes}` })) },
      priority: IMPACT.critic * Math.min(1, spots.length / 20)
    }));
  }

  if ((findings.evaluator.strongLow || []).length >= 5) {
    const low = findings.evaluator.strongLow;
    const labels = findings.evaluator.labels;
    out.push(candidate({
      id: id(), kind: 'code', target: 'evaluator', scope: 'all', section: null,
      text: 'The evaluator label is a structure and retrieval check, not an accuracy signal. Either rename it in the overlay or feed it a proven accuracy signal before calling a summary Strong.',
      why: `${low.length} verdict(s) labelled Strong scored under 60 with the jury; label means are ${Object.entries(labels).map(([l, v]) => `${l} ${Math.round(v.juryMean)}`).join(', ')}.`,
      evidence: { count: low.length, sites: new Set(low.map(l => l.domain)).size, examples: low.slice(0, 3).map(l => ({ domain: l.domain, text: `evaluator ${l.evaluator}, jury ${l.jury}` })) },
      priority: IMPACT.evaluator * Math.min(1, low.length / 20)
    }));
  }

  const generic = findings.fabrications.byPattern['generic-advice'];
  if (generic && generic.count >= 3) {
    out.push(candidate({
      id: id(), kind: 'code', target: 'analyzer-prompt', scope: 'all', section: 'howToOptOut',
      text: 'Change the analyzer prompt\'s fallback for HOW TO OPT OUT from "No specific steps provided — check your account settings" to "The document gives no specific steps", so the fallback itself is not advice the document never gave.',
      why: `${generic.count} fabrication(s) on ${generic.sites} site(s) were the prompt's own fallback phrase or its cousins.`,
      evidence: { count: generic.count, sites: generic.sites, examples: generic.examples.slice(0, 3) },
      priority: IMPACT.prompt * Math.min(1, generic.count / 10)
    }));
  }

  for (const site of findings.notApplicable || []) {
    out.push(candidate({
      id: id(), kind: 'site-fact', target: 'fetcher', scope: site.domain, section: null,
      text: `${site.domain}: the frozen source is not a legal document (the jury found no applicable section in ${site.samples} sample(s)). Point the site database at the actual document URLs and refreeze.`,
      why: 'A source with nothing to grade wastes every replay and, live, produces an honest but empty overlay.',
      evidence: { count: site.samples, sites: 1, examples: [] },
      priority: IMPACT.fetcher * 0.6
    }));
  }
  if ((findings.notApplicable || []).length) {
    out.push(candidate({
      id: id(), kind: 'code', target: 'fetcher', scope: 'all', section: null,
      text: 'Make the legal-document check distrust pages that are mostly headings, titles, and dates: an index of policies passes the current keyword test.',
      why: `${findings.notApplicable.length} site(s) froze an index page as a legal document.`,
      evidence: { count: findings.notApplicable.length, sites: findings.notApplicable.length, examples: findings.notApplicable.slice(0, 3).map(s => ({ domain: s.domain, text: 'no applicable section' })) },
      priority: IMPACT.fetcher * Math.min(1, findings.notApplicable.length / 5)
    }));
  }

  if ((findings.coverage || []).length >= 3) {
    const worst = findings.coverage.slice(0, 5);
    out.push(candidate({
      id: id(), kind: 'code', target: 'analyzer-excerpt', scope: 'all', section: null,
      text: 'Review the analysis excerpt for large documents: several sites reach the analyzer with well under 60% of their text, and the missing part is usually the terms.',
      why: `${findings.coverage.length} site(s) analysed under 60% of their frozen text; worst ${worst.map(c => `${c.domain} ${Math.round(c.ratio * 100)}%`).join(', ')}.`,
      evidence: { count: findings.coverage.length, sites: findings.coverage.length, examples: worst.slice(0, 3).map(c => ({ domain: c.domain, text: `${c.analysisChars} of ${c.textChars} characters` })) },
      priority: IMPACT.fetcher * Math.min(1, findings.coverage.length / 10)
    }));
  }

  const uncovered = Object.entries(findings.omissions.byTheme).filter(([theme]) => (findings.omissions.themeSections[theme] || []).length === 0 && theme !== 'other').filter(([, t]) => t.count >= 15);
  for (const [theme, t] of uncovered) {
    out.push(candidate({
      id: id(), kind: 'code', target: 'schema', scope: 'all', section: null,
      text: `No section of the summary covers "${theme}", yet the jury reported it missing ${t.count} time(s) on ${t.sites} site(s). Decide whether the bottom line should carry it or a section should be added.`,
      why: 'The analyzer cannot be complete on a topic the schema gives it no place for.',
      evidence: { count: t.count, sites: t.sites, examples: t.examples.slice(0, 3) },
      priority: IMPACT.schema * Math.min(1, t.count / 60)
    }));
  }

  const disagreements = findings.risk.over + findings.risk.under;
  if (disagreements >= 10) {
    const dominant = findings.risk.over >= findings.risk.under ? 'over' : 'under';
    const share = Math.max(findings.risk.over, findings.risk.under) / disagreements;
    if (share >= 0.7) {
      out.push(candidate({
        id: id(), kind: 'lesson', target: 'analyzer', scope: 'all', section: 'riskLevel',
        text: dominant === 'over'
          ? 'Reserve High for what the rule names: sale with no opt-out, sensitive data shared broadly, forced arbitration, or no deletion right. Broad collection alone is Moderate.'
          : 'Forced arbitration, sensitive data shared broadly, or no deletion right each make the risk High even when opt-outs exist elsewhere.',
        why: `Of ${disagreements} risk disagreements with the jury, the overlay was ${dominant === 'over' ? 'higher' : 'lower'} ${Math.round(share * 100)}% of the time.`,
        evidence: { count: disagreements, sites: null, examples: [] },
        priority: IMPACT.risk * share
      }));
    }
  }

  if (findings.variance.n && findings.variance.unstable.length / findings.variance.n >= 0.2) {
    out.push(candidate({
      id: id(), kind: 'note', target: 'proof-design', scope: 'all', section: null,
      text: `Prove lessons with at least three samples per arm and compare per site: ${findings.variance.unstable.length} of ${findings.variance.n} sites moved 20 or more points between identical runs.`,
      why: `Spread across samples: median ${findings.variance.median}, max ${findings.variance.max}.`,
      evidence: { count: findings.variance.unstable.length, sites: findings.variance.n, examples: findings.variance.unstable.slice(0, 3).map(u => ({ domain: u.domain, text: `scores ${u.scores.join(', ')}` })) },
      priority: IMPACT.proof
    }));
  }

  out.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  return out;
}

function renderLessons(candidates, meta = {}) {
  const lines = [];
  lines.push(`# Lesson candidates — ${meta.runId || 'run'}`);
  lines.push('');
  lines.push(`${candidates.length} candidate(s) from the reflection${meta.generatedAt ? ` of ${meta.generatedAt.slice(0, 10)}` : ''}. Every one is a proposal: nothing here is recalled into a prompt or changed in code until it is proven on the reference set and promoted by the owner.`);
  lines.push('');
  const kinds = [['lesson', 'Prompt lessons (tier 2: recalled into the analyzer or critic prompt after proof)'], ['calibration', 'Critic calibration'], ['site-fact', 'Site facts (tier 1)'], ['code', 'Code changes (tier 3: pull request)'], ['note', 'Notes for the proof design']];
  for (const [kind, title] of kinds) {
    const list = candidates.filter(c => c.kind === kind);
    if (!list.length) continue;
    lines.push(`## ${title}`);
    lines.push('');
    for (const c of list) {
      lines.push(`### ${c.id} · ${c.target}${c.scope && c.scope !== 'all' ? ` · ${c.scope}` : ''}${c.section ? ` · ${c.section}` : ''} · priority ${c.priority.toFixed(2)}`);
      lines.push('');
      lines.push(c.text);
      lines.push('');
      lines.push(`Why: ${c.why}`);
      if (c.evidence && c.evidence.examples && c.evidence.examples.length) {
        for (const e of c.evidence.examples) lines.push(`- ${e.domain}: ${String(e.text).replace(/\s+/g, ' ')}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

module.exports = { SECTION_TITLES, COMPLETENESS_LESSONS, FABRICATION_LESSONS, IMPACT, dreamLessons, renderLessons };
