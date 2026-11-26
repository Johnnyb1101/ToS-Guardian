'use strict';

const { canonicalJson } = require('./final-corpus-lib');
const { readOpenAITextUsage } = require('./maintenance-openai-contract');
const { parseUnambiguousJson } = require('./maintenance-observed-live-transport');
const { requestBytes } = require('./release-class');

const MAX_REQUEST_BYTES = 1000000; // Match the fixed provider transport.
const MAX_RESPONSE_BYTES = 1048576;
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const HEADINGS = [
  '🧭 BOTTOM LINE', '🧭 RISK LEVEL', '📥 WHAT THEY COLLECT', '🔴 DATA SELLING & SHARING',
  '🔴 OPT-OUT RIGHTS', '📋 HOW TO OPT OUT RIGHT NOW', '🟡 AUTO-RENEWAL & BILLING', '🟢 DATA DELETION RIGHTS',
];

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const exact = (value, keys) => only(value, keys) && Object.keys(value).length === keys.length;
const tokens = value => Number.isSafeInteger(value) && value >= 0;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const text = value => typeof value === 'string' && value.isWellFormed() && value.trim().length > 0 && !value.includes('\0');
const utf8 = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

function independentRequest(model, maxOutputTokens, prompt, sourceText, rubric, summary) {
  return {
    url: OPENAI_ENDPOINT,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      max_completion_tokens: maxOutputTokens,
      service_tier: 'default',
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: canonicalJson({ sourceText, rubric, summary }) },
      ],
    }),
  };
}

function validateQualityRequest(captured, call) {
  const capture = requestBytes(captured, call.provider);
  const bytes = Buffer.from(captured.body);
  const body = parseUnambiguousJson(captured.body);
  const headers = Object.fromEntries(Object.entries(captured.headers).map(([name, value]) => [name.toLowerCase(), value]));
  const independent = call.stage === 'independent';
  const anthropic = call.provider === 'anthropic';
  const outputField = independent ? 'max_completion_tokens' : 'max_tokens';
  const fields = ['model', 'messages', outputField];
  if (anthropic) fields.push('system');
  if (independent) fields.push('service_tier');
  const roles = anthropic ? ['user'] : ['system', 'user'];
  requireThat(exact(body, fields) && bytes.length > 0 && bytes.length <= MAX_REQUEST_BYTES &&
    body.model === call.model && body[outputField] === call.pricing.maxOutputTokens &&
    headers['content-type'] === 'application/json' && (!anthropic || headers['anthropic-version'] === '2023-06-01') &&
    (!anthropic || text(body.system)) && (!independent || body.service_tier === 'default') &&
    Array.isArray(body.messages) && body.messages.length === roles.length &&
    body.messages.every((message, index) => exact(message, ['role', 'content']) &&
      message.role === roles[index] && text(message.content)),
  'Unexpected evaluation request, model, tier or output cap');
  return { capture, bytes };
}

function anthropicResponse(response, call) {
  const usage = response.usage;
  const content = response.content;
  const blocks = Array.isArray(content) ? content.filter(block => block?.type === 'text') : [];
  requireThat(response.type === 'message' && response.role === 'assistant' && response.stop_reason === 'end_turn' &&
    blocks.length === 1 && text(blocks[0].text) &&
    content.every(block => ['text', 'thinking', 'redacted_thinking'].includes(block?.type)),
  'Anthropic evaluation response was refused, truncated or unsupported');
  requireThat(only(usage, ['input_tokens', 'output_tokens', 'output_tokens_details', 'cache_creation_input_tokens', 'cache_read_input_tokens',
    'cache_creation', 'service_tier', 'inference_geo', 'speed']) &&
    usage.service_tier === 'standard' && usage.inference_geo === 'global' &&
    [undefined, 'standard'].includes(usage.speed) &&
    [undefined, 0].includes(usage.cache_creation_input_tokens) && [undefined, 0].includes(usage.cache_read_input_tokens) &&
    (usage.cache_creation == null || (exact(usage.cache_creation, ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens']) &&
      Object.values(usage.cache_creation).every(count => count === 0))),
  'Unsupported Anthropic tier, inference geography or cache usage');
  // The billed output total already includes the thinking tokens.
  const details = usage.output_tokens_details;
  requireThat(details == null || (exact(details, ['thinking_tokens']) &&
    tokens(details.thinking_tokens) && details.thinking_tokens <= usage.output_tokens),
  'Invalid Anthropic thinking-token breakdown');
  return { text: blocks[0].text, usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } };
}

function openaiResponse(response, call) {
  const choice = Array.isArray(response.choices) && response.choices.length === 1 ? response.choices[0] : null;
  const message = choice?.message;
  requireThat(response.object === 'chat.completion' && response.service_tier === 'default' &&
    only(choice, ['index', 'message', 'finish_reason', 'logprobs']) && choice.index === 0 &&
    choice.finish_reason === 'stop' && choice.logprobs == null &&
    only(message, ['role', 'content', 'refusal', 'annotations']) && message.role === 'assistant' &&
    message.refusal == null && text(message.content) &&
    (message.annotations === undefined || (Array.isArray(message.annotations) && message.annotations.length === 0)),
  'OpenAI evaluation response had an unsupported tier, refusal or output');
  const usage = readOpenAITextUsage(response.usage, call.pricing.maxOutputTokens, {
    requireCachedTokens: false,
    allowReasoning: call.stage === 'judge' || call.stage === 'independent',
  });
  // The signed Luna reserve covers the full long-context, 12-hour cache-write rate.
  const coveredCacheWrites = call.stage === 'independent' && response.model === 'gpt-6-luna' &&
    call.pricing.inputMicrodollarsPerMillion >= 500_000 &&
    call.pricing.outputMicrodollarsPerMillion >= 750_000;
  requireThat(usage.cacheWriteTokens === 0 || coveredCacheWrites, 'Unsupported OpenAI cache write usage');
  return { text: message.content, usage: {
    inputTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
    outputTokens: usage.outputTokens,
  } };
}

function readQualityResponse(delivery, call) {
  requireThat(exact(delivery, ['status', 'requestId', 'response']) && delivery.status === 200 &&
    identifier(delivery.requestId) && Buffer.isBuffer(delivery.response) && delivery.response.length > 0 &&
    delivery.response.length <= MAX_RESPONSE_BYTES, 'Incomplete or unsuccessful evaluation response');
  const body = utf8(delivery.response);
  const response = parseUnambiguousJson(body);
  requireThat(object(response) && identifier(response.id) && response.model === call.pricing.responseModel,
    'Unexpected evaluation response identity or model');
  const result = call.provider === 'anthropic' ? anthropicResponse(response, call) : openaiResponse(response, call);
  const { inputTokens, outputTokens } = result.usage;
  requireThat(tokens(inputTokens) && inputTokens > 0 && inputTokens <= call.pricing.maxInputTokens &&
    tokens(outputTokens) && outputTokens > 0 && outputTokens <= call.pricing.maxOutputTokens,
  'Incomplete or over-budget evaluation token usage');
  return { ...result, requestId: delivery.requestId, completionId: response.id, body };
}

function readIndependentGrade(result) {
  const grade = parseUnambiguousJson(result);
  requireThat(exact(grade, ['accuracy', 'completeness', 'fabrications']) &&
    [grade.accuracy, grade.completeness].every(value => Number.isFinite(value) && value >= 0 && value <= 1) &&
    tokens(grade.fabrications), 'Independent grade is incomplete or invalid');
  return grade;
}

function checkAnalyzerHeadings(summary) {
  const lines = summary.split(/\r?\n/u);
  const headings = lines.filter(line => /^(?:🧭|📥|🔴|📋|🟡|🟢) /u.test(line));
  return {
    passed: lines[0] === HEADINGS[0] && headings.length === HEADINGS.length &&
      HEADINGS.every((heading, index) => headings[index] === heading),
    missing: HEADINGS.filter(heading => !headings.includes(heading)),
  };
}

module.exports = { independentRequest, validateQualityRequest, readQualityResponse,
  readIndependentGrade, checkAnalyzerHeadings, MAX_RESPONSE_BYTES };
