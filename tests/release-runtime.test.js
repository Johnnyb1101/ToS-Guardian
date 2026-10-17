const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');
const { TextEncoder } = require('util');

const repoRoot = path.resolve(__dirname, '..');
const policyFiles = ['vendor/tldts-7.4.8.umd.min.js', 'tosUtils.js', 'evaluator.js',
  'critic.js', 'siteDatabase.js', 'episode.js', 'community.js', 'orchestrator.js',
  'background.js', 'content.js', 'manifest.json'];
const configHash = 'b'.repeat(64);
const otherHash = 'c'.repeat(64);
const releaseToken = 'signed-release-token';
const requests = [];
const replies = [];
const storageData = { selectedProvider: 'anthropic' };
const storage = {
  get(keys, callback) {
    const result = {};
    for (const key of Array.isArray(keys) ? keys : [keys]) result[key] = storageData[key];
    if (callback) callback(result);
    return Promise.resolve(result);
  },
  set(value, callback) {
    Object.assign(storageData, value);
    if (callback) callback();
    return Promise.resolve();
  },
  remove() { return Promise.resolve(); }
};
const context = {
  console: { log() {}, warn() {}, error() {} },
  URL, Date, TextEncoder, crypto: webcrypto,
  __TG_POLICY_SOURCES: Object.fromEntries(policyFiles.map(file =>
    [file, fs.readFileSync(path.join(repoRoot, file), 'utf8')])),
  importScripts() {},
  browser: {
    storage: { local: storage },
    runtime: { id: 'release-test', onMessage: { addListener() {} } },
    tabs: {}
  },
  fetch: async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const reply = replies.shift();
    if (!reply) throw new Error(`Unexpected request: ${url}`);
    return { ok: reply.status >= 200 && reply.status < 300,
      status: reply.status, json: async () => reply.body };
  }
};
vm.createContext(context);
for (const file of ['vendor/tldts-7.4.8.umd.min.js', 'evaluator.js', 'critic.js',
  'siteDatabase.js', 'tosUtils.js', 'episode.js', 'community.js', 'orchestrator.js', 'background.js']) {
  vm.runInContext(fs.readFileSync(path.join(repoRoot, file), 'utf8'), context, { filename: file });
}

function reply(body, status = 200) { replies.push({ body, status }); }
function sent() { return requests.shift(); }
function body(request) { return JSON.parse(request.options.body); }

(async () => {
  const policyHash = await context.clientPolicyHash();
  assert.match(policyHash, /^[a-f0-9]{64}$/);
  assert.strictEqual(await context.clientPolicyHash(), policyHash);
  const originalSources = context.__TG_POLICY_SOURCES;
  const hashFor = async sources => {
    context.__TG_POLICY_SOURCES = sources;
    vm.runInContext('clientPolicyHashPromise = null', context);
    return context.clientPolicyHash();
  };
  for (const file of ['tosUtils.js', 'evaluator.js', 'vendor/tldts-7.4.8.umd.min.js',
    'content.js', 'manifest.json']) {
    assert.notStrictEqual(await hashFor({ ...originalSources, [file]: `${originalSources[file]}\nchanged` }), policyHash);
  }
  const crlfSources = Object.fromEntries(Object.entries(originalSources).map(([file, source]) =>
    [file, source.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n')]));
  assert.strictEqual(await hashFor(crlfSources), policyHash);
  await assert.rejects(hashFor({ ...originalSources, 'critic.js': undefined }), /Invalid policy source/);
  context.__TG_POLICY_SOURCES = originalSources;
  vm.runInContext('clientPolicyHashPromise = null', context);
  assert.strictEqual(await context.clientPolicyHash(), policyHash);
  const mockProxyFetch = context.fetch;
  let localReads = 0;
  context.browser.runtime.getURL = file => `chrome-extension://release-test/${file}`;
  context.__TG_POLICY_SOURCES = undefined;
  context.fetch = async url => {
    localReads++;
    const file = String(url).replace('chrome-extension://release-test/', '');
    assert(Object.prototype.hasOwnProperty.call(originalSources, file));
    return { ok: true, text: async () => originalSources[file] };
  };
  vm.runInContext('clientPolicyHashPromise = null', context);
  assert.strictEqual(await context.clientPolicyHash(), policyHash);
  assert.strictEqual(localReads, policyFiles.length);
  context.fetch = mockProxyFetch;
  context.__TG_POLICY_SOURCES = originalSources;
  vm.runInContext('clientPolicyHashPromise = null', context);

  reply({ configHash, releaseToken });
  const session = await context.beginReleaseSession();
  assert.strictEqual(session.configHash, configHash);
  assert.strictEqual(session.releaseToken, releaseToken);
  const sessionRequest = sent();
  assert(sessionRequest.url.endsWith('/learning/session'));
  assert.deepStrictEqual(body(sessionRequest), { provider: 'anthropic', clientPolicyHash: policyHash });

  reply({ text: 'Analyzer output', configHash, releaseToken, analysisReceipt: 'analysis-receipt' });
  const analyzed = await context.analyzeWithModel('=== PRIVACY POLICY ===\nWe collect email.',
    'https://example.com/privacy', false, session);
  assert.strictEqual(analyzed.configHash, configHash);
  assert.strictEqual(analyzed.releaseToken, releaseToken);
  const analyzerRequest = body(sent());
  assert.strictEqual(analyzerRequest.configHash, configHash);
  assert.strictEqual(analyzerRequest.releaseToken, releaseToken);
  assert.strictEqual(analyzerRequest.clientPolicyHash, policyHash);

  const verdictText = JSON.stringify({ dataCollection: 'grounded', dataSelling: 'skipped',
    optOutRights: 'skipped', howToOptOut: 'skipped', autoRenewal: 'skipped',
    dataDeletion: 'skipped', flags: [] });
  const provenance = { configHash: analyzed.configHash, releaseToken: analyzed.releaseToken,
    analysisReceipt: analyzed.analysisReceipt, providerAnalysis: analyzed.providerAnalysis,
    cacheContext: { domain: 'example.com' } };
  reply({ text: verdictText, configHash, writeReceipt: 'write-receipt' });
  const criticized = await context.runCritic(analyzed.summary, analyzed.analysisSource, provenance);
  assert.strictEqual(criticized._writeReceipt, 'write-receipt');
  const criticRequest = body(sent());
  assert.strictEqual(criticRequest.configHash, configHash);
  assert.strictEqual(criticRequest.releaseToken, releaseToken);
  assert.strictEqual(criticRequest.clientPolicyHash, policyHash);
  assert.strictEqual(criticRequest.analysisReceipt, 'analysis-receipt');

  reply({ text: 'Escalated output', configHash: otherHash, releaseToken });
  const mismatchedEscalation = await context.analyzeWithModel('Legal text',
    'https://example.com/privacy', true, session);
  assert.strictEqual(mismatchedEscalation, null);
  assert.strictEqual(body(sent()).configHash, configHash);

  reply({ text: 'Unbound output' });
  assert.strictEqual(await context.analyzeWithModel('Legal text', 'https://example.com/privacy'), null);
  sent();

  reply({ text: verdictText, configHash: otherHash, writeReceipt: 'unsafe-write' });
  const mismatchedCritic = await context.runCritic(analyzed.summary, analyzed.analysisSource, provenance);
  assert.strictEqual(mismatchedCritic.failed, true);
  assert.strictEqual(mismatchedCritic._reason, 'release-mismatch');
  sent();

  reply({ result: 'Cached analysis', configHash, opt_out_links: [] });
  assert.strictEqual((await context.readFromSupabase('example.com', 'policy text', session)).summary, 'Cached analysis');
  assert.strictEqual(sent().options.headers['X-Release-Token'], releaseToken);
  reply({ result: 'Wrong cached analysis', configHash: otherHash, opt_out_links: [] });
  assert.strictEqual(await context.readFromSupabase('example.com', 'policy text', session), null);
  sent();

  reply({ tos: 'https://acmeprivacy.com/terms', privacy: 'https://acmeprivacy.com/privacy',
    is_static: true });
  assert((await context.lookupSite('https://acmeprivacy.com/', releaseToken)).tos);
  assert.strictEqual(sent().options.headers['X-Release-Token'], releaseToken);

  assert.strictEqual(requests.length, 0);
  assert.strictEqual(replies.length, 0);
  console.log('Release runtime: passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
