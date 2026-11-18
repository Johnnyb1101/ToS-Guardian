'use strict';

const { digest, seal } = require('./final-corpus-lib');
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && JSON.stringify(Object.keys(v).sort()) === JSON.stringify([...keys].sort());

function prepareAnthropicCount(request) {
  if (!exact(request, ['url', 'body']) || request.url !== 'https://api.anthropic.com/v1/messages') throw new Error('Only the official Anthropic text Messages endpoint is supported');
  const b = request.body;
  if (!exact(b, ['model', 'system', 'messages', 'max_tokens']) || b.model !== 'claude-sonnet-4-6' || typeof b.system !== 'string' || !b.system.trim() || !Number.isSafeInteger(b.max_tokens) || b.max_tokens < 1 || b.max_tokens > 2400) throw new Error('Unsupported message request');
  if (!Array.isArray(b.messages) || b.messages.length !== 1 || !exact(b.messages[0], ['role', 'content']) || b.messages[0].role !== 'user' || typeof b.messages[0].content !== 'string' || !b.messages[0].content.trim()) throw new Error('Only one plain-text user message is supported');
  if (b.system.length + b.messages[0].content.length > 150000) throw new Error('Request too large; never truncate');
  return seal({ kind: 'anthropic-count-preparation', v: 1, sourceRequestHash: digest(request),
    method: 'POST', url: 'https://api.anthropic.com/v1/messages/count_tokens',
    publicHeaders: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: { model: b.model, system: b.system, messages: JSON.parse(JSON.stringify(b.messages)) },
    requiresCredential: true, dispatchEnabled: false });
}

function recordAnthropicCount(request, preparation, response) {
  const expected = prepareAnthropicCount(request);
  if (JSON.stringify(preparation) !== JSON.stringify(expected)) throw new Error('Count preparation no longer matches complete request');
  if (!exact(response, ['input_tokens']) || !Number.isSafeInteger(response.input_tokens) || response.input_tokens < 0 || response.input_tokens > 40000) throw new Error('Count missing, invalid or over input cap');
  return seal({ kind: 'unverified-count-observation', v: 1, requestHash: digest(request), countPreparationHash: preparation.hash,
    reportedInputTokens: response.input_tokens, responseHash: digest(response),
    providerAuthenticated: false, hardUpperBoundEstablished: false, liveDispatchAllowed: false });
}

async function dispatch() { throw new Error('Provider transport disabled: no credentials or paid/count API dispatch authorized by this tool'); }

module.exports = { prepareAnthropicCount, recordAnthropicCount, dispatch, ...require('./maintenance-openai-contract') };
