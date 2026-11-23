'use strict';

const crypto = require('node:crypto');
const C = require('./final-corpus-lib');
const { TESTS } = require('./maintenance-final-evidence');
const { classifyRelease } = require('./release-class-lib');
const { replayFixtures, requestBytes } = require('./release-class');
const { npmFindings, githubFindings, nextPage } = require('./dependency-advisories');
const { registryKeys, verifyManifest } = require('./dependency-review');
const { parseUnambiguousJson } = require('./maintenance-observed-live-transport');
const { readOpenAITextUsage } = require('./maintenance-openai-contract');
const { SECTIONS } = require('./jury-lib');
const { DEFAULT_SMOKE_CAP, CHECKPOINT_E_SMOKE_CAP, CHECKPOINT_E_RATES, CHECKPOINT_E_CONTEXT, CHECKPOINT_E_OUTPUT,
  isCheckpointEActivation } = require('./maintenance-dependency-smoke-policy');

const PHASE = 'maintenance-dependency';
const PURPOSE = 'tos-guardian.maintenance-dependency-observation.v1\n';
const PROVIDERS = Object.freeze(['anthropic', 'openai']);
const STAGES = ['analyzer', 'critic', 'judge', 'escalation'];
const SMOKE_STAGES = ['analyzer', 'critic'];
const SUMMARY_HEADINGS = ['BOTTOM LINE', 'RISK LEVEL', 'WHAT THEY COLLECT', 'DATA SELLING & SHARING',
  'OPT-OUT RIGHTS', 'HOW TO OPT OUT RIGHT NOW', 'AUTO-RENEWAL & BILLING', 'DATA DELETION RIGHTS'];
const CRITIC_VERDICTS = new Set(['grounded', 'unsupported', 'vague', 'skipped']);
const SPEC = ['mode', 'declaredAt', 'smokeSampleId', 'smokeCapMicros', 'rates', 'reviewers'];
const ROLES = ['execution', 'owner'];
const MAX_METADATA = 16 * 1024 * 1024;
const MAX_ATTACHMENT = 128 * 1024 * 1024;
const MAX_ARCHIVE = 256 * 1024 * 1024;
const MAX_TOTAL = 1024 * 1024 * 1024;
const GLOBAL_TYPES = ['reviewed', 'unreviewed', 'malware'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (left, right) => C.canonicalJson(left) === C.canonicalJson(right);
const hashBytes = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const integer = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => integer(value) && value > 0;
const timestamp = value => typeof value === 'string' && /^\d{4}-/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));
const json = bytes => parseUnambiguousJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));

function requireCondition(condition, message) {
  if (!condition) throw Error(message);
}

function sealed(value, label) {
  const errors = [];
  C.checkSeal(value, label, errors);
  requireCondition(!errors.length, errors[0]);
}

function observationMessage(payload) {
  return PURPOSE + C.canonicalJson(payload);
}

function descriptor(value) {
  return exact(value, ['sha256', 'bytes']) && C.isHash(value.sha256) && positive(value.bytes);
}

function evidenceBytes(attachments) {
  requireCondition(object(attachments), 'Retained evidence bytes required');
  const checked = new Map();
  let total = 0;
  return (hash, size = null, limit = MAX_ATTACHMENT) => {
    requireCondition(C.isHash(hash) && Object.hasOwn(attachments, hash), 'Missing retained evidence bytes');
    if (!checked.has(hash)) {
      const supplied = attachments[hash];
      requireCondition(Buffer.isBuffer(supplied) || typeof supplied === 'string', 'Evidence attachment must contain bytes');
      const bytes = Buffer.isBuffer(supplied) ? supplied : Buffer.from(supplied);
      requireCondition(bytes.length > 0 && bytes.length <= limit && total + bytes.length <= MAX_TOTAL,
        'Retained evidence exceeds size bounds');
      const snapshot = bytes.buffer instanceof SharedArrayBuffer ? Buffer.from(bytes) : bytes;
      requireCondition(hashBytes(snapshot) === hash, 'Retained evidence hash mismatch');
      total += snapshot.length;
      checked.set(hash, snapshot);
    }
    const bytes = checked.get(hash);
    requireCondition(bytes.length <= limit && (size === null || bytes.length === size), 'Retained evidence length mismatch');
    return bytes;
  };
}

function attachment(bytesFor, ref) {
  requireCondition(descriptor(ref), 'Invalid retained evidence descriptor');
  return bytesFor(ref.sha256, ref.bytes);
}

function validateCorpus(corpus) {
  requireCondition(Array.isArray(corpus) && corpus.length >= 6 && corpus.length <= 20, 'Held-out corpus required');
  const distinct = key => new Set(corpus.map(sample => key(sample))).size === corpus.length;
  requireCondition(corpus.every(sample => {
    if (!exact(sample, ['id', 'documentType', 'url', 'source']) || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(sample.id) ||
        !['terms-of-service', 'privacy-policy'].includes(sample.documentType) || !descriptor(sample.source) ||
        sample.source.bytes > 400_000 || typeof sample.url !== 'string') return false;
    const url = new URL(sample.url);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  }) && distinct(sample => sample.id) && distinct(sample => sample.url) && distinct(sample => sample.source.sha256) &&
    corpus.filter(sample => sample.documentType === 'terms-of-service').length === 4, 'Invalid or duplicate held-out corpus');
}

function createDependencyProtocol(classificationInput, classificationReport, spec) {
  const computed = classifyRelease(classificationInput);
  requireCondition(['D', 'E'].includes(computed.classification), 'Class Q cannot use maintenance-dependency evidence');
  sealed(classificationReport, 'Checkpoint A classification');
  const { hash, ...core } = computed;
  requireCondition(exact(classificationReport, [...Object.keys(core), 'hash', 'corpus', 'recordedProviders',
    'fixtureCoverage', 'comparisonScope']) &&
    Object.entries(core).every(([name, value]) => same(classificationReport[name], value)),
  'Checkpoint A report disagrees with recomputed classification');
  requireCondition(same(classificationReport.recordedProviders, PROVIDERS) && classificationReport.fixtureCoverage === true &&
    exact(classificationReport.comparisonScope, ['fixedPrior', 'request', 'response']) &&
    Object.values(classificationReport.comparisonScope).every(text), 'Complete Checkpoint A provider evidence required');
  const { corpus } = classificationReport;
  validateCorpus(corpus);
  const expected = corpus.flatMap(({ id }) => PROVIDERS.flatMap(provider => STAGES.map(stage => `${id}:${provider}:${stage}`))).sort();
  requireCondition(same(expected, computed.comparisons.requests.map(record => record.id)), 'Request evidence does not cover the preregistered corpus');
  const builds = { baseline: computed.baseline, candidate: computed.candidate };
  const sample = corpus.find(item => item.id === spec?.smokeSampleId);
  requireCondition(exact(spec, SPEC) && ['fixture', 'observed'].includes(spec.mode) && timestamp(spec.declaredAt) &&
    sample && positive(spec.smokeCapMicros) && exact(spec.reviewers, ROLES) && Object.values(spec.reviewers).every(identifier) &&
    spec.reviewers.execution !== spec.reviewers.owner && exact(spec.rates, PROVIDERS), 'Invalid dependency protocol');
  requireCondition(spec.smokeCapMicros <= DEFAULT_SMOKE_CAP ||
    (spec.smokeCapMicros === CHECKPOINT_E_SMOKE_CAP && spec.mode === 'observed' && computed.classification === 'E' &&
    same(spec.rates, CHECKPOINT_E_RATES) && isCheckpointEActivation({ builds, classificationHash: classificationReport.hash, sample })),
  'Smoke cap exceeds the approved release scope');
  for (const provider of PROVIDERS) {
    const rate = spec.rates[provider];
    requireCondition(exact(rate, ['model', 'responseModel', 'inputMicrodollarsPerMillion', 'outputMicrodollarsPerMillion']) &&
      text(rate.model) && text(rate.responseModel) && rate.model === classificationInput.candidate.release.config.policy.models[provider]?.default &&
      positive(rate.inputMicrodollarsPerMillion) && positive(rate.outputMicrodollarsPerMillion), 'Invalid smoke model or rate binding');
  }
  return C.seal({ v: 1, kind: 'maintenance-dependency-protocol', ...spec, corpus, providers: PROVIDERS,
    classification: computed.classification, classificationHash: classificationReport.hash,
    builds });
}

function trustKeys(protocol, registry) {
  requireCondition(object(registry), 'External reviewer registry required');
  const keys = Object.fromEntries(ROLES.map(role => {
    const id = protocol.reviewers[role];
    const entry = Object.hasOwn(registry, id) ? registry[id] : null;
    requireCondition(exact(entry, ['publicKey', 'roles']) && text(entry.publicKey) && Array.isArray(entry.roles) &&
      entry.roles.includes(role) && entry.roles.every(value => ROLES.includes(value)), `External trusted ${role} key required`);
    const key = crypto.createPublicKey(entry.publicKey);
    requireCondition(key.asymmetricKeyType === 'ed25519', 'Only Ed25519 evidence keys supported');
    return [role, key];
  }));
  const der = key => key.export({ type: 'spki', format: 'der' });
  requireCondition(!der(keys.execution).equals(der(keys.owner)), 'Owner and execution keys must be independent');
  return keys;
}

function signatureReader(protocol, keys, now) {
  return (envelope, role, kind, fields, earliest = protocol.declaredAt) => {
    requireCondition(exact(envelope, ['payload', 'signature']), `${kind}: signed envelope required`);
    const p = envelope.payload;
    requireCondition(exact(p, ['v', 'kind', 'protocolHash', 'reviewer', 'observedAt', ...fields, 'hash']) &&
      p.v === 1 && p.kind === kind && p.protocolHash === protocol.hash && p.reviewer === protocol.reviewers[role] &&
      timestamp(p.observedAt) && p.observedAt >= earliest && p.observedAt <= now, `${kind}: invalid or stale record`);
    sealed(p, kind);
    const signature = Buffer.from(typeof envelope.signature === 'string' ? envelope.signature : '', 'base64');
    requireCondition(signature.length === 64 && signature.toString('base64') === envelope.signature &&
      crypto.verify(null, Buffer.from(observationMessage(p)), keys[role], signature), `${kind}: signature failed`);
    return p;
  };
}

function checkEquivalence(report, bytesFor) {
  const { comparisons } = report;
  for (const item of comparisons.requests) {
    requireCondition(item.baseline === item.candidate, 'Retained provider requests differ');
    const raw = bytesFor(item.baseline);
    const recorded = json(raw);
    requireCondition(Array.isArray(recorded?.headers), 'Invalid retained provider request');
    const shaped = { ...recorded, headers: Object.fromEntries(recorded.headers) };
    requireCondition(requestBytes(shaped, item.id.split(':')[1]).equals(raw), 'Invalid retained provider request');
  }
  for (const item of comparisons.replays) {
    requireCondition(item.baseline === item.candidate, 'Retained outputs differ');
    bytesFor(item.baseline);
  }
  const replays = new Map(comparisons.replays.map(row => [row.id, row.baseline]));
  const fixtures = new Map(replayFixtures().map(row => [`${row.provider}:${row.id}`, hashBytes(row.body)]));
  for (const input of comparisons.replayInputs) {
    const payload = bytesFor(input.inputDigest);
    const result = json(bytesFor(replays.get(input.id)));
    requireCondition(exact(result, ['outcome', 'parsed', 'usage']), 'Invalid retained replay output');
    let outcome = result.outcome;
    if (input.origin === 'recorded') {
      const envelope = json(payload);
      requireCondition(identifier(envelope?.id) &&
        (input.id.startsWith('anthropic:') ? envelope.type === 'message' && Array.isArray(envelope.content)
          : envelope.object === 'chat.completion' && Array.isArray(envelope.choices)),
      'Recorded replay must retain a provider response');
      if (!text(result.parsed?.text) || Object.hasOwn(result.parsed, 'error')) outcome = 'provider-error';
    } else requireCondition(fixtures.get(input.id) === input.inputDigest, 'Synthetic replay input changed');
    requireCondition(input.outcomes.every(value => value === outcome), 'Replay outcome disagrees with retained result');
  }
}

function closeAdvisorySources(report, bytesFor) {
  const findings = new Map(report.versions.map(row => [row, []]));
  for (const check of report.sourceChecks) {
    if (check.source === 'npm-registry') continue;
    const data = json(bytesFor(check.sha256));
    if (check.source === 'npm') {
      const entry = report.versions.find(row => same(check.query, { [row.name]: [row.version] }));
      requireCondition(entry, 'Unexpected npm advisory query');
      findings.get(entry).push(...npmFindings(data, entry));
    } else {
      const url = new URL(check.route, 'https://api.github.com');
      const subset = check.source === 'github-global'
        ? report.versions.filter(row => url.searchParams.get('affects')?.split(',').includes(`${row.name}@${row.version}`))
        : report.versions.filter(row => url.pathname === `/repos/${row.repository}/security-advisories`);
      requireCondition(subset.length > 0, 'Unexpected GitHub advisory query');
      const next = nextPage(check.headers?.link, check.route);
      requireCondition(!next || report.sourceChecks.some(row => row.source === check.source && row.route === next),
        'Missing retained GitHub advisory page');
      for (const [entry, item] of githubFindings(data, subset, check.source)) findings.get(entry).push(item);
    }
  }
  for (const [entry, expected] of findings) {
    requireCondition(same(entry.advisories.filter(row => row.source !== 'supplemental'), expected),
      'Retained advisory responses disagree with Checkpoint B findings');
  }
}

function checkLockfileCoverage(review, measurement, bytesFor) {
  const arms = ['baseline', 'candidate'];
  const locks = arms.map(arm => {
    const value = json(bytesFor(review[arm].lockfileSha256));
    requireCondition(value?.lockfileVersion === 3 && object(value.packages), 'Verified npm v3 lockfiles required');
    return value.packages;
  });
  const packages = arms.map(arm => new Map(measurement[arm].inventory.packages.map(item => [item.path, item])));
  for (const [i, installed] of packages.entries()) {
    for (const [location, entry] of installed) {
      requireCondition(locks[i][location]?.version === entry.version, 'Installed package is absent from its verified lockfile');
    }
  }
  const rows = new Map(review.dependencies.map(row => [row.path, row]));
  const identity = entry => entry ? { version: entry.version, resolved: entry.resolved ?? null, integrity: entry.integrity ?? null } : null;
  const paths = new Set(locks.flatMap(lock => Object.keys(lock).filter(Boolean)));
  for (const location of paths) {
    if (!same(identity(locks[0][location]), identity(locks[1][location]))) {
      requireCondition(rows.has(location), 'Checkpoint B omits a changed lockfile dependency');
    }
  }
  for (const [location, row] of rows) {
    for (const [i, ref] of [row.before, row.after].entries()) {
      const locked = identity(locks[i][location]);
      const installed = packages[i].get(location);
      requireCondition(same(identity(ref), locked) && Boolean(ref?.installed) === Boolean(installed) &&
        (!installed || installed.version === ref.version && installed.name === ref.name),
      'Checkpoint B dependency disagrees with verified lockfile or installation');
    }
  }
}

function checkRegistryEvidence(review, bytesFor) {
  if (!review.versions.length) return;
  const keys = registryKeys(json(bytesFor(review.registryKeysSha256)));
  const packuments = new Map();
  for (const entry of review.versions) {
    if (!packuments.has(entry.packumentSha256)) {
      packuments.set(entry.packumentSha256, json(bytesFor(entry.packumentSha256)));
    }
    const verified = verifyManifest(packuments.get(entry.packumentSha256), entry, keys);
    const archive = bytesFor(entry.tarballSha256);
    const actual = 'sha512-' + crypto.createHash('sha512').update(archive).digest('base64');
    requireCondition(actual === entry.integrity && verified.integrity === entry.integrity &&
      verified.published === entry.published && same(verified.signerKeyIds, entry.signerKeyIds),
    'Checkpoint B tarball, signature or metadata changed');
  }
}

function checkSourceCoverage(report, bytesFor) {
  requireCondition(Array.isArray(report.sourceChecks) && report.sourceChecks.length <= 2000, 'Dependency source checks required');
  for (const check of report.sourceChecks) {
    requireCondition(check.status === 'complete' && check.httpStatus === 200 &&
      ['npm-registry', 'npm', 'github-global', 'github-repository'].includes(check.source) && text(check.route),
    'Dependency source coverage incomplete');
    bytesFor(check.sha256);
  }
  const has = (source, predicate) => report.sourceChecks.some(row => row.source === source && predicate(row));
  if (report.versions.length) requireCondition(has('npm-registry', row =>
    row.route === '/-/npm/v1/keys' && row.sha256 === report.registryKeysSha256), 'Registry signing keys missing');
  for (const entry of report.versions) {
    const { name, version, repository } = entry;
    const id = `${name}@${version}`;
    requireCondition(text(name) && text(version) && typeof repository === 'string' &&
      /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/.test(repository) &&
      has('npm-registry', row => row.route === '/' + encodeURIComponent(name) && row.sha256 === entry.packumentSha256) &&
      has('npm-registry', row => row.route === `/${name}/-/${name.split('/').at(-1)}-${version}.tgz` &&
        row.sha256 === entry.tarballSha256) &&
      has('npm', row => row.route === '/-/npm/v1/security/advisories/bulk' && row.query &&
        same(row.query, { [name]: [version] })) &&
      GLOBAL_TYPES.every(type => has('github-global', row => {
        if (!row.route.startsWith('/advisories?')) return false;
        const query = new URLSearchParams(row.route.split('?')[1]);
        return query.get('ecosystem') === 'npm' && query.get('type') === type && query.get('affects')?.split(',').includes(id);
      })) &&
      has('github-repository', row => row.route.startsWith(`/repos/${repository}/security-advisories?`) &&
        new URLSearchParams(row.route.split('?')[1]).get('state') === 'published'), `Missing advisory or registry coverage for ${id}`);
  }
}

function checkDependencyReport(review, report, measurement, bytesFor, verificationTime) {
  sealed(review, 'Checkpoint B dependency review');
  requireCondition(review.v === 2 && review.kind === 'dependency-review' && review.classificationHash === report.hash &&
    ['activation', 'recovery'].includes(review.pair) && timestamp(review.measuredAt) && review.measuredAt <= verificationTime &&
    review.status === 'awaiting-owner-review' && review.promotionEligible === false && Array.isArray(review.blockers) &&
    !review.blockers.length && review.registry === 'https://registry.npmjs.org' &&
    Array.isArray(review.dependencies) && Array.isArray(review.versions), 'Checkpoint B is incomplete, stopped or stale');
  for (const arm of ['baseline', 'candidate']) {
    requireCondition(same(review[arm].image, report[arm].image) &&
      review[arm].lockfileSha256 === measurement[arm].inventory.files.find(file => file.path === 'package-lock.json')?.sha256 &&
      C.isHash(review[arm].lockfileSha256), 'Checkpoint B image or lockfile binding changed');
  }
  checkSourceCoverage(review, bytesFor);
  checkLockfileCoverage(review, measurement, bytesFor);
  const entries = new Map(review.versions.map(entry => [`${entry.name}@${entry.version}`, entry]));
  requireCondition(entries.size === review.versions.length && review.versions.every(entry => Array.isArray(entry.advisories) &&
    Array.isArray(entry.signerKeyIds) && entry.signerKeyIds.length > 0 && object(entry.scripts) &&
    positive(entry.fileCount) && C.isHash(entry.fileTreeSha256)), 'Invalid reviewed dependency versions');
  const observed = [];
  const accepted = [];
  const seen = new Set();
  const usedVersions = new Set();
  for (const row of review.dependencies) {
    requireCondition(text(row.path) && !seen.has(row.path) && (row.before || row.after), 'Invalid dependency change');
    seen.add(row.path);
    const references = [row.before, row.after].map(entry => {
      if (!entry) return null;
      const id = `${entry.name}@${entry.version}`;
      const known = entries.get(id);
      requireCondition(known && entry.integrity === known.integrity && (!entry.installed || same(entry.installed, {
        fileCount: known.fileCount, fileTreeSha256: known.fileTreeSha256,
      })), 'Unverified dependency content or metadata');
      usedVersions.add(id);
      return known;
    });
    const [previous, next] = references;
    const project = entry => entry?.installed ? { name: entry.name, version: entry.version, path: row.path } : null;
    const before = project(row.before), after = project(row.after);
    if (!same(before, after)) observed.push({ path: row.path, baseline: before, candidate: after,
      change: !before ? 'added' : !after ? 'removed' : 'changed' });
    const scriptChange = !same(previous?.scripts ?? {}, next?.scripts ?? {});
    requireCondition(row.scriptChange === scriptChange && !(after && (scriptChange || !before) &&
      Object.keys(next.scripts).length), 'Unresolved install-time script changes');
    const ids = (entry, active) => [...new Set((active ? entry?.advisories ?? [] : []).map(item => {
      requireCondition(typeof item.id === 'string' && /^[A-Za-z0-9:-]{1,128}$/.test(item.id), 'Invalid advisory ID');
      return item.id;
    }))].sort();
    const oldIds = ids(previous, before || (!before && !after));
    const newIds = ids(next, after || (!before && !after));
    const introduced = newIds.filter(id => !oldIds.includes(id));
    const resolved = oldIds.filter(id => !newIds.includes(id));
    const carried = newIds.filter(id => oldIds.includes(id));
    requireCondition(same(row.introducedAdvisories, introduced) && same(row.resolvedAdvisories, resolved) &&
      same(row.carriedAdvisories, carried) && !(after && introduced.length), 'Unresolved or inconsistent dependency advisories');
    if (after) accepted.push(...carried.map(id => `${row.path}:${id}`));
  }
  requireCondition(same(observed, report.packageDiff) && usedVersions.size === entries.size, 'Checkpoint B dependency graph coverage changed');
  closeAdvisorySources(review, bytesFor);
  checkRegistryEvidence(review, bytesFor);
  return accepted.sort();
}

function verifySmokeOutput(name, output, responseText) {
  if (name === 'analyzer') {
    requireCondition(exact(output, ['summary']) && output.summary === responseText,
      'Smoke output disagrees with retained response');
    const lines = output.summary.split(/\r?\n/).map(line => line.replace(/[^\p{L}\p{N}& -]/gu, '').trim().toUpperCase());
    requireCondition(SUMMARY_HEADINGS.every(heading => lines.includes(heading)), 'Smoke analyzer summary is incomplete');
    return;
  }
  const fence = String.fromCharCode(96).repeat(3);
  const trimmed = responseText.trim();
  const content = trimmed.startsWith(fence) && trimmed.endsWith(fence)
    ? trimmed.slice(fence.length, -fence.length).replace(/^json\s+/i, '').trim() : trimmed;
  requireCondition(same(output, parseUnambiguousJson(content)), 'Smoke output disagrees with retained response');
  requireCondition(exact(output, [...SECTIONS, 'flags']) && SECTIONS.every(section => CRITIC_VERDICTS.has(output[section])) &&
    Array.isArray(output.flags) && output.flags.every(text), 'Smoke critic response is incomplete');
}

function verifySmokeStage(provider, name, stage, rate, bytesFor, usedIds, startedAt, observedAt, fullContext = false) {
  requireCondition(exact(stage, ['model', 'requestId', 'request', 'response', 'output', 'usage', 'costMicros']) &&
    stage.model === rate.model && identifier(stage.requestId) && !usedIds.has(stage.requestId), 'Invalid or repeated smoke request');
  usedIds.add(stage.requestId);
  const request = json(attachment(bytesFor, stage.request));
  const response = json(attachment(bytesFor, stage.response));
  const output = json(attachment(bytesFor, stage.output));
  requireCondition(request?.model === rate.model && positive(request.max_tokens) && request.stream !== true &&
    !Object.hasOwn(request, 'tools') && response?.model === rate.responseModel && identifier(response.id) &&
    !usedIds.has(response.id) && object(output) && Object.keys(output).length > 0, 'Smoke request, response or output mismatch');
  requireCondition(!fullContext || request.max_tokens === CHECKPOINT_E_OUTPUT[name], 'Checkpoint E smoke output cap changed');
  usedIds.add(response.id);
  let usage, responseText;
  if (provider === 'openai') {
    const choice = response.choices?.[0];
    requireCondition(response.object === 'chat.completion' && response.choices.length === 1 &&
      choice.finish_reason === 'stop' && choice.message?.role === 'assistant' && text(choice.message.content) &&
      !choice.message.refusal && !choice.message.tool_calls && [undefined, 'default', 'standard'].includes(response.service_tier) &&
      integer(response.created) && response.created >= Math.floor(Date.parse(startedAt) / 1000) &&
      response.created <= Math.floor(Date.parse(observedAt) / 1000),
    'Unsuccessful or unsupported OpenAI smoke response');
    usage = readOpenAITextUsage(response.usage, request.max_tokens, { requireCachedTokens: false });
    responseText = choice.message.content;
    requireCondition(usage.cacheReadTokens === 0 && usage.cacheWriteTokens === 0, 'Unsupported cached smoke usage');
  } else {
    const tokens = response.usage;
    const allowed = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens',
      'cache_creation', 'service_tier'];
    requireCondition(response.type === 'message' && response.role === 'assistant' && response.stop_reason === 'end_turn' &&
      Array.isArray(response.content) && response.content.length > 0 &&
      response.content.every(block => block.type === 'text' && text(block.text)) && object(tokens) &&
      Object.keys(tokens).every(key => allowed.includes(key)) && positive(tokens.input_tokens) &&
      positive(tokens.output_tokens) && tokens.output_tokens <= request.max_tokens &&
      [undefined, 0].includes(tokens.cache_creation_input_tokens) && [undefined, 0].includes(tokens.cache_read_input_tokens) &&
      (tokens.cache_creation == null || exact(tokens.cache_creation, ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens']) &&
        Object.values(tokens.cache_creation).every(count => count === 0)) &&
      [undefined, 'standard'].includes(tokens.service_tier), 'Unsuccessful or unsupported Anthropic smoke response');
    usage = { inputTokens: tokens.input_tokens, outputTokens: tokens.output_tokens };
    responseText = response.content.map(block => block.text).join('');
  }
  verifySmokeOutput(name, output, responseText);
  const normalized = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
  requireCondition(!fullContext || normalized.inputTokens <= CHECKPOINT_E_CONTEXT[provider], 'Checkpoint E smoke input exceeds reserved context');
  const charge = (tokens, ratePerMillion) => (BigInt(tokens) * BigInt(ratePerMillion) + 999999n) / 1000000n;
  const cost = charge(normalized.inputTokens, rate.inputMicrodollarsPerMillion) +
    charge(normalized.outputTokens, rate.outputMicrodollarsPerMillion);
  requireCondition(positive(normalized.inputTokens) && positive(normalized.outputTokens) && same(stage.usage, normalized) &&
    positive(stage.costMicros) && cost === BigInt(stage.costMicros), 'Smoke usage or computed cost disagrees with receipt');
  return cost;
}

function checkExecution(protocol, evidence, signed, bytesFor, earliest) {
  const expectedHash = protocol.builds.candidate.image.sha256;
  requireCondition(Array.isArray(evidence.tests) && evidence.tests.length === TESTS.length &&
    Array.isArray(evidence.smokes) && evidence.smokes.length === PROVIDERS.length, 'Required candidate tests or smokes missing');
  const ids = new Set();
  for (const envelope of evidence.tests) {
    const p = signed(envelope, 'execution', 'full-test', ['id', 'imageSha256', 'command', 'exitCode', 'passed', 'failed',
      'skipped', 'outcome', 'log'], earliest);
    requireCondition(TESTS.includes(p.id) && !ids.has(p.id) && p.imageSha256 === expectedHash && text(p.command) &&
      p.exitCode === 0 && positive(p.passed) && p.failed === 0 && p.skipped === 0 && p.outcome === 'pass',
    'Candidate test failed, skipped, duplicated or has a stale image');
    ids.add(p.id);
    attachment(bytesFor, p.log);
  }
  const providers = new Set();
  const usedIds = new Set();
  let total = 0n;
  for (const envelope of evidence.smokes) {
    const p = signed(envelope, 'execution', 'smoke',
      ['provider', 'sampleId', 'imageSha256', 'outcome', 'origin', 'attemptCount', 'stages', 'log'], earliest);
    requireCondition(PROVIDERS.includes(p.provider) && !providers.has(p.provider) && p.imageSha256 === expectedHash &&
      p.sampleId === protocol.smokeSampleId && p.outcome === 'pass' && p.attemptCount === 1 && exact(p.stages, SMOKE_STAGES) &&
      p.origin === (protocol.mode === 'observed' ? 'captured-runtime' : 'fixture'), 'Failed, duplicate or stale smoke');
    providers.add(p.provider);
    attachment(bytesFor, p.log);
    for (const stage of SMOKE_STAGES) {
      total += verifySmokeStage(p.provider, stage, p.stages[stage], protocol.rates[p.provider], bytesFor, usedIds,
        earliest, p.observedAt, protocol.smokeCapMicros === CHECKPOINT_E_SMOKE_CAP);
    }
  }
  requireCondition(total <= BigInt(protocol.smokeCapMicros), 'Total smoke cost exceeds approved cap');
  return Number(total);
}

function validateDependencyEvidence(protocol, evidence, context = {}) {
  const reasons = [];
  let totalSmokeMicros = null, validated = null;
  try {
    requireCondition(exact(context, ['attachments', 'trustedReviewers', 'trustedRates', 'now']) && timestamp(context.now),
      'External evidence trust and verification time required');
    sealed(protocol, 'dependency protocol');
    sealed(evidence, 'dependency evidence');
    requireCondition(exact(evidence, ['v', 'kind', 'protocolHash', 'classificationInput', 'classificationReport',
      'preregistration', 'equivalence', 'dependencyReport', 'dependencyReview', 'codeReview', 'tests', 'smokes', 'hash']) &&
      evidence.kind === 'maintenance-dependency-evidence' && evidence.v === 1 && evidence.protocolHash === protocol.hash &&
      Buffer.byteLength(C.canonicalJson(evidence)) <= MAX_METADATA, 'Invalid or stale maintenance dependency package');
    const { classificationInput, classificationReport } = evidence;
    const expected = createDependencyProtocol(classificationInput, classificationReport,
      Object.fromEntries(SPEC.map(key => [key, protocol[key]])));
    requireCondition(same(protocol, expected) && protocol.declaredAt <= context.now && same(protocol.rates, context.trustedRates),
      'Dependency protocol changed or lacks externally trusted rates');
    const signed = signatureReader(protocol, trustKeys(protocol, context.trustedReviewers), context.now);
    const bytesFor = evidenceBytes(context.attachments);
    for (const { image } of Object.values(protocol.builds)) bytesFor(image.sha256, image.bytes, MAX_ARCHIVE);
    for (const sample of protocol.corpus) attachment(bytesFor, sample.source);
    const prereg = signed(evidence.preregistration, 'owner', 'preregistration', ['outcome', 'attachment']);
    requireCondition(prereg.outcome === 'pass', 'Owner preregistration approval required');
    attachment(bytesFor, prereg.attachment);
    const equivalence = signed(evidence.equivalence, 'execution', 'equivalence',
      ['measurementHash', 'reportHash', 'outcome'], prereg.observedAt);
    requireCondition(equivalence.measurementHash === C.digest(classificationInput) &&
      equivalence.reportHash === classificationReport.hash && equivalence.outcome === 'pass', 'Equivalence attestation mismatch');
    checkEquivalence(classificationReport, bytesFor);
    const dependency = signed(evidence.dependencyReview, 'owner', 'dependency-review',
      ['reportHash', 'acceptedAdvisories', 'outcome', 'attachment'], equivalence.observedAt);
    const accepted = checkDependencyReport(evidence.dependencyReport, classificationReport, classificationInput, bytesFor,
      dependency.observedAt);
    requireCondition(dependency.reportHash === evidence.dependencyReport.hash && dependency.outcome === 'pass' &&
      same(dependency.acceptedAdvisories, accepted), 'Owner dependency review or carried advisory acceptance missing');
    attachment(bytesFor, dependency.attachment);
    if (protocol.classification === 'E') {
      const code = signed(evidence.codeReview, 'owner', 'code-review',
        ['reportHash', 'outcome', 'attachment'], equivalence.observedAt);
      requireCondition(code.reportHash === classificationReport.hash && code.outcome === 'pass', 'Class E code review failed or stale');
      attachment(bytesFor, code.attachment);
    } else requireCondition(evidence.codeReview === null, 'Unexpected Class D code review');
    totalSmokeMicros = checkExecution(protocol, evidence, signed, bytesFor, prereg.observedAt);
    validated = expected;
  } catch (error) {
    reasons.push(error.message);
  }
  const eligible = validated?.mode === 'observed';
  return Object.freeze(C.seal({ v: 1, kind: 'maintenance-dependency-report', phase: PHASE,
    mode: validated?.mode ?? null, protocolHash: validated?.hash ?? null,
    corpusHash: validated ? C.digest(validated.corpus) : null,
    baselineConfigHash: validated?.builds.baseline.configHash ?? null,
    configHash: validated?.builds.candidate.configHash ?? null,
    baselineArtifactHash: validated?.builds.baseline.image.sha256 ?? null,
    candidateArtifactHash: validated?.builds.candidate.image.sha256 ?? null,
    class: validated?.classification ?? null, inputEvidenceHash: validated ? evidence.hash : null,
    totalSmokeMicros, contractSatisfied: Boolean(validated), diagnosticOnly: !eligible,
    evaluationPassed: eligible, promotionEligible: eligible, reasons,
    limitations: ['Signatures attest observations. The offline verifier cannot prove provider origin or detect unreported calls.'],
  }));
}

function authorizationEvidence(report) {
  sealed(report, 'maintenance dependency report');
  requireCondition(report.kind === 'maintenance-dependency-report' && report.phase === PHASE &&
    report.mode === 'observed' && report.contractSatisfied === true && report.evaluationPassed === true &&
    report.promotionEligible === true && report.diagnosticOnly === false, 'Complete observed dependency evidence required');
  return Object.freeze({ phase: PHASE, configHash: report.configHash, evidenceHash: report.hash,
    protocolHash: report.protocolHash, corpusHash: report.corpusHash, evaluationPassed: true,
    promotionEligible: true, diagnosticOnly: false });
}

module.exports = { TESTS, PROVIDERS, createDependencyProtocol, validateDependencyEvidence, authorizationEvidence, observationMessage, verifySmokeStage };
