'use strict';

const crypto = require('node:crypto');
const { FLAGS, validateProtocol } = require('./maintenance-evaluation-lib');
const { canonicalJson, seal } = require('./final-corpus-lib');

const MODELS = Object.freeze({ analyzer: 'claude-sonnet-4-6', critic: 'claude-sonnet-4-6', judge: 'gpt-6-luna' });
const OUTPUT = Object.freeze({ analyzer: 1200, critic: 1000, judge: 8000 });
// Integer microdollars per million tokens; Luna reserves the higher cache-write rate.
const RATES = Object.freeze({ analyzer: [3000000, 15000000], critic: [3000000, 15000000], judge: [125000, 500000] });
const INPUT = 40000;
const digest = value => crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
const budgetPolicy = () => clone({ version: 1, models: MODELS, outputCaps: OUTPUT, inputCap: INPUT, rates: RATES, mode: 'synthetic-only-no-refunds' });

function integer(value, name, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

function cost(stage, input, output) {
  if (!Object.hasOwn(RATES, stage)) throw new Error('Unknown stage');
  integer(input, 'input tokens', INPUT); integer(output, 'output tokens', OUTPUT[stage]);
  const [i, o] = RATES[stage];
  return Number((BigInt(input) * BigInt(i) + BigInt(output) * BigInt(o) + 999999n) / 1000000n);
}

class Budget {
  #limit; #reserved = 0; #attempts = new Map(); #halted = false;
  constructor(limitMicrodollars) {
    this.#limit = integer(limitMicrodollars, 'budget', 1000000000);
  }
  reserve(id, stage) {
    if (this.#halted) throw new Error('Budget halted');
    if (typeof id !== 'string' || !id || this.#attempts.has(id)) throw new Error('Duplicate or invalid attempt');
    const amount = cost(stage, INPUT, OUTPUT[stage]);
    if (amount > this.#limit - this.#reserved) { this.#halted = true; throw new Error('Budget exhausted before dispatch'); }
    this.#reserved += amount;
    this.#attempts.set(id, { id, stage, reservedMicrodollars: amount, status: 'reserved' });
    return amount;
  }
  settle(id, usage) {
    const attempt = this.#attempts.get(id);
    if (!attempt || attempt.status !== 'reserved') throw new Error('Attempt not pending');
    try {
      if (!keys(usage, ['inputTokens', 'outputTokens'])) throw new Error('Missing or unknown usage');
      attempt.actualMicrodollars = cost(attempt.stage, usage.inputTokens, usage.outputTokens);
      attempt.usage = clone(usage);
      attempt.status = 'accounted';
    } catch (error) {
      attempt.status = 'unknown-cost'; this.#halted = true; throw error;
    }
    // Never release a reservation: uncertainty and refunds cannot finance another call.
  }
  fail(id) {
    const attempt = this.#attempts.get(id);
    if (!attempt || attempt.status !== 'reserved') throw new Error('Attempt not pending');
    attempt.status = 'unknown-cost'; this.#halted = true;
  }
  snapshot() { return { limitMicrodollars: this.#limit, reservedMicrodollars: this.#reserved, halted: this.#halted, attempts: clone([...this.#attempts.values()]) }; }
}

function createPlan(protocol, cases, limitMicrodollars) {
  const result = validateProtocol(protocol);
  if (!result.valid) throw new Error(result.reasons.join('; '));
  integer(limitMicrodollars, 'budget', 1000000000);
  if (!Array.isArray(cases) || cases.length !== 12) throw new Error('Exactly 12 synthetic cases required');
  const ids = new Set();
  const frozen = cases.map(item => {
    if (!keys(item, ['id', 'source']) || typeof item.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(item.id) || ids.has(item.id)) throw new Error('Invalid or duplicate case');
    ids.add(item.id);
    if (typeof item.source !== 'string' || !item.source.trim() || item.source.length > 100000) throw new Error('Source missing or oversized; never truncate');
    return { id: item.id, sourceHash: digest(item.source), source: item.source };
  });
  const calls = [];
  for (const item of frozen) for (const arm of ['baseline', 'candidate']) for (const stage of ['analyzer', 'critic', 'judge']) {
    calls.push({ id: `${item.id}:${arm}:${stage}`, caseId: item.id, arm, stage, model: MODELS[stage], maxInputTokens: INPUT,
      maxOutputTokens: OUTPUT[stage], reservedMicrodollars: cost(stage, INPUT, OUTPUT[stage]) });
  }
  const maximumMicrodollars = calls.reduce((sum, call) => sum + call.reservedMicrodollars, 0);
  if (maximumMicrodollars > limitMicrodollars) throw new Error('Full plan exceeds budget');
  return seal({ v: 1, kind: 'maintenance-synthetic-plan', ...FLAGS, protocolHash: protocol.hash,
    buildBindings: { baseline: protocol.baseline.artifact, candidate: protocol.candidate.artifact },
    cases: frozen, calls, limitMicrodollars, maximumMicrodollars, pricingDate: '2026-11-14',
    pricingScope: 'Hypothetical standard API tokens only; excludes calibration, retries, hosting, taxes and premiums' });
}

function judgeRequest(system, user) {
  if (![system, user].every(s => typeof s === 'string' && s.trim())) throw new Error('Judge prompts required');
  if (system.length + user.length > 130000) throw new Error('Judge request oversized; never truncate');
  return { model: MODELS.judge, reasoning_effort: 'medium', max_completion_tokens: OUTPUT.judge,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
}

function parseJudgeResponse(response) {
  if (!response || typeof response.id !== 'string' || !response.id || response.model !== MODELS.judge || !Array.isArray(response.choices) || response.choices.length !== 1) throw new Error('Unexpected judge identity or choices');
  const choice = response.choices[0];
  if (choice.finish_reason !== 'stop' || choice.message?.refusal || choice.message?.tool_calls || typeof choice.message?.content !== 'string') throw new Error('Judge incomplete, refused or requested tools');
  const u = response.usage;
  if (!u || u.total_tokens !== u.prompt_tokens + u.completion_tokens) throw new Error('Missing or inconsistent judge usage');
  cost('judge', u.prompt_tokens, u.completion_tokens);
  const value = JSON.parse(choice.message.content);
  if (!keys(value, ['reason', 'verdict']) || !['pass', 'fail', 'unresolved'].includes(value.verdict) || typeof value.reason !== 'string' || !value.reason.trim()) throw new Error('Invalid synthetic judge verdict');
  return { value, usage: { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens }, responseHash: digest(response) };
}

function countSyntheticRequest(request, certificate) {
  if (!keys(certificate, ['mode', 'requestHash', 'model', 'counter', 'inputTokens', 'includesAllOverhead']) || certificate.mode !== 'synthetic-only' || certificate.requestHash !== digest(request) || certificate.model !== request?.model || certificate.counter !== 'synthetic-fixture-v1' || certificate.includesAllOverhead !== true) throw new Error('Missing exact-request synthetic token certificate; live counting unavailable');
  integer(certificate.inputTokens, 'complete request input tokens', INPUT);
  return { mode: 'synthetic-only', requestHash: certificate.requestHash, inputTokens: certificate.inputTokens, measuredProviderTokens: false, liveDispatchAllowed: false };
}

function runSynthetic(protocol, cases, fixtures, limitMicrodollars, journal = null) {
  const plan = createPlan(protocol, cases, limitMicrodollars);
  if (!Array.isArray(fixtures) || fixtures.length !== plan.calls.length) throw new Error('One explicit fixture per planned attempt required');
  if (journal !== null && (!(journal instanceof require('./maintenance-budget-journal').Journal) || journal.bindingHash() !== plan.hash || journal.snapshot().limitMicrodollars !== limitMicrodollars || journal.snapshot().attempts.length || journal.snapshot().halted)) throw new Error('Fresh matching synthetic journal required; no replay dispatch');
  const budget = journal || new Budget(limitMicrodollars);
  const records = [];
  let blocked = null;
  for (let index = 0; index < plan.calls.length; index++) {
    const call = plan.calls[index];
    const fixture = fixtures[index];
    if (!fixture || fixture.id !== call.id) { blocked = 'Missing, reordered or mismatched fixture'; break; }
    try {
      if (fixture.request?.model !== call.model) throw new Error('Synthetic request model mismatch');
      countSyntheticRequest(fixture.request, fixture.tokenCertificate);
    } catch (error) { blocked = error.message; break; }
    budget.reserve(call.id, call.stage);
    try {
      if (fixture.error) throw new Error('Synthetic transport failure');
      if (!fixture.output || typeof fixture.output !== 'string') throw new Error('Missing synthetic output');
      if (fixture.usage?.inputTokens > fixture.tokenCertificate.inputTokens) throw new Error('Usage exceeds synthetic request bound');
      budget.settle(call.id, fixture.usage);
      records.push({ id: call.id, provenance: 'synthetic-fixture-not-provider', fixtureHash: digest(fixture), outputHash: digest(fixture.output) });
    } catch (error) {
      if (budget.snapshot().attempts.at(-1).status === 'reserved') budget.fail(call.id);
      records.push({ id: call.id, provenance: 'synthetic-fixture-not-provider', failure: error.message });
      blocked = error.message; break;
    }
  }
  return seal({ v: 1, kind: 'maintenance-synthetic-run', ...FLAGS, planHash: plan.hash,
    simulatedAllCalls: !blocked && records.length === plan.calls.length, blocked, records, budget: budget.snapshot(),
    limitations: ['No provider calls or build execution occurred', 'Hashes are byte bindings, not authenticated provenance',
      'Token limits are simulated, not measured on actual full requests', 'No calibration, final grading, human review or release gate evidence'] });
}

module.exports = { Budget, budgetPolicy, cost, createPlan, judgeRequest, parseJudgeResponse, countSyntheticRequest, runSynthetic };
