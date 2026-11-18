'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), { EventEmitter } = require('node:events'), crypto = require('node:crypto');
const { canonicalJson } = require('../tools/final-corpus-lib');
const file = path.resolve(__dirname, '../tools/maintenance-smoke-transport.js');
const source = fs.readFileSync(file, 'utf8');
const request = { url: 'https://api.anthropic.com/v1/messages', body: { model: 'claude-sonnet-4-6', max_tokens: 1200, system: 'test', messages: [{ role: 'user', content: 'public fixture' }] } };
const bytes = canonicalJson(request), hash = crypto.createHash('sha256').update(bytes).digest('hex');
const valid = { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'Synthetic response.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
function fixture(options = {}) {
  let calls = 0, requestOptions, sentBody, timer, destroyed = false;
  const fake = { request(opts, callback) {
    calls++; requestOptions = opts;
    const req = new EventEmitter(); req.destroy = () => { destroyed = true; };
    req.end = body => {
      sentBody = body;
      queueMicrotask(() => {
        if (options.timeout) return timer();
        if (options.requestError) return req.emit('error', Error('SECRET provider error must not leak'));
        const res = new EventEmitter(); res.destroy = () => { destroyed = true; };
        res.statusCode = options.status ?? 200; res.complete = options.complete ?? true;
        res.headers = { 'content-type': 'application/json', 'request-id': 'req_fixture', ...options.headers };
        callback(res);
        if (destroyed) return;
        if (options.aborted) return res.emit('aborted');
        if (options.closed) return res.emit('close');
        const payload = options.payload ?? Buffer.from(JSON.stringify(options.response ?? valid));
        res.emit('data', payload); if (!destroyed) res.emit('end');
      });
    };
    return req;
  } };
  const m = new Module(file, module); m.filename = file; m.paths = module.paths;
  const req = m.require.bind(m); m.require = name => name === 'node:https' ? fake : req(name);
  // Test-only lexical timer substitution and private exposure; production exports dispatch only.
  m._compile('const setTimeout=globalThis.__smokeTestClock.set, clearTimeout=globalThis.__smokeTestClock.clear;\n' + source + '\nmodule.exports.privateSend=sendOnce;', file);
  return { m: m.exports, stats: () => ({ calls, requestOptions, sentBody, destroyed }), setTimer: fn => { timer = fn; } };
}
async function run() {
  let active;
  globalThis.__smokeTestClock = { set(fn, ms) { assert.equal(ms, 60000); active.setTimer(fn); return 1; }, clear() {} };
  try {
    active = fixture(); const good = await active.m.privateSend(bytes, hash, 'analyzer', 'OFFLINE-FIXTURE');
    const s = active.stats(); assert.equal(s.calls, 1); assert.equal(s.sentBody, canonicalJson(request.body));
    assert.equal(s.requestOptions.hostname, 'api.anthropic.com'); assert.equal(s.requestOptions.path, '/v1/messages');
    assert.equal(s.requestOptions.rejectUnauthorized, true); assert.equal(s.requestOptions.minVersion, 'TLSv1.2'); assert.equal(s.requestOptions.agent, false);
    assert.equal(good.providerAuthenticated, false); assert.equal(good.liveDispatchAllowed, false);
    console.log('ok immutable bytes, fixed endpoint, TLS options, one send and synthetic provenance');
    const cases = [{ status: 302 }, { status: 429 }, { status: 500 }, { timeout: true }, { requestError: true }, { aborted: true }, { closed: true }, { complete: false }, { headers: { 'content-encoding': 'gzip' } }, { headers: { 'request-id': undefined } }, { headers: { 'content-length': '10' } }, { payload: Buffer.alloc(1048577) }, { payload: Buffer.from([0xff]) }, { payload: Buffer.from('{') }, { response: { ...valid, stop_reason: 'max_tokens' } }];
    for (const c of cases) {
      active = fixture(c);
      await assert.rejects(active.m.privateSend(bytes, hash, 'analyzer', 'OFFLINE-FIXTURE'), error => /charge unknown/.test(error.message) && !error.message.includes('SECRET'));
      assert.equal(active.stats().calls, 1); assert.equal(active.stats().destroyed, true);
    }
    console.log('ok 15 redirect/retry/timeout/size/encoding/partial/usage negatives stop after one attempt');
    const raw = JSON.stringify(valid);
    for (const ambiguous of [raw.replace('"output_tokens":10', '"output_tokens":999999,"output_tokens":10'), raw.replace('"model":"claude-sonnet-4-6"', '"model":"unapproved","model":"claude-sonnet-4-6"'), raw.replace('"output_tokens":10', '"output_tokens":999999,"output_\\u0074okens":10')]) {
      active = fixture({ payload: Buffer.from(ambiguous) });
      await assert.rejects(active.m.privateSend(bytes, hash, 'analyzer', 'OFFLINE-FIXTURE'), /validation failed/);
      assert.equal(active.stats().calls, 1);
    }
    console.log('ok duplicate and escaped-equivalent JSON members rejected before settlement');
    active = fixture(); assert.throws(() => active.m.privateSend(bytes + ' ', hash, 'analyzer', 'OFFLINE-FIXTURE'));
    assert.equal(active.stats().calls, 0);
    await assert.rejects(require('../tools/maintenance-smoke-transport').dispatch({ enabled: true }), /disabled/);
    assert.deepEqual(Object.keys(require('../tools/maintenance-smoke-transport')), ['dispatch']);
    console.log('ok unreserved byte mutation rejected and public transport cannot enable private implementation');
  } finally { delete globalThis.__smokeTestClock; }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
