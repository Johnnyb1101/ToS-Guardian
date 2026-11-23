'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
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
const { sameLocalDirectory, verifyDependencySmokeApproval,
  verifyDependencySmokeRecovery } = require('./maintenance-dependency-smoke-approval');
const { prepareDependencySmokeCredentials } = require('./maintenance-dependency-smoke-credentials');
const { sendDependencySmokeRequest } = require('./maintenance-dependency-smoke-transport');
const {
  DEFAULT_SMOKE_CAP, CHECKPOINT_E_SMOKE_CAP, CHECKPOINT_E_SCOPE_HASH, CHECKPOINT_E_SAMPLE_ID: SAMPLE_ID,
  CHECKPOINT_E_RATES: RATES, CHECKPOINT_E_CONTEXT, CHECKPOINT_E_OUTPUT: STAGES, isCheckpointEActivation,
} = require('./maintenance-dependency-smoke-policy');

const MAX_ARCHIVE = 256 * 1024 * 1024;
const MAX_RESPONSE = 800_000;
// Checkpoint E trust pins from the reviewed Class E evidence. File paths are
// local inputs. The bytes executed by WSL are verified against these pins.
const IMAGE_RUNTIME_HASH = 'a1b5a200c69a402a11d08c724849ccd27939dc40a532dcb9d9cef93d4d495a51';
const ORIGINAL_BUDGET_BUILDER = Object.freeze({ path: 'tools/maintenance-observed-budget.js', bytes: 10469,
  sha256: '3cbfd5ad95767480372358b3dfe6f414dce6ababded001f0a89889b3fcf27848' });
const RECOVERY_BUDGET_BUILDER = Object.freeze({ path: ORIGINAL_BUDGET_BUILDER.path, bytes: 12933,
  sha256: 'b16ef7f97dca12b97ad9cbd0f4d5c9aebc7549b1b513ebe25bc0f6ca6437bef6' });
// This is a single reviewed incident. A generic first-slot failure cannot authorize recovery.
const CHECKPOINT_E_RECOVERY_INCIDENT = Object.freeze({
  priorApprovalHash: 'f8c7b9677c52e9ab3757790d3b5aa2a37274c3b51516141f6d7b0f511f7e06d3',
  budgetHash: 'db3aa9f589ff789f8f68ca540039c9a54b00c8ffd3a3a48ca9e586339336106b',
  journalHash: '6b245e08c7bd07a60233341625f21bbe986ffcbee72883504ec53f867c8291df',
  journalTailHash: 'dbb10824a112dfec4e1eced280302fbf5520a767ccc30495e6e32bc529893672',
  callId: 'anthropic:analyzer',
  requestHash: 'e3220995ed215b3c3602cfb0bace21619d72307ad8fd0f97dbd06a5bec178d00',
  failureEvidence: Object.freeze({ sha256: '64b3d4dc1c9866cda110074f18bc07a0db48f13a3353376dd2b1d49a7bbc6f44', bytes: 1027 }),
  dispatchLog: Object.freeze({ sha256: 'f25bcc97c91192e37068231091de15e1e51f46a936240e175d3b6d5b05e49179', bytes: 528 }),
});
const PROVIDERS = ['anthropic', 'openai'];
const CALLS = PROVIDERS.flatMap(provider => Object.entries(STAGES).map(([stage, maxOutputTokens]) => ({
  provider, stage, id: provider + ':' + stage, maxOutputTokens,
})));
const IDS = CALLS.map(call => call.id);
const POLICY_KEYS = ['v', 'kind', 'mode', 'declaredAt', 'smokeSampleId', 'smokeCapMicros', 'rates',
  'reviewers', 'corpus', 'providers', 'classification', 'classificationHash', 'builds', 'hash'];
const IMAGE_INPUT = ['protocol', 'candidate', 'imageRuntime', 'sourceFile'];
const AUTHORIZED_INPUT = [...IMAGE_INPUT, 'expectedProtocolHash', 'outputDirectory', 'approval',
  'preregistration', 'preregistrationBytes', 'billingEvidenceBytes'];
const RECOVERY_INPUT = [...AUTHORIZED_INPUT, 'recovery', 'priorApproval', 'failureEvidenceBytes', 'dispatchLogBytes'];
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
    protocol.smokeSampleId === SAMPLE_ID && [DEFAULT_SMOKE_CAP, CHECKPOINT_E_SMOKE_CAP].includes(protocol.smokeCapMicros) &&
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
  const expanded = protocol.smokeCapMicros === CHECKPOINT_E_SMOKE_CAP;
  requireThat(!expanded || isCheckpointEActivation({ builds: protocol.builds, classificationHash: protocol.classificationHash, sample: samples[0] }),
    'Expanded smoke cap requires the approved Checkpoint E activation pair');
  const bounds = assessDependencySmokeInputBounds(protocol.smokeCapMicros);
  return createObservedBudgetPlan({
    // A new approval or protocol cannot reset this activation's paid allowance.
    approvalId: expanded ? 'dep-smoke-live-' + CHECKPOINT_E_SCOPE_HASH : 'dep-smoke-off-' + protocol.hash,
    planHash: protocol.hash,
    limitMicrodollars: protocol.smokeCapMicros,
    overheadMicrodollars: 0,
    calls: CALLS.map(({ provider, id, maxOutputTokens }) => ({
      id, maxOutputTokens, maxInputTokens: bounds[provider].reservedInputTokens,
      inputMicrodollarsPerMillion: RATES[provider].inputMicrodollarsPerMillion,
      outputMicrodollarsPerMillion: RATES[provider].outputMicrodollarsPerMillion,
    })),
  });
}

function assessDependencySmokeInputBounds(cap = DEFAULT_SMOKE_CAP) {
  // Sonnet's Messages max_tokens covers generated output. Its count_tokens
  // response and any byte-length check are estimates, not a billing ceiling.
  const fullContext = cap === CHECKPOINT_E_SMOKE_CAP;
  return {
    anthropic: { reservedInputTokens: fullContext ? CHECKPOINT_E_CONTEXT.anthropic : 64_000,
      providerContextTokens: CHECKPOINT_E_CONTEXT.anthropic, hardUpperBoundEstablished: fullContext },
    openai: { reservedInputTokens: CHECKPOINT_E_CONTEXT.openai,
      providerContextTokens: CHECKPOINT_E_CONTEXT.openai, hardUpperBoundEstablished: true },
    liveDispatchAllowed: false,
  };
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

async function executeSmoke({ protocol, build, sourceText, outputDirectory }, bridge, plan, dispatch) {
  const sample = validateBuildAndSource(protocol, build, sourceText);
  const directory = localPath(outputDirectory);
  requireThat(fs.readdirSync(directory).length === 0, 'An empty offline smoke output directory is required');
  const journal = localPath(dispatch.journalDirectory);
  requireThat(dispatch.live || !sameLocalDirectory(journal, liveJournalPath()),
    'An offline rehearsal cannot use the paid smoke journal');
  const budget = openObservedBudget(journal, plan);
  const usedIds = new Set();
  const stages = [];
  let prior;
  try {
    const initial = budget.snapshot();
    requireThat(!initial.recovery && initial.attempts.length === (dispatch.recovery ? 1 : 0),
      'This activation has already used its smoke allowance or is missing its failed reservation');
    const writer = openEvidence(directory);
    for (const { provider, stage, id, maxOutputTokens } of CALLS) {
      const captured = await bridge.shapeOffline({ provider, stage, build: structuredClone(build), buildHash: C.digest(build),
        sourceUrl: sample.url, sourceText, sourceHash: sample.source.sha256, prior: stage === 'critic' ? prior : null });
      const capture = writer.keep(validateRequest(captured, provider, maxOutputTokens));
      const request = writer.keep(Buffer.from(captured.body));
      dispatch.checkCurrent();
      if (dispatch.recovery && id === IDS[0]) {
        requireThat(capture.sha256 === dispatch.recovery.requestHash, 'Recovered request hash mismatch');
        budget.recoverBeforeDispatch(dispatch.recovery);
      }
      budget.reserve(id, capture.sha256);
      try {
        const startedAt = dispatch.live ? new Date().toISOString() : protocol.declaredAt;
        const receipt = await dispatch.send({ id, provider, stage, captured, captureSha256: capture.sha256 });
        requireThat(exact(receipt, ['status', 'requestId', 'body']) && identifier(receipt.requestId) &&
          typeof receipt.body === 'string' && Buffer.byteLength(receipt.body) <= MAX_RESPONSE,
        'Incomplete smoke response; charge unknown');
        const response = writer.keep(Buffer.from(receipt.body));
        requireThat(receipt.status === 200, 'Unsuccessful smoke response; charge unknown');
        const replay = await bridge.replay(build.artifact.sha256, { provider, body: receipt.body });
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
        const observation = { model: rate.model, requestId: receipt.requestId, request, response, output, usage, costMicros };
        verifySmokeStage(provider, stage, observation, rate, writer.read, usedIds, startedAt, new Date().toISOString(),
          protocol.smokeCapMicros === CHECKPOINT_E_SMOKE_CAP);
        budget.settle(id, usage);
        stages.push({ id, capture, observation });
        if (stage === 'analyzer') prior = normalized.summary;
      } catch (error) {
        if (budget.snapshot().attempts.at(-1)?.status === 'reserved') budget.fail(id);
        throw error;
      }
    }
    const receipt = C.seal({
      v: 1, kind: 'maintenance-dependency-smoke-run', origin: dispatch.live ? 'captured-runtime' : 'fixture',
      protocolHash: protocol.hash, approvalHash: dispatch.approvalHash ?? null,
      imageSha256: build.artifact.sha256, sampleId: SAMPLE_ID, providerCalls: dispatch.live ? stages.length : 0,
      fixtureDeliveries: dispatch.live ? 0 : stages.length, liveAuthorized: dispatch.live, promotionEligible: false,
      ...assessDependencySmokeInputBounds(protocol.smokeCapMicros), budget: budget.snapshot(), stages,
    });
    fs.writeFileSync(path.join(directory, 'smoke-rehearsal.json'), C.canonicalJson(receipt) + '\n', { flag: 'wx', mode: 0o600 });
    return receipt;
  } finally {
    budget.close();
  }
}

function fixtureSender(fixtures) {
  requireThat(exact(fixtures, IDS), 'Exactly four offline fixture responses required');
  const replies = structuredClone(fixtures);
  return ({ id }) => replies[id];
}

async function rehearseDependencySmoke(input, bridge) {
  const snapshot = structuredClone(input);
  const plan = planDependencySmoke(snapshot.protocol, snapshot.expectedProtocolHash);
  return executeSmoke(snapshot, bridge, plan, {
    live: false, journalDirectory: snapshot.outputDirectory, checkCurrent() {}, send: fixtureSender(snapshot.fixtures),
  });
}

function readJson(file, limit) {
  const stat = fs.statSync(file);
  requireThat(stat.isFile() && stat.size > 0 && stat.size <= limit, 'Invalid smoke input file');
  const bytes = fs.readFileSync(file);
  requireThat(bytes.length === stat.size, 'Smoke input file changed');
  return parseUnambiguousJson(utf8(bytes).replace(/^\uFEFF/, ''));
}

function prepareImageRun(options) {
  requireThat(exact(options.candidate, ['archivePath', 'releaseFile', 'image', 'runtime']) &&
    exact(options.imageRuntime, ['umociPath', 'umociSha256', 'imageLauncherSha256', 'builderFiles']),
  'Exact candidate smoke input required');
  const { protocol, candidate, imageRuntime } = options;
  const { umociPath, ...runtimeFiles } = imageRuntime;
  requireThat(typeof umociPath === 'string' && C.digest(runtimeFiles) === IMAGE_RUNTIME_HASH,
    'Unreviewed dependency smoke image runtime');
  // The recovery code changes only the budget builder. Keep every other archived builder pin.
  const builderFiles = imageRuntime.builderFiles.map(file => same(file, ORIGINAL_BUDGET_BUILDER) ? RECOVERY_BUDGET_BUILDER : file);
  const reviewedRuntime = { ...imageRuntime, builderFiles };
  const sample = protocol.corpus.find(item => item.id === SAMPLE_ID);
  requireThat(isCheckpointEActivation({ builds: protocol.builds, classificationHash: protocol.classificationHash, sample }),
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
  return { build, sourceText, bridge: imageBridge(reviewedRuntime, { archiveLocations: { [sha256]: archivePath } },
    { ...reviewedRuntime, images: [candidate.image] }) };
}

async function withImage(input, execute) {
  const { build, sourceText, bridge } = prepareImageRun(input);
  try {
    await bridge.ready();
    return await execute({ protocol: input.protocol, outputDirectory: input.outputDirectory, build, sourceText }, bridge);
  } finally {
    await bridge.close();
  }
}

function liveJournalPath() {
  return path.join(os.homedir(), 'AppData', 'Local', 'ToSGuardian', 'dependency-smoke-live');
}

async function authorizedSmoke(input, operatorTrust, prepareDelivery, live, recoveryContext) {
  requireThat(exact(input, recoveryContext ? RECOVERY_INPUT : AUTHORIZED_INPUT), 'Signed live approval and input bounds are required');
  const { preregistrationBytes, billingEvidenceBytes, failureEvidenceBytes, dispatchLogBytes, ...config } = input;
  const snapshot = structuredClone(config);
  const plan = planDependencySmoke(snapshot.protocol, snapshot.expectedProtocolHash);
  requireThat(plan.totalMicrodollars === 6_072_720, 'Live smoke requires full documented context reservations');
  const approvalInput = {
    ...snapshot, operatorTrust: structuredClone(operatorTrust), budgetHash: plan.hash,
    preregistrationBytes: Buffer.from(preregistrationBytes), billingEvidenceBytes: Buffer.from(billingEvidenceBytes),
  };
  const approval = verifyDependencySmokeApproval(approvalInput);
  if (live) {
    requireThat(approval.journalDirectory === localPath(liveJournalPath()), 'Fixed Checkpoint E live journal directory required');
  }
  const recovery = recoveryContext && verifyDependencySmokeRecovery({
    recovery: snapshot.recovery, priorApproval: snapshot.priorApproval, successor: approval,
    operatorTrust: approvalInput.operatorTrust, ...recoveryContext,
    failureEvidenceBytes: Buffer.from(failureEvidenceBytes), dispatchLogBytes: Buffer.from(dispatchLogBytes),
  });
  const checkCurrent = () => verifyDependencySmokeApproval(approvalInput);
  const delivery = prepareDelivery(approval.accounts);
  return withImage(snapshot, (context, bridge) => executeSmoke(context, bridge, plan, {
    live, journalDirectory: approval.journalDirectory, approvalHash: approval.hash, checkCurrent, recovery,
    send: call => delivery(call, approval.accounts[call.provider], checkCurrent),
  }));
}

function providerDelivery(readCredential) {
  return async (call, accountId, checkCurrent) => {
    const credential = await readCredential({ provider: call.provider, accountId });
    checkCurrent();
    return sendDependencySmokeRequest({ ...call, credential, accountId });
  };
}

// Called by a trusted local operator wrapper. Credentials are obtained only
// when a signed, current approval has passed and the request is reserved.
async function runDependencySmokeLive(input, operatorTrust, readCredential) {
  requireThat(exact(input, AUTHORIZED_INPUT), 'Signed live approval and input bounds are required');
  requireThat(typeof readCredential === 'function', 'Local credential reader required');
  return authorizedSmoke(input, operatorTrust, () => providerDelivery(readCredential), true);
}

function rehearseApprovedDependencySmoke(input, operatorTrust, fixtures) {
  return authorizedSmoke(input, operatorTrust, () => fixtureSender(fixtures), false);
}

function reviewedLauncherCommit() {
  const git = args => execFileSync('git', args, { cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
    windowsHide: true, timeout: 10000 }).trim();
  const commit = git(['rev-parse', 'HEAD']);
  requireThat(/^[a-f0-9]{40}$/.test(commit), 'Reviewed recovery launcher commit required');
  git(['diff', '--quiet', '--no-ext-diff', commit, '--', 'tools', 'vendor']);
  git(['cat-file', '-e', `${commit}:tools/maintenance-dependency-smoke-credentials.js`]);
  requireThat(!git(['ls-files', '--others', '--', 'tools', 'vendor']), 'Untracked recovery launcher files');
  return commit;
}

async function runDependencySmokeRecoveryLive(input, operatorTrust, credentialFiles) {
  return authorizedSmoke(input, operatorTrust,
    accounts => providerDelivery(prepareDependencySmokeCredentials(credentialFiles, accounts)), true,
    { expectedIncident: CHECKPOINT_E_RECOVERY_INCIDENT, launcherCommit: reviewedLauncherCommit() });
}

function rehearseDependencySmokeRecovery(input, operatorTrust, fixtures, { expectedIncident, launcherCommit }) {
  return authorizedSmoke(input, operatorTrust, () => fixtureSender(fixtures), false, { expectedIncident, launcherCommit });
}

async function main([mode, inputFile, expectedProtocolHash, outputDirectory]) {
  if (mode === '--live') throw new Error('Use runDependencySmokeLive with a trusted local operator and a signed Checkpoint E approval');
  requireThat(mode === '--offline' && inputFile && expectedProtocolHash && outputDirectory && process.argv.length === 6,
    'Usage: node tools/maintenance-dependency-smoke.js --offline <input.json> <protocol-sha256> <empty-output-directory>');
  const options = readJson(localPath(inputFile), 4_000_000);
  requireThat(exact(options, [...IMAGE_INPUT, 'fixtures']), 'Offline candidate smoke input required');
  const plan = planDependencySmoke(options.protocol, expectedProtocolHash);
  const send = fixtureSender(options.fixtures);
  const receipt = await withImage({ ...options, outputDirectory }, (context, bridge) => executeSmoke(context, bridge, plan, {
    live: false, journalDirectory: outputDirectory, checkCurrent() {}, send,
  }));
  console.log('Offline dependency smoke completed with ' + receipt.fixtureDeliveries + ' fixture responses and zero provider calls.');
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

module.exports = {
  planDependencySmoke, assessDependencySmokeInputBounds, rehearseDependencySmoke,
  rehearseApprovedDependencySmoke, runDependencySmokeLive, rehearseDependencySmokeRecovery, runDependencySmokeRecoveryLive,
};
