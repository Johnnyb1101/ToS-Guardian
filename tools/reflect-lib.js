'use strict';

const { SECTIONS, RISK_LEVELS, normalizeVerdict, parseJuryJson, scoreVerdict, riskDistance, criticAgreement, summarizeRun } = require('./jury-lib');
const { computeAgreement } = require('./spotcheck-lib');

const FABRICATION_PATTERNS = Object.freeze([
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['url', /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|org|net|edu|io|info|gov|co)\b(?:\/[^\s"'”)]*)?/i],
  ['phone', /\b1?[-. (]*\d{3}[-. )]*\d{3}[-. ]*\d{4}\b|\b1-8\d\d-[A-Z0-9-]{4,}/i],
  ['wrong-mechanism', /(?:is|are) for (?:access|appeals?|portability|requesting|download)|that (?:tool|form|page|link) is|is a postal address|not an? (?:email|deletion)|not (?:the )?(?:deletion|opt-out) (?:tool|page|form)/i],
  ['generic-advice', /check your (?:account )?settings|log ?in and cancel|through your account settings|unsubscribe link|contact (?:customer )?support|cancel anytime|browser extension|Privacy Badger|check your sign-up/i],
  ['menu-path', /→|->|»|\bSettings\b|\bMy Account\b|\bAccount Settings\b|\bPrivacy & Safety\b|\bPrivacy Center\b|\bprivacy dashboard\b|\bNotifications\b.*\bapp\b|\btab\b|\btoggle\b|\bmenu\b/i],
  ['timeframe-or-amount', /\b\d+\s*(?:days?|months?|years?|hours?|business days)\b|\$\s?\d/i],
  ['data-category', /\bgeolocation\b|\bprecise location\b|\bbiometric|\bpurchase history\b|\btransaction (?:data|history)\b|\bSSN\b|\bSocial Security\b|\bcall recordings?\b|\bhealth\b|\bcontacts?\b|driver'?s license|government[- ]issued|Government & financial|\bID data\b/i],
  ['recipient', /\b(?:shared?|shares|sharing|selling|sold|sells?)\b[^.]*\b(?:with|to|across)\b|\baffiliates?\b|\bpartners?\b|\bthird[- ]part(?:y|ies)\b|\bbrokers?\b|\bcompanies\b|\bcredit bureaus?\b|\badvertisers\b/i],
  ['right-claim', /opt[- ]out (?:of|from|:)|\bno [a-z ]*right\b|\bright to\b|\bcan request\b|\bmay request\b|\bfull access\b/i],
  ['scope', /\bCalifornia\b|\ball users\b|\bresidents\b|\bonly\b|\bEEA\b|\bUK\b|\bEU\b|\bjurisdiction|per (?:session|browser|device)/i]
]);

const OMISSION_THEMES = Object.freeze([
  ['fetch-problem', /Processing Error|never loaded|not retrieved|could not be retrieved|page (?:was|is) not|failed to load/i],
  ['dispute', /\barbitrat|class[- ]action|jury[- ]trial|\bwaiver\b|\bvenue\b|governing law|liability (?:cap|is capped|capped)|capped at|limit(?:s|ation)? (?:of|on) liability|\bdamages\b|filed in [A-Z][a-z]+ (?:state|federal|courts)|courts under/i],
  ['tracking-signals', /do[- ]not[- ]track|\bDNT\b|global privacy control|\bGPC\b/i],
  ['ad-opt-out-links', /\bDAA\b|\bNAI\b|aboutads|networkadvertising|industry opt[- ]out|device ad settings|AdChoices|opt[- ]out (?:page|routes?|links?|tools?)\b/i],
  ['no-sale-statement', /(?:does|do|don'?t) not (?:'|")?sell|don'?t sell|never claims? to sell|not (?:'|")sell(?:'|")|no sale of|not a data broker/i],
  ['international-transfer', /transferred?(?: and stored)? internationally|international(?:ly)? transfer|cross[- ]border|outside (?:the )?(?:EEA|EU|UK|United States)|stored (?:in|outside) (?:the )?(?:US|United States|Ireland|Germany|Singapore)/i],
  ['biometrics', /\bbiometric|\bfacial\b|\bface\b|\bvoice(?:print)?\b|\bfingerprint\b/i],
  ['children', /\bchild(?:ren)?\b|\bminors?\b|\bparental\b|under (?:13|16|18)|\bcabined\b|\bteens?\b/i],
  ['ai-training', /generative AI|\bAI models?\b|machine learning|train(?:ing)? (?:AI|models?)|\bAI agents?\b/i],
  ['business-transfer', /\bmerger|\bacquisition|acquired|change of control|asset sale|sale of (?:the |its |Uber's |the company's )?business|sale, merger/i],
  ['law-enforcement', /law enforcement|\bgovernment\b|legal request|subpoena|court order|\bregulators?\b|safety and security partners|legal, safety/i],
  ['public-visibility', /public(?:ly)? (?:visible|accessible|available)|anyone with access|other users (?:can|may) see|\bindexing\b|visible to (?:other|anyone)|accessible to (?:other|anyone|everyone)|\bpublic profile\b|\bpublic\b.*\bAPI\b/i],
  ['credit-reporting', /credit report|credit reporting agenc|credit bureaus?|\bCRAs?\b|credit agencies/i],
  ['automated-decisions', /automated decision|\bprofiling\b/i],
  ['retention', /\bretain|\bretention\b|kept (?:for|until)|stored for|deleted after|inactivit|as long as/i],
  ['deletion-limits', /cannot be deleted|not (?:be )?deletable|(?:deletion|delete)[^.]*\b(?:except|limit|exempt|unless|backup|residual)|backup cop|after deletion|does not delete/i],
  ['opt-out-mechanics', /per[- ]browser|per[- ]device|every browser|must be (?:repeated|redone|renewed)|stored (?:as|in) a? ?cookie|opt-?outs? (?:is|are) (?:stored|cookie)|cookie[- ]based/i],
  ['cannot-opt-out', /cannot (?:be )?opt(?:ed)?[- ]out|can'?t opt out|cannot (?:limit|stop|be limited)|no opt[- ]out|opting out does not|does not stop|not stop you/i],
  ['opt-out-window', /\b\d+ days\b[^.]*\bnotice\b|days? after (?:the )?notice|opt[- ]out window|before sharing begins|sharing can begin/i],
  ['third-party-processors', /\bPlaid\b|\bStripe\b|\bPayPal\b(?!\.com: )|\bvendors?\b|\bprocessors?\b|Google Analytics|\bChartbeat\b|\bLiveRamp\b|\bPulsePoint\b|\bMeta\b|\bAppLovin\b|service providers? (?:such as|including|like)/i],
  ['data-sources', /data brokers?|enrichment|obtain(?:s|ed)? (?:information|data)[^.]*\bfrom\b|receive(?:s|d)? (?:information|data)[^.]*\bfrom\b|collects? (?:data|information) (?:about you )?from (?:partners|third|advertis|other|credit|public)|from third part|pull data from|linked (?:accounts|financial)/i],
  ['sensitive-data', /\brace\b|\bethnicity\b|sexual orientation|\breligion\b|\bdemographic\b|\bincome\b|\bhealth\b|\bprecise (?:geo)?location\b|\bSSN\b|Social Security|government[- ]issued|driver'?s license|\bpassport\b/i],
  ['jurisdiction', /\bCalifornia\b|\bCCPA\b|\bCPRA\b|\bEEA\b|\bGDPR\b|\bUK\b|\bEU\b|\bVirginia\b|\bColorado\b|\bConnecticut\b|\bTexas\b|\bNevada\b|\bMexic|state (?:law|privacy|rights)|residents of|Gramm-Leach|\bGLBA\b|outside the U\.?S|\bARCO\b/i],
  ['content-license', /\blicen[cs]e\b|derivative works|sublicensable|your content|user content|\bworldwide\b.*\bright/i],
  ['account-controls', /\badmin(?:istrator)?s?\b|\bemployer\b|\bcontroller\b|joint account|business customers?|domain administrator|Team account/i],
  ['account-termination', /\bterminat|\bsuspend|\bforfeit|\bdisabl(?:e|ing)\b/i],
  ['billing-terms', /non[- ]refundable|\brefund|renew(?:s|al)? at|full price|credits? expire|final and|\bfees?\b|price changes?|charge(?:s|d)? (?:your|the) (?:saved )?payment/i],
  ['terms-changes', /modify (?:the |these )?terms|change (?:the |these )?terms|update (?:the |these )?terms|without notice|effective (?:on|upon|immediately)/i],
  ['response-time', /respond(?:ing|s)? (?:to|within)|within (?:one|two|\d+) (?:months?|days?|business days)|\b45[- ]day\b|free requests?/i],
  ['contact-channels', /\bphone number\b|\bby mail\b|\bvia mail\b|\bwrite to\b|\bcall(?:ing)? (?:1-|\d)|\b1-8\d\d\b|toll[- ]free|\bemail(?:ing)? [a-z]+@|postal address|mailing address|contact (?:the |its )?privacy/i],
  ['tracking-tech', /\bcookies?\b|\bpixel|\bbeacon|local storage|\bSDKs?\b|\bfingerprinting\b|\bJavaScript\b|clear GIFs?|session (?:replay|recording)/i],
  ['monitoring-consent', /\bmonitor(?:ing|ed)?\b|\brecord(?:ing|ed)\b|consent to|express consent|screening/i],
  ['research-use', /\bresearch\b|\bexperiments?\b|\bvariations?\b|\bA\/B\b/i],
  ['marketing', /\bmarketing\b|\bpromotional\b|\bnewsletter|\bunsubscribe\b|\bpersonaliz|service(?:,|\s+and)?[^.]*(?:communications|emails|messages)|administrative (?:emails|messages)|security communications/i]
]);

const THEME_SECTIONS = Object.freeze({
  'fetch-problem': [],
  dispute: [],
  'tracking-signals': ['optOutRights'],
  'ad-opt-out-links': ['howToOptOut'],
  biometrics: ['dataCollection'],
  children: ['dataCollection'],
  'ai-training': ['dataCollection'],
  'business-transfer': ['dataSelling'],
  'law-enforcement': ['dataSelling'],
  'public-visibility': ['dataSelling'],
  'credit-reporting': ['dataCollection', 'dataSelling'],
  'automated-decisions': ['dataCollection'],
  retention: ['dataDeletion'],
  'deletion-limits': ['dataDeletion'],
  'opt-out-mechanics': ['optOutRights', 'howToOptOut'],
  'cannot-opt-out': ['optOutRights'],
  'opt-out-window': ['optOutRights'],
  'third-party-processors': ['dataSelling'],
  'international-transfer': ['dataSelling'],
  'data-sources': ['dataCollection', 'dataSelling'],
  'sensitive-data': ['dataCollection'],
  jurisdiction: ['optOutRights', 'dataDeletion'],
  'content-license': [],
  'no-sale-statement': ['dataSelling'],
  'account-controls': ['optOutRights'],
  'account-termination': [],
  'billing-terms': ['autoRenewal'],
  'terms-changes': [],
  'response-time': ['dataDeletion'],
  'contact-channels': ['howToOptOut', 'dataDeletion'],
  'tracking-tech': ['dataCollection'],
  'monitoring-consent': ['dataCollection'],
  'research-use': ['dataCollection'],
  marketing: ['optOutRights'],
  other: []
});

function classifyFabrication(text) {
  const s = String(text || '');
  for (const [key, pattern] of FABRICATION_PATTERNS) if (pattern.test(s)) return key;
  return 'other';
}

function omissionTheme(text) {
  const s = String(text || '');
  for (const [key, pattern] of OMISSION_THEMES) if (pattern.test(s)) return key;
  return 'other';
}

function stats(values) {
  const nums = values.filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return { n: 0, mean: null, median: null, min: null, max: null };
  const mean = nums.reduce((s, v) => s + v, 0) / nums.length;
  const median = nums.length % 2 ? nums[(nums.length - 1) / 2] : (nums[nums.length / 2 - 1] + nums[nums.length / 2]) / 2;
  return { n: nums.length, mean, median, min: nums[0], max: nums[nums.length - 1] };
}

function verdictOf(artifact, juror) {
  const stored = artifact.jury && artifact.jury[juror];
  if (!stored) return null;
  const verdict = typeof stored.raw === 'string' ? normalizeVerdict(parseJuryJson(stored.raw)) : stored.verdict;
  if (!verdict || !verdict.valid) return null;
  return verdict;
}

function pushExample(list, example, cap = 4) {
  if (list.length < cap) list.push(example);
}

function reflectRun({ artifacts, manifest, marks, juror = 'anthropic', meta = {} }) {
  const sites = manifest && manifest.sites ? manifest.sites : {};
  const graded = [];
  const notApplicable = {};
  for (const artifact of artifacts) {
    if (!artifact.analyzer || artifact.analyzer.status !== 'ok' || typeof artifact.summary !== 'string') continue;
    const verdict = verdictOf(artifact, juror);
    if (!verdict) continue;
    const score = scoreVerdict(verdict);
    if (score.score === null) {
      notApplicable[artifact.domain] = (notApplicable[artifact.domain] || 0) + 1;
      continue;
    }
    graded.push({ artifact, verdict, score });
  }

  const summary = summarizeRun(artifacts, { juror });

  const sections = {};
  for (const key of SECTIONS) {
    const byType = {};
    let applicable = 0;
    let errors = 0;
    let incomplete = 0;
    const notesSample = [];
    for (const { artifact, verdict } of graded) {
      const section = verdict.sections[key];
      if (section.accuracy === 'not-applicable' || section.completeness === 'not-applicable') continue;
      applicable++;
      const type = artifact.docType || 'other';
      byType[type] = byType[type] || { n: 0, errors: 0, incomplete: 0 };
      byType[type].n++;
      const isError = section.accuracy === 'major' || section.accuracy === 'fabricated';
      const isIncomplete = section.completeness === 'partial' || section.completeness === 'missing';
      if (isError) { errors++; byType[type].errors++; }
      if (isIncomplete) { incomplete++; byType[type].incomplete++; }
      if ((isError || section.accuracy === 'minor') && section.notes) pushExample(notesSample, { domain: artifact.domain, sample: artifact.sample, accuracy: section.accuracy, notes: section.notes }, 6);
    }
    for (const t of Object.values(byType)) {
      t.errorRate = t.n ? t.errors / t.n : null;
      t.incompleteRate = t.n ? t.incomplete / t.n : null;
    }
    sections[key] = { applicable, errorRate: applicable ? errors / applicable : null, incompleteRate: applicable ? incomplete / applicable : null, byType, notesSample };
  }

  const byPattern = {};
  const fabricationsBySite = {};
  let fabricationTotal = 0;
  let verdictsWithFabrications = 0;
  for (const { artifact, verdict } of graded) {
    if (verdict.fabrications.length) verdictsWithFabrications++;
    for (const text of verdict.fabrications) {
      fabricationTotal++;
      const pattern = classifyFabrication(text);
      byPattern[pattern] = byPattern[pattern] || { count: 0, sites: new Set(), examples: [] };
      byPattern[pattern].count++;
      byPattern[pattern].sites.add(artifact.domain);
      pushExample(byPattern[pattern].examples, { domain: artifact.domain, text: text.slice(0, 200) });
      fabricationsBySite[artifact.domain] = (fabricationsBySite[artifact.domain] || 0) + 1;
    }
  }
  for (const p of Object.values(byPattern)) p.sites = p.sites.size;

  const byTheme = {};
  let omissionTotal = 0;
  for (const { artifact, verdict } of graded) {
    for (const text of verdict.omissions) {
      omissionTotal++;
      const theme = omissionTheme(text);
      byTheme[theme] = byTheme[theme] || { count: 0, sites: new Set(), examples: [] };
      byTheme[theme].count++;
      byTheme[theme].sites.add(artifact.domain);
      pushExample(byTheme[theme].examples, { domain: artifact.domain, text: text.slice(0, 200) }, 3);
    }
  }
  for (const t of Object.values(byTheme)) t.sites = t.sites.size;

  const labels = {};
  const strongLow = [];
  const failedHigh = [];
  const issueCounts = {};
  for (const { artifact, score } of graded) {
    const label = artifact.verdict ? artifact.verdict.label : 'none';
    labels[label] = labels[label] || { n: 0, sum: 0 };
    labels[label].n++;
    labels[label].sum += score.score;
    if (label === 'Strong' && score.score < 60) strongLow.push({ domain: artifact.domain, sample: artifact.sample, evaluator: artifact.verdict.score, jury: score.score });
    if (label === 'Failed' && score.score >= 75) failedHigh.push({ domain: artifact.domain, sample: artifact.sample, evaluator: artifact.verdict.score, jury: score.score });
    for (const issue of (artifact.verdict && artifact.verdict.issues) || []) {
      const key = String(issue).replace(/\d+/g, 'N').slice(0, 80);
      issueCounts[key] = (issueCounts[key] || 0) + 1;
    }
  }
  for (const l of Object.values(labels)) { l.juryMean = l.n ? l.sum / l.n : null; delete l.sum; }
  const issuesTop = Object.entries(issueCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([issue, n]) => ({ issue, n }));

  const blindSpots = [];
  let criticCompared = 0;
  let criticAgreed = 0;
  for (const { artifact, verdict } of graded) {
    const critic = artifact.critic && !artifact.critic.failed ? artifact.critic : null;
    if (!critic) continue;
    const agreement = criticAgreement(critic, verdict);
    criticCompared += agreement.compared;
    criticAgreed += agreement.agreed;
    for (const key of SECTIONS) {
      const section = verdict.sections[key];
      const criticOk = critic[key] === 'grounded' || critic[key] === 'skipped';
      if (criticOk && (section.accuracy === 'fabricated' || section.accuracy === 'major')) {
        blindSpots.push({ domain: artifact.domain, sample: artifact.sample, section: key, critic: critic[key], jury: section.accuracy, notes: (section.notes || '').slice(0, 200) });
      }
    }
    if (verdict.fabrications.length && SECTIONS.every(key => critic[key] === 'grounded' || critic[key] === 'skipped')) {
      blindSpots.push({ domain: artifact.domain, sample: artifact.sample, section: 'any', critic: 'all grounded', jury: `${verdict.fabrications.length} fabrication(s)`, notes: verdict.fabrications[0].slice(0, 200) });
    }
  }

  const risk = { exact: 0, adjacent: 0, far: 0, missing: 0, over: 0, under: 0, byType: {} };
  for (const { artifact, verdict } of graded) {
    const displayed = artifact.verdict && artifact.verdict.risk ? artifact.verdict.risk : 'missing';
    const distance = riskDistance(displayed, verdict.riskLevel.jury);
    const type = artifact.docType || 'other';
    risk.byType[type] = risk.byType[type] || { compared: 0, exact: 0 };
    if (distance === null) { risk.missing++; continue; }
    risk.byType[type].compared++;
    if (distance === 0) { risk.exact++; risk.byType[type].exact++; }
    else {
      if (distance === 1) risk.adjacent++; else risk.far++;
      if (RISK_LEVELS.indexOf(displayed) > RISK_LEVELS.indexOf(verdict.riskLevel.jury)) risk.over++; else risk.under++;
    }
  }

  const byDomain = {};
  for (const { artifact, score } of graded) (byDomain[artifact.domain] = byDomain[artifact.domain] || []).push(score.score);
  const spreads = [];
  const unstable = [];
  for (const [domain, scores] of Object.entries(byDomain)) {
    if (scores.length < 2) continue;
    const spread = Math.max(...scores) - Math.min(...scores);
    spreads.push(spread);
    if (spread >= 20) unstable.push({ domain, spread, scores: scores.slice() });
  }
  unstable.sort((a, b) => b.spread - a.spread);

  const coverage = [];
  for (const [domain, scores] of Object.entries(byDomain)) {
    const entry = sites[domain];
    const artifact = graded.find(g => g.artifact.domain === domain).artifact;
    const analysisChars = artifact.analyzer.analysisChars || 0;
    if (!entry || !entry.textChars || !analysisChars) continue;
    const ratio = analysisChars / entry.textChars;
    if (ratio < 0.6) coverage.push({ domain, textChars: entry.textChars, analysisChars, ratio, meanScore: scores.reduce((s, v) => s + v, 0) / scores.length });
  }
  coverage.sort((a, b) => a.ratio - b.ratio);

  let spotcheck = null;
  if (marks && marks.sites && Object.keys(marks.sites).length) {
    const agreement = computeAgreement(artifacts, marks, { juror });
    spotcheck = { marked: agreement.marked, accuracyAgreement: agreement.accuracy.rate, completenessAgreement: agreement.completeness.rate, criticAgreement: agreement.critic.rate, riskAgreement: agreement.risk.rate, itemsNotSupported: agreement.items.notSupported, itemsMarked: agreement.items.marked };
  }

  return {
    v: 1,
    runId: meta.runId || null,
    generatedAt: new Date().toISOString(),
    juror,
    snapshot: {
      gitCommit: meta.gitCommit || null,
      manifestUpdatedAt: manifest && manifest.updatedAt ? manifest.updatedAt : null,
      proxy: meta.proxy || null,
      replayedAt: meta.startedAt || null,
      analyzerModels: summary.models.analyzer,
      juryModels: summary.models.jury,
      sites: Object.keys(byDomain).length + Object.keys(notApplicable).length,
      samples: graded.length && Object.keys(byDomain).length ? graded.length / Object.keys(byDomain).length : 0
    },
    totals: { artifacts: artifacts.length, graded: graded.length, cost: summary.cost },
    score: { overall: stats(graded.map(g => g.score.score)), bySplit: summary.bySplit, byType: summary.byType },
    sections,
    fabrications: {
      total: fabricationTotal,
      verdictsWith: verdictsWithFabrications,
      sitesWith: Object.keys(fabricationsBySite).length,
      byPattern,
      bySite: Object.entries(fabricationsBySite).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([domain, count]) => ({ domain, count }))
    },
    omissions: { total: omissionTotal, byTheme, themeSections: THEME_SECTIONS },
    evaluator: { labels, strongLow, failedHigh, issuesTop },
    critic: { compared: criticCompared, agreed: criticAgreed, rate: criticCompared ? criticAgreed / criticCompared : null, blindSpots },
    risk,
    variance: { ...stats(spreads), unstable },
    coverage,
    notApplicable: Object.entries(notApplicable).map(([domain, samples]) => ({ domain, samples })),
    spotcheck
  };
}

function pct(v, digits = 0) {
  return v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(digits)}%`;
}

function num(v, digits = 1) {
  return v === null || v === undefined ? 'n/a' : Number(v).toFixed(digits);
}

function renderFindings(f) {
  const lines = [];
  lines.push(`# Reflection — ${f.runId || 'run'}`);
  lines.push('');
  lines.push(`Snapshot: code ${f.snapshot.gitCommit ? f.snapshot.gitCommit.slice(0, 10) : 'unknown'}, manifest ${f.snapshot.manifestUpdatedAt || 'unknown'}, analyzer ${f.snapshot.analyzerModels.join(', ') || 'none'}, jury ${f.snapshot.juryModels.join(', ') || 'none'} (${f.juror}). ${f.snapshot.sites} sites, ${num(f.snapshot.samples)} samples each, ${f.totals.graded} graded verdicts, total cost $${num(f.totals.cost.total, 2)}.`);
  lines.push('');
  lines.push('## Score');
  lines.push('');
  const o = f.score.overall;
  lines.push(`Jury score: n ${o.n}, mean ${num(o.mean)}, median ${num(o.median)}, min ${num(o.min, 0)}, max ${num(o.max, 0)}. By split: ${Object.entries(f.score.bySplit).map(([k, s]) => `${k} ${num(s.mean)} (${s.n})`).join(', ')}. By type: ${Object.entries(f.score.byType).sort((a, b) => b[1].mean - a[1].mean).map(([k, s]) => `${k} ${num(s.mean)} (${s.n})`).join(', ')}.`);
  if (f.variance.n) lines.push(`Same site, repeated samples: spread median ${num(f.variance.median, 0)}, mean ${num(f.variance.mean)}, max ${num(f.variance.max, 0)}; ${f.variance.unstable.length} site(s) spread 20 or more${f.variance.unstable.length ? `: ${f.variance.unstable.slice(0, 8).map(u => `${u.domain} (${u.spread})`).join(', ')}` : ''}.`);
  lines.push('');
  lines.push('## Sections');
  lines.push('');
  lines.push('| section | applicable | error rate | incomplete | worst type (incomplete) |');
  lines.push('|---|---|---|---|---|');
  for (const key of SECTIONS) {
    const s = f.sections[key];
    const worst = Object.entries(s.byType).filter(([, t]) => t.n >= 3).sort((a, b) => b[1].incompleteRate - a[1].incompleteRate)[0];
    lines.push(`| ${key} | ${s.applicable} | ${pct(s.errorRate)} | ${pct(s.incompleteRate)} | ${worst ? `${worst[0]} ${pct(worst[1].incompleteRate)} (${worst[1].n})` : 'n/a'} |`);
  }
  lines.push('');
  lines.push('## Fabricated specifics');
  lines.push('');
  lines.push(`${f.fabrications.total} fabrication(s) in ${f.fabrications.verdictsWith} of ${f.totals.graded} verdicts, on ${f.fabrications.sitesWith} site(s). Most: ${f.fabrications.bySite.slice(0, 6).map(s => `${s.domain} (${s.count})`).join(', ') || 'none'}.`);
  lines.push('');
  lines.push('| pattern | count | sites | example |');
  lines.push('|---|---|---|---|');
  for (const [pattern, p] of Object.entries(f.fabrications.byPattern).sort((a, b) => b[1].count - a[1].count)) {
    lines.push(`| ${pattern} | ${p.count} | ${p.sites} | ${p.examples[0] ? `${p.examples[0].domain}: ${p.examples[0].text.replace(/\|/g, '/')}` : ''} |`);
  }
  lines.push('');
  lines.push('## Omissions by theme');
  lines.push('');
  lines.push(`${f.omissions.total} omission(s) reported by the jury.`);
  lines.push('');
  lines.push('| theme | count | sites | maps to section | example |');
  lines.push('|---|---|---|---|---|');
  for (const [theme, t] of Object.entries(f.omissions.byTheme).sort((a, b) => b[1].count - a[1].count)) {
    const mapped = (f.omissions.themeSections[theme] || []).join(', ') || 'no section covers it';
    lines.push(`| ${theme} | ${t.count} | ${t.sites} | ${mapped} | ${t.examples[0] ? `${t.examples[0].domain}: ${t.examples[0].text.replace(/\|/g, '/')}` : ''} |`);
  }
  lines.push('');
  lines.push('## Evaluator against the jury');
  lines.push('');
  lines.push(`${Object.entries(f.evaluator.labels).map(([label, l]) => `${label}: ${l.n} verdicts, jury mean ${num(l.juryMean)}`).join('; ')}.`);
  lines.push(`Strong by the evaluator but under 60 with the jury: ${f.evaluator.strongLow.length}${f.evaluator.strongLow.length ? ` (${f.evaluator.strongLow.slice(0, 6).map(x => `${x.domain}#${x.sample} ${x.jury}`).join(', ')})` : ''}. Failed by the evaluator but 75 or more with the jury: ${f.evaluator.failedHigh.length}${f.evaluator.failedHigh.length ? ` (${f.evaluator.failedHigh.slice(0, 6).map(x => `${x.domain}#${x.sample} ${x.jury}`).join(', ')})` : ''}.`);
  if (f.evaluator.issuesTop.length) lines.push(`Most frequent evaluator issues: ${f.evaluator.issuesTop.slice(0, 5).map(i => `"${i.issue}" (${i.n})`).join('; ')}.`);
  lines.push('');
  lines.push('## Critic against the jury');
  lines.push('');
  lines.push(`Agree on section acceptability ${pct(f.critic.rate)} of ${f.critic.compared}. Blind spots (critic grounded, jury major or fabricated): ${f.critic.blindSpots.length}.`);
  for (const b of f.critic.blindSpots.slice(0, 8)) lines.push(`- ${b.domain}#${b.sample} ${b.section}: critic ${b.critic}, jury ${b.jury}${b.notes ? ` — ${b.notes}` : ''}`);
  lines.push('');
  lines.push('## Risk level');
  lines.push('');
  lines.push(`Displayed risk against the jury: exact ${f.risk.exact}, one step off ${f.risk.adjacent}, two off ${f.risk.far}, not comparable ${f.risk.missing}. Of the disagreements, the overlay was higher than the jury ${f.risk.over} time(s) and lower ${f.risk.under} time(s).`);
  lines.push('');
  lines.push('## Coverage');
  lines.push('');
  if (f.coverage.length) {
    lines.push('Sites where the analyzer saw less than 60% of the frozen text:');
    for (const c of f.coverage.slice(0, 10)) lines.push(`- ${c.domain}: ${c.analysisChars.toLocaleString()} of ${c.textChars.toLocaleString()} characters (${pct(c.ratio)}), jury mean ${num(c.meanScore, 0)}`);
  } else {
    lines.push('Every site was analysed from at least 60% of its frozen text.');
  }
  if (f.notApplicable.length) lines.push(`Sites the jury found nothing to grade in (no applicable section): ${f.notApplicable.map(n => `${n.domain} (${n.samples})`).join(', ')}.`);
  if (f.spotcheck) {
    lines.push('');
    lines.push('## Spot-check');
    lines.push('');
    lines.push(`Owner marked ${f.spotcheck.marked} site(s), ${f.spotcheck.itemsMarked} lines, ${f.spotcheck.itemsNotSupported} not supported. Agreement with the jury on acceptability ${pct(f.spotcheck.accuracyAgreement)}, on completeness ${pct(f.spotcheck.completenessAgreement)}, on risk ${pct(f.spotcheck.riskAgreement)}; with the critic ${pct(f.spotcheck.criticAgreement)}.`);
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = { FABRICATION_PATTERNS, OMISSION_THEMES, THEME_SECTIONS, classifyFabrication, omissionTheme, reflectRun, renderFindings };
