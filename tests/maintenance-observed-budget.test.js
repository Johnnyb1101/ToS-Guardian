'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { canonicalJson, digest, seal } = require('../tools/final-corpus-lib');
const { createObservedBudgetPlan, openObservedBudget } = require('../tools/maintenance-observed-budget');

const requestHash = digest('exact request');
function input() {
  return {
    approvalId: 'test-approval', planHash: digest('approved protocols and rates'),
    limitMicrodollars: 15, overheadMicrodollars: 5,
    calls: ['first', 'second'].map(id => ({
      id, maxInputTokens: 3, maxOutputTokens: 2,
      inputMicrodollarsPerMillion: 500001, outputMicrodollarsPerMillion: 750000,
    })),
  };
}

const plan = createObservedBudgetPlan(input());
function fixture(t) {
  const temp = path.resolve(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(temp, 'tos-observed-budget-'));
  assert.equal(path.dirname(dir), temp);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const name = path.join(dir, `maintenance-observed-budget-${plan.approvalId}`);
  return { dir, log: `${name}.jsonl`, lock: `${name}.lock` };
}

test('preflight seals a defensive copy and rounds each token charge up', () => {
  const provided = input();
  const approved = createObservedBudgetPlan(provided);
  assert.equal(approved.totalMicrodollars, 13);
  assert.equal(approved.hash, plan.hash);
  provided.calls[0].maxInputTokens = 1;
  assert.equal(approved.calls[0].maxInputTokens, 3);
  assert.throws(() => { approved.calls[0].maxInputTokens = 1; }, TypeError);
  assert.throws(() => approved.calls.reverse(), TypeError);
  assert.throws(() => createObservedBudgetPlan({ ...input(), limitMicrodollars: 12 }), /Full observed reservation/);
  assert.throws(() => createObservedBudgetPlan({ ...input(), calls: [input().calls[0], input().calls[0]] }), /budget call/);
  assert.throws(() => createObservedBudgetPlan({ ...input(), approvalId: '../escape' }), /budget plan/);
  const huge = input();
  huge.limitMicrodollars = Number.MAX_SAFE_INTEGER;
  huge.calls[0].maxInputTokens = Number.MAX_SAFE_INTEGER;
  huge.calls[0].inputMicrodollarsPerMillion = Number.MAX_SAFE_INTEGER;
  assert.throws(() => createObservedBudgetPlan(huge), /Full observed reservation/);
});

if (process.platform !== 'win32') {
  test('journal rejects unverified platforms', () => assert.throws(() => openObservedBudget(os.tmpdir(), plan), /Windows/));
} else {
  test('all planned funds remain reserved and the exact request persists across restart', t => {
    const { dir } = fixture(t);
    let budget = openObservedBudget(dir, plan);
    assert.equal(budget.snapshot().reservedMicrodollars, 13);
    assert.throws(() => budget.reserve('second', requestHash), /Next planned/);
    assert.throws(() => budget.reserve('first', 'not-a-hash'), /exact request hash/);
    assert.equal(budget.reserve('first', requestHash), 4);
    assert.throws(() => budget.reserve('second', requestHash), /Unresolved/);
    const usage = { inputTokens: 1, outputTokens: 0 };
    budget.settle('first', usage);
    usage.inputTokens = 0;
    const before = budget.snapshot();
    assert.deepEqual(before.attempts, [{ id: 'first', requestHash, reservedMicrodollars: 4, status: 'settled', usage: { inputTokens: 1, outputTokens: 0 }, actualMicrodollars: 1 }]);
    assert.equal(before.reservedMicrodollars, 13);
    budget.close();
    budget = openObservedBudget(dir, plan);
    assert.deepEqual(budget.snapshot(), before);
    assert.throws(() => budget.reserve('first', requestHash), /Next planned/);
    budget.reserve('second', requestHash);
    budget.settle('second', { inputTokens: 3, outputTokens: 2 });
    budget.close();
    budget = openObservedBudget(dir, plan);
    assert.equal(budget.snapshot().attempts.length, 2);
    assert.throws(() => budget.reserve('second', requestHash), /Next planned/);
    budget.close();
  });

  test('exclusive process lock and unresolved attempt survive a crash', t => {
    const { dir, lock } = fixture(t);
    const modulePath = require.resolve('../tools/maintenance-observed-budget');
    const childScript = `const { openObservedBudget } = require(${JSON.stringify(modulePath)});\n`
      + `const budget = openObservedBudget(${JSON.stringify(dir)}, ${JSON.stringify(plan)});\n`
      + `budget.reserve('first', ${JSON.stringify(requestHash)});`;
    const runChild = () => spawnSync(process.execPath, ['-e', childScript], { encoding: 'utf8' });
    const budget = openObservedBudget(dir, plan);
    try {
      const blocked = runChild();
      assert.equal(blocked.status, 1);
      assert.match(blocked.stderr, /EEXIST/);
    } finally { budget.close(); }
    const crashed = runChild();
    assert.equal(crashed.status, 0, crashed.stderr);
    assert.throws(() => openObservedBudget(dir, plan), /EEXIST/);
    fs.unlinkSync(lock); // Simulate operator removal without resolving the journal.
    assert.throws(() => openObservedBudget(dir, plan), /Unresolved/);
    assert.ok(fs.existsSync(lock));
  });

  test('changed rates cannot reopen an approval, even when the altered plan is sealed', t => {
    const { dir, lock } = fixture(t);
    openObservedBudget(dir, plan).close();
    const changed = input();
    changed.calls[0].inputMicrodollarsPerMillion++;
    const forged = { ...plan, calls: changed.calls };
    assert.throws(() => openObservedBudget(dir, forged), /seal mismatch/);
    assert.equal(fs.existsSync(lock), false);
    assert.throws(() => openObservedBudget(dir, createObservedBudgetPlan(changed)), /plan mismatch/);
    assert.ok(fs.existsSync(lock));
  });

  for (const damage of ['partial', 'hash', 'transition']) {
    test(`journal locks on ${damage} damage`, t => {
      const { dir, lock, log } = fixture(t);
      openObservedBudget(dir, plan).close();
      const header = JSON.parse(fs.readFileSync(log, 'utf8'));
      if (damage === 'partial') fs.appendFileSync(log, '{');
      if (damage === 'hash') fs.writeFileSync(log, canonicalJson({ ...header, hash: digest('tampered') }) + '\n');
      if (damage === 'transition') {
        const record = seal({ sequence: 1, previous: header.hash, event: { id: 'second', requestHash, type: 'reserve' } });
        fs.appendFileSync(log, canonicalJson(record) + '\n');
      }
      assert.throws(() => openObservedBudget(dir, plan), /Incomplete|integrity mismatch|Next planned/);
      assert.ok(fs.existsSync(lock));
    });
  }

  for (const [name, usage] of [['unknown', undefined], ['over-cap', { inputTokens: 4, outputTokens: 0 }]]) {
    test(`${name} usage halts durably and keeps all reservations`, t => {
      const { dir } = fixture(t);
      let budget = openObservedBudget(dir, plan);
      budget.reserve('first', requestHash);
      assert.throws(() => budget.settle('first', usage), /Missing, invalid or over-cap/);
      budget.close();
      budget = openObservedBudget(dir, plan);
      assert.equal(budget.snapshot().attempts[0].status, 'unknown-cost');
      assert.equal(budget.snapshot().reservedMicrodollars, 13);
      assert.throws(() => budget.reserve('second', requestHash), /halted/);
      budget.close();
    });
  }

  test('failed sync prevents reserve from returning and keeps the lock after close', t => {
    const { dir, lock } = fixture(t);
    const budget = openObservedBudget(dir, plan);
    const fsync = fs.fsyncSync;
    try {
      fs.fsyncSync = () => { throw new Error('injected sync failure'); };
      assert.throws(() => budget.reserve('first', requestHash), /injected sync failure/);
    } finally { fs.fsyncSync = fsync; }
    assert.throws(() => budget.close(), /lock retained/);
    assert.ok(fs.existsSync(lock));
    assert.throws(() => openObservedBudget(dir, plan), /EEXIST/);
  });
}
