'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { captureSource, executeSource } = require('../tools/maintenance-source-harness');
const P = require('../tools/maintenance-provider-preflight');
const { digest, seal } = require('../tools/final-corpus-lib');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tos-source-harness-'));
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok ${name}`); }
const files = {
  'analysisOperations.js': "exports.validateOperationRequest = input => ({valid:true,operation:'analyzer',relayRequest:input});",
  'llmRelay.js': "exports.validateAnalyzeRequest = input => ({valid:true,...input}); exports.buildProviderRequest = v => ({url:'https://api.anthropic.com/v1/messages',body:{model:'claude-sonnet-4-6',system:'system',messages:[{role:'user',content:v.documentText}],max_tokens:1200}});",
  'siteValidation.js': 'exports.validateDomainKey = () => true;',
  'node_modules/tldts/dist/cjs/index.js': 'exports.parse = () => ({});',
  'package.json': '{}', 'package-lock.json': '{}'
};
function captureFixture() {
  return { manifest: seal({ kind: 'maintenance-module-capture', v: 1, files: Object.entries(files).map(([name, source]) => ({ name, sha256: require('node:crypto').createHash('sha256').update(source).digest('hex'), bytes: Buffer.byteLength(source) })) }), sources: { ...files } };
}
async function main() {
  try {
    test('exact captured source bytes execute and output binds actual runtime and input', () => {
      const report = executeSource(captureFixture(), { documentText: 'fixture source' });
      assert.equal(report.actualRuntime.node, process.version); assert.equal(report.result.request.body.messages[0].content, 'fixture source');
      assert.equal(report.promotionEligible, false); assert.equal(report.evaluationPassed, false);
    });
    test('source mutation, missing dependency and source timeout fail closed', () => {
      const c = captureFixture(); c.sources['llmRelay.js'] += '\n'; assert.throws(() => executeSource(c, {}), /changed/);
      const original = files['analysisOperations.js'];
      try {
        files['analysisOperations.js'] = "require('node:fs');"; assert.throws(() => executeSource(captureFixture(), {}), /Unexpected/);
        files['analysisOperations.js'] = 'while(true){}'; assert.throws(() => executeSource(captureFixture(), {}), /timed out/);
      } finally { files['analysisOperations.js'] = original; }
    });
    if (process.platform === 'win32') test('local captured bytes are bound; execution does not reopen changed sources', () => {
      for (const [name, source] of Object.entries(files)) { const f = path.join(root, name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, source); }
      const captured = captureSource(root); fs.writeFileSync(path.join(root, 'llmRelay.js'), 'throw new Error("changed disk file")');
      assert.equal(executeSource(captured, { documentText: 'offline' }).result.request.body.messages[0].content, 'offline');
    });
    else test('capture on unsupported filesystem fails closed', () => assert.throws(() => captureSource(root), /Windows/));
    const request = executeSource(captureFixture(), { documentText: 'fixture source' }).result.request;
    test('count preparation binds full text request and strips no token-bearing fields', () => {
      const p = P.prepareAnthropicCount(request);
      assert.equal(p.sourceRequestHash, digest(request)); assert.deepEqual(p.body.messages, request.body.messages);
      assert.equal(p.body.system, request.body.system); assert.equal(p.dispatchEnabled, false);
      const count = P.recordAnthropicCount(request, p, { input_tokens: 25 });
      assert.equal(count.reportedInputTokens, 25); assert.equal(count.providerAuthenticated, false); assert.equal(count.liveDispatchAllowed, false);
      assert.equal(count.hardUpperBoundEstablished, false);
    });
    test('unknown provider, tool/cache fields, tampered preparation and excess counts rejected', () => {
      assert.throws(() => P.prepareAnthropicCount({ ...request, url: 'https://other.example' }));
      assert.throws(() => P.prepareAnthropicCount({ ...request, body: { ...request.body, tools: [] } }));
      const p = P.prepareAnthropicCount(request);
      for (const count of [-1, 40001, 1.5, '1', null]) assert.throws(() => P.recordAnthropicCount(request, p, { input_tokens: count }));
      p.body.system = 'changed'; assert.throws(() => P.recordAnthropicCount(request, p, { input_tokens: 1 }));
    });
    const oldFetch = globalThis.fetch; let calls = 0;
    globalThis.fetch = () => { calls++; throw new Error('Network must not be called'); };
    try { await assert.rejects(P.dispatch({ enabled: true }), /disabled/); assert.equal(calls, 0); passed++; console.log('ok disabled transport cannot be enabled by caller flags'); }
    finally { globalThis.fetch = oldFetch; }
    console.log(`${passed} source harness/preflight test groups passed`);
  } finally { if (path.dirname(root) !== path.resolve(os.tmpdir())) throw new Error('Unsafe cleanup'); fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
