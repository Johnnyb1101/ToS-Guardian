'use strict';
// Trusted local fixture execution ONLY. No credential access or network transport.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { localPath } = require('./maintenance-local-path');
const { canonicalJson } = require('./final-corpus-lib');
const { executeBound } = require('./maintenance-bound-runtime');
const { Registry, prepare } = require('./maintenance-smoke-budget');
const digest = v => crypto.createHash('sha256').update(canonicalJson(v)).digest('hex');
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && JSON.stringify(Object.keys(v).sort()) === JSON.stringify([...keys].sort());
const requireThat = (ok, message) => { if (!ok) throw Error(message); };
const IDS = ['baseline:analyzer', 'baseline:critic', 'candidate:analyzer', 'candidate:critic'];
function boundBytes(binding) {
  const bytes = fs.readFileSync(localPath(binding.path));
  requireThat(bytes.length === binding.bytes && crypto.createHash('sha256').update(bytes).digest('hex') === binding.sha256, 'Changed bound bytes');
  requireThat(bytes.equals(Buffer.from(bytes.toString('utf8'))), 'Invalid UTF-8');
  return bytes.toString('utf8');
}
function parseFixture(response, stage) {
  requireThat(exact(response, ['id', 'type', 'role', 'model', 'content', 'stop_reason', 'stop_sequence', 'usage']), 'Unsupported response shape');
  requireThat(typeof response.id === 'string' && /^msg_[A-Za-z0-9_-]{1,128}$/.test(response.id) && response.type === 'message' && response.role === 'assistant' && response.model === 'claude-sonnet-4-6', 'Unexpected response identity');
  requireThat(['analyzer', 'critic'].includes(stage) && response.stop_reason === 'end_turn' && response.stop_sequence === null, 'Incomplete/refused/tool response');
  requireThat(Array.isArray(response.content) && response.content.length === 1 && exact(response.content[0], ['type', 'text']) && response.content[0].type === 'text' && typeof response.content[0].text === 'string' && response.content[0].text.trim() && response.content[0].text.length <= 30000, 'Only nonempty bounded plain text accepted');
  const u = response.usage;
  requireThat(exact(u, ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) && Number.isSafeInteger(u.input_tokens) && u.input_tokens >= 0 && u.input_tokens <= 1000000 && Number.isSafeInteger(u.output_tokens) && u.output_tokens > 0 && u.output_tokens <= (stage === 'analyzer' ? 1200 : 1000) && u.cache_creation_input_tokens === 0 && u.cache_read_input_tokens === 0, 'Unknown or out-of-bound usage/cache billing');
  return { id: response.id, text: response.content[0].text, responseHash: digest(response), outputHash: digest(response.content[0].text), usage: { inputTokens: u.input_tokens, outputTokens: u.output_tokens }, providerAuthenticated: false, provenance: 'synthetic-response-fixture' };
}
class OfflineSession {
  #spec; #registry; #index = 0; #pending = null; #outputs = {}; #responseIds = new Set(); #halted = false;
  constructor(spec, mode = 'open') {
    prepare(spec);
    this.#spec = JSON.parse(canonicalJson(spec));
    // Harness binding must identify the actual module executed, not arbitrary bytes.
    requireThat(path.resolve(spec.bindings.harness.path).toLowerCase() === path.resolve(__dirname, 'maintenance-bound-runtime.js').toLowerCase(), 'Actual bound-runtime module binding required');
    requireThat(boundBytes(spec.bindings.harness) === fs.readFileSync(path.join(__dirname, 'maintenance-bound-runtime.js'), 'utf8'), 'Harness changed');
    this.#registry = new Registry(this.#spec, mode);
    if (this.#registry.snapshot().events.length !== 1) {
      this.#registry.close(); throw Error('Session resume requires manual evidence reconciliation; no automatic replay');
    }
  }
  nextFixtureRequest() {
    requireThat(!this.#halted && !this.#pending && this.#index < IDS.length, 'Session halted, pending or complete');
    prepare(this.#spec);
    const id = IDS[this.#index], [arm, stage] = id.split(':');
    const capture = JSON.parse(boundBytes(this.#spec.bindings[arm + 'Artifact']));
    const release = JSON.parse(boundBytes(this.#spec.bindings[arm + 'Release']));
    const doc = JSON.parse(boundBytes(this.#spec.bindings.document));
    requireThat(exact(doc, ['domain', 'text', 'sourceUrl', 'capturedAt']) && typeof doc.domain === 'string' && typeof doc.text === 'string' && typeof doc.sourceUrl === 'string' && typeof doc.capturedAt === 'string', 'Document manifest required');
    const input = stage === 'analyzer' ? { operation: stage, provider: 'anthropic', domain: doc.domain, documentText: doc.text } :
      { operation: stage, provider: 'anthropic', domain: doc.domain, sourceText: doc.text, analysisSummary: this.#outputs[arm].text };
    const execution = executeBound(capture, release, input);
    const reservation = this.#registry.reserve(id, execution.result.request, stage === 'critic' ? this.#outputs[arm].outputHash : null);
    const requestBytes = canonicalJson(execution.result.request);
    requireThat(crypto.createHash('sha256').update(requestBytes).digest('hex') === reservation.requestHash, 'Reserved request bytes mismatch');
    this.#pending = { id, arm, stage, requestHash: reservation.requestHash, requestBytes };
    return { ...execution, reservation, requestConstructedByBoundRuntime: true, providerAuthenticated: false, liveDispatchAllowed: false, provenance: 'offline-trusted-module-execution' };
  }
  acceptFixture(response) {
    requireThat(!this.#halted && this.#pending, 'No pending fixture request');
    const pending = this.#pending;
    try {
      const parsed = parseFixture(response, pending.stage);
      requireThat(!this.#responseIds.has(parsed.id), 'Duplicate provider response ID');
      this.#registry.settle(pending.id, parsed.usage, parsed.outputHash);
      this.#responseIds.add(parsed.id);
      if (pending.stage === 'analyzer') this.#outputs[pending.arm] = parsed;
      this.#index++; this.#pending = null;
      return { ...parsed, requestHash: pending.requestHash, liveDispatchAllowed: false, evaluationPassed: false, promotionEligible: false };
    } catch (e) {
      this.#halted = true;
      if (!this.#registry.snapshot().halted) {
        try { this.#registry.fail(pending.id); } catch { /* Failed journal remains poisoned and cannot authorize work. */ }
      }
      throw e;
    }
  }
  snapshot() { return this.#registry.snapshot(); }
  close() { this.#halted = true; this.#registry.close(); }
}
module.exports = { OfflineSession, parseFixture };
