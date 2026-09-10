const R = require('../tools/reflect-lib');
const J = require('../tools/jury-lib');

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (condition) { console.log(`  ok    ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

console.log('Reflect');

const fab = (text, expected) => ok(`fabrication "${text.slice(0, 50)}" is ${expected}`, R.classifyFabrication(text) === expected, R.classifyFabrication(text));
fab('"Settings → Privacy → Location Services" — the policy only says mobile device settings', 'menu-path');
fab('visit Chase\'s Privacy page directly at chase.com/privacy', 'url');
fab('"optout.aboutads.info" (document names the DAA Opt Out Page but gives no URL)', 'url');
fab('"California residents can request deletion by calling 1-800-DISCOVER"', 'phone');
fab('States a specific address privacy@makenotion.com that the document does not contain', 'email');
fab('check your account settings', 'generic-advice');
fab('"Precise geolocation" collected — the document says general location', 'data-category');
fab('"Full data shared across all eBay-owned companies"', 'recipient');
fab('"Arbitration opt-out: Section 23 ... if you want to opt out" — no opt-out from arbitration is described', 'right-claim');
fab('request deletion by using the \'Download your data\' tool — that tool is for access/portability, not deletion', 'wrong-mechanism');
fab('"these sites were not fully accessible at time of review"', 'other');
ok('empty fabrication text is other', R.classifyFabrication('') === 'other' && R.classifyFabrication(null) === 'other');

const om = (text, expected) => ok(`omission "${text.slice(0, 50)}" is ${expected}`, R.omissionTheme(text) === expected, R.omissionTheme(text));
om('Terms include a class action waiver in arbitration', 'dispute');
om('Acorns does not honor \'Do Not Track\' signals', 'tracking-signals');
om('Biometric facial data is generated during identity verification and kept up to 2 years.', 'biometrics');
om('Accounts inactive for more than two years may be terminated; some data is retained even after deletion', 'retention');
om('Personal data can be transferred in a sale, merger, or change of control.', 'business-transfer');
om('Personal information is used to develop and deploy generative AI models', 'ai-training');
om('Policy explicitly states \'we don\'t sell your personal information\'', 'no-sale-statement');
om('Critical service/security communications cannot be opted out of', 'cannot-opt-out');
om('Purchases from Epic are non-refundable unless labeled otherwise', 'billing-terms');
om('The WBD Privacy Center page returned a \'Processing Error\' — the actual policy text never loaded', 'fetch-problem');
om('Data is transferred and stored internationally (Ireland, Germany, Singapore)', 'international-transfer');
om('Hosts must handle Guest personal data under the Host Privacy Standards', 'other');
ok('every theme maps to a section list', Object.keys(R.THEME_SECTIONS).length > 0 && R.OMISSION_THEMES.every(([theme]) => Array.isArray(R.THEME_SECTIONS[theme])));

function section(a, c, notes = '') { return { accuracy: a, completeness: c, notes }; }
function juryRaw(over = {}) {
  return JSON.stringify({
    sections: {
      dataCollection: section('correct', 'partial', 'omits data sources'),
      dataSelling: section('correct', 'partial'),
      optOutRights: section('correct', 'complete'),
      howToOptOut: section('minor', 'complete', 'adds a Settings path'),
      autoRenewal: section('not-applicable', 'not-applicable'),
      dataDeletion: section('correct', 'complete')
    },
    bottomLine: { fair: true, notes: '' }, riskLevel: { summary: 'High', jury: 'High', notes: '' }, fabrications: [], omissions: [], ...over
  });
}
function artifact(domain, sample, over = {}) {
  return {
    domain, sample, split: 'work', docType: 'financial',
    analyzer: { status: 'ok', model: 'claude-sonnet-4-6', analysisChars: 80000 },
    summary: '🧭 RISK LEVEL\nHigh',
    critic: { dataCollection: 'grounded', dataSelling: 'grounded', optOutRights: 'grounded', howToOptOut: 'grounded', autoRenewal: 'skipped', dataDeletion: 'grounded' },
    verdict: { label: 'Strong', score: 100, risk: 'High', issues: [] },
    cost: 0.1,
    jury: { anthropic: { model: 'claude-opus-5', raw: juryRaw(), usageRecord: { model: 'claude-opus-5', input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 } } },
    ...over
  };
}
const manifest = { updatedAt: '2026-09-06T00:00:00.000Z', sites: {
  'a.com': { textChars: 100000 }, 'b.com': { textChars: 300000 }, 'c.com': { textChars: 50000 }, 'idx.com': { textChars: 90000 }
} };
const artifacts = [
  artifact('a.com', 1),
  artifact('a.com', 2, { jury: { anthropic: { raw: juryRaw({ sections: { dataCollection: section('correct', 'complete'), dataSelling: section('major', 'partial', 'overstates'), optOutRights: section('correct', 'partial'), howToOptOut: section('fabricated', 'complete', 'invented path'), autoRenewal: section('not-applicable', 'not-applicable'), dataDeletion: section('correct', 'partial') }, fabrications: ['"Settings → Privacy → Location" is not in the document', 'visit example.com/privacy'], omissions: ['Terms include a class action waiver', 'Data is retained for 5 years'], riskLevel: { summary: 'High', jury: 'Moderate', notes: '' } }) } } }),
  artifact('b.com', 1, { docType: 'social', analyzer: { status: 'ok', analysisChars: 60000 }, verdict: { label: 'Failed', score: 40, risk: 'Unknown', issues: ['some sections were missing from the fetched document'] }, jury: { anthropic: { raw: juryRaw({ fabrications: ['check your account settings'] }) } } }),
  artifact('c.com', 1, { verdict: { label: 'Strong', score: 100, risk: 'High', issues: [] }, jury: { anthropic: { raw: juryRaw({ sections: Object.fromEntries(J.SECTIONS.map(s => [s, section('fabricated', 'missing')])), fabrications: ['a', 'b', 'c', 'd', 'e'] }) } } }),
  artifact('idx.com', 1, { jury: { anthropic: { raw: juryRaw({ sections: Object.fromEntries(J.SECTIONS.map(s => [s, section('not-applicable', 'not-applicable')])) }) } } }),
  artifact('err.com', 1, { analyzer: { status: 'error' }, summary: null })
];
const findings = R.reflectRun({ artifacts, manifest, marks: null, juror: 'anthropic', meta: { runId: 'r1', gitCommit: 'abc123' } });

ok('graded verdicts exclude errors and sites with nothing applicable', findings.totals.graded === 4 && findings.notApplicable.length === 1 && findings.notApplicable[0].domain === 'idx.com');
ok('snapshot carries the code commit, manifest time, and models', findings.snapshot.gitCommit === 'abc123' && findings.snapshot.manifestUpdatedAt === manifest.updatedAt && findings.snapshot.juryModels[0] === 'claude-opus-5');
ok('section incompleteness and error rates are computed over applicable verdicts', findings.sections.dataSelling.applicable === 4 && Math.abs(findings.sections.dataSelling.errorRate - 0.5) < 1e-9 && Math.abs(findings.sections.dataSelling.incompleteRate - 1) < 1e-9, JSON.stringify(findings.sections.dataSelling));
ok('sections track the worst document type', findings.sections.dataSelling.byType.financial.n === 3 && findings.sections.dataSelling.byType.social.n === 1);
ok('fabrications are classified and attributed', findings.fabrications.total === 8 && findings.fabrications.byPattern['menu-path'].count === 1 && findings.fabrications.byPattern['generic-advice'].count === 1 && findings.fabrications.bySite[0].domain === 'c.com');
ok('omissions are themed', findings.omissions.total === 2 && findings.omissions.byTheme.dispute.count === 1 && findings.omissions.byTheme.retention.count === 1);
ok('evaluator disagreements are listed', findings.evaluator.strongLow.length === 2 && findings.evaluator.strongLow.some(x => x.domain === 'c.com') && findings.evaluator.strongLow.some(x => x.domain === 'a.com' && x.sample === 2) && findings.evaluator.failedHigh.length === 1 && findings.evaluator.failedHigh[0].domain === 'b.com', JSON.stringify(findings.evaluator.strongLow));
ok('evaluator issues are counted with numbers normalized', findings.evaluator.issuesTop[0].issue === 'some sections were missing from the fetched document');
ok('critic blind spots list grounded sections the jury failed', findings.critic.blindSpots.some(b => b.domain === 'a.com' && b.section === 'howToOptOut') && findings.critic.blindSpots.some(b => b.domain === 'b.com' && b.section === 'any'));
ok('risk disagreements record direction', findings.risk.exact === 2 && findings.risk.adjacent === 1 && findings.risk.over === 1 && findings.risk.missing === 1, JSON.stringify(findings.risk));
ok('variance is measured across samples of a site', findings.variance.n === 1 && findings.variance.unstable.length === 1 && findings.variance.unstable[0].domain === 'a.com');
ok('coverage lists sites analysed from under 60% of their text', findings.coverage.length === 1 && findings.coverage[0].domain === 'b.com' && findings.coverage[0].ratio === 0.2);
ok('spot-check is absent when there are no marks', findings.spotcheck === null);

const withMarks = R.reflectRun({ artifacts, manifest, juror: 'anthropic', marks: { v: 1, sites: { 'a.com.1': { sections: { dataCollection: { items: { 0: 'supported' }, completeness: 'missing' } }, risk: 'High', bottomLineFair: true } } } });
ok('spot-check agreement is folded in when marks exist', withMarks.spotcheck && withMarks.spotcheck.marked === 1 && withMarks.spotcheck.accuracyAgreement === 1);

const md = R.renderFindings(findings);
ok('findings render with every section', ['## Score', '## Sections', '## Fabricated specifics', '## Omissions by theme', '## Evaluator against the jury', '## Critic against the jury', '## Risk level', '## Coverage'].every(h => md.includes(h)));
ok('findings name the unstable and truncated sites', md.includes('a.com (') && md.includes('b.com: 60,000 of 300,000'));
ok('an empty run renders', R.renderFindings(R.reflectRun({ artifacts: [], manifest: { sites: {} } })).includes('# Reflection'));

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
