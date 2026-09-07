// TOS Guardian — pipeline host tests (tools/pipeline-host.js)
// Run: node tests/pipeline-host.test.js
//
// The host is the one definition of "the extension running headlessly in a
// vm" shared by the batch runner, the reference freezer, and the replayer.
// These tests pin the parts that do not need a network: the file list, the
// overrides, the per-run state, and the site-list parser.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EXTENSION_FILES, createPipelineHost, withTimeout, sitesFromInputs, domainsFromInputs } = require('../tools/pipeline-host');

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (condition) { console.log(`  ok    ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

(async () => {
  console.log('Pipeline host');

  const repoRoot = path.resolve(__dirname, '..');
  ok('every extension file the host loads exists', EXTENSION_FILES.every(f => fs.existsSync(path.join(repoRoot, f))));
  ok('episode.js is loaded before the orchestrator', EXTENSION_FILES.indexOf('episode.js') < EXTENSION_FILES.indexOf('orchestrator.js'));

  let threw = null;
  try { createPipelineHost({}); } catch (e) { threw = e; }
  ok('host refuses to start without an explicit proxy URL', !!threw && /proxyUrl/.test(threw.message));
  threw = null;
  try { createPipelineHost({ proxyUrl: 'localhost:3000' }); } catch (e) { threw = e; }
  ok('host refuses a proxy URL without a scheme', !!threw);

  const logs = [];
  const host = createPipelineHost({ proxyUrl: 'http://127.0.0.1:9', cache: false, write: false, critic: false, onLog: l => logs.push(l) });
  const ctx = host.context;
  ok('the real pipeline entry points are loaded', typeof ctx.runOrchestrator === 'function' && typeof ctx.fetcherAgent === 'function' && typeof ctx.linkFollowerStub === 'function');
  ok('the proxy URL override landed in background.js', vm.runInContext('PROXY_URL', ctx) === 'http://127.0.0.1:9');
  ok('cache reads are disabled when cache is off', (await ctx.readFromSupabase('example.com', '')) === null);
  ok('cache and learned-site writes are disabled when write is off', (await ctx.writeToSupabase('example.com', {}, 'anthropic')) === null && (await ctx.learnSite('https://example.com/', 'a', 'b')) === null);
  ok('the critic is disabled when critic is off', (await ctx.runCritic({}, '')) === null);
  ok('escalation cap is pre-exhausted by default', host.storageData.opusEscalationData && host.storageData.opusEscalationData.count === 5);

  const withEscalation = createPipelineHost({ proxyUrl: 'http://127.0.0.1:9', escalate: true });
  ok('escalation cap is untouched when escalate is on', withEscalation.storageData.opusEscalationData === undefined);

  // The hidden-tab stand-in mirrors the extension's minimum-length gate: a
  // hidden tab never resolves with 500 characters or fewer, it returns null so
  // the fetcher falls through to the proxy.
  {
    const realFetch = globalThis.fetch;
    let body = '';
    globalThis.fetch = async () => ({ ok: true, headers: { get: () => 'text/html; charset=utf-8' }, text: async () => body });
    try {
      const gated = createPipelineHost({ proxyUrl: 'http://127.0.0.1:9' });
      body = '<html><body><div id="app"></div><script>boot()</script></body></html>';
      ok('a JavaScript shell shorter than the gate is rejected as a hidden tab would', (await gated.context.fetchWithHiddenTab('https://x.example/terms')) === null);
      body = '<html><body><h1>Terms of Service</h1><p>' + 'These terms govern your use of the service. '.repeat(20) + '</p></body></html>';
      const doc = await gated.context.fetchWithHiddenTab('https://x.example/terms');
      ok('a real document passes the gate with text and html', !!doc && doc.text.length > 500 && doc.html === body, doc ? String(doc.text.length) : 'null');
      body = '';
      ok('an empty body is rejected', (await gated.context.fetchWithHiddenTab('https://x.example/terms')) === null);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // Per-run state: episode events and console output are captured for the run
  // that produced them, never leaked across runs.
  const stateA = host.newRunState();
  const stateB = host.newRunState();
  await host.run(stateA, async () => { ctx.observerSink({ stage: 'a' }); ctx.console.log('from A'); });
  await host.run(stateB, async () => { ctx.observerSink({ stage: 'b' }); });
  ok('observer events land on the run that produced them', stateA.events.length === 1 && stateA.events[0].stage === 'a' && stateB.events.length === 1 && stateB.events[0].stage === 'b');
  ok('pipeline console output is captured per run and streamed to onLog', stateA.logs.length === 1 && /from A/.test(stateA.logs[0]) && logs.some(l => /from A/.test(l)) && stateB.logs.length === 0);
  ok('an event outside any run is dropped, not attributed to a stale run', (ctx.observerSink({ stage: 'x' }), stateA.events.length === 1 && stateB.events.length === 1));

  // The dev test recorder's result is captured per run and not persisted.
  const stateC = host.newRunState();
  await host.run(stateC, async () => { await ctx.browser.storage.local.set({ tosGuardianLastResult: { domain: 'example.com', score: 50 }, other: 1 }); });
  ok('tosGuardianLastResult is captured on the run and kept out of storage', stateC.lastResult && stateC.lastResult.score === 50 && host.storageData.tosGuardianLastResult === undefined && host.storageData.other === 1);

  const got = await ctx.browser.storage.local.get({ missing: 'default', other: 0 });
  ok('storage.get honors defaults for missing keys only', got.missing === 'default' && got.other === 1);

  // withTimeout aborts the run's controller so in-flight fetches stop too.
  const controller = new AbortController();
  let timedOut = false;
  try { await withTimeout(new Promise(() => {}), 20, controller); } catch (e) { timedOut = /timed out/.test(e.message); }
  ok('withTimeout rejects and aborts the controller', timedOut && controller.signal.aborted);
  const fast = await withTimeout(Promise.resolve('done'), 1000, new AbortController());
  ok('withTimeout passes a prompt result through', fast === 'done');

  // Site list parsing.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-host-'));
  const listPath = path.join(dir, 'sites.txt');
  fs.writeFileSync(listPath, '# financial\nchase.com\nhttps://www.capitalone.com/path # trailing comment\n\nchase.com\nnot a domain at all\n', 'utf8');
  const warnings = [];
  const domains = domainsFromInputs([listPath, 'discord.com', 'https://reddit.com/x'], w => warnings.push(w));
  ok('site lists strip comments, blanks, and duplicates and accept literals', JSON.stringify(domains) === JSON.stringify(['chase.com', 'www.capitalone.com', 'discord.com', 'reddit.com']), JSON.stringify(domains));
  ok('unparseable entries are reported, not thrown', warnings.length === 1 && /not a domain at all/.test(warnings[0]));

  fs.writeFileSync(listPath, '# preamble comment\nplain.example\n# type: financial\nchase.com # bank\n# a note that is not a type header\nsofi.com\n# type: Social\nreddit.com\nchase.com\n', 'utf8');
  const typed = sitesFromInputs([listPath, 'literal.example']);
  ok('type headers apply to the entries that follow them, other comments do not reset them',
    JSON.stringify(typed) === JSON.stringify([
      { domain: 'plain.example', type: null }, { domain: 'chase.com', type: 'financial' }, { domain: 'sofi.com', type: 'financial' },
      { domain: 'reddit.com', type: 'social' }, { domain: 'literal.example', type: null }
    ]), JSON.stringify(typed));
  ok('domainsFromInputs is the same list without types', JSON.stringify(domainsFromInputs([listPath])) === JSON.stringify(['plain.example', 'chase.com', 'sofi.com', 'reddit.com']));
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\nSummary: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
