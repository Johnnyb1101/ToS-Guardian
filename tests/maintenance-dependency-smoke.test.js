'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { seal, hashText } = require('../tools/final-corpus-lib');
const { releaseConfigHash } = require('../tools/sites-lib');
const { makeRelease, reseal } = require('./final-test-fixtures');
const {
  planDependencySmoke, assessDependencySmokeInputBounds,
  runDependencySmokeLive, rehearseDependencySmoke,
} = require('../tools/maintenance-dependency-smoke');

const SLOTS = ['anthropic:analyzer', 'anthropic:critic', 'openai:analyzer', 'openai:critic'];
const RATES = {
  anthropic: {
    model: 'claude-sonnet-4-6', responseModel: 'claude-sonnet-4-6',
    inputMicrodollarsPerMillion: 3000000, outputMicrodollarsPerMillion: 15000000,
  },
  openai: {
    model: 'gpt-4o-mini', responseModel: 'gpt-4o-mini-2024-07-18',
    inputMicrodollarsPerMillion: 150000, outputMicrodollarsPerMillion: 600000,
  },
};
const ENDPOINTS = {
  anthropic: 'https://api.anthropic.com/v1/messages',
  openai: 'https://api.openai.com/v1/chat/completions',
};
const HEADINGS = [
  'BOTTOM LINE', 'RISK LEVEL', 'WHAT THEY COLLECT', 'DATA SELLING & SHARING',
  'OPT-OUT RIGHTS', 'HOW TO OPT OUT RIGHT NOW', 'AUTO-RENEWAL & BILLING', 'DATA DELETION RIGHTS',
];
const SUMMARY = HEADINGS.map(heading => heading + '\nSynthetic result.').join('\n\n');
const CRITIQUE = JSON.stringify({
  dataCollection: 'grounded', dataSelling: 'skipped', optOutRights: 'skipped',
  howToOptOut: 'vague', autoRenewal: 'skipped', dataDeletion: 'skipped', flags: [],
});

function descriptor(text) {
  return { bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') };
}

function fixtureProtocol() {
  const release = makeRelease([]);
  release.config.policy.models = {
    anthropic: { default: RATES.anthropic.model, escalated: 'mock-escalation', jury: 'mock-judge' },
    openai: { default: RATES.openai.model, escalated: 'mock-escalation', jury: 'mock-judge' },
  };
  release.config.policy.cache = { shared: 'disabled' };
  release.configHash = releaseConfigHash(release.config);
  const artifact = descriptor('candidate');
  const build = {
    artifact, release, runtime: { platform: 'linux', arch: 'x64', node: 'v22.23.3', npm: '10.9.9' },
  };
  const sourceText = 'Synthetic privacy policy for offline smoke tests.';
  const corpus = Array.from({ length: 6 }, (_, index) => ({
    id: index === 5 ? 'fastmail-privacy' : 'test-doc-' + index,
    documentType: index < 4 ? 'terms-of-service' : 'privacy-policy',
    url: index === 5 ? 'https://www.fastmail.com/policies/privacy/' : 'https://example.com/policy-' + index,
    source: descriptor(index === 5 ? sourceText : 'Fictional document ' + index),
  }));
  const protocol = seal({
    v: 1, kind: 'maintenance-dependency-protocol', mode: 'observed',
    declaredAt: new Date(Date.now() - 60_000).toISOString(),
    classification: 'E', classificationHash: hashText('fixture classification'),
    reviewers: { execution: 'executor', owner: 'owner' },
    providers: ['anthropic', 'openai'], corpus, smokeSampleId: 'fastmail-privacy',
    smokeCapMicros: 500000, rates: structuredClone(RATES),
    builds: {
      baseline: {
        image: { ...descriptor('baseline'), manifestDigest: 'sha256:' + hashText('baseline manifest') },
        configHash: hashText('prior config'), inventoryHash: hashText('baseline inventory'),
      },
      candidate: {
        image: { ...artifact, manifestDigest: 'sha256:' + hashText('candidate manifest') },
        configHash: release.configHash, inventoryHash: hashText('candidate inventory'),
      },
    },
  });
  return { protocol, expectedProtocolHash: protocol.hash, build, sourceText };
}

function testFixtures() {
  return Object.fromEntries(SLOTS.map(slot => {
    const [provider, stage] = slot.split(':');
    const content = stage === 'analyzer' ? SUMMARY : CRITIQUE;
    const id = slot.replace(':', '_');
    const response = provider === 'anthropic' ? {
      id: 'response_' + id, type: 'message', role: 'assistant', model: RATES.anthropic.responseModel,
      content: [{ type: 'text', text: content }], stop_reason: 'end_turn',
      usage: { input_tokens: 20, output_tokens: 10 },
    } : {
      id: 'response_' + id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: RATES.openai.responseModel,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    };
    return [slot, { status: 200, requestId: 'request_' + id, body: JSON.stringify(response) }];
  }));
}

function fakeBridge({ mutateRequest, replayError } = {}) {
  const shaped = [];
  const delivered = [];
  return {
    shaped, delivered,
    async shapeOffline({ provider, stage, sourceText, prior }) {
      const slot = provider + ':' + stage;
      shaped.push({ slot, prior });
      const isAnthropic = provider === 'anthropic';
      const headers = isAnthropic
        ? { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' }
        : { 'Content-Type': 'application/json' };
      const messages = [{ role: 'user', content: stage === 'critic' ? sourceText + '\n' + prior : sourceText }];
      const body = { model: RATES[provider].model, messages, max_tokens: stage === 'analyzer' ? 1200 : 1000 };
      if (isAnthropic) body.system = 'Synthetic system message.';
      else messages.unshift({ role: 'system', content: 'Synthetic system message.' });
      mutateRequest?.(slot, body);
      return { url: ENDPOINTS[provider], headers, body: JSON.stringify(body) };
    },
    async replay(_imageHash, { provider, body }) {
      const response = JSON.parse(body);
      delivered.push(response.id);
      if (replayError) throw replayError;
      const anthropic = provider === 'anthropic';
      const text = anthropic ? response.content[0].text : response.choices[0].message.content;
      return {
        outcome: 'parsed', parsed: { text },
        usage: {
          inputTokens: anthropic ? response.usage.input_tokens : response.usage.prompt_tokens,
          outputTokens: anthropic ? response.usage.output_tokens : response.usage.completion_tokens,
          cacheReadTokens: 0, cacheWriteTokens: 0,
        },
      };
    },
  };
}

function fixture(t) {
  const temp = fs.realpathSync(os.tmpdir());
  const outputDirectory = fs.mkdtempSync(path.join(temp, 'tos-dependency-smoke-test-'));
  assert.equal(path.dirname(outputDirectory), temp);
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  return { ...fixtureProtocol(), outputDirectory, fixtures: testFixtures() };
}

function journalEvents(directory) {
  const file = fs.readdirSync(directory).find(name => name.endsWith('.jsonl'));
  assert.ok(file, 'expected a durable budget journal');
  return fs.readFileSync(path.join(directory, file), 'utf8').trim().split('\n').map(line => JSON.parse(line).event);
}

test('four ordered slots reserve $0.45672 under the approved cap', () => {
  const { protocol, expectedProtocolHash } = fixtureProtocol();
  const plan = planDependencySmoke(protocol, expectedProtocolHash);
  assert.equal(plan.limitMicrodollars, 500000);
  assert.equal(plan.totalMicrodollars, 456720);
  assert.deepEqual(plan.calls.map(({ id }) => id), SLOTS);
  assert.deepEqual(plan.calls.map(({ maxInputTokens }) => maxInputTokens), [64000, 64000, 128000, 128000]);
  assert.deepEqual(plan.calls.map(({ maxOutputTokens }) => maxOutputTokens), [1200, 1000, 1200, 1000]);
  assert.throws(() => planDependencySmoke({ ...protocol, smokeCapMicros: 500001 }, expectedProtocolHash));
  const wrongRate = structuredClone(protocol);
  wrongRate.rates.anthropic.inputMicrodollarsPerMillion++;
  const changed = reseal(wrongRate);
  assert.throws(() => planDependencySmoke(changed, changed.hash), /rate|model/i);
  assert.throws(() => planDependencySmoke(protocol, hashText('different sealed protocol')), /hash|pin/i);
});

test('an estimate, credential callback and usage claim cannot enable live dispatch', async () => {
  const bounds = assessDependencySmokeInputBounds({
    providerAuthenticated: true, input_tokens: 17, hardUpperBoundEstablished: true,
  });
  assert.deepEqual(bounds.anthropic, {
    reservedInputTokens: 64000, providerContextTokens: 1000000, hardUpperBoundEstablished: false,
  });
  assert.deepEqual(bounds.openai, {
    reservedInputTokens: 128000, providerContextTokens: 128000, hardUpperBoundEstablished: true,
  });
  assert.equal(bounds.liveDispatchAllowed, false);
  const unexpectedInput = new Proxy({}, { get: () => assert.fail('live preparation inspected a caller capability') });
  await assert.rejects(runDependencySmokeLive(unexpectedInput, () => assert.fail('credential read')), /ceiling|bound|disabled/i);
});

if (process.platform === 'win32') {
  test('the CLI rejects an unreviewed runtime before resolving missing OCI inputs', t => {
    const input = fixture(t);
    const inputFile = path.join(input.outputDirectory, 'smoke-input.json');
    const receiptDirectory = path.join(input.outputDirectory, 'receipt');
    fs.mkdirSync(receiptDirectory);
    fs.writeFileSync(inputFile, JSON.stringify({
      protocol: input.protocol,
      candidate: {
        archivePath: path.join(input.outputDirectory, 'missing.oci.tar'),
        releaseFile: path.join(input.outputDirectory, 'missing-release.json'),
        image: input.protocol.builds.candidate.image,
        runtime: input.build.runtime,
      },
      imageRuntime: {
        umociPath: '/usr/local/bin/umoci',
        umociSha256: hashText('unreviewed umoci'),
        imageLauncherSha256: hashText('unreviewed launcher'),
        builderFiles: [{ path: 'tools/maintenance-observed-runner.js', ...descriptor('unreviewed builder') }],
      },
      sourceFile: path.join(input.outputDirectory, 'missing-source.txt'),
      fixtures: input.fixtures,
    }));
    const result = spawnSync(process.execPath, [
      require.resolve('../tools/maintenance-dependency-smoke'), '--offline',
      inputFile, input.expectedProtocolHash, receiptDirectory,
    ], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), 'Unreviewed dependency smoke image runtime');
    assert.deepEqual(fs.readdirSync(receiptDirectory), []);
  });

  test('only four fixture deliveries occur, and a run cannot be replayed in the same journal', async t => {
    const input = fixture(t);
    const bridge = fakeBridge();
    const result = await rehearseDependencySmoke(input, bridge);
    assert.equal(result.liveDispatchAllowed, false);
    assert.equal(result.providerCalls, 0);
    assert.equal(result.stages.length, 4);
    assert.deepEqual(bridge.delivered, SLOTS.map(slot => 'response_' + slot.replace(':', '_')));
    assert.deepEqual(bridge.shaped.map(({ slot }) => slot), SLOTS);
    for (const { slot, prior } of bridge.shaped) {
      if (slot.endsWith(':critic')) assert.equal(prior, SUMMARY);
    }
    const events = journalEvents(input.outputDirectory);
    assert.deepEqual(events.filter(({ type }) => type === 'reserve').map(({ id }) => id), SLOTS);
    assert.deepEqual(events.filter(({ type }) => type === 'settle').map(({ id }) => id), SLOTS);
    assert.equal(result.budget.attempts.every(({ status }) => status === 'settled'), true);
    for (const [index, stage] of result.stages.entries()) {
      assert.equal(stage.capture.sha256, result.budget.attempts[index].requestHash);
      for (const retained of [stage.capture, stage.observation.request, stage.observation.response, stage.observation.output]) {
        const bytes = fs.readFileSync(path.join(input.outputDirectory, 'evidence', retained.sha256));
        assert.equal(bytes.length, retained.bytes);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), retained.sha256);
      }
    }
    await assert.rejects(rehearseDependencySmoke(input, bridge));
    assert.equal(bridge.delivered.length, 4);
  });

  test('a fifth fixture is rejected before any image or journal operation', async t => {
    const input = fixture(t);
    input.fixtures['openai:extra'] = input.fixtures['openai:critic'];
    const bridge = fakeBridge();
    await assert.rejects(rehearseDependencySmoke(input, bridge), /four|fixture/i);
    assert.deepEqual(bridge.shaped, []);
    assert.deepEqual(fs.readdirSync(input.outputDirectory), []);
  });

  test('an oversized candidate critic is rejected before reserving it', async t => {
    const input = fixture(t);
    const bridge = fakeBridge({ mutateRequest(slot, body) {
      if (slot === 'anthropic:critic') body.messages[0].content += 'x'.repeat(60_000);
    } });
    await assert.rejects(rehearseDependencySmoke(input, bridge), /large|size|byte|bound|limit/i);
    assert.deepEqual(bridge.delivered, ['response_anthropic_analyzer']);
    assert.deepEqual(journalEvents(input.outputDirectory).filter(({ type }) => type === 'reserve').map(({ id }) => id),
      ['anthropic:analyzer']);
  });

  test('a different request model never reaches a fixture delivery', async t => {
    const input = fixture(t);
    const bridge = fakeBridge({ mutateRequest(slot, body) {
      if (slot === 'anthropic:analyzer') body.model = 'other-model';
    } });
    await assert.rejects(rehearseDependencySmoke(input, bridge), /model|unsupported/i);
    assert.equal(bridge.delivered.length, 0);
    assert.equal(journalEvents(input.outputDirectory).some(event => event.type === 'reserve'), false);
  });

  for (const failure of ['timeout', 'over-cap usage']) {
    test(failure + ' retains only the first reservation as unknown cost', async t => {
      const input = fixture(t);
      const bridge = fakeBridge({ replayError: failure === 'timeout' ? new Error('fixture timeout; charge unknown') : null });
      if (failure === 'over-cap usage') {
        const response = JSON.parse(input.fixtures['anthropic:analyzer'].body);
        response.usage.input_tokens = 64001;
        input.fixtures['anthropic:analyzer'].body = JSON.stringify(response);
      }
      await assert.rejects(rehearseDependencySmoke(input, bridge), /timeout|cap|bound|usage/i);
      assert.deepEqual(bridge.delivered, ['response_anthropic_analyzer']);
      assert.deepEqual(journalEvents(input.outputDirectory).filter(({ type }) => type !== 'header').map(({ type, id }) => [type, id]),
        [['reserve', 'anthropic:analyzer'], ['fail', 'anthropic:analyzer']]);
      await assert.rejects(rehearseDependencySmoke(input, bridge));
      assert.equal(bridge.delivered.length, 1);
    });
  }
}
