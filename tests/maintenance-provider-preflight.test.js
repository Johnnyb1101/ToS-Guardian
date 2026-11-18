'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const preflight = require('../tools/maintenance-provider-preflight');
const { digest } = require('../tools/final-corpus-lib');
const request = (model = 'gpt-4o-mini') => ({ url: 'https://api.openai.com/v1/chat/completions', body: {
  model, max_tokens: 1200, messages: [{ role: 'system', content: 'Fixture trusted system' }, { role: 'user', content: 'Fixture document' }]
} });
const response = (model = 'gpt-4o-mini-2024-07-18') => ({ id: 'chatcmpl-fixture', object: 'chat.completion', created: 1, model,
  choices: [{ index: 0, message: { role: 'assistant', content: 'Fixture analysis', refusal: null }, finish_reason: 'stop', logprobs: null }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 30, audio_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 } }
});
const record = (q, r, p = preflight.prepareOpenAIRequest(q)) => preflight.recordOpenAIResponse(q, p, r);

test('OpenAI text contract keeps exact request and explicit cached accounting offline', () => {
  const q = request(), p = preflight.prepareOpenAIRequest(q), r = response(), observed = record(q, r, p);
  assert.deepEqual(p.body, q.body);
  assert.equal(p.sourceRequestHash, digest(q));
  assert.equal(p.dispatchEnabled, false);
  assert.equal(p.liveDispatchAllowed, false);
  assert.deepEqual(observed.usage, { inputTokens: 70, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0 });
  assert.equal(observed.responseHash, digest(r));
  assert.equal(observed.text, 'Fixture analysis');
  for (const key of ['providerAuthenticated', 'hardUpperBoundEstablished', 'liveDispatchAllowed', 'promotionEligible']) assert.equal(observed[key], false);
  assert.equal(record(request('gpt-4o'), response('gpt-4o-2024-08-06')).reportedModel, 'gpt-4o-2024-08-06');
  assert.equal(record(request('gpt-4o'), response('gpt-4o-2024-11-20')).reportedModel, 'gpt-4o-2024-11-20');
  assert.equal(record(q, response('gpt-4o-mini')).reportedModel, 'gpt-4o-mini');
});

test('OpenAI request options, endpoint, model and message mutations fail closed', () => {
  for (const mutate of [q => q.url += '?x=1', q => q.url = 'https://api.openai.com/v1/responses', q => q.url = 'https://evil.invalid',
    q => q.headers = { Authorization: 'Bearer fixture-only' }, q => q.body.model = 'gpt-4o-mini-unknown', q => q.body.stream = false,
    q => q.body.tools = [], q => q.body.max_tokens = 2401, q => q.body.max_tokens = 0, q => q.body.max_tokens = 1.5,
    q => q.body.messages[0].role = 'developer', q => q.body.messages[1].content = [{ type: 'text', text: 'fixture' }],
    q => q.body.messages.push({ role: 'assistant', content: 'extra' }), q => q.body.messages[1].content = 'x'.repeat(400001)]) {
    const q = request(); mutate(q); assert.throws(() => preflight.prepareOpenAIRequest(q));
  }
  const q = request(), p = preflight.prepareOpenAIRequest(q);
  q.body.messages[1].content += 'changed'; assert.throws(() => record(q, response(), p));
});

test('OpenAI malformed, missing, fractional and inconsistent usage cannot become accounting evidence', () => {
  for (const mutate of [r => delete r.usage, r => r.usage = null, r => delete r.usage.prompt_tokens,
    r => r.usage.prompt_tokens = '100', r => r.usage.completion_tokens = -1, r => r.usage.total_tokens = 120.5,
    r => r.usage.total_tokens++, r => r.usage.prompt_tokens = Number.MAX_SAFE_INTEGER,
    r => { r.usage.completion_tokens = 1201; r.usage.total_tokens = 1301; }, r => delete r.usage.prompt_tokens_details,
    r => delete r.usage.prompt_tokens_details.cached_tokens, r => r.usage.prompt_tokens_details.cached_tokens = 101,
    r => r.usage.prompt_tokens_details.cached_tokens = '30', r => r.usage.prompt_tokens_details.cached_tokens = 0.5,
    r => r.usage.prompt_tokens_details.audio_tokens = 1, r => r.usage.prompt_tokens_details.unknown = 0,
    r => r.usage.completion_tokens_details.reasoning_tokens = 1, r => r.usage.completion_tokens_details.unknown = 0,
    r => r.usage.unknown = 0]) {
    const r = response(); mutate(r); assert.throws(() => record(request(), r));
  }
  const r = response(); r.usage.prompt_tokens_details.cached_tokens = 0; delete r.usage.completion_tokens_details;
  assert.equal(record(request(), r).usage.inputTokens, 100);
});

test('OpenAI refusals, truncation, alternate models and unsupported response options fail closed', () => {
  for (const mutate of [r => r.model = 'gpt-4o-mini-2099-01-01', r => r.model = 'gpt-4o', r => delete r.model,
    r => r.object = 'chat.completion.chunk', r => r.choices = [], r => r.choices.push(structuredClone(r.choices[0])),
    r => r.choices[0].index = 1, r => r.choices[0].finish_reason = 'length', r => r.choices[0].finish_reason = 'content_filter',
    r => r.choices[0].finish_reason = 'tool_calls', r => delete r.choices[0].finish_reason,
    r => r.choices[0].message.refusal = 'Cannot comply', r => r.choices[0].message.content = '',
    r => r.choices[0].message.content = null, r => r.choices[0].message.tool_calls = [],
    r => r.choices[0].message.role = 'user', r => r.unknown = {}, r => r.error = { message: 'unavailable' }]) {
    const r = response(); mutate(r); assert.throws(() => record(request(), r));
  }
  for (const r of [null, [], 'invalid', {}]) assert.throws(() => record(request(), r));
});

test('Anthropic count preparation still works and provider dispatch remains disabled', async () => {
  const q = { url: 'https://api.anthropic.com/v1/messages', body: { model: 'claude-sonnet-4-6', system: 'Fixture system', messages: [{ role: 'user', content: 'Fixture document' }], max_tokens: 1200 } };
  const p = preflight.prepareAnthropicCount(q), observed = preflight.recordAnthropicCount(q, p, { input_tokens: 100 });
  assert.equal(p.dispatchEnabled, false); assert.equal(observed.reportedInputTokens, 100); assert.equal(observed.liveDispatchAllowed, false);
  await assert.rejects(preflight.dispatch(), /transport disabled/);
});
