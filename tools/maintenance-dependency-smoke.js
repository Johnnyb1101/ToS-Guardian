'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const C = require('./final-corpus-lib');
const { localPath, localPaths } = require('./maintenance-local-path');
const { createObservedBudgetPlan, openObservedBudget } = require('./maintenance-observed-budget');
const { imageBridge } = require('./maintenance-observed-live');
const { parseUnambiguousJson } = require('./maintenance-observed-live-transport');
const { prepareOpenAIRequest } = require('./maintenance-openai-contract');
const { prepareAnthropicCount } = require('./maintenance-provider-preflight');
const { requestBytes } = require('./release-class');
const { verifySmokeStage } = require('./maintenance-dependency-evidence');
const { checkRelease } = require('./sites-lib');

const CAP_MICRODOLLARS = 500_000;
const MAX_ARCHIVE = 256 * 1024 * 1024;
const MAX_RESPONSE = 800_000;
const SAMPLE_ID = 'fastmail-privacy';
// Checkpoint E trust pins from the reviewed Class E evidence. File paths are
// local inputs. The bytes executed by WSL are verified against these pins.
const ACTIVATION_SCOPE_HASH = 'd6e429083b0d745526b9ed42e80f6e4c0acd2fe9a131637c85b5804d3b4b540a';
const IMAGE_RUNTIME_HASH = 'a1b5a200c69a402a11d08c724849ccd27939dc40a532dcb9d9cef93d4d495a51';
const PROVIDERS = ['anthropic', 'openai'];
const STAGES = { analyzer: 1200, critic: 1000 };
const INPUT_RESERVATIONS = { anthropic: 64_000, openai: 128_000 };
const RATES = {
  anthropic: { model: 'claude-sonnet-4-6', responseModel: 'claude-sonnet-4-6',
    inputMicrodollarsPerMillion: 3_000_000, outputMicrodollarsPerMillion: 15_000_000 },
  openai: { model: 'gpt-4o-mini', responseModel: 'gpt-4o-mini-2024-07-18',
    inputMicrodollarsPerMillion: 150_000, outputMicrodollarsPerMillion: 600_000 },
};
const CALLS = PROVIDERS.flatMap(provider => Object.entries(STAGES).map(([stage, maxOutputTokens]) => ({
  provider, stage, id: provider + ':' + stage, maxOutputTokens,
})));
const IDS = CALLS.map(call => call.id);
const POLICY_KEYS = ['v', 'kind', 'mode', 'declaredAt', 'smokeSampleId', 'smokeCapMicros', 'rates',
  'reviewers', 'corpus', 'providers', 'classification', 'classificationHash', 'builds', 'hash'];
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const same = (left, right) => C.canonicalJson(left) === C.canonicalJson(right);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const utf8 = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };

function imageIdentity(build) {
  return exact(build, ['configHash', 'image', 'inventoryHash']) && C.isHash(build.configHash) &&
    C.isHash(build.inventoryHash) && exact(build.image, ['sha256', 'bytes', 'manifestDigest']) &&
    C.isHash(build.image.sha256) && positive(build.image.bytes) && build.image.bytes <= MAX_ARCHIVE &&
    /^sha256:[a-f0-9]{64}$/.test(build.image.manifestDigest);
}

function planDependencySmoke(protocol, expectedProtocolHash) {
  const errors = [];
  C.checkSeal(protocol, 'Dependency smoke protocol', errors);
  requireThat(!errors.length && C.isHash(expectedProtocolHash) && protocol.hash === expectedProtocolHash,
    'Pinned dependency smoke protocol required');
  requireThat(exact(protocol, POLICY_KEYS) && protocol.v === 1 && protocol.kind === 'maintenance-dependency-protocol' &&
    protocol.mode === 'observed' && protocol.classification === 'E' && C.isHash(protocol.classificationHash) &&
    protocol.smokeSampleId === SAMPLE_ID && protocol.smokeCapMicros === CAP_MICRODOLLARS &&
    same(protocol.providers, PROVIDERS) && same(protocol.rates, RATES), 'Protocol is outside the approved smoke scope or rates');
  requireThat(exact(protocol.reviewers, ['owner', 'execution']) && identifier(protocol.reviewers.owner) &&
    identifier(protocol.reviewers.execution) && protocol.reviewers.owner !== protocol.reviewers.execution,
  'Distinct owner and execution reviewers required');
  requireThat(exact(protocol.builds, ['baseline', 'candidate']) && Object.values(protocol.builds).every(imageIdentity) &&
    protocol.builds.baseline.image.sha256 !== protocol.builds.candidate.image.sha256,
  'Exact candidate and distinct baseline identities required');
  requireThat(typeof protocol.declaredAt === 'string' && Date.parse(protocol.declaredAt) <= Date.now() &&
    new Date(protocol.declaredAt).toISOString() === protocol.declaredAt, 'Invalid protocol declaration time');
  requireThat(Array.isArray(protocol.corpus), 'Pinned smoke corpus required');
  const samples = protocol.corpus.filter(sample => sample?.id === SAMPLE_ID);
  requireThat(samples?.length === 1 && samples[0].documentType === 'privacy-policy' &&
    samples[0].url === 'https://www.fastmail.com/policies/privacy/' &&
    exact(samples[0].source, ['sha256', 'bytes']) && C.isHash(samples[0].source.sha256) &&
    positive(samples[0].source.bytes) && samples[0].source.bytes <= 400_000, 'Pinned Fastmail privacy policy required');
  return createObservedBudgetPlan({
    approvalId: 'dep-smoke-off-' + protocol.hash,
    planHash: protocol.hash,
    limitMicrodollars: CAP_MICRODOLLARS,
    overheadMicrodollars: 0,
    calls: CALLS.map(({ provider, id, maxOutputTokens }) => ({
      id, maxOutputTokens, maxInputTokens: INPUT_RESERVATIONS[provider],
      inputMicrodollarsPerMillion: RATES[provider].inputMicrodollarsPerMillion,
      outputMicrodollarsPerMillion: RATES[provider].outputMicrodollarsPerMillion,
    })),
  });
}

function assessDependencySmokeInputBounds() {
  // Sonnet's Messages max_tokens covers generated output. Its count_tokens
  // response and any byte-length check are estimates, not a billing ceiling.
  return {
    anthropic: { reservedInputTokens: INPUT_RESERVATIONS.anthropic, providerContextTokens: 1_000_000, hardUpperBoundEstablished: false },
    openai: { reservedInputTokens: INPUT_RESERVATIONS.openai, providerContextTokens: 128_000, hardUpperBoundEstablished: true },
    liveDispatchAllowed: false,
  };
}

async function runDependencySmokeLive() {
  throw new Error('Live dependency smoke blocked: no verified Anthropic input ceiling at the $0.50 cap');
}

function validateBuildAndSource(protocol, build, sourceText) {
  const { configHash, image } = protocol.builds.candidate;
  requireThat(exact(build, ['artifact', 'release', 'runtime']) &&
    same(build.artifact, { sha256: image.sha256, bytes: image.bytes }) && checkRelease(build.release).valid &&
    build.release.configHash === configHash && build.release.config.policy.cache.shared === 'disabled' &&
    PROVIDERS.every(provider => build.release.config.policy.models[provider]?.default === RATES[provider].model),
  'Candidate build or release policy changed');
  const sample = protocol.corpus.find(item => item.id === SAMPLE_ID);
  requireThat(typeof sourceText === 'string' && sourceText.trim() && !sourceText.includes('\0') &&
    Buffer.byteLength(sourceText) === sample.source.bytes && sha(Buffer.from(sourceText)) === sample.source.sha256,
  'Frozen smoke sample changed');
  return sample;
}

function validateRequest(captured, provider, maxOutputTokens) {
  const captureBytes = requestBytes(captured, provider);
  const body = parseUnambiguousJson(captured.body);
  requireThat(body.model === RATES[provider].model && body.max_tokens === maxOutputTokens,
    'Candidate request model or output cap changed');
  const request = { url: captured.url, body };
  if (provider === 'anthropic') {
    requireThat(captureBytes.length <= 60_000, 'Anthropic smoke request exceeds the offline byte limit');
    requireThat(same(captured.headers, { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' }),
      'Unexpected Anthropic public headers');
    prepareAnthropicCount(request);
  } else {
    requireThat(same(captured.headers, { 'Content-Type': 'application/json' }), 'Unexpected OpenAI public headers');
    prepareOpenAIRequest(request);
  }
  return captureBytes;
}

function openEvidence(directory) {
  const folder = path.join(directory, 'evidence');
  // The exclusive directory also prevents concurrent or subsequent runs from
  // replacing an existing rehearsal in the same local journal directory.
  fs.mkdirSync(folder);
  const contents = new Map();
  return {
    keep(bytes) {
      const sha256 = sha(bytes);
      if (!contents.has(sha256)) {
        fs.writeFileSync(path.join(folder, sha256), bytes, { flag: 'wx', mode: 0o600 });
        contents.set(sha256, bytes);
      }
      return { sha256, bytes: bytes.length };
    },
    read(sha256, size, limit = 1_000_000) {
      const bytes = contents.get(sha256);
      requireThat(bytes?.length === size && bytes.length <= limit, 'Smoke evidence attachment changed');
      return bytes;
    },
  };
}

async function rehearseDependencySmoke(input, bridge) {
  const { protocol, expectedProtocolHash, build, sourceText, fixtures, outputDirectory } = structuredClone(input);
  const plan = planDependencySmoke(protocol, expectedProtocolHash);
  const sample = validateBuildAndSource(protocol, build, sourceText);
  requireThat(exact(fixtures, IDS), 'Exactly four offline fixture responses required');
  const directory = localPath(outputDirectory);
  requireThat(fs.readdirSync(directory).length === 0, 'An empty offline smoke output directory is required');
  const writer = openEvidence(directory);
  const budget = openObservedBudget(directory, plan);
  const usedIds = new Set();
  const stages = [];
  let prior;
  try {
    for (const { provider, stage, id, maxOutputTokens } of CALLS) {
      const captured = await bridge.shapeOffline({ provider, stage, build: structuredClone(build), buildHash: C.digest(build),
        sourceUrl: sample.url, sourceText, sourceHash: sample.source.sha256, prior: stage === 'critic' ? prior : null });
      const capture = writer.keep(validateRequest(captured, provider, maxOutputTokens));
      const request = writer.keep(Buffer.from(captured.body));
      budget.reserve(id, capture.sha256);
      try {
        const fixture = fixtures[id];
        requireThat(exact(fixture, ['status', 'requestId', 'body']) && fixture.status === 200 &&
          identifier(fixture.requestId) && typeof fixture.body === 'string' &&
          Buffer.byteLength(fixture.body) <= MAX_RESPONSE, 'Offline fixture response incomplete; charge would be unknown');
        const response = writer.keep(Buffer.from(fixture.body));
        const replay = await bridge.replay(build.artifact.sha256, { provider, body: fixture.body });
        requireThat(['parsed', 'fenced-json'].includes(replay?.outcome) && typeof replay.parsed?.text === 'string' &&
          replay.parsed.text.trim() && replay.parsed.text.length <= 30_000, 'Unsupported smoke relay result');
        const { text } = replay.parsed;
        const normalized = stage === 'analyzer' ? { summary: text } :
          parseUnambiguousJson(text.trim().replace(/^\x60{3}(?:json\s+)?([\s\S]*?)\x60{3}$/i, '$1'));
        const output = writer.keep(Buffer.from(C.canonicalJson(normalized)));
        const { inputTokens, outputTokens } = replay.usage ?? {};
        const usage = { inputTokens, outputTokens };
        const rate = RATES[provider];
        const costMicros = Math.ceil(inputTokens * rate.inputMicrodollarsPerMillion / 1_000_000) +
          Math.ceil(outputTokens * rate.outputMicrodollarsPerMillion / 1_000_000);
        const observation = { model: rate.model, requestId: fixture.requestId, request, response, output, usage, costMicros };
        // The clock check in the promotion verifier is also exercised here.
        // These fixtures never become captured-runtime observations.
        verifySmokeStage(provider, stage, observation, rate, writer.read, usedIds, protocol.declaredAt, new Date().toISOString());
        budget.settle(id, usage);
        stages.push({ id, capture, observation });
        if (stage === 'analyzer') prior = normalized.summary;
      } catch (error) {
        if (budget.snapshot().attempts.at(-1)?.status === 'reserved') budget.fail(id);
        throw error;
      }
    }
    const receipt = C.seal({
      v: 1, kind: 'maintenance-dependency-smoke-rehearsal', origin: 'fixture', protocolHash: protocol.hash,
      imageSha256: build.artifact.sha256, sampleId: SAMPLE_ID, providerCalls: 0, fixtureDeliveries: stages.length,
      promotionEligible: false, ...assessDependencySmokeInputBounds(), budget: budget.snapshot(), stages,
    });
    fs.writeFileSync(path.join(directory, 'smoke-rehearsal.json'), C.canonicalJson(receipt) + '\n', { flag: 'wx', mode: 0o600 });
    return receipt;
  } finally {
    budget.close();
  }
}

function readJson(file, limit) {
  const stat = fs.statSync(file);
  requireThat(stat.isFile() && stat.size > 0 && stat.size <= limit, 'Invalid smoke input file');
  const bytes = fs.readFileSync(file);
  requireThat(bytes.length === stat.size, 'Smoke input file changed');
  return parseUnambiguousJson(utf8(bytes).replace(/^\uFEFF/, ''));
}

async function main([mode, inputFile, expectedProtocolHash, outputDirectory]) {
  if (mode === '--live') return runDependencySmokeLive();
  requireThat(mode === '--offline' && inputFile && expectedProtocolHash && outputDirectory && process.argv.length === 6,
    'Usage: node tools/maintenance-dependency-smoke.js --offline <input.json> <protocol-sha256> <empty-output-directory>');
  const options = readJson(localPath(inputFile), 4_000_000);
  requireThat(exact(options, ['protocol', 'candidate', 'imageRuntime', 'sourceFile', 'fixtures']) &&
    exact(options.candidate, ['archivePath', 'releaseFile', 'image', 'runtime']) &&
    exact(options.imageRuntime, ['umociPath', 'umociSha256', 'imageLauncherSha256', 'builderFiles']),
  'Offline candidate smoke input required');
  const { protocol, candidate, imageRuntime, fixtures } = options;
  planDependencySmoke(protocol, expectedProtocolHash);
  const { umociPath, ...runtimeFiles } = imageRuntime;
  requireThat(typeof umociPath === 'string' && C.digest(runtimeFiles) === IMAGE_RUNTIME_HASH,
    'Unreviewed dependency smoke image runtime');
  const sample = protocol.corpus.find(item => item.id === SAMPLE_ID);
  requireThat(C.digest({ builds: protocol.builds, classificationHash: protocol.classificationHash, sample }) === ACTIVATION_SCOPE_HASH,
    'Unreviewed Checkpoint E activation pair or smoke sample');
  requireThat(same(candidate.image, protocol.builds.candidate.image), 'Candidate OCI identity changed');
  const [archivePath, releaseFile, sourceFile] = localPaths([candidate.archivePath, candidate.releaseFile, options.sourceFile]);
  const sourceStat = fs.statSync(sourceFile);
  requireThat(sourceStat.isFile() && sourceStat.size === sample.source.bytes, 'Frozen smoke sample size changed');
  const sourceText = utf8(fs.readFileSync(sourceFile));
  const { sha256, bytes } = candidate.image;
  const release = readJson(releaseFile, 4_000_000);
  const build = { artifact: { sha256, bytes }, release, runtime: candidate.runtime };
  validateBuildAndSource(protocol, build, sourceText);
  const bridge = imageBridge(imageRuntime, { archiveLocations: { [sha256]: archivePath } },
    { ...imageRuntime, images: [candidate.image] });
  try {
    await bridge.ready();
    const receipt = await rehearseDependencySmoke({ protocol, expectedProtocolHash, build, sourceText, fixtures, outputDirectory }, bridge);
    console.log('Offline dependency smoke completed with ' + receipt.fixtureDeliveries + ' fixture responses and zero provider calls.');
  } finally {
    await bridge.close();
  }
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

module.exports = { planDependencySmoke, assessDependencySmokeInputBounds, rehearseDependencySmoke, runDependencySmokeLive };
