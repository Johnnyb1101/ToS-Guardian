'use strict';
// Private implementation rehearsal only. The sole public entry point is disabled.
const https = require('node:https');
const crypto = require('node:crypto');
const { canonicalJson } = require('./final-corpus-lib');
const { parseFixture } = require('./maintenance-smoke-session');
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && JSON.stringify(Object.keys(v).sort()) === JSON.stringify([...keys].sort());
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = message => { throw Error(message); };
function parseUnambiguousJson(text) {
  let at = 0;
  const ws = () => { while (/[\x20\t\r\n]/.test(text[at] || '\0')) at++; };
  function string() {
    const start = at;
    if (text[at++] !== '"') fail('Expected JSON string');
    while (at < text.length) {
      const c = text[at++];
      if (c === '"') return JSON.parse(text.slice(start, at));
      if (c === '\\') at++; // JSON.parse below validates escape syntax and control characters.
    }
    fail('Unterminated JSON string');
  }
  function value(depth) {
    if (depth > 64) fail('JSON nesting too deep');
    ws(); const c = text[at];
    if (c === '"') { string(); return; }
    if (c === '{') {
      at++; ws(); const keys = new Set();
      if (text[at] === '}') { at++; return; }
      while (true) {
        ws(); const key = string();
        if (keys.has(key)) fail('Duplicate JSON member'); keys.add(key);
        ws(); if (text[at++] !== ':') fail('Missing JSON colon');
        value(depth + 1); ws(); const next = text[at++];
        if (next === '}') return;
        if (next !== ',') fail('Invalid JSON object');
      }
    }
    if (c === '[') {
      at++; ws(); if (text[at] === ']') { at++; return; }
      while (true) { value(depth + 1); ws(); const next = text[at++]; if (next === ']') return; if (next !== ',') fail('Invalid JSON array'); }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(at));
    if (!token) fail('Invalid JSON value'); at += token[0].length;
  }
  value(0); ws(); if (at !== text.length) fail('Trailing JSON content');
  return JSON.parse(text);
}
// Not exported. Future integration must supply private, reserved immutable bytes.
function sendOnce(serializedRequest, expectedHash, stage, credential) {
  if (typeof serializedRequest !== 'string' || Buffer.byteLength(serializedRequest) > 1000000 || hash(serializedRequest) !== expectedHash) fail('Request byte binding invalid');
  const request = JSON.parse(serializedRequest), b = request.body;
  if (canonicalJson(request) !== serializedRequest || !exact(request, ['url', 'body']) || request.url !== 'https://api.anthropic.com/v1/messages') fail('Noncanonical or unapproved endpoint');
  if (!['analyzer', 'critic'].includes(stage) || !exact(b, ['model', 'system', 'messages', 'max_tokens']) || b.model !== 'claude-sonnet-4-6' || b.max_tokens !== (stage === 'analyzer' ? 1200 : 1000)) fail('Unapproved model, feature or output cap');
  if (typeof b.system !== 'string' || !b.system.trim() || !Array.isArray(b.messages) || b.messages.length !== 1 || !exact(b.messages[0], ['role', 'content']) || b.messages[0].role !== 'user' || typeof b.messages[0].content !== 'string' || !b.messages[0].content.trim() || Buffer.byteLength(b.system + b.messages[0].content) > 150000) fail('Unsupported message');
  if (typeof credential !== 'string' || credential.length < 8 || credential.length > 1000 || /[^\x21-\x7e]/.test(credential)) fail('Credential format invalid');
  const body = canonicalJson(b); // Immutable primitive, not the returned diagnostic object.
  return new Promise((resolve, reject) => {
    let req, res, done = false;
    const timer = setTimeout(() => finish(Error('Provider deadline exceeded; charge unknown')), 60000);
    function finish(error, result) {
      if (done) return; done = true; clearTimeout(timer);
      if (error) { res?.destroy(); req?.destroy(); reject(error); }
      else resolve(result);
    }
    try {
      req = https.request({ protocol: 'https:', hostname: 'api.anthropic.com', servername: 'api.anthropic.com', port: 443, path: '/v1/messages', method: 'POST',
        rejectUnauthorized: true, minVersion: 'TLSv1.2', agent: false,
        headers: { 'content-type': 'application/json', accept: 'application/json', 'accept-encoding': 'identity', 'content-length': Buffer.byteLength(body), 'anthropic-version': '2023-06-01', 'x-api-key': credential }
      }, response => {
        res = response;
        res.on('error', () => finish(Error('Provider response failed; charge unknown')));
        res.on('aborted', () => finish(Error('Provider response aborted; charge unknown')));
        res.on('close', () => { if (!done) finish(Error('Provider response closed early; charge unknown')); });
        if (res.statusCode !== 200) return finish(Error('Provider non-success response; no redirect or retry; charge unknown'));
        const type = res.headers['content-type'], encoding = res.headers['content-encoding'];
        if (typeof type !== 'string' || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(type) || (encoding !== undefined && encoding !== 'identity')) return finish(Error('Unsupported response encoding; charge unknown'));
        const requestId = res.headers['request-id'];
        if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(requestId)) return finish(Error('Missing provider request ID; charge unknown'));
        const length = res.headers['content-length'];
        if (length !== undefined && (typeof length !== 'string' || !/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > 1048576)) return finish(Error('Invalid response length; charge unknown'));
        let size = 0; const chunks = [];
        res.on('data', chunk => {
          if (done) return;
          if (!Buffer.isBuffer(chunk)) return finish(Error('Unexpected response chunk; charge unknown'));
          size += chunk.length;
          if (size > 1048576) return finish(Error('Response too large; charge unknown'));
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (done) return;
          try {
            if (!res.complete || (length !== undefined && size !== Number(length))) fail('Incomplete response');
            const bytes = Buffer.concat(chunks), text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            const parsed = parseFixture(parseUnambiguousJson(text), stage);
            finish(null, { parsed, requestId, requestHash: expectedHash, responseBytesHash: hash(bytes),
              providerAuthenticated: false, liveDispatchAllowed: false, provenance: 'private-transport-contract-not-live-evidence' });
          } catch { finish(Error('Provider response validation failed; charge unknown')); }
        });
      });
      req.on('error', () => finish(Error('Provider request failed; charge unknown')));
      req.end(body);
    } catch { finish(Error('Provider request construction failed; charge unknown')); }
  });
}
async function dispatch() { throw Error('Paid transport disabled: final exact paid plan and verified account/billing remain required'); }
module.exports = { dispatch };
