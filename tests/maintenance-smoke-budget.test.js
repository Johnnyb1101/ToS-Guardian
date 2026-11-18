'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const sourceFile = path.resolve(__dirname, '../tools/maintenance-smoke-budget.js');
const source = fs.readFileSync(sourceFile, 'utf8');
const canonical = require('../tools/final-corpus-lib');
const H = 'a'.repeat(64);
// Test-only VM substitutes OS home/path adapter, never exposed by the module.
function load(home, filesystem = fs) {
  const module = { exports: {} };
  vm.runInNewContext(source, { module, Buffer, Date, require(name) {
    if (name === 'node:os') return { userInfo: () => ({ homedir: home }) };
    if (name === 'node:fs') return filesystem;
    if (name === './maintenance-local-path') return { localPath: p => p };
    if (name === './final-corpus-lib') return { canonicalJson: v => canonical.canonicalJson(JSON.parse(JSON.stringify(v))) };
    return require(name);
  } }, { filename: sourceFile });
  return module.exports;
}
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tos-smoke-budget-test-'));
  const artifact = path.join(home, 'fixture'); fs.writeFileSync(artifact, 'fixture');
  const binding = { path: artifact, bytes: 7, sha256: crypto.createHash('sha256').update('fixture').digest('hex') };
  const m = load(home);
  const spec = { v: 1, task: m.TASK, currency: 'USD', limitMicrodollars: 20000000,
    bindings: Object.fromEntries(['baselineArtifact', 'baselineRelease', 'candidateArtifact', 'candidateRelease', 'document', 'harness'].map(k => [k, { ...binding }])),
    provider: { accountScopeHash: H, apiVersion: '2023-06-01', model: 'claude-sonnet-4-6', maxInputTokens: 1000000, inputMicrodollarsPerMillion: 3000000, outputMicrodollarsPerMillion: 15000000, metadataEvidence: H, pricingEvidence: H, tier: 'standard', region: 'global', cache: 'disabled' },
    billing: { taxUpperBoundBps: 1000, feeUpperBoundMicrodollars: 0, hostingUpperBoundMicrodollars: 0, evidenceHash: H },
    expiresAt: new Date(Date.now() + 3600000).toISOString() };
  return { home, m, spec, artifact, root: path.join(home, 'AppData', 'Local', 'ToSGuardian', m.TASK) };
}
const request = (stage = 'analyzer') => ({ url: 'https://api.anthropic.com/v1/messages', body: { model: 'claude-sonnet-4-6', system: 'fixture system', messages: [{ role: 'user', content: 'fixture document' }], max_tokens: stage === 'analyzer' ? 1200 : 1000 } });
const usage = { inputTokens: 100, outputTokens: 10 };
let groups = 0;
function test(name, fn) { fn(); groups++; console.log('ok ' + name); }
test('complete four-call and inclusive tax bound, never paid eligibility', () => {
  const f = fixture(), p = f.m.prepare(f.spec);
  assert.equal(p.apiMicrodollars, 12066000); assert.equal(p.allInMicrodollars, 13272600);
  assert.equal(p.liveDispatchAllowed, false); assert.equal(p.promotionEligible, false);
  for (const change of [s => s.billing.taxUpperBoundBps = null, s => delete s.provider.accountScopeHash, s => s.provider.maxInputTokens = 40000, s => s.provider.region = 'us', s => s.provider.cache = 'enabled', s => s.billing.feeUpperBoundMicrodollars = 10000000, s => s.limitMicrodollars = 50000000]) {
    const s = structuredClone(f.spec); change(s); assert.throws(() => f.m.prepare(s));
  }
});
test('persistent task identity blocks new directories, changed plans and reruns', () => {
  const f = fixture(), r = new f.m.Registry(f.spec, 'initialize');
  assert.throws(() => new f.m.Registry(f.spec, 'initialize')); r.close();
  const changed = structuredClone(f.spec); changed.provider.accountScopeHash = 'b'.repeat(64);
  assert.throws(() => new f.m.Registry(changed));
});
test('all four calls exact order, dependent critic, no refunds or fifth attempt', () => {
  const f = fixture(), r = new f.m.Registry(f.spec, 'initialize');
  assert.throws(() => r.reserve('candidate:analyzer', request()));
  for (const arm of ['baseline', 'candidate']) for (const stage of ['analyzer', 'critic']) {
    const id = arm + ':' + stage;
    const result = r.reserve(id, request(stage), stage === 'critic' ? H : null);
    assert.equal(result.liveDispatchAllowed, false);
    assert.throws(() => r.reserve(id, request(stage)));
    r.settle(id, usage, H);
  }
  assert.throws(() => r.reserve('baseline:analyzer', request())); r.close();
  const reopened = new f.m.Registry(f.spec);
  assert.throws(() => reopened.reserve('baseline:analyzer', request())); reopened.close();
});
test('changed files, options, endpoint, output cap and expiry rejected before reservation', () => {
  const f = fixture(), r = new f.m.Registry(f.spec, 'initialize');
  for (const change of [q => q.url = 'https://evil.invalid', q => q.body.max_tokens++, q => q.body.tools = [], q => q.body.model = 'other', q => q.redirect = 'follow']) {
    const q = request(); change(q); assert.throws(() => r.reserve('baseline:analyzer', q));
  }
  fs.writeFileSync(f.artifact, 'changed'); assert.throws(() => r.reserve('baseline:analyzer', request()));
  assert.equal(r.snapshot().events.length, 1); r.close();
  const e = fixture(); e.spec.expiresAt = '2000-01-01T00:00:00.000Z';
  const expired = new e.m.Registry(e.spec, 'initialize'); assert.throws(() => expired.reserve('baseline:analyzer', request())); expired.close();
});
test('unknown or excessive usage halts permanently with reservation retained', () => {
  const f = fixture(), r = new f.m.Registry(f.spec, 'initialize'); r.reserve('baseline:analyzer', request());
  assert.throws(() => r.settle('baseline:analyzer', { inputTokens: 1000001, outputTokens: 1 }, H));
  assert.equal(r.snapshot().halted, true); assert.throws(() => r.reserve('baseline:critic', request('critic'), H)); r.close();
  assert.ok(fs.existsSync(path.join(f.root, 'exclusive.lock'))); assert.throws(() => new f.m.Registry(f.spec));
});
test('partial or corrupted journals and abandoned attempts fail closed', () => {
  for (const corruption of ['tail', 'hash']) {
    const f = fixture(), r = new f.m.Registry(f.spec, 'initialize'); r.close();
    const file = path.join(f.root, 'registry.jsonl');
    if (corruption === 'tail') fs.appendFileSync(file, '{');
    else { const row = JSON.parse(fs.readFileSync(file, 'utf8')); row.hash = H; fs.writeFileSync(file, JSON.stringify(row) + '\n'); }
    assert.throws(() => new f.m.Registry(f.spec));
  }
  const f = fixture(), r = new f.m.Registry(f.spec, 'initialize'); r.reserve('baseline:analyzer', request()); r.close();
  assert.throws(() => new f.m.Registry(f.spec));
});
test('reservation fsync error cannot return permission and keeps failed lock', () => {
  const f = fixture(); let fail = false;
  const m = load(f.home, { ...fs, fsyncSync(fd) { if (fail) throw Error('injected'); fs.fsyncSync(fd); } });
  const r = new m.Registry(f.spec, 'initialize'); fail = true;
  assert.throws(() => r.reserve('baseline:analyzer', request()), /injected/);
  assert.throws(() => r.reserve('baseline:analyzer', request())); r.close();
  assert.ok(fs.existsSync(path.join(f.root, 'exclusive.lock')));
});
test('separate OS process cannot open same locked approval registry', () => {
  const f = fixture(), r = new f.m.Registry(f.spec, 'initialize');
  const worker = path.join(f.home, 'worker.cjs');
  fs.writeFileSync(worker, `const fs=require('node:fs'),vm=require('node:vm');const module2={exports:{}};vm.runInNewContext(${JSON.stringify(source)},{module:module2,Buffer,Date,require(n){if(n==='node:os')return{userInfo:()=>({homedir:${JSON.stringify(f.home)}})};if(n==='./maintenance-local-path')return{localPath:p=>p};if(n==='./final-corpus-lib')return {canonicalJson:v=>require(${JSON.stringify(path.resolve(__dirname, '../tools/final-corpus-lib.js'))}).canonicalJson(JSON.parse(JSON.stringify(v)))};return require(n)}});try{new module2.exports.Registry(${JSON.stringify(f.spec)});process.exit(2)}catch(e){if(e.code==='EEXIST')process.exit(0);console.error(e);process.exit(3)}`);
  const child = spawnSync(process.execPath, [worker], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr); r.close();
});
Promise.resolve(load(os.tmpdir()).dispatch({ enabled: true })).then(() => { throw Error('transport enabled'); }, () => console.log(`ok transport disabled; ${groups} offline smoke budget groups passed`));
