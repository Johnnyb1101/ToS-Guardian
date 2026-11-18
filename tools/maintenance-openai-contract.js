'use strict';

const { digest, seal } = require('./final-corpus-lib');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const exact = (value, keys) => only(value, keys) && Object.keys(value).length === keys.length;
const count = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' && value.trim().length > 0;
// Existing llmRelay policy, not a model migration or evidence of live availability.
// Checked 2026-11-17: https://developers.openai.com/api/docs/models/gpt-4o-mini
// https://developers.openai.com/api/docs/models/gpt-4o
const RESPONSE_MODELS = Object.freeze({
  'gpt-4o-mini': Object.freeze(['gpt-4o-mini', 'gpt-4o-mini-2024-07-18']),
  'gpt-4o': Object.freeze(['gpt-4o', 'gpt-4o-2024-08-06', 'gpt-4o-2024-11-20'])
});

function prepareOpenAIRequest(request) {
  digest(request); // Reject non-JSON values before inspecting or copying fields.
  if (!exact(request, ['url', 'body']) || request.url !== 'https://api.openai.com/v1/chat/completions') throw new Error('Only the official OpenAI Chat Completions endpoint is supported');
  const b = request.body;
  if (!exact(b, ['model', 'messages', 'max_tokens']) || !Object.hasOwn(RESPONSE_MODELS, b.model) || !Number.isSafeInteger(b.max_tokens) || b.max_tokens < 1 || b.max_tokens > 2400) throw new Error('Unsupported OpenAI text request');
  if (!Array.isArray(b.messages) || b.messages.length !== 2 || b.messages.some((message, index) => !exact(message, ['role', 'content']) || message.role !== (index === 0 ? 'system' : 'user') || !text(message.content))) throw new Error('Exactly one system and one user text message required');
  if (b.messages.reduce((sum, message) => sum + message.content.length, 0) > 400000) throw new Error('Request too large; never truncate');
  return seal({ kind: 'openai-request-preparation', v: 1, sourceRequestHash: digest(request), method: 'POST', url: request.url,
    publicHeaders: { 'content-type': 'application/json' }, body: JSON.parse(JSON.stringify(b)), requiresCredential: true,
    dispatchEnabled: false, liveDispatchAllowed: false });
}

// Narrow offline acceptance contract. The API allows optional usage details, but
// this accounting observation requires explicit cached counts; omission cannot
// become zero-cost evidence. No prices, billing bound, or provider proof here.
// https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
function recordOpenAIResponse(request, preparation, response) {
  const expected = prepareOpenAIRequest(request);
  if (digest(preparation) !== digest(expected)) throw new Error('OpenAI preparation no longer matches complete request');
  digest(response);
  if (!only(response, ['id', 'object', 'created', 'model', 'choices', 'usage', 'system_fingerprint', 'service_tier']) || response.object !== 'chat.completion' || !RESPONSE_MODELS[request.body.model].includes(response.model)) throw new Error('Unsupported OpenAI response or model');
  if (!Array.isArray(response.choices) || response.choices.length !== 1) throw new Error('Exactly one OpenAI choice required');
  const choice = response.choices[0];
  if (!only(choice, ['index', 'message', 'finish_reason', 'logprobs']) || choice.index !== 0 || choice.finish_reason !== 'stop' || (choice.logprobs !== undefined && choice.logprobs !== null)) throw new Error('OpenAI response incomplete, truncated or unsupported');
  const message = choice.message;
  if (!only(message, ['role', 'content', 'refusal']) || message.role !== 'assistant' || !text(message.content) || (message.refusal !== undefined && message.refusal !== null)) throw new Error('OpenAI refusal or unsupported text response');
  const u = response.usage;
  if (!only(u, ['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_tokens_details', 'completion_tokens_details']) || !count(u.prompt_tokens) || !count(u.completion_tokens) || !count(u.total_tokens) || !Number.isSafeInteger(u.prompt_tokens + u.completion_tokens) || u.total_tokens !== u.prompt_tokens + u.completion_tokens || u.completion_tokens > request.body.max_tokens) throw new Error('OpenAI usage missing, malformed or inconsistent');
  if (!only(u.prompt_tokens_details, ['cached_tokens', 'audio_tokens']) || !count(u.prompt_tokens_details.cached_tokens) || u.prompt_tokens_details.cached_tokens > u.prompt_tokens || (u.prompt_tokens_details.audio_tokens !== undefined && u.prompt_tokens_details.audio_tokens !== 0)) throw new Error('Explicit valid OpenAI cached usage required');
  if (u.completion_tokens_details !== undefined && (!only(u.completion_tokens_details, ['reasoning_tokens', 'audio_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens']) || Object.values(u.completion_tokens_details).some(value => value !== 0))) throw new Error('Unsupported OpenAI completion usage details');
  return seal({ kind: 'unverified-openai-response-observation', v: 1, requestHash: digest(request), requestPreparationHash: preparation.hash,
    responseHash: digest(response), reportedModel: response.model, text: message.content, stopReason: choice.finish_reason,
    usage: { inputTokens: u.prompt_tokens - u.prompt_tokens_details.cached_tokens, outputTokens: u.completion_tokens, cacheReadTokens: u.prompt_tokens_details.cached_tokens, cacheWriteTokens: 0 },
    providerAuthenticated: false, hardUpperBoundEstablished: false, liveDispatchAllowed: false, promotionEligible: false });
}

module.exports = { prepareOpenAIRequest, recordOpenAIResponse };
