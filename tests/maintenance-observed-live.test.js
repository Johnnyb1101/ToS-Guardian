'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { Writable, PassThrough } = require('node:stream');
const { test } = require('node:test');
const C = require('../tools/final-corpus-lib');
const F = require('../tools/maintenance-final-evidence');
const { createObservedPlan } = require('../tools/maintenance-observed-runner');
const { openObservedBudget } = require('../tools/maintenance-observed-budget');
const packet = require('../tools/maintenance-observed-live-transport');
const { releaseConfigHash } = require('../tools/sites-lib');
const { makeFinalFixture } = require('./maintenance-final-fixtures');

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const liveFile = require.resolve('../tools/maintenance-observed-live');
const resolveLive = createRequire(liveFile);
const caps = { analyzer: 1200, critic: 1000, judge: 8000 };
const models = {
  analyzer: { provider: 'openai', tier: 'default', model: 'gpt-4o-mini' },
  critic: { provider: 'openai', tier: 'default', model: 'gpt-4o-mini' },
  judge: { provider: 'openai', tier: 'jury', model: 'gpt-4o' },
};
const fakeCredential = 'FAKE-LOCAL-TEST-CREDENTIAL';
const projectId = 'proj_fake_evaluation';

function fakeProvider(model, number) {
  const content = model === 'gpt-6-luna' ? '{"accuracy":1,"completeness":1,"fabrications":0}' : 'Local fake output';
  const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };
  if (number % 4 !== 2) {
    usage.prompt_tokens_details = {
      cached_tokens: 2, cache_write_tokens: model === 'gpt-4o-mini' ? 0 : 4,
      text_tokens: 10, audio_tokens: 0, image_tokens: 0,
    };
    usage.completion_tokens_details = {
      reasoning_tokens: model === 'gpt-6-luna' ? 1 : 0,
      text_tokens: model === 'gpt-6-luna' ? 2 : 3,
      audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0,
    };
  }
  return Buffer.from(JSON.stringify({
    id: `completion-${number}`, object: 'chat.completion', model, service_tier: 'default',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content, annotations: [] } }],
    usage,
  }));
}

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tos-live-supervisor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const journalDirectory = path.join(root, 'AppData', 'Local', 'ToSGuardian', 'observed-live');
  const outputDirectory = path.join(root, 'output');
  fs.mkdirSync(journalDirectory, { recursive: true });
  fs.mkdirSync(outputDirectory);
  const fixture = makeFinalFixture({ mode: 'observed' });
  const builds = {}, archiveLocations = {}, images = [];
  for (const role of ['baseline', 'candidate', 'recovery']) {
    const build = structuredClone(fixture.builds.candidate);
    build.release.config.policy.versions.serverPipeline = C.hashText(role);
    build.release.config.policy.models = { openai: { default: 'gpt-4o-mini', escalated: 'gpt-4o', jury: 'gpt-4o' } };
    build.release.configHash = releaseConfigHash(build.release.config);
    const file = path.join(root, role + '.tar');
    fs.writeFileSync(file, 'fake archive ' + role);
    build.artifact = fixture.attachment('fake archive ' + role);
    archiveLocations[build.artifact.sha256] = file;
    images.push({ ...build.artifact, manifestDigest: 'sha256:' + C.hashText('fake manifest ' + role) });
    builds[role] = build;
  }
  const { declaredAt, criteria, rubric, reviewers } = fixture.protocol;
  const spec = {
    mode: 'observed', declaredAt, sampleCount: 1, repetitions: 1, requiredCoverage: ['social'],
    corpus: { ...fixture.protocol.corpus, samples: fixture.protocol.corpus.samples.slice(0, 1) },
    criteria, rubric, reviewers, stageModels: models,
    judge: { provider: 'openai', model: 'gpt-6-luna', prompt: fixture.protocol.judge.prompt },
  };
  const protocols = {
    activation: F.createFinalProtocol(F.createFinalPreparation(builds.baseline, builds.candidate), spec),
    recovery: F.createFinalProtocol(F.createFinalPreparation(builds.candidate, builds.recovery), spec),
  };
  const plan = createObservedPlan({ protocols, approvalId: 'live-test-only', limitMicrodollars: 4000000,
    overheadMicrodollars: 50000, journalDirectory });
  const preregistrations = Object.fromEntries(Object.entries(protocols).map(([pair, protocol]) => {
    const payload = C.seal({ v: 1, kind: 'preregistration', protocolHash: protocol.hash, reviewer: 'protocol',
      observedAt: protocol.declaredAt, outcome: 'pass', attachment: fixture.attachment('fake preregistration ' + pair) });
    return [pair, { payload,
      signature: crypto.sign(null, Buffer.from(F.observationMessage(payload)), fixture.keys.protocol.privateKey).toString('base64') }];
  }));
  const billingEvidence = fixture.attachment('fake approved price and tax evidence');
  const owner = crypto.generateKeyPairSync('ed25519');
  const controls = { spawn: 0, credentialReads: 0, shape: [], sends: [], badManifest: false, duplicateJson: false };
  const fakeChild = (_file, args, options) => {
    controls.spawn++;
    assert.ok(!JSON.stringify(options.env).includes(fakeCredential));
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; child.emit('close'); };
    let booted = false;
    child.stdin = new Writable({
      write(chunk, _encoding, done) {
        if (!booted) {
          assert.equal(sha(Buffer.from(chunk.toString().trim(), 'base64')), args.at(-1));
          booted = true;
          done();
          return;
        }
        const value = JSON.parse(chunk.toString());
        if (value.images) {
          child.stdout.write(JSON.stringify({ ready: value.images.map(({ sha256, manifestDigest }) => ({ sha256, manifestDigest })) }) + '\n');
        } else {
          const { archiveSha256, input } = value;
          const image = images.find(entry => entry.sha256 === archiveSha256);
          controls.shape.push(value);
          assert.equal(input.build.artifact.sha256, archiveSha256);
          assert.equal(input.prior, input.stage === 'analyzer' ? null : 'Local fake output');
          const request = { url: 'https://api.openai.com/v1/chat/completions',
            body: { model: models[input.stage].model, max_tokens: caps[input.stage],
              messages: [{ role: 'system', content: 'fake prompt' }, { role: 'user', content: input.sourceText }] } };
          child.stdout.write(JSON.stringify({
            archiveSha256, manifestDigest: controls.badManifest ? images[1].manifestDigest : image.manifestDigest, request,
          }) + '\n');
        }
        done();
      },
      final(done) {
        child.stdout.end();
        child.stderr.end();
        setImmediate(() => child.emit('close', 0));
        done();
      },
    });
    return child;
  };
  const mocked = { exports: {} };
  const file = fs.readFileSync(liveFile, 'utf8');
  const deps = {
    'node:os': { homedir: () => root },
    'node:child_process': { spawn: fakeChild },
    './maintenance-observed-live-transport': {
      ...packet,
      async sendObservedRequest({ bytes, sha256, credential, projectId: receivedProject }) {
        assert.equal(sha(bytes), sha256);
        assert.equal(credential, fakeCredential);
        assert.equal(receivedProject, projectId);
        const body = JSON.parse(bytes);
        controls.sends.push({ body, sha256 });
        const number = controls.sends.length;
        let response = fakeProvider(body.model, number);
        if (controls.duplicateJson) response = Buffer.from(response.toString().replace('"prompt_tokens":10', '"prompt_tokens":1,"prompt_tokens":10'));
        return { status: 200, requestId: `fake-request-${number}`, response };
      },
    },
  };
  new Function('require', 'module', '__dirname', file)(id => deps[id] ?? resolveLive(id), mocked, path.dirname(liveFile));
  const options = { plan, preregistrations, reviewerRegistry: fixture.context.trustedReviewers,
    attachments: new Map(Object.entries(fixture.context.attachments)), archiveLocations,
    outputDirectory, trustedOwnerPublicKey: owner.publicKey.export({ type: 'spki', format: 'pem' }),
    imageRuntime: { umociPath: '/var/tmp/fake-umoci' } };
  function sign(fields = {}, config = options) {
    const payload = C.seal({
      v: 1, kind: 'maintenance-observed-live-approval', approvalId: config.plan.approvalId, planHash: config.plan.hash,
      projectId, reviewerRegistryHash: C.digest(config.reviewerRegistry), preregistrationsHash: C.digest(config.preregistrations),
      billingEvidence, maximumMicrodollars: config.plan.limitMicrodollars,
      images, umociSha256: C.hashText('fake reviewed tool'),
      imageLauncherSha256: sha(fs.readFileSync(path.join(path.dirname(liveFile), 'maintenance-observed-image.py'))),
      builderFiles: [{ path: 'tools/maintenance-observed-runner.js', bytes: 1, sha256: C.hashText('fixture') }],
      outputDirectory: config.outputDirectory, issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 180000).toISOString(), ...fields,
    });
    return { payload, signature: crypto.sign(null, Buffer.from(mocked.exports.approvalMessage(payload)), owner.privateKey).toString('base64') };
  }
  options.approval = sign();
  return { options, root, controls, sign, async run(newOptions = options) {
    return mocked.exports.runObservedLive(newOptions, async () => { controls.credentialReads++; return fakeCredential; });
  } };
}

test('signed live plan uses one journal, isolates credentials and retains fake HTTP receipts and exact request bodies', async t => {
  const { options, controls, run } = setup(t);
  const report = await run();
  assert.equal(report.providerCalls, 16);
  assert.equal(report.promotionEligible, false);
  assert.equal(report.observations.length, 4);
  assert.equal(controls.credentialReads, 1);
  assert.equal(controls.shape.length, 12);
  assert.equal(controls.sends.length, 16);
  for (const run of report.observations) {
    assert.equal(run.origin, 'captured-runtime');
    const log = JSON.parse(fs.readFileSync(path.join(options.outputDirectory, run.log.sha256), 'utf8'));
    assert.equal(log.receipts.judge.status, 200);
    for (const stage of ['analyzer', 'critic', 'judge', 'independent']) {
      assert.deepEqual(log.receipts[stage].usage, { inputTokens: 10, outputTokens: 3 });
    }
    const independentReceipt = JSON.parse(fs.readFileSync(path.join(options.outputDirectory, run.stages.independent.response.sha256), 'utf8'));
    assert.equal(independentReceipt.usage.prompt_tokens_details.cache_write_tokens, 4);
    const body = JSON.parse(fs.readFileSync(path.join(options.outputDirectory, run.stages.judge.request.sha256), 'utf8'));
    assert.equal(body.model, 'gpt-4o');
    assert.equal(body.max_tokens, 8000);
    assert.equal(body.service_tier, 'default');
    assert.equal(body.url, undefined);
  }
  await assert.rejects(run(), /already started/);
  assert.equal(controls.credentialReads, 1);
  assert.equal(controls.sends.length, 16);
});

test('wrong approval, expired approval or mutated trust stops before the helper and credential load', async t => {
  const { options, controls, sign, run } = setup(t);
  await assert.rejects(run({ ...options, approval: { ...options.approval, signature: Buffer.alloc(64).toString('base64') } }), /signature/);
  const timestamp = new Date(Date.now() - 1000).toISOString();
  await assert.rejects(run({ ...options, approval: sign({ expiresAt: timestamp }) }), /not current/);
  await assert.rejects(run({ ...options, reviewerRegistry: {} }), /pinned reviewers/);
  await assert.rejects(run({ ...options, attachments: new Map() }), /billing|overhead evidence/);
  assert.equal(controls.spawn, 0);
  assert.equal(controls.credentialReads, 0);
});

test('mismatched archive receipt stops before reading a credential', async t => {
  const { controls, run } = setup(t);
  controls.badManifest = true;
  await assert.rejects(run(), /mismatched build/);
  assert.equal(controls.credentialReads, 0);
  assert.equal(controls.sends.length, 0);
});

test('duplicate JSON in a fake live response halts durably with original bytes retained', async t => {
  const { options, controls, run } = setup(t);
  controls.duplicateJson = true;
  await assert.rejects(run(), /Duplicate JSON member/);
  assert.equal(controls.sends.length, 1);
  const raw = Buffer.from(fakeProvider('gpt-4o-mini', 1).toString().replace('"prompt_tokens":10', '"prompt_tokens":1,"prompt_tokens":10'));
  assert.ok(fs.readFileSync(path.join(options.outputDirectory, sha(raw))).equals(raw));
  const journal = openObservedBudget(options.plan.journalDirectory, options.plan.budget);
  try {
    assert.equal(journal.snapshot().halted, true);
    assert.equal(journal.snapshot().attempts[0].status, 'unknown-cost');
  } finally {
    journal.close();
  }
});

function transportFixture(overrides = {}) {
  const bytes = Buffer.from(C.canonicalJson({ model: 'gpt-4o-mini', max_tokens: 1200, service_tier: 'default',
    messages: [{ role: 'system', content: 'fake prompt' }, { role: 'user', content: 'fake input' }] }));
  const approval = { bytes, sha256: sha(bytes), credential: fakeCredential, projectId };
  const response = Buffer.from(overrides.body ?? '{"saved":"fake raw response"}');
  const activity = { attempts: 0, destroyed: 0 };
  function request(config, receive) {
    activity.attempts++;
    activity.config = config;
    const client = new EventEmitter();
    client.destroy = () => { activity.destroyed++; };
    client.end = body => {
      activity.sent = body;
      if (overrides.timeout) return;
      setImmediate(() => {
        const incoming = new EventEmitter();
        incoming.statusCode = overrides.status ?? 200;
        incoming.complete = !overrides.truncated;
        incoming.rawHeaders = [...(overrides.idHeaders ?? ['X-Request-Id', 'request-fixture']),
          'Content-Length', String(response.length), ...(overrides.extraHeaders ?? [])];
        incoming.destroy = () => { activity.destroyed++; };
        receive(incoming);
        incoming.emit('data', response);
        incoming.emit('end');
      });
    };
    return client;
  }
  return { approval, request, activity, response };
}

test('the transport sends exact bytes once to the fixed TLS endpoint and retains a non-2xx reply', async () => {
  const { approval, request, activity, response } = transportFixture({ status: 429 });
  const result = await packet.sendObservedRequest(approval, { request });
  assert.equal(activity.attempts, 1);
  assert.equal(activity.config.hostname, 'api.openai.com');
  assert.equal(activity.config.path, '/v1/chat/completions');
  assert.equal(activity.config.rejectUnauthorized, true);
  assert.equal(activity.config.headers['OpenAI-Project'], projectId);
  assert.ok(activity.sent.equals(approval.bytes));
  assert.deepEqual(result, { status: 429, requestId: 'request-fixture', response });
});

test('mismatched bytes, malformed header, incomplete response and timeout fail closed', async () => {
  const skipped = transportFixture();
  await assert.rejects(packet.sendObservedRequest({ ...skipped.approval, sha256: '0'.repeat(64) }, { request: skipped.request }), /digest mismatch/);
  assert.equal(skipped.activity.attempts, 0);
  for (const scenario of [{ extraHeaders: ['x-request-id', 'duplicate'] }, { truncated: true }, { timeout: true }]) {
    const fake = transportFixture(scenario);
    await assert.rejects(packet.sendObservedRequest(fake.approval, { request: fake.request, timeoutMs: 20 }), /charge unknown/);
    assert.equal(fake.activity.attempts, 1);
    assert.ok(fake.activity.destroyed > 0);
  }
  assert.throws(() => packet.parseUnambiguousJson('{"inner":{"a":1,"\\u0061":2}}'), /Duplicate JSON member/);
});

const countSource = {
  model: 'claude-sonnet-4-6', max_tokens: 1200, system: 'Synthetic system ☃',
  messages: [{ role: 'user', content: 'Synthetic input 🌲\n' }],
};
const countInput = { bytes: Buffer.from(JSON.stringify(countSource)), credential: fakeCredential, accountId: 'wrkspc_fixture' };
const countHeaders = ['request-id', 'req_count', 'anthropic-workspace-id', countInput.accountId];

test('count sends the complete generation input once to the fixed Anthropic TLS endpoint', async () => {
  const { activity, request } = transportFixture({ idHeaders: countHeaders, body: '{"input_tokens":42}' });
  const receipt = await packet.countAnthropicInputTokens(countInput, { request });
  assert.deepEqual(receipt, { inputTokens: 42, requestId: 'req_count' });
  assert.equal(activity.attempts, 1);
  assert.deepEqual(JSON.parse(activity.sent), { model: countSource.model, system: countSource.system, messages: countSource.messages });
  const { hostname, servername, port, method, path, headers, rejectUnauthorized, minVersion } = activity.config;
  assert.equal(hostname, 'api.anthropic.com');
  assert.equal(servername, hostname);
  assert.equal(port, 443);
  assert.equal(method, 'POST');
  assert.equal(path, '/v1/messages/count_tokens');
  assert.equal(rejectUnauthorized, true);
  assert.equal(minVersion, 'TLSv1.2');
  assert.equal(headers['x-api-key'], countInput.credential);
  assert.equal(headers['anthropic-workspace-id'], countInput.accountId);
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(headers['content-length'], activity.sent.length);
});

test('count rejects request extensions and invalid text before contacting the provider', async () => {
  const { request, activity } = transportFixture();
  for (const body of [{ ...countSource, tools: [] }, { ...countSource, messages: [{ role: 'user', content: [] }] },
    { ...countSource, max_tokens: 0 }, { ...countSource, system: '\ud800' }]) {
    await assert.rejects(packet.countAnthropicInputTokens({ ...countInput, bytes: Buffer.from(JSON.stringify(body)) }, { request }));
  }
  await assert.rejects(packet.countAnthropicInputTokens(countInput, { request, path: '/v1/messages' }));
  await assert.rejects(packet.countAnthropicInputTokens({ ...countInput, provider: 'openai' }, { request }));
  assert.equal(activity.attempts, 0);
});

test('count rejects ambiguous, oversized, incomplete and unsuccessful receipts without retrying or exposing content', async () => {
  const invalidBodies = ['{"input_tokens":0}', '{"input_tokens":1.5}', '{"input_tokens":9007199254740992}',
    '{"input_tokens":1,"input_tokens":2}', '{"input_tokens":"123"}', '{"input_tokens":1,"detail":"PRIVATE"}',
    'PRIVATE', Buffer.from([0xff]), ' '.repeat(4097)];
  for (const scenario of [
    ...invalidBodies.map(body => ({ body })), { status: 302 }, { status: 429 }, { truncated: true },
    { idHeaders: ['request-id', 'req_count'] }, { idHeaders: ['anthropic-workspace-id', countInput.accountId] },
    { idHeaders: ['request-id', 'req_count', 'anthropic-workspace-id', 'wrkspc_wrong'] },
    { extraHeaders: ['request-id', 'req_duplicate'] },
    { idHeaders: ['request-id', countInput.credential, 'anthropic-workspace-id', countInput.accountId] },
  ]) {
    const { activity, request } = transportFixture({ idHeaders: countHeaders, body: '{"input_tokens":1}', ...scenario });
    await assert.rejects(packet.countAnthropicInputTokens(countInput, { request }), error =>
      !error.message.includes('PRIVATE') && !error.message.includes(countInput.credential));
    assert.equal(activity.attempts, 1);
  }
});
