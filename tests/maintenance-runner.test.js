'use strict';

const assert = require('node:assert/strict');
const R = require('../tools/maintenance-runner-lib');
const M = require('../tools/maintenance-evaluation-lib');
const C = require('../tools/final-corpus-lib');
const { makeRelease } = require('./final-test-fixtures');
const { releaseConfigHash, checkAuthorization } = require('../tools/sites-lib');
const clone = x => JSON.parse(JSON.stringify(x));
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok ${name}`); }
function build(seed) {
  const release = makeRelease([]);
  release.config.policy.versions.serverPipeline = C.hashText(seed);
  release.config.policy.cache = { shared: 'disabled' };
  release.configHash = releaseConfigHash(release.config);
  return { release, artifact: { sha256: C.hashText(seed), bytes: 1 }, runtime: { node: 'synthetic', npm: 'synthetic', platform: 'synthetic', arch: 'synthetic' } };
}
const protocol = M.createProtocol(build('old'), build('new'));
const cases = Array.from({ length: 12 }, (_, i) => ({ id: `case-${i}`, source: `Synthetic policy ${i}, not a real document.` }));
const plan = R.createPlan(protocol, cases, 10000000);
const fixtures = plan.calls.map(call => {
  const request = { model: call.model, messages: [{ role: 'user', content: 'Synthetic request' }] };
  return { id: call.id, request, tokenCertificate: { mode: 'synthetic-only', requestHash: C.digest(request), model: call.model, counter: 'synthetic-fixture-v1', inputTokens: 100, includesAllOverhead: true }, output: 'Synthetic output', usage: { inputTokens: 100, outputTokens: 50 } };
});
function response() { return { id: 'synthetic-response', model: 'gpt-6-luna', choices: [{ finish_reason: 'stop', message: { content: '{"verdict":"pass","reason":"Synthetic fixture only"}' } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }; }

test('72 bounded calls and exact conservative API-only maximum', () => {
  assert.equal(plan.calls.length, 72); assert.equal(plan.maximumMicrodollars, 6768000);
  assert.throws(() => R.createPlan(protocol, cases, 6767999), /exceeds/);
  assert.equal(R.createPlan(protocol, cases, 6768000).maximumMicrodollars, 6768000);
});
test('invalid budgets, stages and usage cannot price as zero', () => {
  for (const value of [NaN, Infinity, -1, 1.1, '10', Number.MAX_SAFE_INTEGER]) assert.throws(() => new R.Budget(value));
  assert.throws(() => R.cost('other', 1, 1));
  for (const value of [-1, 40001, NaN, undefined, '1']) assert.throws(() => R.cost('judge', value, 1));
  assert.throws(() => R.cost('judge', 1, 8001));
});
test('reservation precedes work, cannot be reused, released or exceeded', () => {
  const budget = new R.Budget(138000);
  assert.equal(budget.reserve('a', 'analyzer'), 138000);
  assert.throws(() => budget.reserve('a', 'analyzer'));
  budget.settle('a', { inputTokens: 1, outputTokens: 1 });
  assert.equal(budget.snapshot().reservedMicrodollars, 138000);
  assert.throws(() => budget.settle('a', { inputTokens: 1, outputTokens: 1 }));
  assert.throws(() => budget.reserve('b', 'analyzer'), /exhausted/);
  assert.equal(budget.snapshot().attempts.length, 1);
});
test('missing, excess and delimiter-collision usage halts with full charge reserved', () => {
  for (const usage of [null, {}, { 'inputTokens,outputTokens': 1 }, { inputTokens: 40001, outputTokens: 0 }, { inputTokens: 1, outputTokens: 8001 }]) {
    const b = new R.Budget(10000000); b.reserve('j', 'judge');
    assert.throws(() => b.settle('j', usage));
    assert.equal(b.snapshot().reservedMicrodollars, 9000);
    assert.equal(b.snapshot().attempts[0].status, 'unknown-cost');
    assert.throws(() => b.reserve('next', 'judge'), /halted/);
  }
});
test('snapshots cannot mutate private reservations', () => {
  const b = new R.Budget(10000000); b.reserve('a', 'analyzer');
  b.snapshot().attempts[0].status = 'accounted'; b.fail('a');
  assert.equal(b.snapshot().halted, true); assert.throws(() => b.reserve('b', 'critic'));
});
test('case coverage and fixed release invariants fail closed', () => {
  assert.throws(() => R.createPlan(protocol, cases.slice(1), 10000000));
  const duplicate = clone(cases); duplicate[1].id = duplicate[0].id;
  assert.throws(() => R.createPlan(protocol, duplicate, 10000000));
  const oversize = clone(cases); oversize[0].source = 'x'.repeat(100001);
  assert.throws(() => R.createPlan(protocol, oversize, 10000000));
  const invalid = clone(protocol); invalid.candidate.artifact.sha256 = C.hashText('changed');
  assert.throws(() => R.createPlan(invalid, cases, 10000000));
});
test('separate judge request uses completion cap including reasoning, no transport', () => {
  const request = R.judgeRequest('Synthetic rubric', 'Synthetic source and answer');
  assert.equal(request.max_completion_tokens, 8000); assert.equal(request.max_tokens, undefined);
  assert.equal(request.reasoning_effort, 'medium'); assert.equal(request.model, 'gpt-6-luna');
  assert.throws(() => R.judgeRequest('', 'x')); assert.throws(() => R.judgeRequest('x', 'x'.repeat(130000)));
});
test('judge refuses malformed, truncated, refused, wrong-model and unpriced responses', () => {
  assert.equal(R.parseJudgeResponse(response()).value.verdict, 'pass');
  for (const mutate of [r => { r.model = 'different'; }, r => { r.choices[0].finish_reason = 'length'; }, r => { r.choices[0].message.refusal = 'refused'; }, r => { r.choices[0].message.tool_calls = []; }, r => { delete r.usage; }, r => { r.usage.total_tokens = 0; }, r => { r.choices[0].message.content = '{"reason,verdict":"pass"}'; }, r => { r.choices[0].message.content = '```json\n{}\n```'; }, r => { r.choices.push(r.choices[0]); }]) {
    const r = response(); mutate(r); assert.throws(() => R.parseJudgeResponse(r));
  }
});
test('token certificates bind full request and overhead, remain synthetic and reject unknown limits', () => {
  const request = R.judgeRequest('system', 'user');
  const cert = { mode: 'synthetic-only', requestHash: C.digest(request), model: request.model, counter: 'synthetic-fixture-v1', inputTokens: 40000, includesAllOverhead: true };
  const count = R.countSyntheticRequest(request, cert);
  assert.equal(count.liveDispatchAllowed, false); assert.equal(count.measuredProviderTokens, false);
  for (const change of [{ inputTokens: 40001 }, { inputTokens: null }, { includesAllOverhead: false }, { mode: 'live' }, { counter: 'chars-divided-by-four' }, { model: 'other' }]) assert.throws(() => R.countSyntheticRequest(request, { ...cert, ...change }));
  request.messages[0].content += 'changed';
  assert.throws(() => R.countSyntheticRequest(request, cert));
});
test('complete simulation is not signable, eligible or actual build/provider execution', () => {
  const report = R.runSynthetic(protocol, cases, fixtures, 10000000);
  assert.equal(report.simulatedAllCalls, true); assert.equal(report.records.length, 72);
  for (const [key, value] of Object.entries(M.FLAGS)) assert.equal(report[key], value);
  assert.equal(report.phase, undefined);
  assert.equal(checkAuthorization({ payload: report }, protocol.candidate.release, 'not-a-key').valid, false);
});
test('transport failure and unknown usage stop without retries; fixture order is fixed', () => {
  for (const mutate of [f => { f[0].error = true; }, f => { delete f[0].usage; }, f => { f[0].output = ''; }]) {
    const f = clone(fixtures); mutate(f);
    const report = R.runSynthetic(protocol, cases, f, 10000000);
    assert.equal(report.simulatedAllCalls, false); assert.equal(report.records.length, 1);
    assert.equal(report.budget.halted, true); assert.equal(report.budget.reservedMicrodollars, 138000);
  }
  const f = clone(fixtures); [f[0], f[1]] = [f[1], f[0]];
  assert.equal(R.runSynthetic(protocol, cases, f, 10000000).budget.attempts.length, 0);
  assert.throws(() => R.runSynthetic(protocol, cases, [], 10000000));
});
test('runner requires full-request count certificate before reservation, excess actual usage halts', () => {
  for (const mutate of [f => { delete f[0].tokenCertificate; }, f => { f[0].request.messages[0].content = 'changed'; }, f => { f[0].tokenCertificate.inputTokens = 40001; }]) {
    const f = clone(fixtures); mutate(f); const report = R.runSynthetic(protocol, cases, f, 10000000);
    assert.equal(report.simulatedAllCalls, false); assert.equal(report.budget.reservedMicrodollars, 0);
  }
  const f = clone(fixtures); f[0].usage.inputTokens = 101;
  const report = R.runSynthetic(protocol, cases, f, 10000000);
  assert.equal(report.simulatedAllCalls, false); assert.equal(report.budget.halted, true);
  assert.equal(report.budget.reservedMicrodollars, 138000);
});
console.log(`${passed} maintenance runner test groups passed`);
