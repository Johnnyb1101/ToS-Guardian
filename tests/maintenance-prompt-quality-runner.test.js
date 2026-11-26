'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const C = require('../tools/final-corpus-lib');
const F = require('../tools/maintenance-final-evidence');
const { AUTHORIZATION_PURPOSE, checkAuthorization, strictCanonicalJson } = require('../tools/sites-lib');
const { runBoundPromptQuality, runPromptQualityRehearsal } = require('../tools/maintenance-prompt-quality-runner');
const { readQualityResponse } = require('../tools/maintenance-prompt-quality-provider');
const { createPromptQualityPlan } = require('../tools/maintenance-prompt-quality');
const { createQualityFixture } = require('./maintenance-prompt-quality-fixtures');

const HEADINGS = [
  '🧭 BOTTOM LINE', '🧭 RISK LEVEL', '📥 WHAT THEY COLLECT', '🔴 DATA SELLING & SHARING',
  '🔴 OPT-OUT RIGHTS', '📋 HOW TO OPT OUT RIGHT NOW', '🟡 AUTO-RENEWAL & BILLING', '🟢 DATA DELETION RIGHTS',
];
const COMPLETE = HEADINGS.map(heading => heading + '\nFixture text.').join('\n\n');
const MISSING = COMPLETE.replace('🧭 BOTTOM LINE\n', '').replace('DATA SELLING & SHARING', 'DATA SHARING & SELLING');
const GRADE = '{"accuracy":1,"completeness":0.95,"fabrications":0}';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tos-prompt-quality-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputDirectory = path.join(root, 'output');
  const journalDirectory = path.join(root, 'journal');
  fs.mkdirSync(outputDirectory);
  fs.mkdirSync(journalDirectory);
  const settings = createQualityFixture(journalDirectory);
  const { protocol, plan, pricing } = settings;
  const archiveLocations = Object.fromEntries(Object.entries(protocol.builds).map(([arm, build]) => {
    const file = path.join(root, arm + '.oci.tar');
    fs.writeFileSync(file, settings.archives[arm]);
    return [build.artifact.sha256, file];
  }));
  const journal = path.join(journalDirectory, 'maintenance-observed-budget-' + plan.approvalId + '.jsonl');
  const fixtures = new Map(plan.calls.map(({ id }) => {
    const [provider, arm, , , stage] = id.split(':');
    const responseId = id.replaceAll(':', '-');
    const content = stage === 'analyzer' ? (arm === 'baseline' ? MISSING : COMPLETE)
      : stage === 'independent' ? GRADE : 'Fixture stage output.';
    const responseModel = stage === 'independent' ? pricing.independent.responseModel : pricing[provider][stage].responseModel;
    const body = provider === 'anthropic' && stage !== 'independent' ? {
      id: 'msg-' + responseId, type: 'message', role: 'assistant', model: responseModel, stop_reason: 'end_turn',
      content: [{ type: 'text', text: content }],
      usage: { input_tokens: 10, output_tokens: 3, service_tier: 'standard', inference_geo: 'global' },
    } : {
      id: 'completion-' + responseId, object: 'chat.completion', model: responseModel, service_tier: 'default',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, prompt_tokens_details: { cached_tokens: 2 } },
    };
    return [id, { status: 200, requestId: 'req-' + responseId, response: Buffer.from(JSON.stringify(body)) }];
  }));
  return {
    root, journal, outputDirectory, fixtures, plan, protocol, approvedPlanHash: plan.hash, archiveLocations,
    now: settings.now, attachments: settings.attachments, reviewerRegistry: settings.reviewerRegistry,
    preregistration: settings.preregistration,
    shapeRequest({ provider, stage, build, buildHash, sourceUrl, sourceText, sourceHash, prior }) {
      assert.equal(C.digest(build), buildHash);
      assert.equal(C.hashText(sourceText), sourceHash);
      assert.equal(sourceUrl, 'https://example.test/privacy');
      assert.equal(prior, stage === 'analyzer' ? null : build.commit === protocol.builds.baseline.commit ? MISSING : COMPLETE);
      const model = build.release.config.policy.models[provider][stage === 'judge' ? 'jury' : 'default'];
      const max_tokens = pricing[provider][stage].maxOutputTokens;
      const user = { role: 'user', content: sourceText };
      const system = 'Fixture system prompt.';
      if (provider === 'anthropic') {
        return {
          url: 'https://api.anthropic.com/v1/messages',
          headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model, max_tokens, system, messages: [user] }),
        };
      }
      return {
        url: 'https://api.openai.com/v1/chat/completions',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, max_tokens, messages: [{ role: 'system', content: system }, user] }),
      };
    },
    replayResponse(digest, { provider, body }) {
      assert.ok(Object.hasOwn(archiveLocations, digest));
      const response = JSON.parse(body);
      const text = provider === 'anthropic' ? response.content[0].text : response.choices[0].message.content;
      const cached = provider === 'openai' ? 2 : 0;
      return { outcome: 'parsed', parsed: { text }, usage: {
        inputTokens: 10 - cached, outputTokens: 3, cacheReadTokens: cached, cacheWriteTokens: 0,
      } };
    },
  };
}

function journalEvents(input) {
  return fs.readFileSync(input.journal, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line).event);
}

test('both provider lanes settle fixture usage and retain baseline heading failure as an observation', async t => {
  const input = setup(t);
  const report = await runPromptQualityRehearsal(input);
  assert.deepEqual([report.providerCalls, report.fixtureDeliveries, report.observations.length], [0, 16, 4]);
  assert.deepEqual([report.diagnosticOnly, report.promotionEligible, report.evaluationPassed], [true, false, false]);
  assert.equal(C.bodyHash(report), report.hash);
  assert.equal(JSON.parse(fs.readFileSync(path.join(input.outputDirectory, 'prompt-quality-run.json'))).hash, report.hash);
  assert.ok(report.budget.attempts.every(attempt => attempt.status === 'settled' && attempt.usage.inputTokens === 10));
  assert.equal(journalEvents(input).filter(event => event.type === 'settle').length, 16);
  for (const row of report.observations) {
    assert.equal(row.headingCheck.passed, row.arm === 'candidate');
    assert.deepEqual(row.headingCheck.missing, row.arm === 'baseline' ? [HEADINGS[0], HEADINGS[3]] : []);
    assert.equal(row.stages.analyzer.provider, row.provider);
    assert.equal(row.stages.independent.provider, 'openai');
    assert.deepEqual(row.independentGrade, JSON.parse(GRADE));
    for (const stage of Object.values(row.stages)) {
      for (const key of ['capture', 'request', 'response', 'output', 'log']) {
        const { sha256, bytes } = stage[key];
        const data = fs.readFileSync(path.join(input.outputDirectory, 'evidence', sha256));
        assert.equal(data.length, bytes);
        assert.equal(crypto.createHash('sha256').update(data).digest('hex'), sha256);
      }
    }
    const gradeRequest = JSON.parse(fs.readFileSync(path.join(input.outputDirectory, 'evidence', row.stages.independent.request.sha256)));
    assert.deepEqual(Object.keys(JSON.parse(gradeRequest.messages[1].content)).sort(), ['rubric', 'sourceText', 'summary']);
  }
  assert.throws(() => F.authorizationEvidence(report), /independently verified observed/);

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const candidate = input.protocol.builds.candidate.release;
  const authorize = phase => {
    const payload = {
      v: 2, kind: 'release-activation', action: 'activate', authorizationId: 'fixture-authorization-2026',
      environment: 'fixture', configHash: candidate.configHash, expectedGeneration: 1,
      expectedConfigHash: input.protocol.builds.baseline.release.configHash, expectedHeadHash: C.hashText('fixture head'),
      issuedAt: input.now, expiresAt: '2026-11-27T12:00:00.000Z',
      evidence: { phase, configHash: candidate.configHash, evidenceHash: report.hash, protocolHash: report.protocolHash,
        corpusHash: C.digest(input.protocol.corpus), evaluationPassed: true, promotionEligible: true, diagnosticOnly: false },
    };
    return { payload, signature: crypto.sign(null, Buffer.from(AUTHORIZATION_PURPOSE + strictCanonicalJson(payload)), privateKey).toString('base64') };
  };
  const approvalKey = publicKey.export({ type: 'spki', format: 'pem' });
  const options = { now: new Date(input.now), maintenanceEvidence: {
    protocol: input.protocol, evidence: report, attachments: {}, trustedReviewers: input.reviewerRegistry,
  } };
  assert.deepEqual(checkAuthorization(authorize(report.phase), candidate, approvalKey, options),
    { valid: false, reason: 'diagnostic evidence cannot authorize release activation' });
  assert.equal(checkAuthorization(authorize('maintenance-final'), candidate, approvalKey, options).valid, false);
});

test('transport failure is durable, and a second output cannot reopen the attempt', async t => {
  const input = setup(t);
  const first = input.plan.calls[0].id;
  let deliveries = 0;
  input.fixtures.get = id => {
    assert.equal(id, first);
    deliveries++;
    throw new Error('Fixture transport timeout');
  };
  await assert.rejects(runPromptQualityRehearsal(input), /Fixture transport timeout/);
  assert.equal(deliveries, 1);
  assert.deepEqual(journalEvents(input).map(event => event.type), ['header', 'reserve', 'fail']);
  const retryOutput = path.join(input.root, 'retry');
  fs.mkdirSync(retryOutput);
  await assert.rejects(runPromptQualityRehearsal({ ...input, outputDirectory: retryOutput }), /already attempted/);
  assert.deepEqual(fs.readdirSync(retryOutput), []);
  assert.equal(deliveries, 1);
});

test('pinned archive mismatch stops before any budget journal or evidence is written', async t => {
  const input = setup(t);
  const file = Object.values(input.archiveLocations)[0];
  fs.writeFileSync(file, Buffer.alloc(fs.statSync(file).size, 0x2a));
  await assert.rejects(runPromptQualityRehearsal(input), /archive bytes changed/);
  assert.ok(!fs.existsSync(input.journal));
  assert.deepEqual(fs.readdirSync(input.outputDirectory), []);
});

test('an offline caller cannot label arbitrary delivery as a live execution', async t => {
  const input = setup(t);
  await assert.rejects(runBoundPromptQuality(input, {
    origin: 'captured-runtime',
    deliver() { assert.fail('An offline caller cannot dispatch'); },
  }), /Trusted evaluation executor required/);
  assert.ok(!fs.existsSync(input.journal));
  assert.deepEqual(fs.readdirSync(input.outputDirectory), []);
});

test('rehearsal cannot place a journal or output in a protected live directory', async t => {
  const input = setup(t);
  t.mock.method(os, 'homedir', () => input.root);
  const protectedRoot = path.join(input.root, 'AppData', 'Local', 'ToSGuardian', 'observed-prompt-quality-live');
  const nested = path.join(protectedRoot, 'nested');
  fs.mkdirSync(nested, { recursive: true });
  const restaged = createPromptQualityPlan(Object.fromEntries([
    'approvalId', 'limitMicrodollars', 'overheadMicrodollars', 'journalDirectory', 'protocol', 'pricing',
  ].map(field => [field, field === 'journalDirectory' ? nested : input.plan[field]])));
  await assert.rejects(runPromptQualityRehearsal({ ...input, plan: restaged, approvedPlanHash: restaged.hash }),
    /protected live journals/);
  await assert.rejects(runPromptQualityRehearsal({ ...input, outputDirectory: nested }), /protected live journals/);
  assert.ok(!fs.existsSync(input.journal));
  assert.deepEqual(fs.readdirSync(nested), []);
});

test('the supervisor request hook runs before request retention, reservation or delivery', async t => {
  const input = setup(t);
  await assert.rejects(runBoundPromptQuality(input, {
    origin: 'fixture',
    beforeReserve({ id, provider, bytes, sha256 }) {
      assert.equal(id, input.plan.calls[0].id);
      assert.equal(provider, 'anthropic');
      assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), sha256);
      throw new Error('Fixture request rejected');
    },
    deliver() { assert.fail('Unapproved delivery'); },
  }), /Fixture request rejected/);
  assert.deepEqual(journalEvents(input).map(event => event.type), ['header']);
  assert.deepEqual(fs.readdirSync(path.join(input.outputDirectory, 'evidence')), []);
});

test('a metered reply that fails runtime replay stays settled and prevents later calls', async t => {
  const input = setup(t);
  input.replayResponse = () => ({ outcome: 'provider-error' });
  await assert.rejects(runPromptQualityRehearsal(input), /disagrees with the pinned runtime/);
  assert.deepEqual(journalEvents(input).map(event => event.type), ['header', 'reserve', 'settle']);
});

test('unsupported tiers, refusals, duplicate JSON fields and premium cache writes fail closed', () => {
  const settings = createQualityFixture();
  const response = {
    id: 'fixture-completion', model: settings.pricing.openai.analyzer.responseModel, object: 'chat.completion',
    service_tier: 'default', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Fixture text' } }],
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
  };
  const call = { provider: 'openai', stage: 'analyzer', pricing: settings.pricing.openai.analyzer };
  function verify(body) {
    return readQualityResponse({ status: 200, requestId: 'fixture-request', response: Buffer.from(body) }, call);
  }
  assert.deepEqual(verify(JSON.stringify(response)).usage, { inputTokens: 10, outputTokens: 3 });
  assert.throws(() => verify(JSON.stringify({ ...response, service_tier: 'priority' })), /unsupported tier/);
  assert.throws(() => verify(JSON.stringify({ ...response, choices: [{
    ...response.choices[0], message: { role: 'assistant', content: 'Fixture refusal', refusal: 'refusal' },
  }] })), /refusal/);
  assert.throws(() => verify(JSON.stringify({ ...response, usage: { ...response.usage,
    prompt_tokens_details: { cache_write_tokens: 1 } } })), /cache write/);
  assert.throws(() => verify(JSON.stringify(response).replace('"service_tier":', '"service_tier":"default","service_tier":')), /Duplicate JSON/);
});
