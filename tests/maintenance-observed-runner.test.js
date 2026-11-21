'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const C = require('../tools/final-corpus-lib');
const F = require('../tools/maintenance-final-evidence');
const { releaseConfigHash } = require('../tools/sites-lib');
const { openObservedBudget } = require('../tools/maintenance-observed-budget');
const { createObservedPlan, runObservedRehearsal } = require('../tools/maintenance-observed-runner');
const { makeFinalFixture } = require('./maintenance-final-fixtures');

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const stageModels = {
  analyzer: { provider: 'openai', tier: 'default', model: 'gpt-4o-mini' },
  critic: { provider: 'openai', tier: 'default', model: 'gpt-4o-mini' },
  judge: { provider: 'openai', tier: 'jury', model: 'gpt-4o' },
};
const outputCaps = { analyzer: 1200, critic: 1000, judge: 8000 };
const now = '2026-11-17T12:00:00.000Z';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tos-observed-runner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputDirectory = path.join(root, 'records');
  const journalDirectory = path.join(root, 'journal');
  fs.mkdirSync(outputDirectory);
  fs.mkdirSync(journalDirectory);
  const origin = makeFinalFixture({ mode: 'observed' });
  const builds = {};
  const archiveLocations = {};
  for (const role of ['baseline', 'candidate', 'recovery']) {
    const build = structuredClone(origin.builds[role === 'baseline' ? 'baseline' : 'candidate']);
    build.release.config.policy.versions.serverPipeline = C.hashText(role);
    build.release.config.policy.models = { openai: { default: 'gpt-4o-mini', escalated: 'gpt-4o', jury: 'gpt-4o' } };
    build.release.configHash = releaseConfigHash(build.release.config);
    const archive = `archive fixture for ${role}`;
    build.artifact = origin.attachment(archive);
    const file = path.join(root, `${role}.oci.tar`);
    fs.writeFileSync(file, archive);
    archiveLocations[build.artifact.sha256] = file;
    builds[role] = build;
  }
  const corpus = { ...origin.protocol.corpus, samples: origin.protocol.corpus.samples.slice(0, 1) };
  const { declaredAt, criteria, rubric, reviewers } = origin.protocol;
  const spec = {
    mode: 'observed', declaredAt, sampleCount: 1, repetitions: 1, requiredCoverage: ['social'], corpus,
    criteria, rubric, reviewers, stageModels,
    judge: { provider: 'openai', model: 'gpt-6-luna', prompt: origin.protocol.judge.prompt },
  };
  const protocols = {
    activation: F.createFinalProtocol(F.createFinalPreparation(builds.baseline, builds.candidate), spec),
    recovery: F.createFinalProtocol(F.createFinalPreparation(builds.candidate, builds.recovery), spec),
  };
  const approval = { approvalId: 'fixture-rehearsal', limitMicrodollars: 5000000, overheadMicrodollars: 50000, journalDirectory, protocols };
  const plan = createObservedPlan(approval);
  const preregistrations = Object.fromEntries(Object.entries(protocols).map(([pair, protocol]) => {
    const payload = C.seal({
      v: 1, kind: 'preregistration', protocolHash: protocol.hash, reviewer: 'protocol',
      observedAt: protocol.declaredAt, outcome: 'pass', attachment: origin.attachment(`Approved ${pair} fixture`),
    });
    const signature = crypto.sign(null, Buffer.from(F.observationMessage(payload)), origin.keys.protocol.privateKey).toString('base64');
    return [pair, { payload, signature }];
  }));
  const fixtures = new Map(plan.calls.map(({ id }) => {
    const stage = id.split(':').at(-1);
    const model = stage === 'independent' ? 'gpt-6-luna' : stageModels[stage].model;
    const content = stage === 'independent' ? '{"accuracy":1,"completeness":0.95,"fabrications":0}' : `fixture text for ${stage}`;
    const response = Buffer.from(JSON.stringify({
      id: id.replaceAll(':', '-'), object: 'chat.completion', model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, prompt_tokens_details: { cached_tokens: 2 } },
    }));
    return [id, { status: 200, requestId: id.replaceAll(':', '-'), response }];
  }));
  const received = [];
  const shapeRequest = input => {
    received.push(input);
    assert.equal(C.hashText(input.sourceText), input.sourceHash);
    assert.equal(C.digest(input.build), input.buildHash);
    assert.equal(input.prior, input.stage === 'analyzer' ? null : 'fixture text for analyzer');
    return { url: ENDPOINT, body: { model: stageModels[input.stage].model, max_tokens: outputCaps[input.stage],
      messages: [{ role: 'system', content: 'fake system prompt' }, { role: 'user', content: input.sourceText }] } };
  };
  const options = {
    plan, approvedPlanHash: plan.hash, preregistrations, reviewerRegistry: origin.context.trustedReviewers, now,
    attachments: new Map(Object.entries(origin.context.attachments)), archiveLocations, outputDirectory,
    fixtures, shapeRequest,
  };
  const readBudget = () => {
    const budget = openObservedBudget(journalDirectory, plan.budget);
    try { return budget.snapshot(); } finally { budget.close(); }
  };
  return { options, approval, received, readBudget };
}

test('both comparisons keep one reservation, original bytes and fixture-only results', async t => {
  const { options, received, readBudget } = setup(t);
  const result = await runObservedRehearsal(options);
  assert.equal(result.diagnosticOnly, true);
  assert.equal(result.evaluationPassed, false);
  assert.equal(result.promotionEligible, false);
  assert.equal(result.providerCalls, 0);
  assert.equal(result.fakeCalls, 16);
  assert.equal(result.observations.length, 4);
  assert.equal(received.length, 12);
  assert.equal(result.budget.reservedMicrodollars, options.plan.budget.totalMicrodollars);
  assert.equal(readBudget().attempts.length, 16);
  for (const observation of result.observations) {
    assert.equal(observation.origin, 'fixture');
    assert.deepEqual(observation.independentGrade, { accuracy: 1, completeness: 0.95, fabrications: 0 });
    for (const [stage, retained] of Object.entries(observation.stages)) {
      const id = [observation.comparison, observation.arm, observation.sampleId, observation.repetition, stage].join(':');
      const response = fs.readFileSync(path.join(options.outputDirectory, retained.response.sha256));
      assert.ok(response.equals(options.fixtures.get(id).response));
    }
  }
  await assert.rejects(runObservedRehearsal(options), /already started/);
  assert.equal(received.length, 12);
});

test('plan refuses budget below the full reservation and detects a changed plan', async t => {
  const { options, approval, received } = setup(t);
  assert.throws(() => createObservedPlan({ ...approval, limitMicrodollars: options.plan.budget.totalMicrodollars - 1 }), /exceeds approved limit/);
  const modified = structuredClone(options.plan);
  modified.calls[0].maxOutputTokens++;
  await assert.rejects(runObservedRehearsal({ ...options, plan: modified }), /plan changed/);
  const elsewhere = path.join(path.dirname(options.outputDirectory), 'other-journal');
  fs.mkdirSync(elsewhere);
  const reissued = createObservedPlan({ ...approval, journalDirectory: elsewhere });
  await assert.rejects(runObservedRehearsal({ ...options, plan: reissued }), /Approved evaluation plan hash required/);
  assert.equal(received.length, 0);
});

test('signature, source and archive mismatches stop before shaping a request', async t => {
  const { options, received } = setup(t);
  const original = options.preregistrations.activation.signature;
  options.preregistrations.activation.signature = Buffer.alloc(64).toString('base64');
  await assert.rejects(runObservedRehearsal(options), /signature did not verify/);
  options.preregistrations.activation.signature = original;
  const hash = options.plan.protocols.activation.corpus.samples[0].source.sha256;
  const source = options.attachments.get(hash);
  options.attachments.set(hash, Buffer.from('changed capture'));
  await assert.rejects(runObservedRehearsal(options), /attachment changed or is missing/);
  options.attachments.set(hash, source);
  const archive = Object.values(options.archiveLocations)[0];
  const bytes = fs.readFileSync(archive);
  bytes[0] ^= 1;
  fs.writeFileSync(archive, bytes);
  await assert.rejects(runObservedRehearsal(options), /archive bytes changed/);
  assert.equal(received.length, 0);
});

test('reviewer identities must use their pinned independent keys before rehearsal starts', async t => {
  const { options, received } = setup(t);
  options.reviewerRegistry.human.publicKey = options.reviewerRegistry.execution.publicKey;
  await assert.rejects(runObservedRehearsal(options), /independent reviewer keys/);
  assert.equal(received.length, 0);
});

test('unexpected endpoint, model and request cap fail before any reservation', async t => {
  const { options, readBudget } = setup(t);
  for (const amend of [
    request => { request.url += '/elsewhere'; },
    request => { request.body.model = 'some-other-model'; },
    request => { request.body.max_tokens++; },
  ]) {
    await assert.rejects(runObservedRehearsal({ ...options, shapeRequest: input => {
      const request = options.shapeRequest(input);
      amend(request);
      return request;
    } }), /Invalid captured analyzer request/);
    assert.deepEqual(readBudget().attempts, []);
  }
});

test('redirect and lost or partial response leave a durable stop', async t => {
  for (const variant of ['redirect', 'lost', 'partial']) await t.test(variant, async inner => {
    const { options, readBudget, received } = setup(inner);
    const id = options.plan.calls[0].id;
    if (variant === 'lost') options.fixtures.delete(id);
    if (variant === 'redirect') options.fixtures.get(id).status = 302;
    if (variant === 'partial') options.fixtures.get(id).response = Buffer.from('{"id":');
    await assert.rejects(runObservedRehearsal(options));
    if (variant === 'partial') {
      const original = options.fixtures.get(id).response;
      const digest = crypto.createHash('sha256').update(original).digest('hex');
      assert.ok(fs.readFileSync(path.join(options.outputDirectory, digest)).equals(original));
    }
    const snapshot = readBudget();
    assert.equal(snapshot.halted, true);
    assert.equal(snapshot.attempts.length, 1);
    assert.equal(snapshot.reservedMicrodollars, options.plan.budget.totalMicrodollars);
    assert.equal(received.length, 1);
  });
});

test('over-cap usage and malformed independent grades halt without dispatching later stages', async t => {
  await t.test('over cap', async inner => {
    const { options, readBudget } = setup(inner);
    const fixture = options.fixtures.get(options.plan.calls[0].id);
    const response = JSON.parse(fixture.response);
    response.usage.prompt_tokens = 128001;
    response.usage.total_tokens = 128004;
    fixture.response = Buffer.from(JSON.stringify(response));
    await assert.rejects(runObservedRehearsal(options));
    assert.equal(readBudget().halted, true);
    assert.equal(readBudget().attempts.length, 1);
  });
  await t.test('malformed grade', async inner => {
    const { options, readBudget } = setup(inner);
    const fixture = options.fixtures.get(options.plan.calls[3].id);
    const response = JSON.parse(fixture.response);
    response.choices[0].message.content = '{"accuracy":0.8}';
    fixture.response = Buffer.from(JSON.stringify(response));
    await assert.rejects(runObservedRehearsal(options), /grade is incomplete/);
    assert.equal(readBudget().halted, true);
    assert.equal(readBudget().attempts.length, 4);
  });
});

test('repeated receipt identity and unsupported Jury output halt the approval', async t => {
  await t.test('duplicate delivery identity', async inner => {
    const { options, readBudget } = setup(inner);
    const first = options.fixtures.get(options.plan.calls[0].id);
    options.fixtures.get(options.plan.calls[1].id).requestId = first.requestId;
    await assert.rejects(runObservedRehearsal(options), /Repeated provider request or completion identity/);
    assert.equal(readBudget().halted, true);
    assert.equal(readBudget().attempts.length, 2);
  });
  await t.test('unsupported response role', async inner => {
    const { options, readBudget } = setup(inner);
    const fixture = options.fixtures.get(options.plan.calls[2].id);
    const response = JSON.parse(fixture.response);
    response.choices[0].message.role = 'user';
    fixture.response = Buffer.from(JSON.stringify(response));
    await assert.rejects(runObservedRehearsal(options), /Unsupported fake provider output/);
    assert.equal(readBudget().halted, true);
    assert.equal(readBudget().attempts.length, 3);
  });
});
