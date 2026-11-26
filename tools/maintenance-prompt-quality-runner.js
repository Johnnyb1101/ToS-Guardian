'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const C = require('./final-corpus-lib');
const { localPaths } = require('./maintenance-local-path');
const { sameLocalDirectory } = require('./maintenance-dependency-smoke-approval');
const { openObservedBudget } = require('./maintenance-observed-budget');
const { isApprovedPromptQualityExecution, promptQualityLiveJournalDirectory } = require('./maintenance-prompt-quality-live');
const {
  STAGES, validatePromptQualityPlan, verifyPromptQualityPreregistration, readQualityAttachment, promptQualityCallId,
} = require('./maintenance-prompt-quality');
const {
  independentRequest, validateQualityRequest, readQualityResponse, readIndependentGrade, checkAnalyzerHeadings,
  MAX_RESPONSE_BYTES,
} = require('./maintenance-prompt-quality-provider');

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const utf8 = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const encode = value => Buffer.from(C.canonicalJson(value));
const receiptId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

function protectJournals(output, journal, live) {
  const liveJournal = promptQualityLiveJournalDirectory();
  const parent = path.dirname(liveJournal);
  const protectedRoots = [liveJournal, path.join(parent, 'observed-live'), path.join(parent, 'dependency-smoke-live')];
  const overlaps = (directory, root) => {
    // Resolve short names as well as case variations on the ordinary local
    // paths that localPaths has already checked for reparse points.
    const actual = fs.realpathSync.native(directory).toLowerCase();
    const resolvedRoot = fs.existsSync(root) ? fs.realpathSync.native(root) : root;
    const fixed = resolvedRoot.toLowerCase();
    return actual === fixed || actual.startsWith(fixed + path.sep) || fixed.startsWith(actual + path.sep);
  };
  requireThat(protectedRoots.every(root => !overlaps(output, root)) &&
    (live ? journal === liveJournal : protectedRoots.every(root => !overlaps(journal, root))),
  'Evaluation destinations must be separate from protected live journals');
}

async function verifyArchives(builds, archiveLocations, outputDirectory, journalDirectory, live) {
  const artifacts = Object.values(builds).map(build => build.artifact);
  const [output, journal, ...archives] = localPaths([
    outputDirectory, journalDirectory, ...artifacts.map(artifact => archiveLocations?.[artifact.sha256]),
  ]);
  requireThat(fs.statSync(output).isDirectory() && !sameLocalDirectory(output, journal),
    'Evaluation output must be an existing directory distinct from the budget journal');
  protectJournals(output, journal, live);
  for (const [index, file] of archives.entries()) {
    const descriptor = artifacts[index];
    const stat = fs.statSync(file);
    requireThat(stat.isFile() && stat.size === descriptor.bytes, 'Evaluation archive size changed');
    const hash = crypto.createHash('sha256');
    let size = 0;
    for await (const chunk of fs.createReadStream(file)) {
      size += chunk.length;
      requireThat(size <= descriptor.bytes, 'Evaluation archive size changed while reading');
      hash.update(chunk);
    }
    requireThat(size === descriptor.bytes && hash.digest('hex') === descriptor.sha256,
      'Evaluation archive bytes changed');
  }
  return output;
}

function openEvidence(output) {
  requireThat(fs.readdirSync(output).length === 0, 'An empty evaluation output directory is required');
  const directory = path.join(output, 'evidence');
  fs.mkdirSync(directory); // Reserve the destination before creating any evidence.
  return bytes => {
    const sha256 = sha(bytes);
    const file = path.join(directory, sha256);
    if (fs.existsSync(file)) {
      requireThat(fs.lstatSync(file).isFile() && fs.readFileSync(file).equals(bytes), 'Retained evaluation evidence changed');
    } else {
      const fd = fs.openSync(file, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    return { sha256, bytes: bytes.length };
  };
}

function inputText(attachments, descriptor, label) {
  const text = utf8(readQualityAttachment(attachments, descriptor, label));
  requireThat(text.trim().length > 0 && !text.includes('\0') && text.isWellFormed(), 'Invalid evaluation ' + label + ' text');
  return text;
}

function callScope(run, stage, build, protocol, pricing) {
  if (stage === 'independent') {
    return { provider: 'openai', stage, model: protocol.independentJudge.model, pricing: pricing.independent };
  }
  const model = build.release.config.policy.models[run.provider][stage === 'judge' ? 'jury' : 'default'];
  return { provider: run.provider, stage, model, pricing: pricing[run.provider][stage] };
}

async function verifyImageReplay(replayResponse, build, call, result) {
  const replay = await replayResponse(build.artifact.sha256, { provider: call.provider, body: result.body });
  const usage = replay?.usage;
  requireThat(['parsed', 'fenced-json'].includes(replay?.outcome) && replay.parsed?.text === result.text &&
    usage && usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens === result.usage.inputTokens &&
    usage.outputTokens === result.usage.outputTokens, 'Evaluation response disagrees with the pinned runtime');
}

// The live supervisor supplies the only production transport. The fixture entry
// point below gets responses from a local map and never opens credentials.
async function runBoundPromptQuality({ plan, approvedPlanHash, preregistration, reviewerRegistry, now, attachments,
  archiveLocations, outputDirectory, shapeRequest, replayResponse }, execution) {
  const { origin, deliver, beforeReserve = () => {} } = execution;
  const bound = validatePromptQualityPlan(plan, approvedPlanHash);
  const { protocol } = bound;
  const live = origin === 'captured-runtime';
  requireThat((origin === 'fixture' || (live && protocol.mode === 'observed' && isApprovedPromptQualityExecution(execution))) &&
    typeof deliver === 'function' &&
    typeof shapeRequest === 'function' && typeof replayResponse === 'function', 'Trusted evaluation executor required');
  verifyPromptQualityPreregistration({ protocol, preregistration, reviewerRegistry, attachments, now });
  const sources = new Map(protocol.corpus.samples.map(sample => [sample.id, {
    ...sample, text: inputText(attachments, sample.source, 'source'),
  }]));
  const rubric = inputText(attachments, protocol.rubric, 'rubric');
  const judgePrompt = inputText(attachments, protocol.independentJudge.prompt, 'independent judge prompt');
  const output = await verifyArchives(protocol.builds, archiveLocations, outputDirectory, bound.journalDirectory, live);
  const budget = openObservedBudget(bound.journalDirectory, bound.budget);
  let deliveries = 0;
  try {
    requireThat(budget.snapshot().attempts.length === 0, 'Evaluation already attempted under this approval');
    const keep = openEvidence(output);
    const observations = [];
    const responseIds = new Set();
    const requestIds = new Set();
    for (const run of bound.runs) {
      const sample = sources.get(run.sampleId);
      const build = protocol.builds[run.arm];
      const buildHash = C.digest(build);
      const stages = {};
      let summary, headingCheck, independentGrade;
      for (const stage of STAGES) {
        const call = callScope(run, stage, build, protocol, bound.pricing);
        const id = promptQualityCallId(run, stage);
        const request = stage === 'independent'
          ? independentRequest(call.model, call.pricing.maxOutputTokens, judgePrompt, sample.text, rubric, summary)
          : await shapeRequest({
            provider: run.provider, stage, build: structuredClone(build), buildHash,
            sourceUrl: sample.provenance.url, sourceText: sample.text, sourceHash: sample.source.sha256,
            prior: stage === 'analyzer' ? null : summary,
          });
        const { capture, bytes } = validateQualityRequest(request, call);
        beforeReserve({ id, provider: call.provider, bytes: Buffer.from(bytes), sha256: sha(bytes) });
        const captureRef = keep(capture);
        const requestRef = keep(bytes);
        budget.reserve(id, requestRef.sha256);
        let response, receipt, result;
        function retainFailure(accounting) {
          keep(encode({ kind: 'prompt-quality-failed-call', planHash: bound.hash, origin, callId: id,
            provider: call.provider, request: requestRef, capture: captureRef, response: response ?? null,
            receipt: receipt ?? null, accounting }));
        }
        try {
          deliveries++;
          const delivery = await deliver({ id, provider: call.provider, bytes, sha256: requestRef.sha256 });
          if (Number.isInteger(delivery?.status) && receiptId(delivery.requestId)) {
            receipt = { status: delivery.status, requestId: delivery.requestId };
          }
          if (Buffer.isBuffer(delivery?.response) && delivery.response.length > 0 && delivery.response.length <= MAX_RESPONSE_BYTES) {
            response = keep(delivery.response);
          }
          result = readQualityResponse(delivery, call);
          const requestId = call.provider + ':' + result.requestId;
          const completionId = call.provider + ':' + result.completionId;
          requireThat(!requestIds.has(requestId) && !responseIds.has(completionId), 'Repeated provider receipt identity');
          requestIds.add(requestId);
          responseIds.add(completionId);
        } catch (error) {
          try { budget.fail(id); } finally { retainFailure('unknown-cost'); }
          throw error;
        }
        try {
          budget.settle(id, result.usage);
        } catch (error) {
          retainFailure('settlement-unconfirmed');
          throw error;
        }
        try {
          if (stage !== 'independent') await verifyImageReplay(replayResponse, build, call, result);
          if (stage === 'independent') independentGrade = readIndependentGrade(result.text);
          const observation = { provider: call.provider, model: call.model, responseModel: call.pricing.responseModel,
            capture: captureRef, request: requestRef, response, output: keep(Buffer.from(result.text)), receipt, usage: result.usage };
          stages[stage] = { ...observation, log: keep(encode({
            kind: 'prompt-quality-completed-call', planHash: bound.hash, origin, callId: id, ...observation,
          })) };
        } catch (error) {
          retainFailure('settled');
          throw error;
        }
        if (stage === 'analyzer') {
          summary = result.text;
          headingCheck = checkAnalyzerHeadings(summary);
        }
      }
      const observation = { ...run, origin, buildHash, sourceHash: sample.source.sha256, stages, headingCheck, independentGrade };
      observations.push({ ...observation, log: keep(encode(observation)) });
    }

    const report = C.seal({
      v: 1, kind: 'maintenance-prompt-quality-run-report', phase: 'prompt-quality-evaluation',
      diagnosticOnly: true, promotionEligible: false, evaluationPassed: false,
      origin, planHash: bound.hash, protocolHash: protocol.hash,
      providerCalls: live ? deliveries : 0, fixtureDeliveries: live ? 0 : deliveries,
      observations, budget: budget.snapshot(),
    });
    fs.writeFileSync(path.join(output, 'prompt-quality-run.json'), encode(report), { flag: 'wx', mode: 0o600 });
    return report;
  } finally {
    budget.close();
  }
}

function runPromptQualityRehearsal(input) {
  if (!(input.fixtures instanceof Map)) return Promise.reject(new Error('Local evaluation response fixtures required'));
  return runBoundPromptQuality(input, { origin: 'fixture', deliver: ({ id }) => input.fixtures.get(id) });
}

module.exports = { runBoundPromptQuality, runPromptQualityRehearsal };
