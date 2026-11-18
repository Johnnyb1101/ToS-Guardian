'use strict';
// Explicit actual-artifact integration; no inference. Node built-ins only.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), Module = require('node:module');
const { captureRuntime } = require('../tools/maintenance-bound-runtime');
const { canonicalJson } = require('../tools/final-corpus-lib');
const [oldRoot, currentRoot] = process.argv.slice(2);
if (!oldRoot || !currentRoot) throw Error('Explicit historical reconstruction and reconciled-current roots required');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tos-smoke-session-test-'));
function load(relative, overrides) {
  const file = path.resolve(__dirname, relative), m = new Module(file, module);
  m.filename = file; m.paths = module.paths;
  const original = m.require.bind(m);
  m.require = name => Object.hasOwn(overrides, name) ? overrides[name] : original(name);
  m._compile(fs.readFileSync(file, 'utf8'), file); return m.exports;
}
const budget = load('../tools/maintenance-smoke-budget.js', { 'node:os': { userInfo: () => ({ homedir: home }) } });
const { OfflineSession, parseFixture } = load('../tools/maintenance-smoke-session.js', { './maintenance-smoke-budget': budget });
const h = x => crypto.createHash('sha256').update(x).digest('hex');
function binding(file) { const bytes = fs.readFileSync(file); return { path: file, sha256: h(bytes), bytes: bytes.length }; }
const bindings = {};
const expected = { baseline: ['2afe5ea938fe138ee68f2880bfcd3d65131431a49c5da121e81955dfddaab085', '1157c355356c71522f330048aecef02f125f256601f2118f5597e19c87fbf7ab'], candidate: ['1fad3448d9ba79e9c5a45b1b8d3923e90d7ffa4783b2ce6f7b2d58faca94d932', 'df75225533652938188308aff95a2472ed114a03d497dba15f79e8b2738316a0'] };
for (const arm of ['baseline', 'candidate']) {
  const root = arm === 'baseline' ? oldRoot : currentRoot;
  const releasePath = path.resolve(root, arm + '-release.json');
  const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
  assert.equal(release.configHash, expected[arm][0]); assert.equal(release.config.policy.versions.serverPipeline, expected[arm][1]);
  const capture = captureRuntime(path.join(root, arm));
  const file = path.join(home, arm + '-capture.json'); fs.writeFileSync(file, canonicalJson(capture));
  bindings[arm + 'Artifact'] = binding(file); bindings[arm + 'Release'] = binding(releasePath);
}
const doc = { domain: 'example.com', text: 'Privacy Policy. We collect account email addresses. Contact privacy@example.com to request deletion.', sourceUrl: 'https://example.com/privacy', capturedAt: '2026-11-15T00:00:00.000Z' };
const docPath = path.join(home, 'document.json'); fs.writeFileSync(docPath, JSON.stringify(doc));
bindings.document = binding(docPath); bindings.harness = binding(path.resolve(__dirname, '../tools/maintenance-bound-runtime.js'));
const H = 'a'.repeat(64);
const spec = { v: 1, task: budget.TASK, currency: 'USD', limitMicrodollars: 20000000, bindings,
  provider: { accountScopeHash: H, apiVersion: '2023-06-01', model: 'claude-sonnet-4-6', maxInputTokens: 1000000, inputMicrodollarsPerMillion: 3000000, outputMicrodollarsPerMillion: 15000000, metadataEvidence: H, pricingEvidence: H, tier: 'standard', region: 'global', cache: 'disabled' },
  billing: { taxUpperBoundBps: 1000, feeUpperBoundMicrodollars: 0, hostingUpperBoundMicrodollars: 0, evidenceHash: H }, expiresAt: new Date(Date.now() + 3600000).toISOString() };
function response(id, text) { return { id: 'msg_' + id, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }; }
let groups = 0;
function test(label, fn) { fn(); groups++; console.log('ok ' + label); }
test('actual historical and current candidate request chain binds correct releases and parsed analyzer text', () => {
  const session = new OfflineSession(spec, 'initialize');
  for (const arm of ['baseline', 'candidate']) {
    const analyzer = session.nextFixtureRequest();
    assert.equal(analyzer.result.configHash, expected[arm][0]); assert.equal(analyzer.liveDispatchAllowed, false);
    assert.ok(analyzer.result.request.body.messages[0].content.includes(doc.text));
    const reservedHash = analyzer.reservation.requestHash;
    analyzer.result.request.body.messages[0].content = 'MUTATED DIAGNOSTIC COPY';
    const text = 'Fixture ' + arm + ': collects account email addresses.';
    const receipt = session.acceptFixture(response(arm + '_a', text));
    assert.equal(receipt.requestHash, reservedHash);
    const critic = session.nextFixtureRequest();
    assert.ok(critic.result.request.body.messages[0].content.includes(text)); assert.ok(critic.result.request.body.messages[0].content.includes(doc.text));
    assert.equal(critic.reservation.id, arm + ':critic');
    session.acceptFixture(response(arm + '_c', 'Fixture critic text, not a quality verdict.'));
  }
  assert.throws(() => session.nextFixtureRequest()); assert.equal(session.snapshot().events.length, 9); session.close();
  assert.throws(() => new OfflineSession(spec), /resume requires/);
});
test('strict parser rejects incomplete, tools, wrong identity, unexpected fields and unpriced usage', () => {
  const changes = [r => r.stop_reason = 'max_tokens', r => r.stop_reason = 'refusal', r => r.content[0].type = 'tool_use', r => r.model = 'other', r => r.usage.cache_read_input_tokens = 1, r => r.usage.input_tokens = 1000001, r => r.usage.output_tokens = 1201, r => delete r.usage, r => r.extra = true, r => r.content[0].text = '', r => r.usage.output_tokens = -1];
  for (const change of changes) { const r = response('bad', 'text'); change(r); assert.throws(() => parseFixture(r, 'analyzer')); }
  assert.equal(parseFixture(response('good', 'text'), 'critic').providerAuthenticated, false);
});
test('no arbitrary request API or real transport exported by session', () => {
  assert.equal(OfflineSession.prototype.reserve, undefined); assert.equal(OfflineSession.prototype.dispatch, undefined);
});
test('malformed fixture persists unknown reservation and blocks all later calls', () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tos-smoke-failure-test-'));
  const isolatedBudget = load('../tools/maintenance-smoke-budget.js', { 'node:os': { userInfo: () => ({ homedir: isolatedHome }) } });
  const isolated = load('../tools/maintenance-smoke-session.js', { './maintenance-smoke-budget': isolatedBudget });
  const session = new isolated.OfflineSession(spec, 'initialize'); session.nextFixtureRequest();
  const malformed = response('invalid', 'text'); malformed.stop_reason = 'max_tokens';
  assert.throws(() => session.acceptFixture(malformed)); assert.equal(session.snapshot().halted, true);
  assert.equal(session.snapshot().events.at(-1).event.type, 'unknown'); assert.throws(() => session.nextFixtureRequest()); session.close();
});
console.log(groups + ' real-module current-candidate integration groups passed; all responses synthetic and noneligible');
