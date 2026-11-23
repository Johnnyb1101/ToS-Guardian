'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { sendDependencySmokeRequest } = require('../tools/maintenance-dependency-smoke-transport');
const { requestBytes } = require('../tools/release-class');

function input(provider, stage = 'analyzer') {
  const content = 'Public policy | ☃ 🚦 α \u2028';
  const max_tokens = stage === 'analyzer' ? 1200 : 1000;
  const user = { role: 'user', content };
  const captured = provider === 'anthropic'
    ? { url: 'https://api.anthropic.com/v1/messages',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ system: content, model: 'claude-sonnet-4-6', messages: [user], max_tokens }) }
    : { url: 'https://api.openai.com/v1/chat/completions', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ max_tokens, model: 'gpt-4o-mini', messages: [{ role: 'system', content }, user] }) };
  return seal({
    provider, stage, captured, credential: 'sim_key_fake_123',
    accountId: provider === 'anthropic' ? 'wrkspc_fixture_1' : 'proj_fixture_1',
  });
}

function seal(data) {
  const captureSha256 = createHash('sha256').update(requestBytes(data.captured, data.provider)).digest('hex');
  return { ...data, captureSha256 };
}

function fake(data, options = {}) {
  const response = Buffer.from(options.response ?? '{"ok":"🌲"}');
  const idHeader = data.provider === 'anthropic' ? 'request-id' : 'x-request-id';
  const responseHeaders = [idHeader, 'req_fixture', 'content-length', String(response.length)];
  if (data.provider === 'anthropic') responseHeaders.push('anthropic-workspace-id', data.accountId);
  const state = { calls: 0 };
  function request(wire, received) {
    state.calls++;
    state.wire = wire;
    const outgoing = new EventEmitter();
    outgoing.destroy = () => { state.destroyed = true; };
    outgoing.end = bytes => {
      state.payload = bytes;
      if (options.timeout) return;
      queueMicrotask(() => {
        const incoming = new EventEmitter();
        incoming.statusCode = options.status ?? 200;
        incoming.rawHeaders = options.headers ?? responseHeaders;
        incoming.complete = !options.incomplete;
        incoming.destroy = () => { state.incomingDestroyed = true; };
        received(incoming);
        // Split the encoded response without decoding individual chunks.
        incoming.emit('data', response.subarray(0, -2));
        incoming.emit('data', response.subarray(-2));
        incoming.emit('end');
      });
    };
    return outgoing;
  }
  return { state, request };
}

test('per-provider transport sends the exact capture with TLS and the pinned account', async () => {
  for (const provider of ['anthropic', 'openai']) {
    const data = input(provider);
    const { state, request } = fake(data);
    const result = await sendDependencySmokeRequest(data, { request });
    assert.deepEqual(result, { status: 200, requestId: 'req_fixture', body: '{"ok":"🌲"}' });
    assert.equal(state.calls, 1);
    assert.deepEqual(state.payload, Buffer.from(data.captured.body));
    assert.equal(state.wire.hostname, new URL(data.captured.url).hostname);
    assert.equal(state.wire.servername, state.wire.hostname);
    assert.equal(state.wire.port, 443);
    assert.equal(state.wire.method, 'POST');
    assert.equal(state.wire.path, new URL(data.captured.url).pathname);
    assert.equal(state.wire.rejectUnauthorized, true);
    assert.equal(state.wire.minVersion, 'TLSv1.2');
    assert.equal(state.wire.agent, false);
    assert.equal(state.wire.headers['content-length'], state.payload.length);
    assert.equal(state.wire.headers['accept-encoding'], 'identity');
    assert.equal(JSON.stringify(result).includes(data.credential), false);
    if (provider === 'anthropic') {
      assert.equal(state.wire.headers['x-api-key'], data.credential);
      assert.equal(state.wire.headers['anthropic-version'], '2023-06-01');
      assert.equal(state.wire.headers['anthropic-workspace-id'], data.accountId);
      assert.equal(state.wire.headers.authorization, undefined);
    } else {
      assert.equal(state.wire.headers.authorization, 'Bearer ' + data.credential);
      assert.equal(state.wire.headers['OpenAI-Project'], data.accountId);
      assert.equal(state.wire.headers['x-api-key'], undefined);
    }
  }
});

test('provider, account, stage, captured digest and endpoint drift fail before networking', async () => {
  const data = input('anthropic');
  const { state, request } = fake(data);
  await assert.rejects(sendDependencySmokeRequest({ ...data, accountId: 'proj_wrong' }, { request }), /workspace ID/);
  await assert.rejects(sendDependencySmokeRequest({ ...data, stage: 'critic' }, { request }), /output cap/);
  await assert.rejects(sendDependencySmokeRequest({ ...data, provider: 'unknown' }, { request }), /provider or stage/);
  await assert.rejects(sendDependencySmokeRequest({ ...data, captureSha256: '0'.repeat(64) }, { request }), /digest/);
  await assert.rejects(sendDependencySmokeRequest({
    ...data, captured: { ...data.captured, url: 'https://example.invalid/v1/messages' },
  }, { request }), /offline request output/);
  const openai = input('openai');
  await assert.rejects(sendDependencySmokeRequest({ ...openai, accountId: 'wrkspc_wrong' }, { request }), /project ID/);
  assert.equal(state.calls, 0);
});

test('rejects unsupported tier, Unicode, model and embedded credentials at admission', async () => {
  const data = input('openai', 'critic');
  const { state, request } = fake(data);
  const send = mutate => {
    const body = JSON.parse(data.captured.body);
    mutate(body);
    return sendDependencySmokeRequest(seal({ ...data, captured: { ...data.captured, body: JSON.stringify(body) } }), { request });
  };
  await assert.rejects(send(body => { body.service_tier = 'priority'; }), /OpenAI text request/);
  await assert.rejects(send(body => { body.model = 'gpt-4o'; }), /model or output cap/);
  await assert.rejects(send(body => { body.messages[1].content = 'bad\ud800'; }), /Unicode/);
  await assert.rejects(send(body => { body.messages[1].content = data.credential; }), /credential-bearing/);
  assert.equal(state.calls, 0);
});

test('redirect response stays with the caller without following Location', async () => {
  const data = input('openai');
  const { state, request } = fake(data, { status: 302,
    headers: ['x-request-id', 'req_redirect', 'content-length', '0', 'location', 'https://example.invalid/'],
    response: '',
  });
  assert.equal((await sendDependencySmokeRequest(data, { request })).status, 302);
  assert.equal(state.calls, 1);
});

test('partial, oversized, compressed, ambiguous and invalid UTF-8 receipts halt', async () => {
  const data = input('openai');
  const cases = [
    { incomplete: true },
    { headers: ['x-request-id', 'req_expected', 'x-request-id', 'req_duplicate', 'content-length', '2'] },
    { headers: ['x-request-id', 'req_expected', 'content-encoding', 'gzip', 'content-length', '2'] },
    { headers: ['x-request-id', 'req_expected', 'content-length', '800001'] },
    { headers: ['x-request-id', 'req_expected', 'transfer-encoding', 'chunked'], response: 'a'.repeat(800001) },
    { response: Buffer.from([0xc3, 0x28]) },
    { response: data.credential },
  ];
  for (const options of cases) {
    const { state, request } = fake(data, options);
    await assert.rejects(sendDependencySmokeRequest(data, { request }), /charge unknown/);
    assert.equal(state.calls, 1);
  }
});

test('Anthropic success receipt must confirm the workspace', async () => {
  const data = input('anthropic');
  for (const accountHeaders of [[], ['anthropic-workspace-id', 'wrkspc_wrong']]) {
    const { state, request } = fake(data, { response: '{}',
      headers: ['request-id', 'req_fixture', 'content-length', '2', ...accountHeaders],
    });
    await assert.rejects(sendDependencySmokeRequest(data, { request }), /charge unknown/);
    assert.equal(state.calls, 1);
    assert.equal(state.incomingDestroyed, true);
  }
});

test('deadline failure tears down the single request without retrying', async () => {
  const data = input('anthropic');
  const { state, request } = fake(data, { timeout: true });
  await assert.rejects(sendDependencySmokeRequest(data, { request, timeoutMs: 10 }), /deadline exceeded; charge unknown/);
  assert.equal(state.calls, 1);
  assert.equal(state.destroyed, true);
});
