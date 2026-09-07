// TOS Guardian — episode schema tests (episode.js, tools/report-lib.js)
// Run: node tests/episode.test.js
//
// Pins the contract every producer and consumer of episodes shares: ids,
// per-stage allowlists, the recorder's no-op-when-disabled rule, assembly,
// and above all the zero-user-data rule that stripLocal() and the uploadable
// validator enforce. The report builder is checked against a fixture.

const path = require('path');
const vm = require('vm');
const fs = require('fs');
const E = require('../episode');
const { buildReport, attentionReasons } = require('../tools/report-lib');

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (condition) { console.log(`  ok    ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

console.log('Episode schema');

// --- ids and versions ----------------------------------------------------------
ok('schema version is 1', E.EPISODE_SCHEMA_VERSION === 1);
ok('new ids are 16 hex chars', E.isEpisodeId(E.newEpisodeId()));
ok('two ids differ', E.newEpisodeId() !== E.newEpisodeId());
ok('id validator rejects short, long, and uppercase', !E.isEpisodeId('abc') && !E.isEpisodeId('0'.repeat(17)) && !E.isEpisodeId('A'.repeat(16)));

// --- the file also loads as a classic script (importScripts / vm) ----------------
{
  const ctx = { console, URL };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'episode.js'), 'utf8'), ctx, { filename: 'episode.js' });
  ok('loads as a classic script and exposes the recorder as a global', typeof ctx.createEpisodeRecorder === 'function' && vm.runInContext('typeof OBSERVER_DEFAULT_PORT', ctx) === 'number');
}

// --- per-stage validation ------------------------------------------------------
ok('valid fetch data passes', E.validateEventData('fetch', { path: 'known-urls', looksLegal: true, textChars: 62091, textHash: 'deadbeef', documentUrls: ['https://discord.com/privacy'] }).valid);
ok('unknown stage fails', !E.validateEventData('teleport', {}).valid);
ok('unknown field fails closed', !E.validateEventData('fetch', { path: 'known-urls', pageText: 'private stuff' }).valid);
ok('enum outside the list fails', !E.validateEventData('fetch', { path: 'guessing' }).valid);
ok('negative count fails', !E.validateEventData('fetch', { textChars: -1 }).valid);
ok('URL with credentials fails', !E.validateEventData('fetch', { documentUrls: ['https://user:pw@discord.com/privacy'] }).valid);
ok('non-http URL fails', !E.validateEventData('fetch', { documentUrls: ['javascript:alert(1)'] }).valid);
ok('critic verdict object accepts only known fields and values',
  E.validateEventData('critic', { verdicts: { dataSelling: 'grounded' } }).valid &&
  !E.validateEventData('critic', { verdicts: { dataSelling: 'maybe' } }).valid &&
  !E.validateEventData('critic', { verdicts: { flags: 'grounded' } }).valid);
ok('usage object accepts only token counters',
  E.validateEventData('analyze', { usage: { inputTokens: 10, outputTokens: 2 } }).valid &&
  !E.validateEventData('analyze', { usage: { inputTokens: 10, apiKey: 'x' } }).valid);
ok('overlong short string fails', !E.validateEventData('analyze', { model: 'x'.repeat(201) }).valid);
ok('domain must be lowercase registrable', E.validateEventData('relay', { domain: 'chase.com' }).valid && !E.validateEventData('relay', { domain: 'https://chase.com' }).valid);
ok('local layer accepts free text but only known keys',
  E.validateLocal({ pageUrl: 'https://x.com/a?token=1', controlLabel: 'Sign up', userAction: 'back' }).valid &&
  !E.validateLocal({ password: 'hunter2' }).valid);

// --- events ----------------------------------------------------------------------
{
  const id = E.newEpisodeId();
  const event = E.createEvent(id, 'scan', { injection: false, ignored: undefined }, { now: 1000, seq: 3, local: { note: 'n' } });
  ok('createEvent drops undefined fields and keeps local', event.data.ignored === undefined && event.local.note === 'n' && event.seq === 3 && event.ts === 1000);
  ok('validateEvent accepts a well-formed event', E.validateEvent(event).valid);
  ok('validateEvent rejects a bad id', !E.validateEvent({ ...event, episodeId: 'nope' }).valid);
  ok('validateEvent rejects extra top-level keys', !E.validateEvent({ ...event, ip: '1.2.3.4' }).valid);
}

// --- recorder ----------------------------------------------------------------------
{
  let sinkCalls = 0;
  const off = E.createEpisodeRecorder({ enabled: false, sink: () => { sinkCalls++; } });
  const result = off.record('scan', { injection: true });
  ok('disabled recorder records nothing and never calls the sink', result === null && off.events.length === 0 && sinkCalls === 0);
}
{
  const invalid = [];
  const sunk = [];
  let t = 5000;
  const rec = E.createEpisodeRecorder({ enabled: true, episodeId: '0123456789abcdef', now: () => t++, sink: e => sunk.push(e), onInvalid: (stage, errors) => invalid.push({ stage, errors }) });
  rec.record('relay', { domain: 'chase.com', siteLookup: 'static', mode: 'live' });
  rec.record('fetch', { path: 'known-urls', secret: 'x' });
  rec.record('scan', { injection: false });
  ok('enabled recorder keeps the given id', rec.id === '0123456789abcdef');
  ok('valid events reach the sink in order with increasing seq', sunk.length === 2 && sunk[0].stage === 'relay' && sunk[1].stage === 'scan' && sunk[0].seq === 0 && sunk[1].seq === 2);
  ok('invalid event is dropped and reported, never thrown', invalid.length === 1 && invalid[0].stage === 'fetch' && rec.events.length === 2);
  const throwing = E.createEpisodeRecorder({ enabled: true, sink: () => { throw new Error('collector down'); } });
  let threw = false;
  try { throwing.record('scan', { injection: false }); } catch (e) { threw = true; }
  ok('a failing sink never surfaces to the pipeline', !threw && throwing.events.length === 1);
}

// --- assembly ----------------------------------------------------------------------
const fixtureId = 'fedcba9876543210';
const fixtureEvents = [
  E.createEvent(fixtureId, 'trigger', { source: 'click', branch: 'password-field', controlTag: 'button', authForm: true, passwordField: true, knownDomain: true, frame: false }, { now: 1000, local: { pageUrl: 'https://login.chase.com/signin?token=abc', controlLabel: 'Sign in' } }),
  E.createEvent(fixtureId, 'relay', { domain: 'chase.com', siteLookup: 'static', deduped: false, mode: 'live' }, { now: 1010 }),
  E.createEvent(fixtureId, 'fetch', { path: 'known-urls', tosFound: true, privacyFound: true, supplementalCount: 1, textChars: 62091, textHash: 'deadbeef', looksLegal: true, unreadablePdfCount: 0, documentUrls: ['https://chase.com/privacy?lang=en#top', 'https://chase.com/terms'], hiddenTabHits: 1, proxyHits: 1, attempts: 2, retried: false }, { now: 4000 }),
  E.createEvent(fixtureId, 'cache', { read: 'miss' }, { now: 4100 }),
  E.createEvent(fixtureId, 'scan', { injection: false }, { now: 4110 }),
  E.createEvent(fixtureId, 'links', { candidates: 3, followed: 1, displayed: 2 }, { now: 5000 }),
  E.createEvent(fixtureId, 'analyze', { provider: 'anthropic', model: 'claude-sonnet-4-6', escalated: false, inputChars: 61000, stopReason: 'end_turn', usage: { inputTokens: 16000, outputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0 }, status: 'ok', receipt: true, summaryHash: '01234567', retried: false }, { now: 12000 }),
  E.createEvent(fixtureId, 'critic', { ran: true, failed: false, verdicts: { dataCollection: 'grounded', dataSelling: 'grounded', optOutRights: 'vague', howToOptOut: 'grounded', autoRenewal: 'skipped', dataDeletion: 'grounded' }, flagCount: 1, adjustmentCount: 0, receipt: true, model: 'claude-sonnet-4-6', stopReason: 'end_turn', usage: { inputTokens: 20000, outputTokens: 300 } }, { now: 18000, local: { flagsText: ['optOutRights: says check settings without specifics'] } }),
  E.createEvent(fixtureId, 'evaluate', { score: 90, label: 'Adequate', issues: ['critic: optOutRights too vague'], contradictions: 0, thinSourceCap: false, criticCap: false, escalate: true }, { now: 18010 }),
  E.createEvent(fixtureId, 'escalate', { attempted: false, capReached: true, reason: 'cap' }, { now: 18020 }),
  E.createEvent(fixtureId, 'verdict', { risk: 'Moderate', label: 'Adequate', score: 90, retrievalFailure: false, cached: false, optOutLinks: 2, unreadableDocs: 0 }, { now: 18030, local: { bottomLine: 'They share data with affiliates.' } }),
  E.createEvent(fixtureId, 'end', { durationMs: 17030, ok: true }, { now: 18030 }),
  E.createEvent(fixtureId, 'write', { attempted: true, result: 'written' }, { now: 18500 }),
  E.createEvent(fixtureId, 'render', { shown: true, sections: 6, optOutLinksShown: 2, unreadableShown: 0, risk: 'Moderate', confidenceLabel: 'Adequate', error: 'none', retry: false }, { now: 18600 }),
  E.createEvent(fixtureId, 'render', { shown: true }, { now: 25000, local: { userAction: 'back' } })
];
ok('every fixture event validates', fixtureEvents.every(e => E.validateEvent(e).valid), fixtureEvents.map(e => E.validateEvent(e).errors.join('; ')).filter(Boolean).join(' | '));

const episode = E.assembleEpisode(fixtureEvents);
ok('assembles one episode from one id', episode && episode.episodeId === fixtureId && episode.eventCount === fixtureEvents.length);
ok('later render event merges over the earlier one and keeps its fields', episode.stages.render.sections === 6 && episode.local.render.userAction === 'back');
ok('domain and mode derive from the relay stage', episode.domain === 'chase.com' && episode.mode === 'live');
ok('duration prefers the end stage figure', episode.durationMs === 17030);
ok('timeline is sorted by time', episode.timeline.every((t, i, arr) => i === 0 || arr[i - 1].ts <= t.ts));
ok('local layer is kept on the assembled episode', episode.local.trigger.pageUrl.includes('token=abc'));
ok('assembled episode validates as local', E.validateEpisode(episode).valid, E.validateEpisode(episode).errors.join('; '));
ok('assembled episode does NOT validate as uploadable', !E.validateEpisode(episode, { uploadable: true }).valid);

{
  const two = E.assembleEpisodes([...fixtureEvents, E.createEvent('1111111111111111', 'trigger', { source: 'batch' }, { now: 1 })]);
  ok('assembleEpisodes separates ids and infers batch mode', two.length === 2 && two[1].mode === 'batch');
}
{
  // Phase 1: replays of frozen reference sources are their own mode.
  const replayId = '3333333333333333';
  const replay = E.assembleEpisode([
    E.createEvent(replayId, 'trigger', { source: 'replay', branch: 'replay', controlTag: 'other' }, { now: 10 }),
    E.createEvent(replayId, 'relay', { domain: 'chase.com', siteLookup: 'none', mode: 'replay', sample: 2 }, { now: 11 }),
    E.createEvent(replayId, 'fetch', { path: 'frozen', looksLegal: true, textChars: 5000, textHash: 'cafebabe' }, { now: 12 })
  ]);
  ok('replay episode validates with replay mode, a sample index, and the frozen path', E.validateEpisode(replay).valid && replay.mode === 'replay' && replay.stages.relay.sample === 2, E.validateEpisode(replay).errors.join('; '));
  ok('replay mode survives stripLocal and validates as uploadable', E.validateEpisode(E.stripLocal(replay), { uploadable: true }).valid);
  ok('an unknown mode is rejected', !E.validateEpisode({ ...replay, mode: 'dream' }).valid);
}

// --- the zero-user-data rule, in code -------------------------------------------------
const uploadable = E.stripLocal(episode);
{
  const check = E.validateEpisode(uploadable, { uploadable: true });
  ok('stripLocal yields a record that validates as uploadable', check.valid, check.errors.join('; '));
}
ok('uploadable record has no local layer', uploadable.local === undefined);
ok('uploadable record has no timestamps finer than a day', uploadable.startedAt === undefined && uploadable.endedAt === undefined && uploadable.timeline === undefined && uploadable.day === '1970-01-01');
ok('uploadable document URLs lose query strings and fragments', uploadable.stages.fetch.documentUrls.includes('https://chase.com/privacy') && !JSON.stringify(uploadable).includes('lang=en'));
ok('uploadable record carries no page URL, label, user action, flag text, or bottom line',
  !JSON.stringify(uploadable).includes('token=abc') && !JSON.stringify(uploadable).includes('Sign in') &&
  !JSON.stringify(uploadable).includes('back') && !JSON.stringify(uploadable).includes('check settings') &&
  !JSON.stringify(uploadable).includes('affiliates'));
ok('stripLocal does not mutate the original', episode.local !== undefined && episode.startedAt !== null);
{
  const tampered = JSON.parse(JSON.stringify(uploadable));
  tampered.stages.fetch.text = 'a copy of the document';
  ok('a text field smuggled into an uploadable record is rejected', !E.validateEpisode(tampered, { uploadable: true }).valid);
  const nested = JSON.parse(JSON.stringify(uploadable));
  nested.stages.analyze.usage.email = 'x@y.z';
  ok('a forbidden key nested anywhere is rejected', !E.validateEpisode(nested, { uploadable: true }).valid);
  const withTime = JSON.parse(JSON.stringify(uploadable));
  withTime.startedAt = '2026-09-06T16:00:00.000Z';
  ok('a precise timestamp on an uploadable record is rejected', !E.validateEpisode(withTime, { uploadable: true }).valid);
}
ok('forbidden key list covers the local-layer field names', Object.keys(E.LOCAL_FIELDS).every(k => E.FORBIDDEN_UPLOAD_KEYS.includes(k)));

// --- report builder --------------------------------------------------------------------
{
  const cachedId = '2222222222222222';
  const cached = E.assembleEpisode([
    E.createEvent(cachedId, 'trigger', { source: 'batch', branch: 'batch', controlTag: 'other' }, { now: 100 }),
    E.createEvent(cachedId, 'relay', { domain: 'discord.com', siteLookup: 'static', mode: 'batch' }, { now: 110 }),
    E.createEvent(cachedId, 'fetch', { path: 'known-urls', looksLegal: false, textChars: 400 }, { now: 900 }),
    E.createEvent(cachedId, 'cache', { read: 'hit', similarity: 0.97 }, { now: 950 }),
    E.createEvent(cachedId, 'verdict', { risk: 'Low', label: 'Cached', score: 100, cached: true }, { now: 960 }),
    E.createEvent(cachedId, 'end', { durationMs: 860, ok: true }, { now: 960 })
  ]);
  const report = buildReport([episode, cached], { title: 'Fixture report' });
  ok('report has a title and episode count', report.startsWith('# Fixture report') && report.includes('Episodes: 2'));
  ok('report shows the trigger branch for live episodes', report.includes('password-field'));
  ok('report shows fetch path distribution', report.includes('known-urls 2'));
  ok('report shows cache outcomes', report.includes('hit 1') && report.includes('miss 1'));
  ok('report shows the critic concern by section', report.includes('optOutRights 1'));
  ok('report prices the episode from its usage', /Estimated cost: \$0\.1[0-9]{3}/.test(report));
  ok('report flags the episode whose fetched text was not a legal document', /discord\.com at \d\d:\d\d UTC: fetched text is not a legal document/.test(report));
  ok('report table has one row per episode', (report.match(/^\| (chase\.com|discord\.com) \|/gm) || []).length === 2);
  ok('attention reasons name the cap-blocked escalation only when relevant', attentionReasons(episode).length === 0);
  ok('empty report is honest', buildReport([]).includes('No episodes.'));
}

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
