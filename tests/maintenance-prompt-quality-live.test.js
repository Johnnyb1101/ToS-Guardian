'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const vm = require('node:vm');
const C = require('../tools/final-corpus-lib');
const { approvalMessage } = require('../tools/maintenance-observed-live');
const { dependencySmokeApprovalMessage } = require('../tools/maintenance-dependency-smoke-approval');

const sourceFile = path.resolve(__dirname, '../tools/maintenance-prompt-quality-live.js');
const source = fs.readFileSync(sourceFile, 'utf8');
const load = createRequire(sourceFile);
const loadFixture = vm.runInThisContext('(function (module, require) {\n' + source + '\n})', { filename: sourceFile });
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const atOffset = milliseconds => new Date(Date.now() + milliseconds).toISOString();
const owner = crypto.generateKeyPairSync('ed25519');
const reviewer = crypto.generateKeyPairSync('ed25519');
const publicKey = pair => pair.publicKey.export({ type: 'spki', format: 'pem' });
const builderFiles = [
  'tools/maintenance-observed-runner.js',
  'tools/final-corpus-lib.js',
  'tools/maintenance-final-evidence.js',
  'tools/maintenance-openai-contract.js',
  'tools/maintenance-observed-budget.js',
  'tools/maintenance-local-path.js',
  'tools/maintenance-evaluation-lib.js',
  'tools/sites-lib.js',
  'tools/doctype.js',
  'vendor/tldts-7.4.8.umd.min.js',
].map(file => ({ path: file, bytes: 1, sha256: digest(file) }));

function fixture(t, doubles = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tos-prompt-quality-approval-fixture-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const launches = [];
  const rejectLiveAction = () => {
    launches.push('unexpected live action');
    throw new Error('Offline approval fixtures cannot load credentials, launch images or send requests');
  };
  const module = { exports: {} };
  loadFixture(module, id => {
    if (id === 'node:os') return { homedir: () => home };
    if (id === './maintenance-local-path') {
      return { lexicalPath: path.resolve, localPaths: files => files.map(file => fs.realpathSync(file)) };
    }
    if (id === './maintenance-prompt-quality') {
      return {
        validatePromptQualityPlan(plan, hash) { assert.equal(plan.hash, hash); },
        verifyPromptQualityPreregistration({ preregistration }) {
          assert.ok(preregistration.payload.observedAt);
        },
      };
    }
    if (id === './maintenance-observed-live') return { imageBridge: doubles.bridge ?? rejectLiveAction };
    if (id === './maintenance-dependency-smoke-credentials') {
      return { prepareDependencySmokeCredentials: doubles.credentials ?? rejectLiveAction };
    }
    if (id === './maintenance-observed-live-transport') {
      return { ...load(id), sendProviderBytes: doubles.transport ?? rejectLiveAction };
    }
    if (id === './maintenance-prompt-quality-runner') {
      return { runBoundPromptQuality: doubles.runner ?? rejectLiveAction };
    }
    return load(id);
  });

  const live = module.exports;
  const journalDirectory = live.promptQualityLiveJournalDirectory();
  const outputDirectory = path.join(home, 'quality-output');
  fs.mkdirSync(journalDirectory, { recursive: true });
  fs.mkdirSync(outputDirectory);
  const archiveLocations = {};
  const images = ['baseline', 'candidate'].map(arm => {
    const archive = path.join(home, arm + '.tar');
    const bytes = Buffer.from(arm);
    const sha256 = digest(bytes);
    fs.writeFileSync(archive, bytes);
    archiveLocations[sha256] = archive;
    return { bytes: bytes.length, sha256, manifestDigest: 'sha256:' + digest(arm + '-manifest') };
  });
  const accounts = { anthropic: 'wrkspc_fixture', openai: 'proj_fixture' };
  const imageRuntime = {
    umociPath: '/usr/bin/umoci', umociSha256: digest('umoci'), imageLauncherSha256: digest('launcher'), builderFiles,
  };
  const plan = {
    approvalId: 'quality-fixture', hash: digest('fixture plan'), journalDirectory,
    limitMicrodollars: 1000, overheadMicrodollars: 20, pricing: { fixture: 100 },
    calls: [{ id: 'anthropic:baseline:example:1:independent' }],
    protocol: {
      mode: 'observed', reviewers: { protocol: 'fixture-reviewer' },
      builds: { baseline: { artifact: images[0] }, candidate: { artifact: images[1] } },
    },
  };
  const reviewerRegistry = { 'fixture-reviewer': { publicKey: publicKey(reviewer), roles: ['protocol'] } };
  const preregistration = { payload: { observedAt: atOffset(-6000) } };
  const operatorTrust = { ownerPublicKey: publicKey(owner) };
  const options = {
    plan, preregistration, reviewerRegistry, imageRuntime, archiveLocations, outputDirectory, attachments: new Map(),
  };
  const billing = {
    checkedAt: atOffset(-8000), accounts, pricingHash: C.digest(plan.pricing), overheadMicrodollars: plan.overheadMicrodollars,
    destinations: { anthropic: { serviceTier: 'standard', region: 'global' }, openai: { serviceTier: 'standard' } },
  };
  const approval = {
    v: 1, kind: 'maintenance-prompt-quality-live-approval', approvalId: plan.approvalId, planHash: plan.hash,
    maximumMicrodollars: plan.limitMicrodollars, reviewerRegistryHash: C.digest(reviewerRegistry),
    preregistrationHash: C.digest(preregistration), accounts, images, archiveLocations, imageRuntime,
    outputDirectory, journalDirectory, issuedAt: atOffset(-3000), expiresAt: atOffset(90_000),
  };
  function sign(approvalEdits = {}, billingEdits = {}, message = live.promptQualityApprovalMessage, signer = owner) {
    const bytes = Buffer.from(JSON.stringify({ ...billing, ...billingEdits }));
    const billingEvidence = { bytes: bytes.length, sha256: digest(bytes) };
    options.attachments.set(billingEvidence.sha256, bytes);
    const payload = C.seal({ ...approval, billingEvidence, ...approvalEdits });
    options.approval = { payload, signature: crypto.sign(null, Buffer.from(message(payload)), signer.privateKey).toString('base64') };
  }
  sign();
  const verify = () => live.verifyPromptQualityLiveApproval(options, operatorTrust);
  t.after(() => assert.deepEqual(launches, []));
  return { live, options, operatorTrust, approval, sign, verify };
}

test('validates separate signed live authority and refuses signatures from prior approval domains', async t => {
  const f = fixture(t);
  assert.deepEqual(f.verify(), f.options.approval.payload);
  assert.equal(path.basename(f.verify().journalDirectory), 'observed-prompt-quality-live');
  for (const foreignMessage of [approvalMessage, dependencySmokeApprovalMessage]) {
    f.sign({}, {}, foreignMessage);
    assert.throws(f.verify, /approval signature did not verify/);
    await assert.rejects(f.live.runPromptQualityLive(f.options, f.operatorTrust, {}), /approval signature did not verify/);
  }
  f.sign({}, {}, undefined, reviewer);
  assert.throws(f.verify, /approval signature did not verify/);
});

test('refuses fixture mode, altered reviewer and preregistration bindings, and a shared approval key', t => {
  const f = fixture(t);
  f.options.plan.protocol.mode = 'fixture';
  assert.throws(f.verify, /requires an observed protocol/);
  f.options.plan.protocol.mode = 'observed';
  f.options.reviewerRegistry['fixture-reviewer'].publicKey = publicKey(owner);
  assert.throws(f.verify, /frozen reviewers/);
  f.sign({ reviewerRegistryHash: C.digest(f.options.reviewerRegistry) });
  assert.throws(f.verify, /key independent of all reviewer roles/);
  f.options.preregistration.payload.observedAt = atOffset(-5000);
  assert.throws(f.verify, /frozen reviewers/);
});

test('refuses changed archives, manifests, runtime builder pins, and signed destination substitution', t => {
  const f = fixture(t);
  const [baseline, candidate] = f.approval.images;
  f.sign({ images: [baseline, { ...candidate, manifestDigest: baseline.manifestDigest }] });
  assert.throws(f.verify, /exact image archive and manifest identities/);
  f.sign({ images: [baseline, baseline] });
  assert.throws(f.verify, /exact image archive and manifest identities/);
  f.sign({ imageRuntime: { ...f.approval.imageRuntime, builderFiles: [] } });
  assert.throws(f.verify, /pinned image launcher, tool and builder inventory/);
  f.sign({ outputDirectory: f.approval.journalDirectory });
  assert.throws(f.verify, /fixed journal or signed destinations/);
  f.options.outputDirectory = f.approval.journalDirectory;
  assert.throws(f.verify, /empty output directory separate from spending journals/);
  f.options.outputDirectory = f.approval.outputDirectory;
  f.sign({ maximumMicrodollars: f.options.plan.limitMicrodollars + 1 });
  assert.throws(f.verify, /does not match the plan/);
  f.sign();
  const copy = f.options.archiveLocations[baseline.sha256];
  fs.appendFileSync(copy, 'additional bytes');
  assert.throws(f.verify, /separate, unaliased local image archives/);
  fs.truncateSync(copy, baseline.bytes);
  fs.writeFileSync(path.join(f.options.outputDirectory, 'already-present'), 'fixture');
  assert.throws(f.verify, /empty output directory/);
});

test('refuses expired and overlong authority, changed rates, stale prices and nonstandard destinations', t => {
  const f = fixture(t);
  f.sign({ expiresAt: atOffset(-1000) });
  assert.throws(f.verify, /expired, premature or exceeds 24 hours/);
  f.sign({ expiresAt: atOffset(86_400_000) });
  assert.throws(f.verify, /expired, premature or exceeds 24 hours/);
  f.sign({}, { pricingHash: digest('different rates') });
  assert.throws(f.verify, /match the approved rates/);
  f.sign({}, { overheadMicrodollars: f.options.plan.overheadMicrodollars + 1 });
  assert.throws(f.verify, /match the approved rates/);
  f.sign({}, { checkedAt: atOffset(-86_500_000) });
  assert.throws(f.verify, /billing evidence is stale/);
  f.sign({}, { checkedAt: atOffset(-1000) });
  assert.throws(f.verify, /billing evidence is stale or postdates approval/);
  f.sign({}, { destinations: { anthropic: { serviceTier: 'standard', region: 'us' }, openai: { serviceTier: 'standard' } } });
  assert.throws(f.verify, /standard service destinations/);
});

test('checks the request before retention and reduces credential-bearing responses to a safe receipt', async t => {
  const events = [];
  let approvedExecution;
  const fixtureSecret = 'fixture-openai-secret';
  const escapedSecretBody = Buffer.from('{"text":"\\u0066ixture-openai-secret"}');
  let requestBytes = escapedSecretBody;
  const f = fixture(t, {
    bridge() {
      return {
        ready() { events.push('image ready'); },
        close() { events.push('image closed'); },
      };
    },
    credentials(_filePins, accounts) {
      events.push('fixture credentials checked');
      return ({ provider, accountId }) => {
        assert.equal(accountId, accounts[provider]);
        return provider === 'openai' ? fixtureSecret : 'fixture-anthropic-secret';
      };
    },
    transport({ provider, accountId }) {
      events.push('fixture dispatch');
      assert.equal(provider, 'openai');
      assert.equal(accountId, 'proj_fixture');
      return { status: 200, requestId: 'fixture-request-id', response: escapedSecretBody };
    },
    async runner(input, execution) {
      approvedExecution = execution;
      assert.equal(f.live.isApprovedPromptQualityExecution(execution), true);
      const { beforeReserve, deliver } = execution;
      const call = {
        id: input.plan.calls[0].id, provider: 'openai', bytes: requestBytes, sha256: digest(requestBytes),
      };
      beforeReserve(call);
      events.push('request eligible for retention');
      return deliver(call);
    },
  });
  const execute = () => f.live.runPromptQualityLive(f.options, f.operatorTrust, {});
  await assert.rejects(execute, /Credential-bearing prompt-quality request/);
  assert.deepEqual(events, ['image ready', 'fixture credentials checked', 'image closed']);
  events.length = 0;
  requestBytes = Buffer.from('{"text":"fixture request"}');
  assert.deepEqual(await execute(), { status: 200, requestId: 'fixture-request-id' });
  assert.equal(f.live.isApprovedPromptQualityExecution(approvedExecution), false);
  assert.deepEqual(events, [
    'image ready', 'fixture credentials checked', 'request eligible for retention', 'fixture dispatch', 'image closed',
  ]);
});
