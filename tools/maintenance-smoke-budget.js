'use strict';

// OFFLINE ONLY. This module cannot authorize or transmit a provider request.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { localPath } = require('./maintenance-local-path');
const { canonicalJson } = require('./final-corpus-lib');
const TASK = 'maintenance-paired-diagnostic-20261115';
const LIMIT = 20000000; // USD microdollars, independent of account spend settings.
const MODEL = 'claude-sonnet-4-6';
const IDS = ['baseline:analyzer', 'baseline:critic', 'candidate:analyzer', 'candidate:critic'];
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) &&
  JSON.stringify(Object.keys(v).sort()) === JSON.stringify([...keys].sort());
const hash = v => crypto.createHash('sha256').update(canonicalJson(v)).digest('hex');
const clone = v => JSON.parse(canonicalJson(v));
function requireThat(ok, message) { if (!ok) throw new Error(message); }
function integer(n, max = Number.MAX_SAFE_INTEGER) { return Number.isSafeInteger(n) && n >= 0 && n <= max; }
function isHash(h) { return typeof h === 'string' && /^[a-f0-9]{64}$/.test(h); }
function readBinding(b) {
  requireThat(exact(b, ['path', 'sha256', 'bytes']) && isHash(b.sha256) && integer(b.bytes, 1000000000) && b.bytes > 0, 'Invalid file binding');
  requireThat(typeof b.path === 'string' && path.isAbsolute(b.path), 'Absolute local file required');
  const p = localPath(b.path);
  const fd = fs.openSync(p, 'r');
  try {
    const stat = fs.fstatSync(fd);
    requireThat(stat.isFile() && stat.size === b.bytes, 'Bound file size changed');
    const h = crypto.createHash('sha256'), buffer = Buffer.alloc(65536);
    let size = 0, count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) { h.update(buffer.subarray(0, count)); size += count; }
    requireThat(size === b.bytes && h.digest('hex') === b.sha256, 'Bound file bytes changed');
  } finally { fs.closeSync(fd); }
}
function validate(spec, verifyFiles = true) {
  requireThat(exact(spec, ['v', 'task', 'currency', 'limitMicrodollars', 'bindings', 'provider', 'billing', 'expiresAt']), 'Unexpected plan fields');
  requireThat(spec.v === 1 && spec.task === TASK && spec.currency === 'USD' && spec.limitMicrodollars === LIMIT, 'Wrong task or budget');
  requireThat(exact(spec.bindings, ['baselineArtifact', 'baselineRelease', 'candidateArtifact', 'candidateRelease', 'document', 'harness']), 'Exact six file bindings required');
  if (verifyFiles) Object.values(spec.bindings).forEach(readBinding);
  const p = spec.provider;
  requireThat(exact(p, ['accountScopeHash', 'apiVersion', 'model', 'maxInputTokens', 'inputMicrodollarsPerMillion', 'outputMicrodollarsPerMillion', 'metadataEvidence', 'pricingEvidence', 'tier', 'region', 'cache']), 'Unknown provider policy');
  requireThat(isHash(p.accountScopeHash) && p.apiVersion === '2023-06-01', 'Exact account scope and reviewed API version required');
  requireThat(p.model === MODEL && p.maxInputTokens === 1000000 && p.inputMicrodollarsPerMillion === 3000000 && p.outputMicrodollarsPerMillion === 15000000 && p.tier === 'standard' && p.region === 'global' && p.cache === 'disabled', 'Unreviewed model, window or price policy');
  requireThat(isHash(p.metadataEvidence) && isHash(p.pricingEvidence), 'Provider evidence bindings required');
  const b = spec.billing;
  requireThat(exact(b, ['taxUpperBoundBps', 'feeUpperBoundMicrodollars', 'hostingUpperBoundMicrodollars', 'evidenceHash']), 'Unknown billing fields');
  requireThat(integer(b.taxUpperBoundBps, 100000) && integer(b.feeUpperBoundMicrodollars, LIMIT) && integer(b.hostingUpperBoundMicrodollars, LIMIT) && isHash(b.evidenceHash), 'Unknown tax, fees or hosting: stop');
  requireThat(typeof spec.expiresAt === 'string' && new Date(spec.expiresAt).toISOString() === spec.expiresAt, 'Canonical expiry required');
  const calls = IDS.map(id => {
    const outputCap = id.endsWith('analyzer') ? 1200 : 1000;
    return { id, outputCap, reserve: Number((BigInt(p.maxInputTokens) * BigInt(p.inputMicrodollarsPerMillion) + BigInt(outputCap) * BigInt(p.outputMicrodollarsPerMillion) + 999999n) / 1000000n) };
  });
  const api = calls.reduce((s, c) => s + c.reserve, 0);
  const subtotal = api + b.feeUpperBoundMicrodollars + b.hostingUpperBoundMicrodollars;
  const allIn = Number((BigInt(subtotal) * BigInt(10000 + b.taxUpperBoundBps) + 9999n) / 10000n);
  requireThat(allIn <= LIMIT, 'Complete four-call all-in reservation exceeds task budget');
  return { calls, apiMicrodollars: api, allInMicrodollars: allIn };
}
function prepare(spec) {
  const budget = validate(spec);
  return { kind: 'offline-paired-smoke-plan', spec: clone(spec), planHash: hash(spec), ...budget,
    providerEvidenceAuthenticated: false, billingEvidenceAuthenticated: false,
    requestBuildAuthenticated: false, finalPaidPlanApproved: false,
    liveDispatchAllowed: false, evaluationPassed: false, promotionEligible: false };
}
function rootPath() {
  return localPath(path.join(os.userInfo().homedir, 'AppData', 'Local', 'ToSGuardian', TASK), { allowMissing: true });
}
function checkRequest(request, cap) {
  requireThat(exact(request, ['url', 'body']) && request.url === 'https://api.anthropic.com/v1/messages', 'Only pinned provider endpoint permitted');
  const b = request.body;
  requireThat(exact(b, ['model', 'system', 'messages', 'max_tokens']) && b.model === MODEL && b.max_tokens === cap, 'Unapproved model/output/options');
  requireThat(typeof b.system === 'string' && b.system.trim() && Array.isArray(b.messages) && b.messages.length === 1 && exact(b.messages[0], ['role', 'content']) && b.messages[0].role === 'user' && typeof b.messages[0].content === 'string' && b.messages[0].content.trim(), 'Plain text system and one user message required');
  requireThat(Buffer.byteLength(b.system, 'utf8') + Buffer.byteLength(b.messages[0].content, 'utf8') <= 150000, 'Request too large; never truncate');
  // Byte rejection is operational, NOT a tokenizer bound. Reserve full window.
  return hash(request);
}
class Registry {
  #fd; #lockFd; #lock; #spec; #planHash; #calls; #events = []; #poisoned = false; #closed = false;
  constructor(spec, mode = 'open') {
    requireThat(mode === 'initialize' || mode === 'open', 'Explicit registry mode required');
    this.#spec = clone(spec); this.#planHash = hash(spec); this.#calls = validate(this.#spec).calls;
    const root = rootPath();
    if (mode === 'initialize') fs.mkdirSync(root, { recursive: true });
    requireThat(fs.statSync(localPath(root)).isDirectory(), 'Registry directory absent');
    this.#lock = localPath(path.join(root, 'exclusive.lock'), { allowMissing: true });
    this.#lockFd = fs.openSync(this.#lock, 'wx');
    try {
      fs.writeFileSync(this.#lockFd, TASK); fs.fsyncSync(this.#lockFd);
      const file = localPath(path.join(root, 'registry.jsonl'), { allowMissing: mode === 'initialize' });
      this.#fd = fs.openSync(file, mode === 'initialize' ? 'wx+' : 'r+');
      if (mode === 'initialize') this.#append({ type: 'header', task: TASK, planHash: this.#planHash, spec: this.#spec });
      else {
        requireThat(fs.fstatSync(this.#fd).isFile() && fs.fstatSync(this.#fd).size <= 1000000, 'Invalid registry file');
        const text = fs.readFileSync(this.#fd, 'utf8');
        requireThat(text.endsWith('\n'), 'Partial journal; manual reconciliation required');
        for (const line of text.slice(0, -1).split('\n')) {
          const row = JSON.parse(line);
          requireThat(exact(row, ['sequence', 'previous', 'event', 'hash']) && row.sequence === this.#events.length && row.previous === (this.#events.at(-1)?.hash ?? null) && row.hash === hash({ sequence: row.sequence, previous: row.previous, event: row.event }), 'Journal integrity failure');
          this.#validateEvent(row.event); this.#events.push(row);
        }
        requireThat(this.#events.length > 0 && !this.#pending() && !this.#halted(), 'Unresolved/halted run: no recovery or replay');
      }
    } catch (e) {
      if (this.#fd !== undefined) fs.closeSync(this.#fd);
      fs.closeSync(this.#lockFd); this.#closed = true; throw e; // Keep lock.
    }
  }
  #pending() { const last = this.#events.at(-1)?.event; return last?.type === 'reserve' ? last : null; }
  #halted() { return this.#events.some(r => r.event.type === 'unknown'); }
  #ready() { requireThat(!this.#closed && !this.#poisoned && !this.#halted(), 'Closed, poisoned or halted registry'); }
  #validateEvent(e) {
    if (!this.#events.length) {
      requireThat(exact(e, ['type', 'task', 'planHash', 'spec']) && e.type === 'header' && e.task === TASK && e.planHash === this.#planHash && hash(e.spec) === this.#planHash, 'Registry bound to another plan'); return;
    }
    requireThat(!this.#halted(), 'Events after halt forbidden');
    const pending = this.#pending();
    if (e.type === 'reserve') {
      const count = this.#events.filter(r => r.event.type === 'reserve').length;
      requireThat(exact(e, ['type', 'id', 'requestHash', 'reserve', 'dependencyOutputHash']) && !pending && count < 4 && e.id === this.#calls[count].id && e.reserve === this.#calls[count].reserve && isHash(e.requestHash), 'Duplicate, out-of-order or unpriced reservation');
      const dependency = e.id.endsWith('critic') ? this.#events.at(-1).event.outputHash : null;
      requireThat(e.dependencyOutputHash === dependency, 'Critic requires preceding Analyzer output binding');
    } else {
      requireThat(pending && e.id === pending.id, 'No matching pending attempt');
      if (e.type === 'unknown') requireThat(exact(e, ['type', 'id']), 'Unknown failure fields');
      else {
        requireThat(exact(e, ['type', 'id', 'inputTokens', 'outputTokens', 'outputHash']) && e.type === 'settle' && integer(e.inputTokens, 1000000) && integer(e.outputTokens, this.#calls.find(c => c.id === e.id).outputCap) && isHash(e.outputHash), 'Missing or out-of-bound usage');
      }
    }
  }
  #append(event) {
    this.#ready(); this.#validateEvent(event);
    const body = { sequence: this.#events.length, previous: this.#events.at(-1)?.hash ?? null, event };
    const row = { ...body, hash: hash(body) }, bytes = Buffer.from(canonicalJson(row) + '\n');
    try {
      const end = fs.fstatSync(this.#fd).size;
      for (let offset = 0; offset < bytes.length;) {
        const written = fs.writeSync(this.#fd, bytes, offset, bytes.length - offset, end + offset);
        requireThat(written > 0, 'Write made no progress'); offset += written;
      }
      fs.fsyncSync(this.#fd); this.#events.push(row);
    } catch (e) { this.#poisoned = true; throw e; }
  }
  reserve(id, request, dependencyOutputHash = null) {
    this.#ready(); validate(this.#spec); // Rehash artifacts/input immediately before each attempt.
    requireThat(Date.now() < Date.parse(this.#spec.expiresAt), 'Plan expired');
    const call = this.#calls.find(c => c.id === id); requireThat(call, 'Unknown call');
    const requestHash = checkRequest(request, call.outputCap);
    this.#append({ type: 'reserve', id, requestHash, reserve: call.reserve, dependencyOutputHash });
    return { id, requestHash, reservedMicrodollars: call.reserve, requestBuildAuthenticated: false, liveDispatchAllowed: false };
  }
  settle(id, usage, outputHash) {
    this.#ready();
    requireThat(this.#pending()?.id === id, 'No matching pending attempt');
    try {
      requireThat(exact(usage, ['inputTokens', 'outputTokens']), 'Unknown usage fields');
      this.#append({ type: 'settle', id, ...usage, outputHash });
    } catch (e) {
      if (!this.#poisoned) this.#append({ type: 'unknown', id });
      throw e;
    }
  }
  fail(id) { this.#ready(); this.#append({ type: 'unknown', id }); }
  snapshot() { return { task: TASK, planHash: this.#planHash, events: clone(this.#events), halted: this.#halted(), liveDispatchAllowed: false, evaluationPassed: false, promotionEligible: false }; }
  close() {
    requireThat(!this.#closed, 'Already closed');
    const unresolved = this.#pending() || this.#poisoned || this.#halted();
    fs.closeSync(this.#fd); fs.closeSync(this.#lockFd); this.#closed = true;
    if (!unresolved) fs.unlinkSync(this.#lock); // Keep failed locks; no automatic recovery.
  }
}
async function dispatch() { throw new Error('Paid transport disabled: reviewed implementation and final exact plan approval still required'); }
module.exports = { TASK, prepare, Registry, dispatch };
