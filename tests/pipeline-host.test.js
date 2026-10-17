const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EXTENSION_FILES, POLICY_SOURCE_FILES, createPipelineHost, withTimeout, sitesFromInputs, domainsFromInputs } = require('../tools/pipeline-host');

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
  ok('content and manifest are fingerprinted without executing them in the VM',
    POLICY_SOURCE_FILES.includes('content.js') && POLICY_SOURCE_FILES.includes('manifest.json') &&
    !EXTENSION_FILES.includes('content.js') && !EXTENSION_FILES.includes('manifest.json'));
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
  ok('policy fingerprint input contains every original extension source in order before URL rewriting',
    JSON.stringify(Object.keys(ctx.__TG_POLICY_SOURCES)) === JSON.stringify(POLICY_SOURCE_FILES) &&
    ctx.__TG_POLICY_SOURCES['background.js'] === fs.readFileSync(path.join(repoRoot, 'background.js'), 'utf8') &&
    ctx.__TG_POLICY_SOURCES['background.js'].includes('PROXY_URL'));
  {
    const policyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-policy-sources-'));
    try {
      for (const file of POLICY_SOURCE_FILES) {
        const destination = path.join(policyRoot, file);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, file), destination);
      }
      const evaluatorPath = path.join(policyRoot, 'evaluator.js');
      fs.writeFileSync(evaluatorPath, fs.readFileSync(evaluatorPath, 'utf8').replace(/\r?\n/g, '\r\n'));
      const normalizedHost = createPipelineHost({ proxyUrl: 'http://127.0.0.1:9', repoRoot: policyRoot });
      ok('line ending differences do not change the packaged policy fingerprint', await normalizedHost.clientPolicyHash === await host.clientPolicyHash);
      fs.appendFileSync(evaluatorPath, '\r\n// policy fingerprint regression fixture\r\n');
      const changedHost = createPipelineHost({ proxyUrl: 'http://127.0.0.1:9', repoRoot: policyRoot });
      ok('a source-only change outside the old function list changes the policy fingerprint', await changedHost.clientPolicyHash !== await host.clientPolicyHash);
      fs.copyFileSync(path.join(repoRoot, 'evaluator.js'), evaluatorPath);
      for (const file of ['content.js', 'manifest.json']) {
        const target = path.join(policyRoot, file);
        fs.appendFileSync(target, '\n');
        const changed = createPipelineHost({ proxyUrl: 'http://127.0.0.1:9', repoRoot: policyRoot });
        ok(`${file} source changes alter the policy fingerprint`, await changed.clientPolicyHash !== await host.clientPolicyHash);
        fs.copyFileSync(path.join(repoRoot, file), target);
      }
    } finally {
      fs.rmSync(policyRoot, { recursive: true, force: true });
    }
  }
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
      const request = body ? JSON.parse(body) : {};
      const data = { text, promptHash: 'a'.repeat(64), lessonsHash: 'b'.repeat(64), docType: 'financial', configHash: request.configHash || 'c'.repeat(64), releaseToken: 'signed-test-token', stopReason: 'end_turn', model: 'claude-sonnet-4-6', provider: 'anthropic', usage: { inputTokens: 900, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0 } };
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
      ok('analyzer prompt and fixed critic identity come from actual proxy responses', state.analyses[0].result.promptHash === 'a'.repeat(64) && state.evidence.length === 2 && state.evidence[1].operation === 'critic' && state.evidence[1].provider === 'anthropic' && state.evidence[1].promptHash === 'a'.repeat(64) && state.evidence[1].lessonsHash === 'b'.repeat(64));
      const capturedPolicyHash = await captured.clientPolicyHash;
      ok('captured client policy hash is computed before host stubs replace runtime functions', /^[a-f0-9]{64}$/.test(capturedPolicyHash) && state.evidence.every(e => e.clientPolicyHash === capturedPolicyHash));
      const seen = [];
      const realFetchForPin = globalThis.fetch;
      globalThis.fetch = async (url, options) => { seen.push(JSON.parse(options.body)); return realFetchForPin(url, options); };
      const configHash = 'c'.repeat(64);
      const pinned = createPipelineHost({ proxyUrl: 'http://127.0.0.1:9', critic: true, configHash });
      const pinState = pinned.newRunState();
      await pinned.run(pinState, async () => {
        await pinned.context.analyzeWithModel('=== PRIVACY POLICY ===\nWe share data with affiliates.', 'https://x.example/privacy', false);
        await pinned.context.runCritic('SUMMARY FROM FAKE PROXY', '=== PRIVACY POLICY ===\nWe share data with affiliates.');
      });
      globalThis.fetch = realFetchForPin;
      ok('a complete configHash is pinned onto analyzer and critic requests', seen.length === 2 && seen.every(b => b.configHash === configHash) && pinState.evidence.every(e => e.configHash === configHash), JSON.stringify(seen.map(b => b.configHash)));
      ok('legacy per-lesson host selection is refused', (() => { try { createPipelineHost({ proxyUrl: 'http://127.0.0.1:9', lessonSet: { ids: ['lsn_0123456789abcdef'] } }); return false; } catch (error) { return /Per-lesson host selection/.test(error.message); } })());
      const wrongResponseFetch = globalThis.fetch;
      globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ configHash: 'd'.repeat(64) }) });
      const mismatchHost = createPipelineHost({ proxyUrl: 'http://127.0.0.1:9', configHash });
      let mismatch = null;
      try { await mismatchHost.run(mismatchHost.newRunState(), () => mismatchHost.context.fetch('http://127.0.0.1:9/v2/analyze', { method: 'POST', body: JSON.stringify({ operation: 'analyzer' }) })); } catch (error) { mismatch = error; }
      globalThis.fetch = wrongResponseFetch;
      ok('a successful proxy response with another configHash is refused before evidence capture', mismatch && /configHash mismatch/.test(mismatch.message));
      const policyPinned = createPipelineHost({ proxyUrl: 'http://127.0.0.1:9', configHash, expectedClientPolicyHash: 'e'.repeat(64) });
      let wrongPolicy = null;
      try { await policyPinned.run(policyPinned.newRunState(), () => policyPinned.context.fetch('http://127.0.0.1:9/v2/analyze', { method: 'POST', body: JSON.stringify({ operation: 'critic', clientPolicyHash: 'f'.repeat(64) }) })); } catch (error) { wrongPolicy = error; }
      ok('client pipeline policy mismatch is refused before a proxy call', wrongPolicy && /Client pipeline policy hash mismatch/.test(wrongPolicy.message));
      const headersSeen = [];
      const realFetchForTag = globalThis.fetch;
      globalThis.fetch = async (url, options) => { headersSeen.push(options.headers || {}); return realFetchForTag(url, options); };
      const tagged = createPipelineHost({ proxyUrl: 'http://127.0.0.1:9', critic: false, runTag: 'treat-x' });
      const tagState = tagged.newRunState();
      await tagged.run(tagState, async () => { await tagged.context.analyzeWithModel('=== PRIVACY POLICY ===\nWe share data with affiliates.', 'https://x.example/privacy', false); });
      globalThis.fetch = realFetchForTag;
      ok('a run tag travels as the X-Trainer-Run header', headersSeen.length === 1 && headersSeen[0]['X-Trainer-Run'] === 'treat-x', JSON.stringify(headersSeen));
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
