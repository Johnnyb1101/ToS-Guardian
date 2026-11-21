'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { canonicalJson, digest, isHash, seal } = require('./final-corpus-lib');
const { localPath } = require('./maintenance-local-path');

const PLAN_KEYS = ['approvalId', 'planHash', 'limitMicrodollars', 'overheadMicrodollars', 'calls'];
const CALL_KEYS = ['id', 'maxInputTokens', 'maxOutputTokens', 'inputMicrodollarsPerMillion', 'outputMicrodollarsPerMillion'];
const USAGE_KEYS = ['inputTokens', 'outputTokens'];
const JOURNAL_MAX_BYTES = 10000000;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const nonnegativeInteger = value => Number.isSafeInteger(value) && value >= 0;

function cost(call, inputTokens, outputTokens) {
  const input = BigInt(inputTokens) * BigInt(call.inputMicrodollarsPerMillion);
  const output = BigInt(outputTokens) * BigInt(call.outputMicrodollarsPerMillion);
  return (input + 999999n) / 1000000n + (output + 999999n) / 1000000n;
}

function maximumCost(call) {
  return cost(call, call.maxInputTokens, call.maxOutputTokens);
}

function createObservedBudgetPlan(input) {
  const copy = JSON.parse(canonicalJson(input));
  if (!exact(copy, PLAN_KEYS) || typeof copy.approvalId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(copy.approvalId)
      || !isHash(copy.planHash) || !nonnegativeInteger(copy.limitMicrodollars) || copy.limitMicrodollars === 0
      || !nonnegativeInteger(copy.overheadMicrodollars) || !Array.isArray(copy.calls) || copy.calls.length === 0) {
    throw new Error('Invalid observed budget plan');
  }
  const ids = new Set();
  let total = BigInt(copy.overheadMicrodollars);
  for (const call of copy.calls) {
    if (!exact(call, CALL_KEYS) || typeof call.id !== 'string' || !call.id.trim() || ids.has(call.id)
        || !CALL_KEYS.slice(1).every(key => nonnegativeInteger(call[key]))) throw new Error('Invalid observed budget call');
    ids.add(call.id);
    total += maximumCost(call);
  }
  if (total > MAX_SAFE || total > BigInt(copy.limitMicrodollars)) throw new Error('Full observed reservation exceeds approved limit');
  const plan = seal({ ...copy, totalMicrodollars: Number(total) });
  plan.calls.forEach(Object.freeze);
  Object.freeze(plan.calls);
  return Object.freeze(plan);
}

function checkBudgetPlan(value) {
  const copy = JSON.parse(canonicalJson(value));
  if (!exact(copy, [...PLAN_KEYS, 'totalMicrodollars', 'hash'])) throw new Error('Sealed observed budget plan required');
  const { totalMicrodollars, hash, ...input } = copy;
  const plan = createObservedBudgetPlan(input);
  if (hash !== plan.hash || totalMicrodollars !== plan.totalMicrodollars) throw new Error('Observed budget plan seal mismatch');
  return plan;
}

class ObservedBudget {
  #plan;
  #attempts = [];
  #halted = false;
  #fd;
  #lockFd;
  #lock;
  #previous = null;
  #sequence = 0;
  #closed = false;
  #poisoned = false;

  constructor(directory, budgetPlan) {
    this.#plan = checkBudgetPlan(budgetPlan);
    const root = localPath(directory);
    if (!fs.statSync(root).isDirectory()) throw new Error('Existing local observed budget directory required');
    const name = `maintenance-observed-budget-${this.#plan.approvalId}`;
    this.#lock = localPath(path.join(root, `${name}.lock`), { allowMissing: true });
    this.#lockFd = fs.openSync(this.#lock, 'wx', 0o600);
    try {
      fs.writeFileSync(this.#lockFd, 'Exclusive observed evaluation budget lock. Reconcile stale locks before removing them.\n');
      fs.fsyncSync(this.#lockFd);
      const file = localPath(path.join(root, `${name}.jsonl`), { allowMissing: true });
      if (fs.existsSync(file)) {
        this.#fd = fs.openSync(file, 'r+');
        this.#replay();
      } else {
        this.#fd = fs.openSync(file, 'wx+', 0o600);
        this.#append(this.#header());
      }
    } catch (error) {
      this.#releaseDescriptors();
      throw error;
    }
  }

  #header() {
    return { type: 'header', mode: 'observed-v1', budgetPlanHash: this.#plan.hash, reservedMicrodollars: this.#plan.totalMicrodollars };
  }

  #replay() {
    const stat = fs.fstatSync(this.#fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > JOURNAL_MAX_BYTES) throw new Error('Invalid observed budget journal file');
    const bytes = fs.readFileSync(this.#fd, 'utf8');
    if (!bytes.endsWith('\n')) throw new Error('Incomplete observed budget journal');
    for (const line of bytes.slice(0, -1).split('\n')) {
      const record = JSON.parse(line);
      if (!exact(record, ['sequence', 'previous', 'event', 'hash']) || canonicalJson(record) !== line
          || record.sequence !== this.#sequence || record.previous !== this.#previous
          || record.hash !== digest({ sequence: record.sequence, previous: record.previous, event: record.event })) {
        throw new Error('Observed budget journal integrity mismatch');
      }
      const { event } = record;
      if (this.#sequence === 0) {
        if (canonicalJson(event) !== canonicalJson(this.#header())) throw new Error('Observed budget plan mismatch');
      } else {
        this.#apply(event);
      }
      this.#previous = record.hash;
      this.#sequence++;
    }
    if (this.#pending()) throw new Error('Unresolved observed attempt requires reconciliation');
  }

  #pending() {
    const last = this.#attempts.at(-1);
    return last?.status === 'reserved' ? last : undefined;
  }

  #ready() {
    if (this.#closed || this.#poisoned) throw new Error('Observed budget closed or poisoned');
  }

  #append(event) {
    const record = seal({ sequence: this.#sequence, previous: this.#previous, event });
    const bytes = Buffer.from(canonicalJson(record) + '\n');
    try {
      const end = fs.fstatSync(this.#fd).size;
      if (end + bytes.length > JOURNAL_MAX_BYTES) throw new Error('Observed budget journal size exceeded');
      for (let offset = 0; offset < bytes.length;) {
        const written = fs.writeSync(this.#fd, bytes, offset, bytes.length - offset, end + offset);
        if (written <= 0) throw new Error('Observed budget journal write made no progress');
        offset += written;
      }
      fs.fsyncSync(this.#fd);
      this.#previous = record.hash;
      this.#sequence++;
    } catch (error) {
      this.#poisoned = true;
      throw error;
    }
  }

  #requireNext(id, requestHash) {
    if (this.#halted) throw new Error('Observed budget halted');
    if (this.#pending()) throw new Error('Unresolved observed attempt');
    const call = this.#plan.calls[this.#attempts.length];
    if (!call || call.id !== id || !isHash(requestHash)) throw new Error('Next planned observed call and exact request hash required');
    return call;
  }

  #requirePending(id) {
    const attempt = this.#pending();
    if (!attempt || attempt.id !== id) throw new Error('Matching pending observed attempt required');
    return attempt;
  }

  #validUsage(usage) {
    const call = this.#plan.calls[this.#attempts.length - 1];
    return exact(usage, USAGE_KEYS) && nonnegativeInteger(usage.inputTokens) && usage.inputTokens <= call.maxInputTokens
      && nonnegativeInteger(usage.outputTokens) && usage.outputTokens <= call.maxOutputTokens;
  }

  #apply(event) {
    if (exact(event, ['type', 'id', 'requestHash']) && event.type === 'reserve') {
      const call = this.#requireNext(event.id, event.requestHash);
      const reservedMicrodollars = Number(maximumCost(call));
      this.#attempts.push({ id: event.id, requestHash: event.requestHash, reservedMicrodollars, status: 'reserved' });
      return reservedMicrodollars;
    }
    if (exact(event, ['type', 'id', 'usage']) && event.type === 'settle') {
      const attempt = this.#requirePending(event.id);
      if (!this.#validUsage(event.usage)) throw new Error('Invalid observed usage in journal');
      const call = this.#plan.calls[this.#attempts.length - 1];
      attempt.status = 'settled';
      attempt.usage = event.usage;
      attempt.actualMicrodollars = Number(cost(call, event.usage.inputTokens, event.usage.outputTokens));
      return;
    }
    if (exact(event, ['type', 'id']) && event.type === 'fail') {
      this.#requirePending(event.id).status = 'unknown-cost';
      this.#halted = true;
      return;
    }
    throw new Error('Unsupported observed budget journal event');
  }

  reserve(id, requestHash) {
    this.#ready();
    this.#requireNext(id, requestHash);
    const event = { type: 'reserve', id, requestHash };
    this.#append(event);
    return this.#apply(event);
  }

  settle(id, usage) {
    this.#ready();
    this.#requirePending(id);
    let copy;
    try { copy = JSON.parse(canonicalJson(usage)); } catch { /* Unusable usage must durably halt the budget. */ }
    if (!this.#validUsage(copy)) {
      this.fail(id);
      throw new Error('Missing, invalid or over-cap observed usage');
    }
    const event = { type: 'settle', id, usage: copy };
    this.#append(event);
    this.#apply(event);
  }

  fail(id) {
    this.#ready();
    this.#requirePending(id);
    const event = { type: 'fail', id };
    this.#append(event);
    this.#apply(event);
  }

  snapshot() {
    this.#ready();
    return {
      limitMicrodollars: this.#plan.limitMicrodollars,
      overheadMicrodollars: this.#plan.overheadMicrodollars,
      reservedMicrodollars: this.#plan.totalMicrodollars,
      halted: this.#halted,
      attempts: structuredClone(this.#attempts),
    };
  }

  #releaseDescriptors() {
    this.#closed = true;
    try { if (this.#fd !== undefined) fs.closeSync(this.#fd); }
    finally { fs.closeSync(this.#lockFd); }
  }

  close() {
    if (this.#closed) throw new Error('Observed budget closed');
    this.#releaseDescriptors();
    if (this.#poisoned || this.#pending()) throw new Error('Poisoned or unresolved observed budget requires reconciliation; lock retained');
    fs.unlinkSync(localPath(this.#lock));
  }
}

function openObservedBudget(directory, budgetPlan) {
  return new ObservedBudget(directory, budgetPlan);
}

module.exports = { createObservedBudgetPlan, openObservedBudget };
