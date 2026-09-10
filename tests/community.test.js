const E = require('../episode');
const C = require('../community');

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (condition) { console.log(`  ok    ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

function storage(value) {
  return { get: (key, cb) => { const out = value === undefined ? {} : { [key]: value }; if (cb) cb(out); return Promise.resolve(out); } };
}

function liveEvents(id = '0123456789abcdef', mode = 'live') {
  const source = mode === 'batch' ? 'batch' : mode === 'replay' ? 'replay' : 'click';
  return [
    E.createEvent(id, 'trigger', { source, branch: 'button', controlTag: 'button', authForm: true, passwordField: false, knownDomain: true, frame: false }, { now: 1000, local: { pageUrl: 'https://login.chase.com/signup?session=secret', controlLabel: 'Agree and continue' } }),
    E.createEvent(id, 'relay', { domain: 'chase.com', siteLookup: 'static', deduped: false, mode }, { now: 1001 }),
    E.createEvent(id, 'fetch', { path: 'known-urls', tosFound: true, privacyFound: true, supplementalCount: 0, textChars: 40000, textHash: 'deadbeef', looksLegal: true, unreadablePdfCount: 0, documentUrls: ['https://chase.com/terms?x=1', 'https://chase.com/privacy'], retried: false }, { now: 1002, local: { pageUrl: 'https://login.chase.com/signup?session=secret' } }),
    E.createEvent(id, 'verdict', { risk: 'High', label: 'Strong', score: 100, retrievalFailure: false, cached: false, optOutLinks: 1, unreadableDocs: 0 }, { now: 1003, local: { bottomLine: 'You agree to arbitration.' } }),
    E.createEvent(id, 'end', { durationMs: 1500, ok: true }, { now: 1004 })
  ];
}

(async () => {
  console.log('Community reports');

  ok('config is off and undecided by default', JSON.stringify(await C.readCommunityConfig(storage(undefined))) === JSON.stringify({ enabled: false, decided: false }));
  ok('a stored decision is honoured', JSON.stringify(await C.readCommunityConfig(storage({ enabled: true }))) === JSON.stringify({ enabled: true, decided: true }));
  ok('a declined prompt stays off and decided', JSON.stringify(await C.readCommunityConfig(storage({ enabled: false, decided: true }))) === JSON.stringify({ enabled: false, decided: true }));
  ok('garbage in storage means off', (await C.readCommunityConfig(storage('yes'))).enabled === false && (await C.readCommunityConfig(null)).enabled === false);

  ok('the prompt is offered once, only after a successful render, only while undecided',
    C.shouldOfferCommunityPrompt({ enabled: false, decided: false }, true) && !C.shouldOfferCommunityPrompt({ enabled: false, decided: false }, false) && !C.shouldOfferCommunityPrompt({ enabled: false, decided: true }, true) && !C.shouldOfferCommunityPrompt({ enabled: true, decided: true }, true));
  ok('a decision records the answer and closes the prompt', JSON.stringify(C.communityDecision(true)) === JSON.stringify({ enabled: true, decided: true }) && JSON.stringify(C.communityDecision('yes')) === JSON.stringify({ enabled: false, decided: true }));

  const built = C.buildCommunityReport(liveEvents(), { analysisReceipt: 'abc.def' });
  ok('a live episode builds an uploadable report with its receipt', built.ok && built.report.v === 1 && built.report.analysisReceipt === 'abc.def' && built.report.episode.mode === 'live', JSON.stringify(built.errors));
  const text = JSON.stringify(built.report);
  ok('the report carries no page url, button label, bottom line, or fine timestamp',
    !text.includes('session=secret') && !text.includes('Agree and continue') && !text.includes('arbitration') && !text.includes('startedAt') && !text.includes('"ts"') && built.report.episode.day && built.report.episode.local === undefined);
  ok('document urls lose their query strings', built.report.episode.stages.fetch.documentUrls[0] === 'https://chase.com/terms');
  ok('the report validates as uploadable against the schema', E.validateEpisode(built.report.episode, { uploadable: true }).valid);
  ok('a non-string receipt is dropped', C.buildCommunityReport(liveEvents(), { analysisReceipt: 42 }).report.analysisReceipt === undefined);
  ok('batch and replay episodes are never reported', !C.buildCommunityReport(liveEvents('1111111111111111', 'batch')).ok && !C.buildCommunityReport(liveEvents('2222222222222222', 'replay')).ok);
  ok('no events means no report', !C.buildCommunityReport([]).ok);

  ok('outcomes are described', /accepted \(receipt-bound, site proposal recorded\)/.test(C.describeCommunityOutcome({ accepted: true, receiptBound: true, proposal: 'recorded' })) && /not accepted: too old/.test(C.describeCommunityOutcome({ accepted: false, reason: 'too old' })) && /No answer/.test(C.describeCommunityOutcome(null)));

  console.log(`\nSummary: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
