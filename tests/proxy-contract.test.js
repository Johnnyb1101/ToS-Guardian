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
for (const file of ['vendor/tldts-7.4.8.umd.min.js', 'tosUtils.js', 'critic.js', 'background.js']) {
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

  responses.push({ status: 200, body: { text: 'Analyzer output', model: 'server-model', stopReason: 'end_turn' } });
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
      stopReason: 'end_turn'
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
