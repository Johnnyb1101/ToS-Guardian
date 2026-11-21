'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const C = require('./final-corpus-lib');
const F = require('./maintenance-final-evidence');
const OpenAI = require('./maintenance-openai-contract');
const { createObservedBudgetPlan, openObservedBudget } = require('./maintenance-observed-budget');
const { localPath, localPaths } = require('./maintenance-local-path');

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const SYNTHETIC_KEY = 'OFFLINE-NOT-A-CREDENTIAL';
const STAGES = Object.freeze({
  analyzer: Object.freeze({ model: 'gpt-4o-mini', tier: 'default', input: 128000, output: 1200, inputRate: 150000, outputRate: 600000 }),
  critic: Object.freeze({ model: 'gpt-4o-mini', tier: 'default', input: 128000, output: 1000, inputRate: 150000, outputRate: 600000 }),
  judge: Object.freeze({ model: 'gpt-4o', tier: 'jury', input: 128000, output: 8000, inputRate: 2500000, outputRate: 10000000 }),
  independent: Object.freeze({ model: 'gpt-6-luna', input: 1050000, output: 8000, inputRate: 250000, outputRate: 750000 }),
});
const comparisons = Object.freeze(['activation', 'recovery']);
const arms = Object.freeze(['baseline', 'candidate']);
const acceptedModels = Object.freeze({
  'gpt-4o': Object.freeze(['gpt-4o', 'gpt-4o-2024-08-06', 'gpt-4o-2024-11-20']),
  'gpt-6-luna': Object.freeze(['gpt-6-luna']),
});
const independentRoles = Object.freeze([
  ['execution', 'human'], ['execution', 'judge'], ['execution', 'code'], ['execution', 'scope'], ['human', 'judge'],
]);

function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
const boundedText = text => C.nonempty(text) && !text.includes('\0') && Buffer.byteLength(text) <= 400000;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const describe = bytes => ({ sha256: sha(bytes), bytes: bytes.length });
const copyJson = value => JSON.parse(C.canonicalJson(value));
const same = (a, b) => C.canonicalJson(a) === C.canonicalJson(b);
const timestamp = text => typeof text === 'string' && Number.isFinite(Date.parse(text)) && new Date(text).toISOString() === text;
const receiptId = text => typeof text === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(text);

function createObservedPlan(input) {
  const value = copyJson(input);
  if (!exact(value, ['approvalId', 'limitMicrodollars', 'overheadMicrodollars', 'journalDirectory', 'protocols']) ||
      !exact(value.protocols, comparisons)) throw new Error('Both observed evaluation protocols and a budget are required');
  value.journalDirectory = localPath(value.journalDirectory);
  if (!fs.statSync(value.journalDirectory).isDirectory()) throw new Error('An existing local budget journal directory is required');
  for (const protocol of Object.values(value.protocols)) {
    const result = F.validateFinalProtocol(protocol);
    if (!result.valid || protocol.mode !== 'observed') {
      throw new Error(`Observed protocol required: ${result.reasons.join('; ')}`);
    }
    for (const stage of F.STAGES) {
      const model = protocol.stageModels[stage];
      if (model.provider !== 'openai' || model.tier !== STAGES[stage].tier || model.model !== STAGES[stage].model) {
        throw new Error(`Unsupported frozen model for ${stage}`);
      }
    }
    if (protocol.judge.provider !== 'openai' || protocol.judge.model !== STAGES.independent.model) {
      throw new Error('Unsupported independent grading model');
    }
  }
  const { activation, recovery } = value.protocols;
  if (!same(activation.preparation.candidate, recovery.preparation.baseline) ||
      same(activation.preparation.baseline.artifact, recovery.preparation.candidate.artifact)) {
    throw new Error('Expected one shared candidate and three distinct build archives');
  }
  for (const field of ['corpus', 'requiredCoverage', 'criteria', 'rubric', 'judge', 'stageModels', 'repetitions']) {
    if (!same(activation[field], recovery[field])) throw new Error(`Comparisons differ on ${field}`);
  }

  const runs = comparisons.flatMap(comparison => {
    const protocol = value.protocols[comparison];
    return arms.flatMap(arm => protocol.corpus.samples.flatMap(sample =>
      Array.from({ length: protocol.repetitions }, (_, index) => ({
        comparison, arm, sampleId: sample.id, repetition: index + 1,
      }))));
  });
  const calls = runs.flatMap(run => Object.entries(STAGES).map(([stage, rates]) => ({
    id: callId(run, stage), maxInputTokens: rates.input, maxOutputTokens: rates.output,
    inputMicrodollarsPerMillion: rates.inputRate, outputMicrodollarsPerMillion: rates.outputRate,
  })));
  const binding = C.seal({ version: 1, kind: 'offline-observed-evaluation-plan', ...value, runs, calls });
  const budget = createObservedBudgetPlan({
    approvalId: value.approvalId, planHash: binding.hash, limitMicrodollars: value.limitMicrodollars,
    overheadMicrodollars: value.overheadMicrodollars, calls,
  });
  return { ...binding, budget };
}

function callId({ comparison, arm, sampleId, repetition }, stage) {
  return `${comparison}:${arm}:${sampleId}:${repetition}:${stage}`;
}

function validatePlan(plan, approvedPlanHash) {
  const snapshot = copyJson(plan);
  if (!C.isHash(approvedPlanHash) || snapshot.hash !== approvedPlanHash) throw new Error('Approved evaluation plan hash required');
  const { approvalId, limitMicrodollars, overheadMicrodollars, journalDirectory, protocols } = snapshot;
  const computed = createObservedPlan({ approvalId, limitMicrodollars, overheadMicrodollars, journalDirectory, protocols });
  if (!same(snapshot, computed)) throw new Error('Evaluation plan changed after preparation');
  return computed;
}

function verifyPreregistration(protocol, envelope, registry, now, attachment) {
  if (!timestamp(now) || !exact(envelope, ['payload', 'signature'])) throw new Error('Trusted clock and signed preregistration required');
  const { payload, signature } = envelope;
  if (!exact(payload, ['v', 'kind', 'protocolHash', 'reviewer', 'observedAt', 'outcome', 'attachment', 'hash']) ||
      payload.v !== 1 || payload.kind !== 'preregistration' || payload.outcome !== 'pass' ||
      payload.protocolHash !== protocol.hash || payload.reviewer !== protocol.reviewers.protocol ||
      !timestamp(payload.observedAt) || payload.observedAt < protocol.declaredAt || payload.observedAt > now ||
      C.bodyHash(payload) !== payload.hash) throw new Error('Invalid preregistration for this protocol');
  const reviewers = new Map(F.ROLES.map(role => {
    const id = protocol.reviewers[role];
    const entry = Object.hasOwn(registry ?? {}, id) ? registry[id] : null;
    if (!exact(entry, ['publicKey', 'roles']) || !Array.isArray(entry.roles) ||
        !entry.roles.includes(role) || !entry.roles.every(item => F.ROLES.includes(item))) {
      throw new Error(`Externally trusted ${role} reviewer required`);
    }
    const key = crypto.createPublicKey(entry.publicKey);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 reviewer keys required');
    return [role, { key, fingerprint: sha(key.export({ type: 'spki', format: 'der' })) }];
  }));
  for (const [left, right] of independentRoles) {
    if (reviewers.get(left).fingerprint === reviewers.get(right).fingerprint) {
      throw new Error(`${left} and ${right} must use independent reviewer keys`);
    }
  }
  const key = reviewers.get('protocol').key;
  const bytes = Buffer.from(String(signature), 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== signature ||
      !crypto.verify(null, Buffer.from(F.observationMessage(payload)), key, bytes)) {
    throw new Error('Preregistration signature did not verify');
  }
  attachment(payload.attachment);
}

async function verifyBuilds(protocols, locations) {
  const expected = new Map(Object.values(protocols).flatMap(protocol =>
    arms.map(arm => [protocol.preparation[arm].artifact.sha256, protocol.preparation[arm].artifact])));
  const files = localPaths([...expected.keys()].map(digest => locations?.[digest]));
  const descriptors = [...expected.values()];
  for (const [index, file] of files.entries()) {
    const descriptor = descriptors[index];
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size !== descriptor.bytes) throw new Error('Build archive size changed');
    const hash = crypto.createHash('sha256');
    let total = 0;
    for await (const bytes of fs.createReadStream(file)) {
      total += bytes.length;
      if (total > descriptor.bytes) throw new Error('Build archive grew during verification');
      hash.update(bytes);
    }
    if (total !== descriptor.bytes || hash.digest('hex') !== descriptor.sha256) throw new Error('Build archive bytes changed');
  }
}

function validateRequest(input, stage) {
  const request = copyJson(input);
  const spec = STAGES[stage];
  const { body } = request;
  const capName = stage === 'independent' ? 'max_completion_tokens' : 'max_tokens';
  const keys = stage === 'independent' ? ['model', 'messages', capName, 'reasoning_effort'] : ['model', 'messages', capName];
  if (!exact(request, ['url', 'body']) || request.url !== ENDPOINT || !exact(body, keys) ||
      body.model !== spec.model || body[capName] !== spec.output ||
      (stage === 'independent' && body.reasoning_effort !== 'medium') ||
      !Array.isArray(body.messages) || body.messages.length !== 2 ||
      !body.messages.every((message, index) => exact(message, ['role', 'content']) &&
        message.role === (index === 0 ? 'system' : 'user') && boundedText(message.content))) {
    throw new Error(`Invalid captured ${stage} request`);
  }
  if (stage === 'analyzer' || stage === 'critic') OpenAI.prepareOpenAIRequest(request);
  const bytes = Buffer.from(C.canonicalJson(request));
  if (bytes.length > 1000000) throw new Error('Observed request is too large');
  return { request, bytes };
}

// Run this adapter against the trusted app directory of an independently verified image.
// It uses the image's own runtime policy, lesson resolution and request builders.
function createImageRequestBuilder(appDirectory) {
  if (!path.isAbsolute(appDirectory)) throw new Error('Absolute image app directory required');
  const root = fs.realpathSync(appDirectory);
  const release = require(path.join(root, 'release-config.js'));
  const policy = require(path.join(root, 'release-policy.js'));
  const operations = require(path.join(root, 'analysisOperations.js'));
  const relay = require(path.join(root, 'llmRelay.js'));
  const { classifyDocumentType } = require(path.join(root, 'docType.js'));
  const npm = require(path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/package.json')).version;
  const runtime = { node: process.version, npm, platform: process.platform, arch: process.arch };
  return ({ stage, provider, build, buildHash, sourceUrl, sourceText, sourceHash, prior }) => {
    const legacy = provider === undefined;
    const escalation = stage === 'escalation' && !legacy;
    if ((!F.STAGES.includes(stage) && !escalation) || (!legacy && !isImageProvider(provider)) ||
        !same(build.runtime, runtime) || C.digest(build) !== buildHash ||
        !boundedText(sourceText) || sha(Buffer.from(sourceText)) !== sourceHash) {
      throw new Error('Image runtime, build or held-out source identity changed');
    }
    const checked = release.validateRelease(build.release);
    const declared = build.release.config.policy;
    if (!checked.valid || declared.cache.shared !== 'disabled' ||
        !policy.samePolicy(declared, policy.createRuntimePolicy(declared.versions.pipeline, { sharedCacheDisabled: true }))) {
      throw new Error('Image runtime policy does not match the frozen release');
    }
    const domain = new URL(sourceUrl).hostname;
    const target = escalation ? 'analyzer' : stage;
    const operation = { operation: target === 'judge' ? 'jury' : target, provider: provider ?? 'openai', domain };
    const options = {};
    if (target === 'analyzer') {
      operation.documentText = sourceText;
      if (escalation) operation.escalate = true;
    } else {
      operation.sourceText = sourceText;
      operation.analysisSummary = prior;
    }
    if (target === 'judge') options.trainerOperations = true;
    else {
      const docType = classifyDocumentType(sourceText, domain).type;
      options.lessons = { [target]: release.resolveRelease(build.release, { target, docType }).lessons };
    }
    const op = operations.validateOperationRequest(operation, options);
    if (!op.valid) throw new Error(op.reason);
    const validated = relay.validateAnalyzeRequest(op.relayRequest);
    if (!validated.valid) throw new Error(validated.reason);
    const { url, headers, body } = relay.buildProviderRequest(validated, SYNTHETIC_KEY);
    if (legacy) return validateRequest({ url, body }, stage).request;
    const auth = provider === 'anthropic' ? 'x-api-key' : 'Authorization';
    const expected = provider === 'anthropic' ? SYNTHETIC_KEY : `Bearer ${SYNTHETIC_KEY}`;
    if (headers?.[auth] !== expected) throw new Error('Image request did not use the synthetic credential');
    const retainedHeaders = Object.fromEntries(Object.entries(headers).filter(([name]) => name !== auth));
    // The proxy serializes the relay body with JSON.stringify before dispatch.
    return { url, headers: retainedHeaders, body: JSON.stringify(body) };
  };
}

function isImageProvider(provider) {
  return provider === 'anthropic' || provider === 'openai';
}

function replayImageResponse(appDirectory, { provider, body }) {
  if (!isImageProvider(provider) || typeof body !== 'string') throw new Error('Invalid image response replay');
  let data;
  try {
    data = JSON.parse(body);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { outcome: 'malformed-json', parsed: null, usage: null };
  }
  const relay = require(path.join(appDirectory, 'llmRelay.js'));
  const parsed = relay.parseProviderResponse(provider, data);
  const usage = relay.normalizeProviderUsage(provider, data?.usage);
  // Annotate the recorded edge case while retaining the relay's unmodified result.
  const choice = data?.choices?.[0];
  const stop = provider === 'anthropic' ? data?.stop_reason : choice?.finish_reason;
  const refusal = provider === 'anthropic'
    ? stop === 'refusal' || (Array.isArray(data?.content) && data.content.some(block => block?.type === 'refusal'))
    : stop === 'content_filter' || Boolean(choice?.message?.refusal);
  let outcome = parsed.error === undefined ? 'parsed' : 'provider-error';
  if (stop === 'length' || stop === 'max_tokens') outcome = 'truncated';
  else if (refusal) outcome = 'refusal';
  else if (typeof parsed.text === 'string' && /^\s*```(?:json\b|[ \t]*\r?\n\s*[{\[])/i.test(parsed.text)) {
    outcome = 'fenced-json';
  }
  return { outcome, parsed, usage };
}

function providerResponse(fixture, stage, request, bytes, parseJson, live) {
  if (!exact(fixture, ['status', 'requestId', 'response']) || fixture.status !== 200 ||
      !receiptId(fixture.requestId) ||
      !bytes) {
    throw new Error('Fake provider response failed or was incomplete');
  }
  const response = parseJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!response || !receiptId(response.id) ||
      ((live || response.service_tier !== undefined) && response.service_tier !== 'default')) {
    throw new Error('Fake provider response has an unexpected identity or billing tier');
  }
  const { choices } = response;
  const choice = Array.isArray(choices) && choices.length === 1 ? choices[0] : null;
  if (choice?.message?.role !== 'assistant') throw new Error('Unsupported fake provider output role');
  const usageOptions = { requireCachedTokens: !live };
  let text;
  let usage;
  if (stage === 'analyzer' || stage === 'critic') {
    const parsed = OpenAI.recordOpenAIResponse(request, OpenAI.prepareOpenAIRequest(request), response, usageOptions);
    ({ text, usage } = parsed);
  } else {
    const supported = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).every(key => fields.includes(key));
    const { message } = choice;
    if (!supported(response, ['id', 'object', 'created', 'model', 'choices', 'usage', 'system_fingerprint', 'service_tier']) ||
        response.object !== 'chat.completion' ||
        !acceptedModels[request.body.model].includes(response.model) ||
        !supported(choice, ['index', 'finish_reason', 'message', 'logprobs']) ||
        choice.index !== 0 || choice.finish_reason !== 'stop' || choice.logprobs != null ||
        !supported(message, ['role', 'content', 'refusal', 'annotations']) ||
        !boundedText(message.content) || message.refusal != null ||
        (message.annotations !== undefined && (!Array.isArray(message.annotations) || message.annotations.length !== 0))) {
      throw new Error('Unsupported provider output');
    }
    text = message.content;
    usage = OpenAI.readOpenAITextUsage(response.usage, STAGES[stage].output, { ...usageOptions, allowReasoning: true });
  }
  // Charge every prompt token at the reserved rate, including reads and writes.
  return {
    text, requestId: fixture.requestId, completionId: response.id,
    usage: { inputTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens, outputTokens: usage.outputTokens },
  };
}

function readIndependentGrade(text, parseJson) {
  const grade = parseJson(text);
  if (!exact(grade, ['accuracy', 'completeness', 'fabrications']) ||
      ![grade.accuracy, grade.completeness].every(value => Number.isFinite(value) && value >= 0 && value <= 1) ||
      !Number.isSafeInteger(grade.fabrications) || grade.fabrications < 0) {
    throw new Error('Independent grade is incomplete or invalid');
  }
  return grade;
}

function createArtifactWriter(directory) {
  const root = localPath(directory);
  if (!fs.statSync(root).isDirectory()) throw new Error('Existing local output directory required');
  return bytes => {
    const descriptor = describe(bytes);
    const file = localPath(path.join(root, descriptor.sha256), { allowMissing: true });
    if (fs.existsSync(file)) {
      if (!fs.statSync(localPath(file)).isFile() || fs.statSync(file).size !== descriptor.bytes ||
          !fs.readFileSync(file).equals(bytes)) throw new Error('Retained evidence bytes differ');
      return descriptor;
    }
    const fd = fs.openSync(file, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return descriptor;
  };
}

// Internal orchestration shared with the separately authorized live supervisor.
async function runBoundEvaluation({ plan, approvedPlanHash, preregistrations, reviewerRegistry, now, attachments,
  archiveLocations, outputDirectory, shapeRequest }, { origin, deliver, parseJson = JSON.parse, beforeReserve = () => {} }) {
  const bound = validatePlan(plan, approvedPlanHash);
  if (typeof shapeRequest !== 'function' || !(attachments instanceof Map)) {
    throw new Error('Trusted request builder and attachment bytes required');
  }
  const attachment = descriptor => {
    const bytes = attachments.get(descriptor?.sha256);
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > F.MAX_BYTES || !same(describe(bytes), descriptor)) {
      throw new Error('Required evaluation attachment changed or is missing');
    }
    return Buffer.from(bytes);
  };
  const text = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const sourceByComparison = {};
  const judgeByComparison = {};
  for (const [comparison, protocol] of Object.entries(bound.protocols)) {
    verifyPreregistration(protocol, preregistrations?.[comparison], reviewerRegistry, now, attachment);
    const sources = new Map(protocol.corpus.samples.map(sample => [sample.id, text(attachment(sample.source))]));
    if ([...sources.values()].some(source => !boundedText(source))) throw new Error('Invalid evaluation source text');
    sourceByComparison[comparison] = sources;
    judgeByComparison[comparison] = { prompt: text(attachment(protocol.judge.prompt)), rubric: text(attachment(protocol.rubric)) };
  }
  await verifyBuilds(bound.protocols, archiveLocations);
  const write = createArtifactWriter(outputDirectory);
  const budget = openObservedBudget(bound.journalDirectory, bound.budget);
  const observations = [];
  const requestIds = new Set(), completionIds = new Set();
  const live = origin === 'captured-runtime';
  let providerCalls = 0;
  try {
    if (budget.snapshot().attempts.length) throw new Error('This rehearsal has already started; do not replay it');
    for (const run of bound.runs) {
      const protocol = bound.protocols[run.comparison];
      const build = protocol.preparation[run.arm];
      const sample = protocol.corpus.samples.find(item => item.id === run.sampleId);
      const sourceText = sourceByComparison[run.comparison].get(run.sampleId);
      const sourceUrl = sample.provenance.url;
      const outputs = {};
      const stages = {};
      const receipts = {};
      const buildHash = C.digest(build);
      let independentGrade;
      for (const stage of Object.keys(STAGES)) {
        const id = callId(run, stage);
        const { prompt, rubric } = judgeByComparison[run.comparison];
        const captured = stage === 'independent' ? {
          url: ENDPOINT,
          body: { model: STAGES.independent.model, reasoning_effort: 'medium', max_completion_tokens: STAGES.independent.output,
            messages: [{ role: 'system', content: prompt }, { role: 'user', content: C.canonicalJson({ sourceText, rubric, summary: outputs.analyzer }) }] },
        } : await shapeRequest(copyJson({ stage, build, buildHash, sourceUrl, sourceText, sourceHash: sample.source.sha256,
          prior: outputs.analyzer ?? null }));
        const { request, bytes } = validateRequest(captured, stage);
        const sentBytes = live ? Buffer.from(C.canonicalJson({ ...request.body, service_tier: 'default' })) : bytes;
        const requestDescriptor = write(sentBytes);
        beforeReserve();
        budget.reserve(id, requestDescriptor.sha256);
        let responseDescriptor = null;
        let receipt = null;
        const retainFailure = () => write(Buffer.from(C.canonicalJson({
          callId: id, request: requestDescriptor, response: responseDescriptor, receipt, origin, outcome: 'failed',
        })));
        let result, retained;
        try {
          if (live) providerCalls++;
          const delivery = await deliver({ id, bytes: sentBytes, sha256: requestDescriptor.sha256 });
          const reply = Buffer.isBuffer(delivery?.response) && delivery.response.length > 0 && delivery.response.length <= 1048576
            ? Buffer.from(delivery.response) : null;
          if (delivery && Number.isInteger(delivery.status) && receiptId(delivery.requestId)) {
            receipt = { status: delivery.status, requestId: delivery.requestId };
          }
          if (reply) responseDescriptor = write(reply);
          result = providerResponse(delivery, stage, request, reply, parseJson, live);
          if (requestIds.has(result.requestId) || completionIds.has(result.completionId)) {
            throw new Error('Repeated provider request or completion identity');
          }
          requestIds.add(result.requestId);
          completionIds.add(result.completionId);
          if (stage === 'independent') independentGrade = readIndependentGrade(result.text, parseJson);
          retained = {
            provider: 'openai', model: request.body.model, requestId: result.requestId,
            request: requestDescriptor, response: responseDescriptor, output: write(Buffer.from(result.text)),
          };
          if (live) receipts[stage] = { ...receipt, completionId: result.completionId, usage: result.usage };
        } catch (error) {
          budget.fail(id);
          retainFailure();
          throw error;
        }
        try {
          budget.settle(id, result.usage);
        } catch (error) {
          retainFailure();
          throw error;
        }
        outputs[stage] = result.text;
        stages[stage] = retained;
      }
      const observation = { ...run, buildHash, sourceHash: sample.source.sha256, origin, stages, independentGrade };
      const log = write(Buffer.from(C.canonicalJson(live ? { ...observation, receipts } : observation)));
      observations.push({ ...observation, log });
    }
    return { diagnosticOnly: true, evaluationPassed: false, promotionEligible: false,
      providerCalls, fakeCalls: live ? 0 : bound.calls.length, planHash: bound.hash, observations, budget: budget.snapshot() };
  } finally {
    budget.close();
  }
}

// Trusted request builder and fake response bytes only. This entry point never dispatches.
function runObservedRehearsal(input) {
  if (!(input.fixtures instanceof Map)) return Promise.reject(new Error('Fake provider replies required'));
  return runBoundEvaluation(input, { origin: 'fixture', deliver: ({ id }) => input.fixtures.get(id) });
}

module.exports = { createObservedPlan, createImageRequestBuilder, replayImageResponse, runObservedRehearsal, runBoundEvaluation };
