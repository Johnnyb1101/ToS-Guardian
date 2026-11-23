'use strict';

const { createHash } = require('node:crypto');
const { canonicalJson } = require('./final-corpus-lib');
const { prepareOpenAIRequest } = require('./maintenance-openai-contract');
const { prepareAnthropicCount } = require('./maintenance-provider-preflight');
const { parseUnambiguousJson, sendProviderBytes } = require('./maintenance-observed-live-transport');
const { requestBytes } = require('./release-class');

const MODELS = Object.freeze({ anthropic: 'claude-sonnet-4-6', openai: 'gpt-4o-mini' });
const OUTPUT_LIMITS = Object.freeze({ analyzer: 1200, critic: 1000 });
const PUBLIC_HEADERS = {
  anthropic: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
  openai: { 'Content-Type': 'application/json' },
};
const MAX_RESPONSE_BYTES = 800_000;

function verifiedPayload({ provider, stage, captured, captureSha256, credential }) {
  if (!Object.hasOwn(MODELS, provider) || !Object.hasOwn(OUTPUT_LIMITS, stage)) {
    throw new Error('Unsupported smoke provider or stage');
  }
  canonicalJson(captured); // Reject non-JSON values before taking a snapshot.
  const envelope = JSON.parse(JSON.stringify(captured)); // Preserve captured header order.
  const bytes = requestBytes(envelope, provider);
  if (createHash('sha256').update(bytes).digest('hex') !== captureSha256) {
    throw new Error('Smoke capture digest mismatch');
  }
  if (canonicalJson(envelope.headers) !== canonicalJson(PUBLIC_HEADERS[provider])) {
    throw new Error('Unsupported smoke public headers');
  }
  const body = parseUnambiguousJson(envelope.body);
  if (!body || body.model !== MODELS[provider] || body.max_tokens !== OUTPUT_LIMITS[stage]) {
    throw new Error('Smoke model or output cap changed');
  }

  const request = { url: envelope.url, body };
  if (provider === 'anthropic') {
    if (bytes.length > 60_000) throw new Error('Anthropic smoke capture exceeds the byte limit');
    prepareAnthropicCount(request);
  } else {
    // An absent service_tier preserves the app's exact bytes. The supervisor
    // must attest Standard processing for the pinned OpenAI project.
    prepareOpenAIRequest(request);
  }
  const messages = body.messages.map(message => message.content);
  if (provider === 'anthropic') messages.push(body.system);
  if (![envelope.body, ...messages].every(text => text.isWellFormed() && !text.includes('\0')) ||
      (typeof credential === 'string' && credential.length >= 8 &&
        [envelope.body, ...messages].some(text => text.includes(credential)))) {
    throw new Error('Invalid Unicode or credential-bearing smoke content');
  }
  return Buffer.from(envelope.body, 'utf8');
}

async function sendDependencySmokeRequest(input, options) {
  const bytes = verifiedPayload(input);
  const { provider, credential, accountId } = input;
  const response = await sendProviderBytes({ provider, bytes, credential, accountId, maxResponseBytes: MAX_RESPONSE_BYTES }, options);
  let body;
  try {
    body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(response.response);
  } catch {
    throw new Error('Invalid provider response UTF-8; charge unknown');
  }
  if (body.includes(credential)) throw new Error('Credential-bearing provider response; charge unknown');
  return { status: response.status, requestId: response.requestId, body };
}

module.exports = { sendDependencySmokeRequest };
