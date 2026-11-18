'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Journal } = require('../tools/maintenance-budget-journal');
const { digest, canonicalJson } = require('../tools/final-corpus-lib');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tos-journal-test-'));
const binding = digest({ synthetic: true });
let passed = 0;
function dir() { return fs.mkdtempSync(path.join(root, 'case-')); }
function test(name, fn) { fn(); passed++; console.log(`ok ${name}`); }
function log(d) { return path.join(d, 'maintenance-budget.jsonl'); }

try {
  if (process.platform !== 'win32') {
    test('non-Windows filesystem journal fails closed', () => assert.throws(() => new Journal(root, binding, 10000000), /Windows/));
  } else {
    test('clean restart retains full reservations and rejects duplicate attempts', () => {
      const d = dir(); let j = new Journal(d, binding, 10000000);
      j.reserve('a', 'analyzer'); j.settle('a', { inputTokens: 10, outputTokens: 10 }); j.close();
      j = new Journal(d, binding, 10000000);
      assert.equal(j.snapshot().reservedMicrodollars, 138000);
      assert.throws(() => j.reserve('a', 'analyzer'));
      j.reserve('b', 'critic'); j.settle('b', { inputTokens: 10, outputTokens: 10 }); j.close();
      j = new Journal(d, binding, 10000000);
      assert.equal(j.snapshot().reservedMicrodollars, 273000); j.close();
    });
    test('exclusive lock rejects a second process and crash leaves lock intact', () => {
      const d = dir(); const j = new Journal(d, binding, 10000000);
      assert.throws(() => new Journal(d, binding, 10000000), /EEXIST/); j.close();
      const moduleFile = require.resolve('../tools/maintenance-budget-journal');
      const child = spawnSync(process.execPath, ['-e', `const {Journal}=require(${JSON.stringify(moduleFile)});const j=new Journal(${JSON.stringify(d)},${JSON.stringify(binding)},10000000);j.reserve('crashed','judge');process.exit(0)`], { encoding: 'utf8' });
      assert.equal(child.status, 0, child.stderr);
      assert.throws(() => new Journal(d, binding, 10000000), /EEXIST/);
      const rows = fs.readFileSync(log(d), 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(rows.at(-1).event.type, 'reserve');
    });
    test('failed usage remains charged and halted across restart', () => {
      const d = dir(); let j = new Journal(d, binding, 10000000);
      j.reserve('a', 'judge'); assert.throws(() => j.settle('a', {}));
      assert.throws(() => j.settle('a', {})); j.close();
      j = new Journal(d, binding, 10000000);
      assert.equal(j.snapshot().halted, true); assert.equal(j.snapshot().reservedMicrodollars, 9000);
      assert.throws(() => j.reserve('b', 'judge'), /halted/); j.close();
    });
    test('budget exhaustion persists across restart even when a cheaper call would fit', () => {
      const d = dir(); let j = new Journal(d, binding, 150000);
      j.reserve('a', 'analyzer'); j.settle('a', { inputTokens: 1, outputTokens: 1 });
      assert.throws(() => j.reserve('b', 'critic'), /exhausted/);
      assert.equal(j.snapshot().halted, true); j.close();
      j = new Journal(d, binding, 150000);
      assert.equal(j.snapshot().halted, true); assert.equal(j.snapshot().reservedMicrodollars, 138000);
      assert.throws(() => j.reserve('c', 'judge'), /halted/); j.close();
    });
    test('changed budget or binding cannot reset a journal', () => {
      for (const change of ['binding', 'budget']) {
        const d = dir(); const j = new Journal(d, binding, 10000000); j.close();
        assert.throws(() => new Journal(d, change === 'binding' ? digest('other') : binding, change === 'budget' ? 11000000 : 10000000), /mismatch/);
        assert.ok(fs.existsSync(path.join(d, 'maintenance-budget.lock')));
      }
    });
    test('partial tail, changed hash and resealed invalid transition fail closed', () => {
      for (const corruption of ['tail', 'hash', 'transition']) {
        const d = dir(); const j = new Journal(d, binding, 10000000); j.close();
        if (corruption === 'tail') fs.appendFileSync(log(d), '{');
        if (corruption === 'hash') {
          const r = JSON.parse(fs.readFileSync(log(d), 'utf8')); r.hash = digest('tampered'); fs.writeFileSync(log(d), JSON.stringify(r) + '\n');
        }
        if (corruption === 'transition') {
          const r = JSON.parse(fs.readFileSync(log(d), 'utf8'));
          const body = { sequence: 1, previous: r.hash, event: { type: 'settle', id: 'never-reserved', usage: { inputTokens: 1, outputTokens: 1 } } };
          fs.appendFileSync(log(d), canonicalJson({ ...body, hash: digest(body) }) + '\n');
        }
        assert.throws(() => new Journal(d, binding, 10000000));
      }
    });
    test('reserve fsync failure poisons session and retains lock, never returns permission', () => {
      const d = dir(); const j = new Journal(d, binding, 10000000);
      const original = fs.fsyncSync;
      try {
        fs.fsyncSync = () => { throw new Error('injected fsync failure'); };
        assert.throws(() => j.reserve('a', 'judge'), /fsync/);
      } finally { fs.fsyncSync = original; }
      assert.throws(() => j.reserve('b', 'judge'), /poisoned/);
      assert.throws(() => j.close(), /poisoned/);
      assert.ok(fs.existsSync(path.join(d, 'maintenance-budget.lock')));
      j.abandon();
    });
    test('settlement write failure preserves the reserved attempt and unresolved replay blocks', () => {
      const d = dir(); const j = new Journal(d, binding, 10000000); j.reserve('a', 'judge');
      const original = fs.writeSync;
      try { fs.writeSync = () => { throw new Error('injected write failure'); }; assert.throws(() => j.settle('a', { inputTokens: 1, outputTokens: 1 }), /write failure/); }
      finally { fs.writeSync = original; }
      j.abandon();
      assert.throws(() => new Journal(d, binding, 10000000), /EEXIST/);
      // Synthetic operator-reconciliation fixture: removing a stale lock alone must not permit replay.
      fs.unlinkSync(path.join(d, 'maintenance-budget.lock'));
      assert.throws(() => new Journal(d, binding, 10000000), /Unresolved/);
    });
    test('runner journal integration binds plan and persists every simulation reservation', () => {
      const R = require('../tools/maintenance-runner-lib');
      const M = require('../tools/maintenance-evaluation-lib');
      const { makeRelease } = require('./final-test-fixtures');
      const { releaseConfigHash } = require('../tools/sites-lib');
      const build = seed => {
        const release = makeRelease([]); release.config.policy.versions.serverPipeline = digest(seed); release.config.policy.cache = { shared: 'disabled' }; release.configHash = releaseConfigHash(release.config);
        return { release, artifact: { sha256: digest(seed), bytes: 1 }, runtime: { node: 'synthetic', npm: 'synthetic', platform: 'synthetic', arch: 'synthetic' } };
      };
      const p = M.createProtocol(build('old'), build('new'));
      const cases = Array.from({ length: 12 }, (_, i) => ({ id: `case-${i}`, source: 'Synthetic' }));
      const plan = R.createPlan(p, cases, 10000000);
      const fixtures = plan.calls.map(c => {
        const request = { model: c.model, messages: [{ role: 'user', content: 'Synthetic' }] };
        return { id: c.id, request, tokenCertificate: { mode: 'synthetic-only', requestHash: digest(request), model: c.model, counter: 'synthetic-fixture-v1', inputTokens: 1, includesAllOverhead: true }, output: 'Synthetic', usage: { inputTokens: 1, outputTokens: 1 } };
      });
      const d = dir(); let j = new Journal(d, plan.hash, 10000000);
      const report = R.runSynthetic(p, cases, fixtures, 10000000, j);
      assert.equal(report.simulatedAllCalls, true); assert.equal(report.promotionEligible, false); j.close();
      j = new Journal(d, plan.hash, 10000000);
      assert.equal(j.snapshot().reservedMicrodollars, 6768000);
      assert.equal(j.snapshot().attempts.length, 72);
      assert.throws(() => R.runSynthetic(p, cases, fixtures, 10000000, j), /no replay/); j.close();
    });
  }
  console.log(`${passed} maintenance journal test groups passed`);
} finally {
  // Each test owns this unique temporary root; never delete external paths.
  if (path.dirname(root) !== path.resolve(os.tmpdir())) throw new Error('Unsafe test cleanup path');
  fs.rmSync(root, { recursive: true, force: true });
}
