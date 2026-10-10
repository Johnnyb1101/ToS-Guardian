const C = require('../tools/campaign-lib');
const { SECTIONS } = require('../tools/jury-lib');

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (condition) { console.log(`  ok    ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

console.log('Campaign driver');

const good = {
  name: 'bundle-2b-billing', proxy: 'http://127.0.0.1:3001/', control: 'treat-bundle1',
  lessons: { revise: [{ run: 'baseline-1', candidateId: 'L005', id: 'L005b', after: 'proof-bundle2', text: 'In AUTO-RENEWAL & BILLING name only the charges the document authorizes, in its words.' }], pin: ['lsn_ba40ed07be36a4c4'] },
  screen: { sites: ['ebay.com', 'coursera.org', 'google.com'], samples: 3, budget: 10 },
  proof: { samples: 3, budget: 40 },
  notify: { url: 'https://ntfy.sh/example-topic' }
};
const parsed = C.validateSpec(good);
ok('a complete spec validates and is normalized', parsed.valid && parsed.spec.proxy === 'http://127.0.0.1:3001' && parsed.spec.proof.kind === 'jury' && parsed.spec.screen.maxFabricationRise === 0.25 && parsed.spec.delayMs === 6000, parsed.errors.join('; '));
ok('a spec without lessons, with a bad name, a bad proxy or a bad notify url is refused', (() => {
  const noLessons = C.validateSpec({ ...good, lessons: {} });
  const badName = C.validateSpec({ ...good, name: 'Bad Name' });
  const badProxy = C.validateSpec({ ...good, proxy: 'ftp://x' });
  const badNotify = C.validateSpec({ ...good, notify: { url: 'http://insecure' } });
  return !noLessons.valid && /needs lessons/.test(noLessons.errors[0]) && !badName.valid && !badProxy.valid && !badNotify.valid;
})());
ok('a screen needs three sites, a revision needs text, pins need real ids', !C.validateSpec({ ...good, screen: { sites: ['a.com'] } }).valid && !C.validateSpec({ ...good, lessons: { revise: [{ run: 'baseline-1', candidateId: 'L005', text: 'short' }] } }).valid && !C.validateSpec({ ...good, lessons: { pin: ['L005'] } }).valid);
const critic = C.validateSpec({ name: 'critic-b3', proxy: 'http://127.0.0.1:3001', control: 'baseline-1', lessons: { create: { run: 'baseline-1', ids: ['L014', 'L016'] } }, proof: { kind: 'critic', source: 'baseline-1', budget: 8 } });
ok('a critic campaign needs a source run and takes no screen', critic.valid && critic.spec.proof.source === 'baseline-1' && !C.validateSpec({ ...critic.spec, proof: { kind: 'critic' } }).valid && !C.validateSpec({ ...good, proof: { kind: 'critic', source: 'baseline-1' } }).valid);

ok('a jury campaign with a screen plans ten steps, without a screen seven, a critic campaign six', C.planSteps(parsed.spec).length === 10 && C.planSteps({ ...parsed.spec, screen: null }).length === 7 && C.planSteps(critic.spec).join(',') === 'health,register,critic-replay,prove-critic,report,notify');
ok('run ids derive from the campaign name and budgets split replay and jury', C.runIds(parsed.spec).proof === 'bundle-2b-billing-proof' && C.budgetSplit(40).replay === 16 && C.budgetSplit(40).jury === 24);

function juryRaw(fabrications, completeness = 'complete') {
  return JSON.stringify({
    sections: Object.fromEntries(SECTIONS.map(s => [s, { accuracy: 'correct', completeness, notes: '' }])),
    bottomLine: { fair: true, notes: '' }, riskLevel: { summary: 'High', jury: 'High', notes: '' },
    fabrications: Array.from({ length: fabrications }, (_, i) => `invented ${i}`), omissions: []
  });
}
function artifact(domain, sample, fabrications, completeness) {
  return {
    domain, sample, split: 'work', docType: 'financial', analyzer: { status: 'ok', model: 'claude-sonnet-4-6', analysisChars: 1000, lessonsHash: 'h', lessonsArm: 'pinned' },
    summary: '🧭 RISK LEVEL\nHigh', analysisSource: 'x', critic: null, verdict: { label: 'Strong', score: 100, risk: 'High' }, cost: 0.1,
    jury: { anthropic: { model: 'claude-opus-5', raw: juryRaw(fabrications, completeness), usageRecord: { model: 'claude-opus-5', input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 } } }
  };
}
const sites = ['ebay.com', 'coursera.org', 'google.com'];
const control = sites.flatMap(d => [1, 2, 3].map(s => artifact(d, s, 0, 'partial')));
const other = [artifact('other.com', 1, 9, 'missing')];
const steady = sites.flatMap(d => [1, 2, 3].map(s => artifact(d, s, 0, 'complete')));
const decision = C.screenDecision({ controlArtifacts: [...control, ...other], treatmentArtifacts: steady, sites });
ok('a screen that improves completeness without fabrications proceeds, ignoring sites outside the screen', decision.proceed && decision.control.verdicts === 9 && decision.treatment.meanScore > decision.control.meanScore, JSON.stringify(decision));
const spiky = sites.flatMap(d => [1, 2, 3].map(s => artifact(d, s, s === 1 ? 2 : 0, 'complete')));
const stop = C.screenDecision({ controlArtifacts: control, treatmentArtifacts: spiky, sites });
ok('a fabrication spike stops the campaign with its numbers', !stop.proceed && /fabrications per verdict rose from 0.00 to 0.67/.test(stop.reasons[0]), stop.reasons.join('; '));
const worse = sites.flatMap(d => [1, 2, 3].map(s => artifact(d, s, 0, 'missing')));
ok('a jury-score drop stops the campaign', !C.screenDecision({ controlArtifacts: control, treatmentArtifacts: worse, sites }).proceed);
ok('no verdicts to compare stops the campaign', !C.screenDecision({ controlArtifacts: control, treatmentArtifacts: [], sites }).proceed);

const state = C.initialState(parsed.spec);
const plan = C.planSteps(parsed.spec);
ok('the first step of a fresh campaign is health', C.nextStep(state, plan) === 'health');
C.markStep(state, 'health', { status: 'done' });
C.markStep(state, 'register', { status: 'failed', note: 'proxy down' });
ok('a failed step is retried on resume', C.nextStep(state, plan) === 'register');
C.markStep(state, 'register', { status: 'done' });
state.lessons.registered = [{ candidateId: 'L013', id: 'lsn_ba40ed07be36a4c4', status: 'exists', underTest: false }, { candidateId: 'L005b', id: 'lsn_0123456789abcdef', status: 'created', underTest: true }];
state.lessons.pinned = ['lsn_0123456789abcdef', 'lsn_ba40ed07be36a4c4'];
state.screen = stop;
state.decision = 'stopped-at-screen';
const stoppedReport = C.renderReport(state);
ok('a stopped campaign reports the screen and proposes retiring only the lessons under test', /Stopped at the screen/.test(stoppedReport) && /\| treatment \| 9 \| 0.67 \|/.test(stoppedReport) && /lessons.js status lsn_0123456789abcdef retired/.test(C.proposal(state)) && !/lsn_ba40ed07be36a4c4 retired/.test(C.proposal(state)) && /carried, not under test/.test(stoppedReport));
ok('carried lessons validate like created ones', C.validateSpec({ ...good, lessons: { carry: { run: 'baseline-1', ids: ['L013'] }, revise: good.lessons.revise } }).valid && !C.validateSpec({ ...good, lessons: { carry: { run: 'baseline-1' }, revise: good.lessons.revise } }).valid);
state.screen = decision;
state.decision = 'proven';
state.proof = { kind: 'jury', proven: true, summary: 'Proven: jury score +5.2 on 30 work sites (95% 0.6 to 10.0), holdout +7.3 on 19.', lessonsHash: 'd93555f3f157abcdef', runDir: 'reference/runs/bundle-2b-billing-proof' };
state.cost = { screen: 9.4, proof: 38.6 };
const provenReport = C.renderReport(state);
ok('a proven campaign reports the proof, the cost and the promotion commands', /Proven: jury score \+5\.2/.test(provenReport) && /total \$48\.00/.test(provenReport) && /lessons.js status lsn_0123456789abcdef promoted --proxy http:\/\/127\.0\.0\.1:3001 --proof reference\/runs\/bundle-2b-billing-proof/.test(provenReport) && /Lesson set d93555f3f157/.test(provenReport));
const text = C.notificationText(state);
ok('the notification is short, names the campaign and the outcome, and carries no document text', text.startsWith('ToS Guardian campaign bundle-2b-billing: PROVEN.') && /Cost \$48\.00/.test(text) && text.length <= 400);
ok('a failure notification names the step', /failed: register: proxy down/.test(C.notificationText({ ...state, failure: 'register: proxy down' })));

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
