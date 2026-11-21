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

// https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
function readOpenAITextUsage(usage, maxOutputTokens, { allowReasoning = false, requireCachedTokens = true } = {}) {
  if (!only(usage, ['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_tokens_details', 'completion_tokens_details'])) {
    throw new Error('OpenAI usage missing, malformed or inconsistent');
  }
  const {
    prompt_tokens: promptTokens, completion_tokens: outputTokens, total_tokens: totalTokens,
    prompt_tokens_details: promptDetails = {}, completion_tokens_details: completionDetails = {}
  } = usage;
  if (!count(promptTokens) || !count(outputTokens) || !count(totalTokens) ||
      !count(maxOutputTokens) || outputTokens > maxOutputTokens || totalTokens - outputTokens !== promptTokens) {
    throw new Error('OpenAI usage missing, malformed or inconsistent');
  }

  if (!only(promptDetails, ['cached_tokens', 'cache_write_tokens', 'audio_tokens', 'image_tokens', 'text_tokens'])) {
    throw new Error('Unsupported OpenAI prompt usage details');
  }
  const {
    cached_tokens: cacheReadTokens = 0, cache_write_tokens: cacheWriteTokens = 0,
    audio_tokens: promptAudio = 0, image_tokens: promptImages = 0, text_tokens: promptText = 0
  } = promptDetails;
  if (requireCachedTokens && !count(promptDetails.cached_tokens)) {
    throw new Error('Explicit valid OpenAI cached usage required');
  }
  if (!count(cacheReadTokens) || !count(cacheWriteTokens) || cacheWriteTokens > promptTokens - cacheReadTokens ||
      promptAudio !== 0 || promptImages !== 0 || !count(promptText) || promptText > promptTokens) {
    throw new Error('Unsupported OpenAI prompt usage details');
  }

  if (!only(completionDetails, ['reasoning_tokens', 'audio_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens', 'text_tokens'])) {
    throw new Error('Unsupported OpenAI completion usage details');
  }
  const {
    reasoning_tokens: reasoning = 0, audio_tokens: completionAudio = 0, text_tokens: completionText = 0,
    accepted_prediction_tokens: acceptedPrediction = 0, rejected_prediction_tokens: rejectedPrediction = 0
  } = completionDetails;
  if (!count(reasoning) || (!allowReasoning && reasoning !== 0) ||
      !count(completionText) || completionText > outputTokens - reasoning ||
      completionAudio !== 0 || acceptedPrediction !== 0 || rejectedPrediction !== 0) {
    throw new Error('Unsupported OpenAI completion usage details');
  }

  return { inputTokens: promptTokens - cacheReadTokens - cacheWriteTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

function recordOpenAIResponse(request, preparation, response, options) {
  const expected = prepareOpenAIRequest(request);
  if (digest(preparation) !== digest(expected)) throw new Error('OpenAI preparation no longer matches complete request');
  digest(response);
  if (!only(response, ['id', 'object', 'created', 'model', 'choices', 'usage', 'system_fingerprint', 'service_tier']) || response.object !== 'chat.completion' || !RESPONSE_MODELS[request.body.model].includes(response.model)) throw new Error('Unsupported OpenAI response or model');
  if (!Array.isArray(response.choices) || response.choices.length !== 1) throw new Error('Exactly one OpenAI choice required');
  const choice = response.choices[0];
  if (!only(choice, ['index', 'message', 'finish_reason', 'logprobs']) || choice.index !== 0 || choice.finish_reason !== 'stop' || (choice.logprobs !== undefined && choice.logprobs !== null)) throw new Error('OpenAI response incomplete, truncated or unsupported');
  const message = choice.message;
  if (!only(message, ['role', 'content', 'refusal', 'annotations']) || message.role !== 'assistant' || !text(message.content) ||
      (message.refusal !== undefined && message.refusal !== null) ||
      (message.annotations !== undefined && (!Array.isArray(message.annotations) || message.annotations.length !== 0))) {
    throw new Error('OpenAI refusal or unsupported text response');
  }
  const usage = readOpenAITextUsage(response.usage, request.body.max_tokens, options);
  return seal({ kind: 'unverified-openai-response-observation', v: 1, requestHash: digest(request), requestPreparationHash: preparation.hash,
    responseHash: digest(response), reportedModel: response.model, text: message.content, stopReason: choice.finish_reason,
    usage,
    providerAuthenticated: false, hardUpperBoundEstablished: false, liveDispatchAllowed: false, promotionEligible: false });
}

module.exports = { prepareOpenAIRequest, readOpenAITextUsage, recordOpenAIResponse };
