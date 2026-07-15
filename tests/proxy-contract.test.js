const fs = require('fs');
const path = require('path');
const vm = require('vm');

const repoRoot = path.resolve(__dirname, '..');
let passed = 0;
let failed = 0;
let storageData = { selectedProvider: 'anthropic' };
const requests = [];
const responses = [];

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
    tabs: {},
    runtime: { onMessage: { addListener() {} }, lastError: null }
  }
};

vm.createContext(context);
for (const file of ['tosUtils.js', 'critic.js', 'background.js']) {
  vm.runInContext(fs.readFileSync(path.join(repoRoot, file), 'utf8'), context, { filename: file });
}

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
