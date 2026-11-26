'use strict';

const { createHash } = require('node:crypto');
const https = require('node:https');
const { canonicalJson } = require('./final-corpus-lib');
const { prepareOpenAIRequest } = require('./maintenance-openai-contract');

const HOST = 'api.openai.com';
const PATH = '/v1/chat/completions';
const MAX_REQUEST_BYTES = 1000000;
const MAX_RESPONSE_BYTES = 1048576;
const MAX_TIMEOUT_MS = 60000;
const ROUTES = Object.freeze({
  openai: { hostname: HOST, path: PATH, requestIdHeader: 'x-request-id', accountPrefix: 'proj_' },
  anthropic: {
    hostname: 'api.anthropic.com', path: '/v1/messages', requestIdHeader: 'request-id', accountPrefix: 'wrkspc_',
    accountHeader: 'anthropic-workspace-id',
  },
});

function parseUnambiguousJson(text) {
  let value;
  try {
    if (typeof text !== 'string') throw new Error();
    value = JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON');
  }

  // With syntax already validated, a string followed by a colon is an
  // object member name. Scan strings whole so braces in strings are ignored.
  const tokens = /"(?:[^"\\]|\\[\s\S])*"|[{}]/g;
  const colon = /[ \t\r\n]*:/y;
  const objects = [];
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    if (token === '{') objects.push(new Set());
    else if (token === '}') objects.pop();
    else {
      colon.lastIndex = match.index + token.length;
      if (!colon.test(text)) continue;
      const key = JSON.parse(token);
      const keys = objects[objects.length - 1];
      if (keys.has(key)) throw new Error('Duplicate JSON member');
      keys.add(key);
    }
  }
  return value;
}

function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function verifiedBody(bytes, sha256) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_REQUEST_BYTES ||
      typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('Invalid observed request bytes or digest');
  }
  const payload = Buffer.from(bytes);
  if (createHash('sha256').update(payload).digest('hex') !== sha256) {
    throw new Error('Observed request digest mismatch');
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload);
    const body = parseUnambiguousJson(text);
    if (!body || body.service_tier !== 'default' || !Array.isArray(body.messages) || body.messages.length !== 2 ||
        !body.messages.every((message, index) => exact(message, ['role', 'content']) &&
          message.role === (index === 0 ? 'system' : 'user') &&
          typeof message.content === 'string' && message.content.trim() && !message.content.includes('\0') &&
          Buffer.byteLength(message.content) <= 400000)) {
      throw new Error();
    }
    switch (body.model) {
      case 'gpt-4o-mini':
        if (![1000, 1200].includes(body.max_tokens)) throw new Error();
        {
          const { service_tier, ...requestBody } = body;
          prepareOpenAIRequest({ url: `https://${HOST}${PATH}`, body: requestBody });
        }
        break;
      case 'gpt-4o':
        if (!exact(body, ['model', 'messages', 'max_tokens', 'service_tier']) || body.max_tokens !== 8000) throw new Error();
        break;
      case 'gpt-6-luna':
        if (!exact(body, ['model', 'messages', 'max_completion_tokens', 'reasoning_effort', 'service_tier']) ||
            body.max_completion_tokens !== 8000 || body.reasoning_effort !== 'medium') throw new Error();
        break;
      default:
        throw new Error();
    }
    if (canonicalJson(body) !== text) throw new Error();
  } catch {
    throw new Error('Unsupported observed request body');
  }
  return payload;
}

function responseMetadata(response, { requestIdHeader, accountHeader }, accountId, maxResponseBytes) {
  const status = response.statusCode;
  const headers = response.rawHeaders;
  if (!Number.isInteger(status) || status < 200 || status > 599 || !Array.isArray(headers) || headers.length % 2) {
    throw new Error('Invalid provider status or response headers');
  }

  const names = new Set([requestIdHeader, 'content-encoding', 'content-length', 'transfer-encoding']);
  if (accountHeader) names.add(accountHeader);
  const values = new Map();
  for (let index = 0; index < headers.length; index += 2) {
    const name = headers[index].toLowerCase();
    if (!names.has(name)) continue;
    if (values.has(name) || typeof headers[index + 1] !== 'string') {
      throw new Error('Ambiguous provider response headers');
    }
    values.set(name, headers[index + 1]);
  }
  const requestId = values.get(requestIdHeader);
  const encoding = values.get('content-encoding');
  const wireLength = values.get('content-length');
  const transfer = values.get('transfer-encoding');
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(requestId)) {
    throw new Error('Invalid provider request ID');
  }
  if (accountHeader && status === 200 && values.get(accountHeader) !== accountId) {
    throw new Error('Provider receipt belongs to a different account');
  }
  if (encoding !== undefined && !/^identity$/i.test(encoding)) {
    throw new Error('Unsupported provider content encoding');
  }
  if (wireLength !== undefined && (!/^(0|[1-9][0-9]*)$/.test(wireLength) || Number(wireLength) > maxResponseBytes)) {
    throw new Error('Invalid provider response length');
  }
  const bodyless = status === 204 || status === 304;
  if ((transfer !== undefined && (!/^chunked$/i.test(transfer) || wireLength !== undefined || bodyless)) ||
      (transfer === undefined && wireLength === undefined && !bodyless) ||
      (status === 204 && wireLength !== undefined && wireLength !== '0')) {
    throw new Error('Unsupported provider response framing');
  }
  return { status, requestId, expectedLength: bodyless ? 0 : wireLength === undefined ? null : Number(wireLength) };
}

async function sendProviderBytes(input, options) {
  if (!Object.hasOwn(ROUTES, input.provider)) throw new Error('Invalid provider endpoint or payload bounds');
  return sendToRoute(ROUTES[input.provider], input, options);
}

async function sendToRoute(route, { bytes, credential, accountId, maxResponseBytes = MAX_RESPONSE_BYTES },
  { request = https.request, timeoutMs = MAX_TIMEOUT_MS } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_REQUEST_BYTES ||
      !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_RESPONSE_BYTES) {
    throw new Error('Invalid provider endpoint or payload bounds');
  }
  const payload = Buffer.from(bytes);
  if (typeof credential !== 'string' || credential.length < 8 || credential.length > 1000 ||
      /[^\x21-\x7e]/.test(credential)) {
    throw new Error('Invalid provider credential format');
  }
  if (typeof accountId !== 'string' || !accountId.startsWith(route.accountPrefix) ||
      !/^[A-Za-z0-9_-]{1,195}$/.test(accountId.slice(route.accountPrefix.length))) {
    throw new Error(route === ROUTES.openai ? 'Invalid provider project ID' : 'Invalid provider workspace ID');
  }
  if (typeof request !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error('Invalid provider transport options');
  }

  return new Promise((resolve, reject) => {
    let outgoing;
    let incoming;
    let settled = false;
    const timer = setTimeout(() => fail('Provider deadline exceeded'), timeoutMs);

    function fail(message) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${message}; charge unknown`));
      incoming?.destroy?.();
      outgoing?.destroy();
    }

    function receive(response) {
      incoming = response;
      response.on('error', () => fail('Provider response failed'));
      if (settled) {
        incoming.destroy?.();
        return;
      }
      response.on('aborted', () => fail('Provider response aborted'));
      response.on('close', () => fail('Provider response closed before completion'));
      let metadata;
      try {
        metadata = responseMetadata(response, route, accountId, maxResponseBytes);
      } catch {
        fail('Unsupported provider status or response headers');
        return;
      }

      const { status, requestId, expectedLength } = metadata;
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        if (settled) return;
        if (!Buffer.isBuffer(chunk)) return fail('Unsupported provider response bytes');
        size += chunk.length;
        if (size > maxResponseBytes || (expectedLength !== null && size > expectedLength)) {
          return fail('Provider response exceeded its size limit');
        }
        if (chunk.length) chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) return;
        if (response.complete !== true || (expectedLength !== null && size !== expectedLength)) {
          return fail('Provider response incomplete');
        }
        settled = true;
        clearTimeout(timer);
        resolve({ status, requestId, response: Buffer.concat(chunks, size) });
      });
    }

    try {
      const accountHeaders = route === ROUTES.openai
        ? { authorization: `Bearer ${credential}`, 'OpenAI-Project': accountId }
        : { 'x-api-key': credential, 'anthropic-version': '2023-06-01', [route.accountHeader]: accountId };
      outgoing = request({
        protocol: 'https:',
        hostname: route.hostname,
        servername: route.hostname,
        port: 443,
        path: route.path,
        method: 'POST',
        agent: false,
        autoSelectFamily: false,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        maxHeaderSize: 16384,
        headers: {
          ...accountHeaders,
          'content-type': 'application/json',
          'content-length': payload.length,
          accept: 'application/json',
          'accept-encoding': 'identity',
          connection: 'close',
        },
      }, receive);
      outgoing.on('error', () => fail('Provider request failed'));
      outgoing.on('close', () => fail('Provider request closed before completion'));
      outgoing.on('upgrade', (_response, socket) => {
        socket.destroy();
        fail('Unsupported provider protocol upgrade');
      });
      if (settled) outgoing.destroy();
      else outgoing.end(payload);
    } catch {
      fail('Provider request construction or write failed');
    }
  });
}

async function sendObservedRequest({ bytes, sha256, credential, projectId }, options) {
  return sendProviderBytes({ provider: 'openai', bytes: verifiedBody(bytes, sha256), credential, accountId: projectId }, options);
}

async function countAnthropicInputTokens(input, options = {}) {
  if (!exact(input, ['bytes', 'credential', 'accountId']) || !Buffer.isBuffer(input.bytes) ||
      !input.bytes.length || input.bytes.length > MAX_REQUEST_BYTES || !options || typeof options !== 'object' ||
      Array.isArray(options) || !Object.keys(options).every(key => ['request', 'timeoutMs'].includes(key))) {
    throw new Error('Invalid Anthropic count request or options');
  }
  const decode = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const body = parseUnambiguousJson(decode(input.bytes));
  const text = value => typeof value === 'string' && value.isWellFormed() && value.trim().length > 0 && !value.includes('\0');
  if (!exact(body, ['model', 'max_tokens', 'system', 'messages']) || !text(body.model) || !text(body.system) ||
      !Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || !Array.isArray(body.messages) ||
      body.messages.length !== 1 || !exact(body.messages[0], ['role', 'content']) ||
      body.messages[0].role !== 'user' || !text(body.messages[0].content)) {
    throw new Error('Unsupported Anthropic count source');
  }
  const route = { ...ROUTES.anthropic, path: '/v1/messages/count_tokens' };
  const bytes = Buffer.from(JSON.stringify({ model: body.model, system: body.system, messages: body.messages }));
  const { status, response, requestId } = await sendToRoute(route, { ...input, bytes, maxResponseBytes: 4096 }, options);
  if (status !== 200 || requestId.includes(input.credential)) throw new Error('Invalid Anthropic count receipt');
  const count = parseUnambiguousJson(decode(response));
  if (!exact(count, ['input_tokens']) || !Number.isSafeInteger(count.input_tokens) || count.input_tokens < 1) {
    throw new Error('Invalid Anthropic input token count');
  }
  return { inputTokens: count.input_tokens, requestId };
}

module.exports = { parseUnambiguousJson, sendObservedRequest, sendProviderBytes, countAnthropicInputTokens };
