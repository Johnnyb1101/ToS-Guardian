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

function setup(t, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tos-prompt-quality-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputDirectory = path.join(root, 'output');
  const journalDirectory = path.join(root, 'journal');
  fs.mkdirSync(outputDirectory);
  fs.mkdirSync(journalDirectory);
  const settings = createQualityFixture(journalDirectory, options);
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

test('the runner awaits Anthropic count checks and binds their receipts to the exact dispatched requests', async t => {
  const input = setup(t, { checkAnthropicInput: true });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const checked = new Map();
  const sent = [];
  const evidence = path.join(input.outputDirectory, 'evidence');
  const run = runBoundPromptQuality(input, {
    origin: 'fixture',
    async beforeReserve({ id, provider, bytes, sha256 }) {
      if (provider !== 'anthropic') return;
      assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), sha256);
      if (id === input.plan.calls[0].id) {
        entered.resolve();
        await release.promise;
      }
      const receipt = { inputTokens: 56_000, requestId: 'count-' + checked.size };
      checked.set(id, { requestSha256: sha256, ...receipt });
      bytes.fill(0);
      return receipt;
    },
    deliver({ id, provider, bytes, sha256 }) {
      assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), sha256);
      if (provider === 'anthropic') assert.equal(checked.get(id).requestSha256, sha256);
      sent.push(id);
      return input.fixtures.get(id);
    },
  });
  try {
    await Promise.race([entered.promise, run]);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(sent, []);
    assert.deepEqual(journalEvents(input).map(event => event.type), ['header']);
    assert.deepEqual(fs.readdirSync(evidence), []);
  } finally {
    release.resolve();
  }
  const report = await run;
  assert.deepEqual([report.providerCalls, report.fixtureDeliveries, report.inputChecks], [0, 16, 6]);
  assert.deepEqual(sent, input.plan.calls.map(call => call.id));
  for (const row of report.observations) {
    for (const stage of Object.values(row.stages)) {
      const log = JSON.parse(fs.readFileSync(path.join(evidence, stage.log.sha256)));
      if (stage.provider === 'anthropic') {
        assert.equal(log.request.sha256, log.inputCheck.requestSha256);
        assert.deepEqual(log.inputCheck, checked.get(log.callId));
        assert.deepEqual(stage.inputCheck, log.inputCheck);
      } else {
        assert.equal(Object.hasOwn(stage, 'inputCheck'), false);
        assert.equal(Object.hasOwn(log, 'inputCheck'), false);
      }
    }
  }
});

test('missing, malformed and oversized counts stop before reservation or delivery', async t => {
  const invalid = [
    [undefined, null],
    [{ inputTokens: 0, requestId: 'count-id' }, null],
    [{ inputTokens: 1.5, requestId: 'count-id' }, null],
    [{ inputTokens: 1, requestId: 'invalid id' }, 1],
    [{ inputTokens: 1, requestId: 'count-id', extra: 1 }, 1],
    [{ inputTokens: 56_001, requestId: 'count-id' }, 56_001],
  ];
  for (const [receipt, expectedCount] of invalid) {
    const input = setup(t, { checkAnthropicInput: true });
    const first = input.plan.calls[0].id;
    let requestSha256;
    await assert.rejects(runBoundPromptQuality(input, {
      origin: 'fixture',
      async beforeReserve({ id, sha256 }) {
        assert.equal(id, first);
        requestSha256 = sha256;
        return receipt;
      },
      deliver() { assert.fail('Invalid count cannot permit delivery'); },
    }), /Anthropic input count/);
    assert.deepEqual(journalEvents(input).map(event => event.type), ['header']);
    assert.deepEqual(fs.readdirSync(input.outputDirectory), ['evidence']);
    const evidence = path.join(input.outputDirectory, 'evidence');
    const files = fs.readdirSync(evidence);
    assert.equal(files.length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(evidence, files[0]))), {
      kind: 'prompt-quality-input-check-failed', origin: 'fixture', planHash: input.plan.hash,
      callId: first, requestSha256, inputTokens: expectedCount,
    });
  }
});

test('a repeated Anthropic count receipt stops before the second reservation', async t => {
  const input = setup(t, { checkAnthropicInput: true });
  const sent = [];
  await assert.rejects(runBoundPromptQuality(input, {
    origin: 'fixture',
    async beforeReserve() { return { inputTokens: 10, requestId: 'reused-count-id' }; },
    deliver({ id }) {
      sent.push(id);
      return input.fixtures.get(id);
    },
  }), /Anthropic input count/);
  assert.deepEqual(sent, [input.plan.calls[0].id]);
  assert.deepEqual(journalEvents(input).map(event => event.type), ['header', 'reserve', 'settle']);
});

test('a reduced reservation still requires headroom for one full-context Anthropic charge', async t => {
  const input = setup(t, { checkAnthropicInput: true });
  const { approvalId, overheadMicrodollars, journalDirectory, protocol } = input.plan;
  const pricing = structuredClone(input.plan.pricing);
  pricing.anthropic.analyzer.inputMicrodollarsPerMillion = 12000;
  const plan = createPromptQualityPlan({ approvalId, limitMicrodollars: 6000, overheadMicrodollars,
    journalDirectory, protocol, pricing });
  assert(plan.budget.totalMicrodollars < plan.limitMicrodollars);
  await assert.rejects(runBoundPromptQuality({ ...input, plan, approvedPlanHash: plan.hash }, {
    origin: 'fixture',
    beforeReserve() { assert.fail('The count should never be sent without charge headroom'); },
    deliver() { assert.fail('The paid request should never be sent without charge headroom'); },
  }), /Insufficient Anthropic charge headroom/);
  assert.deepEqual(journalEvents(input).map(event => event.type), ['header']);
});

test('actual Anthropic usage above the reserved cap stays unknown-cost after an accepted estimate', async t => {
  const input = setup(t, { checkAnthropicInput: true });
  await assert.rejects(runPromptQualityRehearsal(input), /Local Anthropic input count fixtures required/);
  assert.ok(!fs.existsSync(input.journal));
  const first = input.plan.calls[0].id;
  const delivery = input.fixtures.get(first);
  const response = JSON.parse(delivery.response);
  response.usage.input_tokens = 64_001;
  const fixtures = new Map([[first, { ...delivery, response: Buffer.from(JSON.stringify(response)) }]]);
  const inputCounts = new Map([[first, { inputTokens: 56_000, requestId: 'count-id' }]]);
  await assert.rejects(runPromptQualityRehearsal({ ...input, fixtures, inputCounts }), /over-budget evaluation token usage/);
  const events = journalEvents(input);
  assert.deepEqual(events.map(event => event.type), ['header', 'reserve', 'fail']);
  assert.equal(events[1].id, first);
  const evidence = path.join(input.outputDirectory, 'evidence');
  const failure = fs.readdirSync(evidence).map(file => JSON.parse(fs.readFileSync(path.join(evidence, file))))
    .find(entry => entry.kind === 'prompt-quality-failed-call');
  assert.equal(failure.accounting, 'unknown-cost');
  assert.deepEqual(failure.inputCheck, {
    requestSha256: events[1].requestHash, requestId: 'count-id', inputTokens: 56_000,
  });
});

test('a metered reply that fails runtime replay stays settled and prevents later calls', async t => {
  const input = setup(t);
  input.replayResponse = () => ({ outcome: 'provider-error' });
  await assert.rejects(runPromptQualityRehearsal(input), /disagrees with the pinned runtime/);
  assert.deepEqual(journalEvents(input).map(event => event.type), ['header', 'reserve', 'settle']);
});

function anthropicThinkingResponse() {
  // The retained Jury response's block types and usage, with synthetic content and identity.
  return {
    id: 'fixture-thinking-completion', type: 'message', role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: '', signature: 'fixture' }, { type: 'text', text: 'Fixture verdict.' }],
    usage: {
      input_tokens: 10_665, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      output_tokens: 2_238, output_tokens_details: { thinking_tokens: 1_338 },
      service_tier: 'standard', inference_geo: 'global', speed: 'standard',
    },
  };
}

function anthropicThinkingDelivery(response) {
  return { status: 200, requestId: 'fixture-thinking-request', response: Buffer.from(JSON.stringify(response)) };
}

test('the runner settles all billed Anthropic Jury output tokens and retains the visible verdict', async t => {
  const input = setup(t);
  const { id } = input.plan.calls.find(call => call.id.startsWith('anthropic:') && call.id.endsWith(':judge'));
  const response = anthropicThinkingResponse();
  const usage = { inputTokens: 10_665, outputTokens: 2_238 };
  input.fixtures.set(id, anthropicThinkingDelivery(response));
  const replayResponse = input.replayResponse;
  input.replayResponse = (digest, replay) => JSON.parse(replay.body).id === response.id ? {
    outcome: 'parsed', parsed: { text: response.content[1].text },
    usage: { ...usage, cacheReadTokens: 0, cacheWriteTokens: 0 },
  } : replayResponse(digest, replay);

  const report = await runPromptQualityRehearsal(input);
  const attempt = report.budget.attempts.find(attempt => attempt.id === id);
  assert.equal(attempt.status, 'settled');
  assert.deepEqual(attempt.usage, usage);
  assert.equal(attempt.actualMicrodollars, 16);
  const { stages } = report.observations.find(row => row.provider === 'anthropic' && row.arm === id.split(':')[1]);
  assert.deepEqual(stages.judge.usage, usage);
  assert.equal(fs.readFileSync(path.join(input.outputDirectory, 'evidence', stages.judge.output.sha256), 'utf8'),
    response.content[1].text);
});

test('Anthropic Jury usage allows omitted or null thinking details and rejects invalid breakdowns', () => {
  const { pricing } = createQualityFixture(undefined, { checkAnthropicInput: true });
  const call = { provider: 'anthropic', stage: 'judge', pricing: pricing.anthropic.judge };
  const response = anthropicThinkingResponse();
  function verify() {
    return readQualityResponse(anthropicThinkingDelivery(response), call);
  }

  delete response.usage.output_tokens_details;
  assert.deepEqual(verify().usage, { inputTokens: 10_665, outputTokens: 2_238 });
  response.usage.output_tokens_details = null;
  assert.deepEqual(verify().usage, { inputTokens: 10_665, outputTokens: 2_238 });

  const invalid = [[], {}, { thinking_tokens: 1, unknown_tokens: 0 }, ...[
    null, '1338', -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 2_239,
  ].map(thinking_tokens => ({ thinking_tokens }))];
  for (const breakdown of invalid) {
    response.usage.output_tokens_details = breakdown;
    assert.throws(verify, /Invalid Anthropic thinking-token breakdown/, JSON.stringify(breakdown));
  }
  response.usage.output_tokens_details = { thinking_tokens: 1_338 };
  response.usage.unknown_tokens = 0;
  assert.throws(verify, /Unsupported Anthropic tier, inference geography or cache usage/);
  delete response.usage.unknown_tokens;

  response.usage.output_tokens = 8_001;
  response.usage.output_tokens_details = { thinking_tokens: 7_101 };
  assert.throws(verify, /over-budget evaluation token usage/);
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
