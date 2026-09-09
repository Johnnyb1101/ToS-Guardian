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

  {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      const body = String((options && options.body) || '');
      const text = body.includes('"operation":"critic"')
        ? '{"dataCollection":"grounded","dataSelling":"unsupported","optOutRights":"grounded","howToOptOut":"vague","autoRenewal":"skipped","dataDeletion":"grounded","flags":["sharing overstated"]}'
        : 'SUMMARY FROM FAKE PROXY';
      const data = { text, stopReason: 'end_turn', model: 'claude-sonnet-4-6', provider: 'anthropic', usage: { inputTokens: 900, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => data, text: async () => JSON.stringify(data) };
    };
    try {
      const captured = createPipelineHost({ proxyUrl: 'http://127.0.0.1:9', critic: true });
      const state = captured.newRunState();
      await captured.run(state, async () => {
        const returned = await captured.context.analyzeWithModel('=== PRIVACY POLICY ===\nWe share data with affiliates.', 'https://x.example/privacy', false);
        returned.summary = '<div class="tg-eval-warning">rewritten by the orchestrator</div>';
        const verdict = await captured.context.runCritic('SUMMARY FROM FAKE PROXY', '=== PRIVACY POLICY ===\nWe share data with affiliates.');
        verdict.dataSelling = 'grounded';
      });
      ok('analyzer results are captured on the run with their escalation flag',
        state.analyses.length === 1 && state.analyses[0].escalated === false && state.analyses[0].result.summary === 'SUMMARY FROM FAKE PROXY' && state.analyses[0].result.status === 'ok',
        JSON.stringify(state.analyses.map(a => a.result && a.result.summary)));
      ok('captured results are snapshots, untouched by later rewrites', state.analyses[0].result.summary === 'SUMMARY FROM FAKE PROXY' && state.critics[0].dataSelling === 'unsupported');
      ok('critic verdicts are captured on the run', state.critics.length === 1 && state.critics[0] && state.critics[0].dataSelling === 'unsupported', JSON.stringify(state.critics));
      ok('proxy usage is recorded for both calls', state.llmCalls === 2 && state.usage.length === 2 && state.usage.every(u => u.model === 'claude-sonnet-4-6' && u.input === 900), JSON.stringify(state.usage));
      const criticOff = createPipelineHost({ proxyUrl: 'http://127.0.0.1:9', critic: false });
      const quiet = criticOff.newRunState();
      await criticOff.run(quiet, async () => { await criticOff.context.runCritic('s', 't'); });
      ok('a disabled critic records nothing', quiet.critics.length === 0 && quiet.llmCalls === 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  const stateA = host.newRunState();
  const stateB = host.newRunState();
  await host.run(stateA, async () => { ctx.observerSink({ stage: 'a' }); ctx.console.log('from A'); });
  await host.run(stateB, async () => { ctx.observerSink({ stage: 'b' }); });
  ok('observer events land on the run that produced them', stateA.events.length === 1 && stateA.events[0].stage === 'a' && stateB.events.length === 1 && stateB.events[0].stage === 'b');
  ok('pipeline console output is captured per run and streamed to onLog', stateA.logs.length === 1 && /from A/.test(stateA.logs[0]) && logs.some(l => /from A/.test(l)) && stateB.logs.length === 0);
  ok('an event outside any run is dropped, not attributed to a stale run', (ctx.observerSink({ stage: 'x' }), stateA.events.length === 1 && stateB.events.length === 1));

  const stateC = host.newRunState();
  await host.run(stateC, async () => { await ctx.browser.storage.local.set({ tosGuardianLastResult: { domain: 'example.com', score: 50 }, other: 1 }); });
  ok('tosGuardianLastResult is captured on the run and kept out of storage', stateC.lastResult && stateC.lastResult.score === 50 && host.storageData.tosGuardianLastResult === undefined && host.storageData.other === 1);

  const got = await ctx.browser.storage.local.get({ missing: 'default', other: 0 });
  ok('storage.get honors defaults for missing keys only', got.missing === 'default' && got.other === 1);

  const controller = new AbortController();
  let timedOut = false;
  try { await withTimeout(new Promise(() => {}), 20, controller); } catch (e) { timedOut = /timed out/.test(e.message); }
  ok('withTimeout rejects and aborts the controller', timedOut && controller.signal.aborted);
  const fast = await withTimeout(Promise.resolve('done'), 1000, new AbortController());
  ok('withTimeout passes a prompt result through', fast === 'done');

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
