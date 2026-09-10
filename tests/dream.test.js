const D = require('../tools/dream-lib');
const { SECTIONS } = require('../tools/jury-lib');
const { THEME_SECTIONS } = require('../tools/reflect-lib');

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (condition) { console.log(`  ok    ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

console.log('Dream');

function findings(over = {}) {
  const sections = Object.fromEntries(SECTIONS.map(s => [s, { applicable: 100, errorRate: 0, incompleteRate: 0.3, byType: { financial: { n: 40, errorRate: 0, incompleteRate: 0.3 } }, notesSample: [] }]));
  sections.optOutRights.incompleteRate = 0.85;
  sections.dataSelling.incompleteRate = 0.9;
  sections.dataSelling.byType.commerce = { n: 15, errorRate: 0, incompleteRate: 1 };
  return {
    v: 1, runId: 'r1', generatedAt: '2026-09-10T00:00:00.000Z', juror: 'anthropic',
    snapshot: {}, totals: { artifacts: 150, graded: 147, cost: { total: 38 } },
    score: { overall: { n: 147, mean: 70 }, bySplit: {}, byType: {} },
    sections,
    fabrications: { total: 60, verdictsWith: 40, sitesWith: 20, byPattern: { 'menu-path': { count: 40, sites: 18, examples: [{ domain: 'a.com', text: 'Settings → Privacy' }] }, 'generic-advice': { count: 4, sites: 3, examples: [{ domain: 'b.com', text: 'check your account settings' }] }, other: { count: 16, sites: 9, examples: [] } }, bySite: [] },
    omissions: { total: 300, byTheme: { dispute: { count: 80, sites: 29, examples: [{ domain: 'a.com', text: 'class action waiver' }] }, 'tracking-signals': { count: 40, sites: 17, examples: [{ domain: 'a.com', text: 'Do Not Track' }] }, 'no-sale-statement': { count: 15, sites: 7, examples: [] }, other: { count: 165, sites: 40, examples: [] } }, themeSections: THEME_SECTIONS },
    evaluator: { labels: { Strong: { n: 96, juryMean: 71 }, Failed: { n: 15, juryMean: 59 } }, strongLow: Array.from({ length: 18 }, (_, i) => ({ domain: `s${i}.com`, sample: 1, evaluator: 100, jury: 50 })), failedHigh: [], issuesTop: [] },
    critic: { compared: 870, agreed: 810, rate: 0.93, blindSpots: Array.from({ length: 55 }, (_, i) => ({ domain: `b${i % 10}.com`, sample: 1, section: 'howToOptOut', critic: 'grounded', jury: 'fabricated', notes: 'invented path' })) },
    risk: { exact: 92, adjacent: 35, far: 0, missing: 20, over: 18, under: 17, byType: {} },
    variance: { n: 49, median: 14, mean: 16.5, max: 66, unstable: Array.from({ length: 16 }, (_, i) => ({ domain: `u${i}.com`, spread: 30, scores: [50, 80, 60] })) },
    coverage: [{ domain: 'x.com', textChars: 300000, analysisChars: 80000, ratio: 0.27, meanScore: 55 }, { domain: 'y.com', textChars: 200000, analysisChars: 80000, ratio: 0.4, meanScore: 60 }, { domain: 'z.com', textChars: 100000, analysisChars: 50000, ratio: 0.5, meanScore: 70 }],
    notApplicable: [{ domain: 'idx.com', samples: 3 }],
    spotcheck: null,
    ...over
  };
}

const candidates = D.dreamLessons(findings());
const byKind = (kind) => candidates.filter(c => c.kind === kind);
const find = (fn) => candidates.find(fn);

ok('completeness lessons appear for sections incomplete 60% or more, with the mapped omission themes in the reason',
  find(c => c.kind === 'lesson' && c.section === 'optOutRights' && c.scope === 'all' && /tracking-signals \(40\)/.test(c.why)) && find(c => c.section === 'dataSelling' && c.scope === 'all') && !find(c => c.section === 'dataCollection'));
ok('a type that is worse than the overall rate gets a scoped lesson', find(c => c.section === 'dataSelling' && c.scope === 'commerce'));
ok('a fabrication pattern with five or more cases yields an analyzer lesson and a critic lesson',
  find(c => c.target === 'analyzer' && /menu path/.test(c.text)) && find(c => c.target === 'critic' && /menu path/.test(c.text)) && !find(c => /generic advice/.test(c.text) && c.target === 'analyzer'));
ok('critic blind spots seed a calibration set', find(c => c.kind === 'calibration' && /55 verdict/.test(c.text)));
ok('evaluator miscalibration becomes a code candidate', find(c => c.kind === 'code' && c.target === 'evaluator' && /18 verdict/.test(c.why)));
ok('the prompt fallback phrase becomes a prompt candidate', find(c => c.kind === 'code' && c.target === 'analyzer-prompt' && /fallback/.test(c.text)));
ok('an index page becomes a site fact and a fetcher code candidate', find(c => c.kind === 'site-fact' && c.scope === 'idx.com') && find(c => c.kind === 'code' && c.target === 'fetcher'));
ok('truncated coverage becomes an excerpt candidate naming the worst sites', find(c => c.target === 'analyzer-excerpt' && /x\.com 27%/.test(c.why)));
ok('an uncovered omission theme becomes a schema candidate', find(c => c.target === 'schema' && /"dispute"/.test(c.text)) && !find(c => c.target === 'schema' && /tracking-signals/.test(c.text)));
ok('balanced risk disagreement yields no risk lesson', !find(c => c.section === 'riskLevel'));
ok('one-sided risk disagreement yields a risk lesson', D.dreamLessons(findings({ risk: { exact: 50, adjacent: 20, far: 0, missing: 0, over: 18, under: 2, byType: {} } })).some(c => c.section === 'riskLevel' && /Reserve High/.test(c.text)));
ok('unstable sites yield a proof-design note', find(c => c.kind === 'note' && /three samples/.test(c.text)));
ok('candidates are sorted by priority with ids assigned', candidates.every((c, i) => i === 0 || candidates[i - 1].priority >= c.priority) && candidates.every(c => /^L\d{3}$/.test(c.id)));
ok('the most frequent fabrication pattern ranks first and the proof note near last', candidates[0].kind === 'lesson' && /menu path/.test(candidates[0].text) && candidates.findIndex(c => c.kind === 'note') >= candidates.length - 3);
ok('every candidate starts as a proposal', candidates.every(c => c.status === 'candidate'));

const quiet = D.dreamLessons(findings({
  sections: Object.fromEntries(SECTIONS.map(s => [s, { applicable: 100, errorRate: 0, incompleteRate: 0.2, byType: {}, notesSample: [] }])),
  fabrications: { total: 2, verdictsWith: 2, sitesWith: 2, byPattern: { url: { count: 2, sites: 2, examples: [] } }, bySite: [] },
  omissions: { total: 5, byTheme: { other: { count: 5, sites: 3, examples: [] } }, themeSections: THEME_SECTIONS },
  evaluator: { labels: {}, strongLow: [], failedHigh: [], issuesTop: [] },
  critic: { compared: 100, agreed: 99, rate: 0.99, blindSpots: [] },
  risk: { exact: 90, adjacent: 2, far: 0, missing: 0, over: 1, under: 1, byType: {} },
  variance: { n: 49, median: 5, mean: 6, max: 12, unstable: [] },
  coverage: [], notApplicable: []
}));
ok('a clean run yields no candidates', quiet.length === 0, JSON.stringify(quiet.map(c => c.id)));

const md = D.renderLessons(candidates, { runId: 'r1', generatedAt: '2026-09-10T00:00:00.000Z' });
ok('lessons render grouped by kind with evidence lines', md.includes('# Lesson candidates — r1') && md.includes('## Prompt lessons') && md.includes('## Code changes') && md.includes('- a.com: Settings → Privacy'));
ok('an empty candidate list renders', D.renderLessons([], {}).includes('0 candidate(s)'));

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
