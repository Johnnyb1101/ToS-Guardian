const fs = require('fs');
const path = require('path');
const vm = require('vm');

const repoRoot = path.resolve(__dirname, '..');
let passed = 0;
let failed = 0;
let storageData = { selectedProvider: 'anthropic' };
const requests = [];
const responses = [];
let backgroundListener;
let activeTab = { id: 7, url: 'https://login.chase.com/signin' };

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}${detail ? `: ${detail}` : ''}`);
  }
}

const storage = {
  get(keys, callback) {
    const result = {};
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) result[key] = storageData[key];
    if (callback) callback(result);
    return Promise.resolve(result);
  },
  set(items, callback) {
    Object.assign(storageData, items);
    if (callback) callback();
    return Promise.resolve();
  },
  remove(keys, callback) {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete storageData[key];
    if (callback) callback();
    return Promise.resolve();
  }
};

const context = {
  console: { log() {}, warn() {}, error() {} },
  URL,
  Date,
  setTimeout,
  clearTimeout,
  importScripts() {},
  fetch: async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const data = responses.shift();
    if (!data) throw new Error('Unexpected fetch');
    return {
      ok: data.status >= 200 && data.status < 300,
      status: data.status,
      json: async () => data.body
    };
  },
  browser: {
    storage: { local: storage },
    tabs: {
      query(_query, callback) {
        callback(activeTab ? [activeTab] : []);
      }
    },
    runtime: {
      id: 'extension-test-id',
      getURL(pathname) { return `chrome-extension://extension-test-id/${pathname}`; },
      onMessage: { addListener(listener) { backgroundListener = listener; } },
      lastError: null
    }
  }
};

vm.createContext(context);
for (const file of ['vendor/tldts-7.4.8.umd.min.js', 'tosUtils.js', 'critic.js', 'episode.js', 'background.js']) {
  vm.runInContext(fs.readFileSync(path.join(repoRoot, file), 'utf8'), context, { filename: file });
}

const backgroundTextLimit = vm.runInContext('MAX_BACKGROUND_TEXT_CHARS', context);
const backgroundHtmlLimit = vm.runInContext('MAX_BACKGROUND_HTML_CHARS', context);

const orchestratorCalls = [];
const lookupCalls = [];
context.runOrchestrator = async (...args) => {
  orchestratorCalls.push(args);
  return { summary: 'trusted analysis' };
};
context.lookupSite = async (url) => {
  lookupCalls.push(url);
  return null;
};
const observerEvents = [];
context.observerSink = (event) => { observerEvents.push(event); };

function sendBackground(request, sender) {
  return new Promise(resolve => backgroundListener(request, sender, resolve));
}

const contentSender = {
  id: 'extension-test-id',
  tab: { id: 7, url: 'https://login.chase.com/signin' },
  url: 'https://login.chase.com/signin',
  frameId: 0
};
const popupSender = {
  id: 'extension-test-id',
  url: 'chrome-extension://extension-test-id/popup.html'
};

(async () => {
  console.log('Keyless constrained proxy contract');

  responses.push({ status: 200, body: { text: 'Analyzer output', model: 'server-model', stopReason: 'end_turn', analysisReceipt: 'analysis-token' } });
  const analyzerResult = await context.analyzeWithModel(
    '=== PRIVACY POLICY ===\nThis policy collects an email address.',
    'https://example.com/privacy',
    true
  );
  const analyzerRequest = requests.shift();
  const analyzerBody = JSON.parse(analyzerRequest.options.body);

  check('Analyzer uses the constrained v2 endpoint', analyzerRequest.url.endsWith('/v2/analyze'), analyzerRequest.url);
  check('Analyzer sends the server-owned operation name', analyzerBody.operation === 'analyzer');
  check('Analyzer sends legal document text', /collects an email/.test(analyzerBody.documentText));
  check('Analyzer sends escalation intent', analyzerBody.escalate === true);
  check('Analyzer does not send a system prompt', !Object.prototype.hasOwnProperty.call(analyzerBody, 'system'));
  check('Analyzer does not send an arbitrary user prompt', !Object.prototype.hasOwnProperty.call(analyzerBody, 'user'));
  check('Analyzer does not send a model', !Object.prototype.hasOwnProperty.call(analyzerBody, 'model'));
  check('Analyzer does not send a token limit', !Object.prototype.hasOwnProperty.call(analyzerBody, 'maxTokens'));
  check('Analyzer sends no proxy credential header', !Object.keys(analyzerRequest.options.headers || {}).some(k => k.toLowerCase() === 'x-tg-proxy-key'));
  check('Analyzer response still reaches the caller', analyzerResult.summary === 'Analyzer output');
  check('Analyzer preserves the proxy analysis receipt', analyzerResult.analysisReceipt === 'analysis-token');
  check('Analyzer preserves the exact source sent to the proxy', /collects an email/.test(analyzerResult.analysisSource));

  responses.push({
    status: 200,
    body: {
      text: JSON.stringify({
        dataCollection: 'grounded',
        dataSelling: 'grounded',
        optOutRights: 'grounded',
        howToOptOut: 'grounded',
        autoRenewal: 'skipped',
        dataDeletion: 'grounded',
        flags: []
      }),
      model: 'server-model',
      stopReason: 'end_turn',
      writeReceipt: 'write-token'
    }
  });
  const criticResult = await context.runCritic(
    'Structured privacy analysis.',
    'Original legal source text describing privacy practices.'
  );
  const criticRequest = requests.shift();
  const criticBody = JSON.parse(criticRequest.options.body);

  check('Critic uses the constrained v2 endpoint', criticRequest.url.endsWith('/v2/analyze'), criticRequest.url);
  check('Critic sends the server-owned operation name', criticBody.operation === 'critic');
  check('Critic sends the analysis separately', criticBody.analysisSummary === 'Structured privacy analysis.');
  check('Critic sends source text separately', /Original legal source/.test(criticBody.sourceText));
  check('Critic does not send its system prompt', !Object.prototype.hasOwnProperty.call(criticBody, 'system'));
  check('Critic does not send an arbitrary user prompt', !Object.prototype.hasOwnProperty.call(criticBody, 'user'));
  check('Critic does not send a model or token limit', !Object.prototype.hasOwnProperty.call(criticBody, 'model') && !Object.prototype.hasOwnProperty.call(criticBody, 'maxTokens'));
  check('Critic sends no proxy credential header', !Object.keys(criticRequest.options.headers || {}).some(k => k.toLowerCase() === 'x-tg-proxy-key'));
  check('Critic response still parses', criticResult && criticResult.dataCollection === 'grounded');
  check('Critic preserves the proxy write receipt', criticResult?._writeReceipt === 'write-token');

  responses.push({
    status: 200,
    body: {
      text: JSON.stringify({
        dataCollection: 'grounded', dataSelling: 'grounded', optOutRights: 'grounded',
        howToOptOut: 'grounded', autoRenewal: 'skipped', dataDeletion: 'grounded', flags: []
      }),
      model: 'server-model', stopReason: 'end_turn', writeReceipt: 'bound-write-token'
    }
  });
  const cacheContext = {
    domain: 'acorns.com', sourceUrls: ['https://acorns.com/privacy'], optOutLinks: [],
    sourceFingerprint: 'a1b2c3d4', schemaVersion: 2, aiProvider: 'anthropic', privacyText: 'privacy text'
  };
  await context.runCritic('Canonical analysis.', 'Exact analyzer source.', {
    analysisReceipt: 'analysis-token', providerAnalysis: 'Provider analysis.', cacheContext
  });
  const provenanceCriticRequest = requests.shift();
  const provenanceCriticBody = JSON.parse(provenanceCriticRequest.options.body);
  check('Critic forwards the Analyzer receipt for proxy verification', provenanceCriticBody.analysisReceipt === 'analysis-token');
  check('Critic forwards the exact provider output for proxy verification', provenanceCriticBody.providerAnalysis === 'Provider analysis.');
  check('Critic binds the cache context into write authorization', provenanceCriticBody.cacheContext.domain === 'acorns.com');

  const oversizedCriticSource = [
    '=== TERMS OF SERVICE ===\n' + 't'.repeat(70000),
    '=== PRIVACY POLICY ===\n' + 'p'.repeat(70000),
    '=== SUPPLEMENTAL PRIVACY NOTICE: https://example.com/supplemental ===\n' + 's'.repeat(70000)
  ].join('\n');
  const criticExcerpt = context.buildCriticSourceExcerpt(oversizedCriticSource);
  check('Critic excerpt never exceeds the proxy source contract', criticExcerpt.length <= 100000, criticExcerpt.length);
  check('Critic excerpt preserves supplemental privacy material', criticExcerpt.includes('=== SUPPLEMENTAL PRIVACY NOTICE:'));

  responses.push({ status: 503, body: { error: 'provider_busy', reason: 'At capacity' } });
  const busyCritic = await context.runCritic('Structured privacy analysis.', 'Original legal source text.');
  requests.shift();
  check('Critic treats provider capacity as a failed verification', busyCritic?.failed === true);
  responses.push({ status: 503, body: { error: 'provider_not_configured', reason: 'No key' } });
  const unconfiguredCritic = await context.runCritic('Structured privacy analysis.', 'Original legal source text.');
  requests.shift();
  check('Critic only skips when the provider key is actually unconfigured', unconfiguredCritic === null);

  responses.push({ status: 503, body: { error: 'provider_busy', reason: 'At capacity' } });
  const busyAnalyzer = await context.analyzeWithModel('Privacy policy text.', 'https://example.com/privacy');
  requests.shift();
  check('Analyzer reports provider capacity without claiming the key is missing', /service busy/i.test(busyAnalyzer.summary));
  responses.push({ status: 429, body: { error: 'daily_limit_reached', reason: 'Daily limit' } });
  const dailyLimitedAnalyzer = await context.analyzeWithModel('Privacy policy text.', 'https://example.com/privacy');
  requests.shift();
  check('Analyzer distinguishes the daily safety circuit breaker', /daily analysis safety limit/i.test(dailyLimitedAnalyzer.summary));

  const writesBeforeSkip = requests.length;
  await context.writeToSupabase('acorns.com', 'Summary', 'anthropic', [], 'privacy text');
  check('Shared write is skipped without proxy provenance', requests.length === writesBeforeSkip);
  responses.push({ status: 200, body: { success: true } });
  await context.writeToSupabase('acorns.com', 'Final summary', 'anthropic', [], 'privacy text', {
    writeReceipt: 'write-token',
    analysisSummary: 'Canonical analysis.',
    cacheContext
  });
  const cacheWriteRequest = requests.shift();
  const cacheWriteBody = JSON.parse(cacheWriteRequest.options.body);
  check('Shared write carries its signed write receipt', cacheWriteBody.write_receipt === 'write-token');
  check('Shared write carries the receipt-bound analysis summary', cacheWriteBody.analysis_summary === 'Canonical analysis.');
  check('Shared write carries receipt-bound source metadata',
    cacheWriteBody.source_fingerprint === 'a1b2c3d4' && cacheWriteBody.schema_version === 2);

  console.log('\nPrivileged background message boundary');

  const validAnalysis = await sendBackground({ action: 'analyzeTos', text: 'Terms text' }, contentSender);
  check('Content analysis succeeds without a caller-supplied page URL', validAnalysis.summary === 'trusted analysis');
  check('Content analysis uses sender.tab.url', orchestratorCalls[0]?.[0] === contentSender.tab.url, orchestratorCalls[0]?.[0]);

  const analysisCount = orchestratorCalls.length;
  const mismatchedUrl = await sendBackground(
    { action: 'analyzeTos', text: 'Terms text', pageUrl: 'https://attacker.example/terms' },
    contentSender
  );
  check('Mismatched content pageUrl is rejected', mismatchedUrl.error === 'invalid_message');
  check('Rejected pageUrl never reaches the orchestrator', orchestratorCalls.length === analysisCount);

  const oversizeText = await sendBackground(
    { action: 'analyzeTos', text: 'x'.repeat(backgroundTextLimit + 1) },
    contentSender
  );
  check('Oversized analysis text is rejected', oversizeText.error === 'invalid_message');
  const oversizeHtml = await sendBackground(
    { action: 'analyzeTos', text: 'Terms', pageHtml: 'x'.repeat(backgroundHtmlLimit + 1) },
    contentSender
  );
  check('Oversized page HTML is rejected', oversizeHtml.error === 'invalid_message');
  check('Oversized page URLs are rejected',
    (await sendBackground({ action: 'analyzeTos', text: 'Terms', pageUrl: `https://example.com/${'x'.repeat(9000)}` }, contentSender)).error === 'invalid_message');
  check('Non-string analysis text is rejected',
    (await sendBackground({ action: 'analyzeTos', text: { forged: true } }, contentSender)).error === 'invalid_message');
  check('Unsupported analysis fields are rejected',
    (await sendBackground({ action: 'analyzeTos', text: 'Terms', model: 'attacker-model' }, contentSender)).error === 'invalid_message');

  const lookupsBeforeForgery = lookupCalls.length;
  const forgedCache = await sendBackground({ action: 'checkCache', domain: 'attacker.com' }, contentSender);
  check('Forged cache domain is rejected', forgedCache.error === 'invalid_message');
  check('Forged cache domain triggers no lookup', lookupCalls.length === lookupsBeforeForgery);
  check('Oversized cache domains are rejected',
    (await sendBackground({ action: 'checkCache', domain: 'x'.repeat(254) }, contentSender)).error === 'invalid_message');

  const cacheResult = await sendBackground({ action: 'checkCache' }, contentSender);
  check('Cache lookup derives the registrable sender domain', lookupCalls.at(-1) === 'https://chase.com/', lookupCalls.at(-1));
  check('Cache response returns the trusted domain', cacheResult.domain === 'chase.com');

  delete storageData.tosAcknowledged;
  const forgedAck = await sendBackground({ action: 'acknowledge', domain: 'attacker.com' }, contentSender);
  check('Forged acknowledgment domain is rejected', forgedAck.error === 'invalid_message' && forgedAck.ok === false);
  check('Rejected acknowledgment is not stored', storageData.tosAcknowledged === undefined);

  const validAck = await sendBackground({ action: 'acknowledge' }, contentSender);
  check('Acknowledgment derives the sender domain', validAck.ok === true && validAck.domain === 'chase.com');
  check('Trusted acknowledgment is stored under the sender domain', Number.isFinite(storageData.tosAcknowledged?.['chase.com']));

  activeTab = { id: 8, url: 'https://accounts.example.org/legal' };
  const popupAnalysis = await sendBackground(
    { action: 'analyzeTos', text: 'Popup terms', pageUrl: activeTab.url },
    popupSender
  );
  check('Popup analysis succeeds for the currently active tab', popupAnalysis.summary === 'trusted analysis');
  check('Popup analysis is rebound to the active tab URL', orchestratorCalls.at(-1)?.[0] === activeTab.url, orchestratorCalls.at(-1)?.[0]);
  check('Popup cannot analyze a different selected URL',
    (await sendBackground({ action: 'analyzeTos', text: 'Popup terms', pageUrl: 'https://other.example/' }, popupSender)).error === 'invalid_message');
  check('Non-popup extension pages cannot invoke analysis',
    (await sendBackground(
      { action: 'analyzeTos', text: 'Options terms', pageUrl: activeTab.url },
      { id: 'extension-test-id', url: 'chrome-extension://extension-test-id/options.html' }
    )).error === 'invalid_message');
  check('A different extension ID is rejected',
    (await sendBackground({ action: 'checkCache' }, { ...contentSender, id: 'other-extension' })).error === 'invalid_message');
  check('Unknown actions are rejected',
    (await sendBackground({ action: 'deleteEverything' }, contentSender)).error === 'unknown_action');
  check('Malformed messages are rejected',
    (await sendBackground(null, contentSender)).error === 'invalid_message');

  console.log('\nObserver mode message boundary (learning loop, phase 0)');

  const validEpisodeId = '0123456789abcdef';
  const withEpisode = await sendBackground({ action: 'analyzeTos', text: 'Terms text', episodeId: validEpisodeId }, contentSender);
  check('analyzeTos accepts a well-formed episode id', withEpisode.summary === 'trusted analysis');
  check('analyzeTos passes the episode id to the orchestrator', orchestratorCalls.at(-1)?.[3]?.episodeId === validEpisodeId, JSON.stringify(orchestratorCalls.at(-1)?.[3]));
  check('analyzeTos rejects a malformed episode id',
    (await sendBackground({ action: 'analyzeTos', text: 'Terms text', episodeId: 'not-hex' }, contentSender)).error === 'invalid_message');

  const triggerData = { source: 'click', branch: 'password-field', controlTag: 'button', authForm: true, passwordField: true, knownDomain: false, frame: false };
  delete storageData.tosGuardianObserver;
  const observerOff = await sendBackground({ action: 'observerEvent', episodeId: validEpisodeId, stage: 'trigger', data: triggerData }, contentSender);
  check('observerEvent is accepted but not recorded while observer mode is off', observerOff.ok === true && observerOff.recorded === false && observerEvents.length === 0);

  storageData.tosGuardianObserver = { enabled: true, port: 3123 };
  const observerOn = await sendBackground(
    { action: 'observerEvent', episodeId: validEpisodeId, stage: 'trigger', data: triggerData, local: { pageUrl: 'https://login.chase.com/signin?token=abc', controlLabel: 'Sign in' } },
    contentSender
  );
  check('observerEvent is recorded while observer mode is on', observerOn.ok === true && observerOn.recorded === true && observerEvents.length === 1);
  check('recorded trigger event carries the id, stage, data, and local layer',
    observerEvents[0]?.episodeId === validEpisodeId && observerEvents[0]?.stage === 'trigger' &&
    observerEvents[0]?.data?.branch === 'password-field' && observerEvents[0]?.local?.controlLabel === 'Sign in');
  check('recorded event validates against the schema', context.validateEvent(observerEvents[0]).valid);
  check('observerEvent rejects an unknown data field',
    (await sendBackground({ action: 'observerEvent', episodeId: validEpisodeId, stage: 'trigger', data: { ...triggerData, pageText: 'private' } }, contentSender)).error === 'invalid_message');
  check('observerEvent rejects a stage the content script may not report',
    (await sendBackground({ action: 'observerEvent', episodeId: validEpisodeId, stage: 'fetch', data: { path: 'known-urls' } }, contentSender)).error === 'invalid_message');
  check('observerEvent rejects an unknown local field',
    (await sendBackground({ action: 'observerEvent', episodeId: validEpisodeId, stage: 'render', data: { shown: true }, local: { password: 'x' } }, contentSender)).error === 'invalid_message');
  check('observerEvent rejects an oversized local label',
    (await sendBackground({ action: 'observerEvent', episodeId: validEpisodeId, stage: 'render', data: { shown: true }, local: { controlLabel: 'x'.repeat(3000) } }, contentSender)).error === 'invalid_message');
  check('observerEvent rejects a malformed episode id',
    (await sendBackground({ action: 'observerEvent', episodeId: 'nope', stage: 'trigger', data: triggerData }, contentSender)).error === 'invalid_message');
  check('observerEvent rejects unsupported fields',
    (await sendBackground({ action: 'observerEvent', episodeId: validEpisodeId, stage: 'trigger', data: triggerData, ip: '1.2.3.4' }, contentSender)).error === 'invalid_message');
  check('observerEvent is refused from the popup',
    (await sendBackground({ action: 'observerEvent', episodeId: validEpisodeId, stage: 'trigger', data: triggerData }, popupSender)).error === 'invalid_message');
  check('rejected observer events are never recorded', observerEvents.length === 1);
  delete storageData.tosGuardianObserver;

  console.log('\nExtension permission contract');
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'manifest.json'), 'utf8'));
  check('Manifest does not request the unused scripting permission', !manifest.permissions.includes('scripting'));
  check('Manifest does not request redundant activeTab permission', !manifest.permissions.includes('activeTab'));
  check('Manifest retains tabs for tab URL verification and hidden document tabs', manifest.permissions.includes('tabs'));
  check('Manifest retains storage for settings, cache, and acknowledgment state', manifest.permissions.includes('storage'));
  check('Embedded agreement-frame detection remains enabled',
    manifest.content_scripts?.[0]?.all_frames === true && manifest.content_scripts?.[0]?.match_about_blank === true);

  const backgroundSource = fs.readFileSync(path.join(repoRoot, 'background.js'), 'utf8');
  check('Extension source contains no PROXY_KEY declaration', !/\bPROXY_KEY\b/.test(backgroundSource));
  check('Extension source contains no proxy-key header', !/x-tg-proxy-key/i.test(backgroundSource));
  check('No requests remain queued', requests.length === 0);

  console.log(`\nSummary: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
