'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require('./final-corpus-lib');
const { MAX_BYTES } = require('./maintenance-final-evidence');
const { lexicalPath, localPaths } = require('./maintenance-local-path');
const { sameLocalDirectory } = require('./maintenance-dependency-smoke-approval');
const { imageBridge } = require('./maintenance-observed-live');
const { countAnthropicInputTokens, parseUnambiguousJson, sendProviderBytes } = require('./maintenance-observed-live-transport');
const { prepareDependencySmokeCredentials } = require('./maintenance-dependency-smoke-credentials');

const PURPOSE = 'tos-guardian.maintenance-prompt-quality-live-approval.v1\n';
const KIND = 'maintenance-prompt-quality-live-approval';
const DAY_MS = 86_400_000;
const approvedExecutions = new WeakSet();
const PROVIDERS = ['anthropic', 'openai'];
const ARMS = ['baseline', 'candidate'];
const APPROVAL_FIELDS = [
  'v', 'kind', 'approvalId', 'planHash', 'maximumMicrodollars', 'reviewerRegistryHash',
  'preregistrationHash', 'accounts', 'billingEvidence', 'images', 'archiveLocations',
  'imageRuntime', 'outputDirectory', 'journalDirectory', 'issuedAt', 'expiresAt', 'hash',
];
const BUILDER_PATHS = [
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
];
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const canonical = C.canonicalJson;
const same = (left, right) => canonical(left) === canonical(right);
const copy = value => JSON.parse(canonical(value));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const parseJsonBytes = bytes => parseUnambiguousJson(
  new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
);
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const boundedBytes = (size, maximum) => Number.isSafeInteger(size) && size > 0 && size <= maximum;
const promptQualityApprovalMessage = payload => PURPOSE + canonical(payload);

function promptQualityLiveJournalDirectory() {
  return path.join(os.homedir(), 'AppData', 'Local', 'ToSGuardian', 'observed-prompt-quality-live');
}

function isApprovedPromptQualityExecution(execution) {
  return approvedExecutions.has(execution);
}

function requireCurrent(payload, billing) {
  const now = Date.now();
  const issued = Date.parse(payload.issuedAt);
  const expires = Date.parse(payload.expiresAt);
  if (!validDate(payload.issuedAt) || !validDate(payload.expiresAt) || issued > now ||
      expires <= now || expires - issued > DAY_MS) {
    throw new Error('Prompt-quality approval is expired, premature or exceeds 24 hours');
  }
  if (billing && (!validDate(billing.checkedAt) || Date.parse(billing.checkedAt) > issued ||
      now - Date.parse(billing.checkedAt) > DAY_MS)) {
    throw new Error('Prompt-quality billing evidence is stale or postdates approval');
  }
}

function verifySignature(approval, operatorTrust) {
  if (!exact(operatorTrust, ['ownerPublicKey']) || typeof operatorTrust.ownerPublicKey !== 'string' ||
      !exact(approval, ['payload', 'signature']) || !exact(approval.payload, APPROVAL_FIELDS)) {
    throw new Error('Signed prompt-quality approval and an independently supplied owner key are required');
  }
  const { payload, signature } = approval;
  const owner = crypto.createPublicKey(operatorTrust.ownerPublicKey);
  const bytes = Buffer.from(typeof signature === 'string' ? signature : '', 'base64');
  if (payload.v !== 1 || payload.kind !== KIND || C.bodyHash(payload) !== payload.hash ||
      owner.asymmetricKeyType !== 'ed25519' || bytes.length !== 64 || bytes.toString('base64') !== signature ||
      !crypto.verify(null, Buffer.from(promptQualityApprovalMessage(payload)), owner, bytes)) {
    throw new Error('Prompt-quality spending approval signature did not verify');
  }
  requireCurrent(payload);
  return owner;
}

function verifyBilling(payload, plan, attachments) {
  const { accounts, billingEvidence } = payload;
  if (!exact(accounts, PROVIDERS) || typeof accounts.anthropic !== 'string' || typeof accounts.openai !== 'string' ||
      !/^wrkspc_[A-Za-z0-9_-]{1,190}$/.test(accounts.anthropic) ||
      !/^proj_[A-Za-z0-9_-]{1,195}$/.test(accounts.openai)) {
    throw new Error('Prompt-quality approval requires both provider account IDs');
  }
  const bytes = attachments instanceof Map ? attachments.get(billingEvidence?.sha256) : undefined;
  if (!exact(billingEvidence, ['bytes', 'sha256']) || !C.isHash(billingEvidence.sha256) ||
      !boundedBytes(billingEvidence.bytes, MAX_BYTES) || !Buffer.isBuffer(bytes) ||
      bytes.length !== billingEvidence.bytes || sha(bytes) !== billingEvidence.sha256) {
    throw new Error('Approved prompt-quality billing attachment is missing or changed');
  }
  const billing = parseJsonBytes(bytes);
  if (!exact(billing, ['checkedAt', 'accounts', 'pricingHash', 'destinations', 'overheadMicrodollars']) ||
      !same(billing.accounts, accounts) || billing.pricingHash !== C.digest(plan.pricing) ||
      billing.overheadMicrodollars !== plan.overheadMicrodollars ||
      !same(billing.destinations, {
        anthropic: { serviceTier: 'standard', region: 'global' },
        openai: { serviceTier: 'standard' },
      })) {
    throw new Error('Prompt-quality billing must match the approved rates, accounts and standard service destinations');
  }
  requireCurrent(payload, billing);
  return billing;
}

function verifyRuntime(payload, plan, imageRuntime) {
  const images = ARMS.map(arm => plan.protocol.builds[arm].artifact);
  if (!same(payload.images, images) || new Set(images.map(image => image.sha256)).size !== 2 ||
      images.some(image => !exact(image, ['sha256', 'bytes', 'manifestDigest']) ||
        !C.isHash(image.sha256) || !boundedBytes(image.bytes, 1_000_000_000) ||
        typeof image.manifestDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(image.manifestDigest)) ||
      !exact(payload.archiveLocations, images.map(image => image.sha256))) {
    throw new Error('Prompt-quality approval must bind both exact image archive and manifest identities');
  }
  if (!exact(imageRuntime, ['umociPath', 'umociSha256', 'imageLauncherSha256', 'builderFiles']) ||
      !same(payload.imageRuntime, imageRuntime) || typeof imageRuntime.umociPath !== 'string' ||
      !/^\/[A-Za-z0-9_./-]+$/.test(imageRuntime.umociPath) ||
      imageRuntime.umociPath.split('/').some(part => part === '..' || part === '.') ||
      !C.isHash(imageRuntime.umociSha256) || !C.isHash(imageRuntime.imageLauncherSha256) ||
      !Array.isArray(imageRuntime.builderFiles) || imageRuntime.builderFiles.length !== BUILDER_PATHS.length ||
      !BUILDER_PATHS.every(file => imageRuntime.builderFiles.some(entry =>
        exact(entry, ['path', 'bytes', 'sha256']) && entry.path === file &&
        boundedBytes(entry.bytes, MAX_BYTES) && C.isHash(entry.sha256)))) {
    throw new Error('Prompt-quality approval requires the pinned image launcher, tool and builder inventory');
  }
}

function requireIndependentOwner(owner, protocol, reviewerRegistry) {
  const identity = key => sha(key.export({ type: 'spki', format: 'der' }));
  const ownerId = identity(owner);
  for (const reviewerId of Object.values(protocol.reviewers)) {
    const reviewer = crypto.createPublicKey(reviewerRegistry[reviewerId]?.publicKey);
    if (identity(reviewer) === ownerId) {
      throw new Error('Prompt-quality spending approval must use a key independent of all reviewer roles');
    }
  }
}

function checkedDestination(file) {
  if (typeof file !== 'string' || lexicalPath(file) !== file) {
    throw new Error('Prompt-quality destinations require exact canonical local paths');
  }
  const [checked] = localPaths([file]);
  if (fs.realpathSync.native(checked).toLowerCase() !== checked.toLowerCase()) {
    throw new Error('Prompt-quality destinations cannot use path aliases');
  }
  return checked;
}

function verifyDestinations(payload, options) {
  const journal = promptQualityLiveJournalDirectory();
  if (payload.journalDirectory !== journal || options.plan.journalDirectory !== journal ||
      payload.outputDirectory !== options.outputDirectory ||
      !same(payload.archiveLocations, options.archiveLocations)) {
    throw new Error('Prompt-quality approval does not match the fixed journal or signed destinations');
  }
  const output = checkedDestination(payload.outputDirectory);
  const ledger = checkedDestination(journal);
  const priorLedgers = ['observed-live', 'dependency-smoke-live'].map(name => path.join(path.dirname(ledger), name));
  const overlap = (left, right) => {
    const a = left.toLowerCase(), b = right.toLowerCase();
    return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
  };
  if (!fs.statSync(output).isDirectory() || fs.readdirSync(output).length !== 0 ||
      [ledger, ...priorLedgers].some(directory => overlap(output, directory)) ||
      !fs.statSync(ledger).isDirectory() || sameLocalDirectory(output, ledger) ||
      priorLedgers.some(directory => sameLocalDirectory(output, directory) || sameLocalDirectory(ledger, directory))) {
    throw new Error('Prompt-quality requires an empty output directory separate from spending journals');
  }
  for (const image of payload.images) {
    const archive = checkedDestination(payload.archiveLocations[image.sha256]);
    const stat = fs.statSync(archive);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== image.bytes ||
        [output, ledger, ...priorLedgers].some(directory => overlap(archive, directory))) {
      throw new Error('Prompt-quality requires separate, unaliased local image archives');
    }
  }
}

function verifyApproval(options, operatorTrust) {
  const { plan, approval, reviewerRegistry, preregistration, attachments, imageRuntime } = options;
  const owner = verifySignature(approval, operatorTrust);
  const { payload } = approval;
  if (payload.planHash !== plan?.hash || payload.approvalId !== plan.approvalId ||
      payload.maximumMicrodollars !== plan.limitMicrodollars ||
      payload.reviewerRegistryHash !== C.digest(reviewerRegistry) ||
      payload.preregistrationHash !== C.digest(preregistration)) {
    throw new Error('Prompt-quality approval does not match the plan or frozen reviewers');
  }
  if (plan.protocol?.mode !== 'observed') throw new Error('Live prompt quality requires an observed protocol');
  const billing = verifyBilling(payload, plan, attachments);
  verifyRuntime(payload, plan, imageRuntime);
  const { validatePromptQualityPlan, verifyPromptQualityPreregistration } = require('./maintenance-prompt-quality');
  validatePromptQualityPlan(plan, payload.planHash);
  verifyPromptQualityPreregistration({
    protocol: plan.protocol, preregistration, reviewerRegistry, attachments, now: new Date().toISOString(),
  });
  if (plan.protocol.v === 2) require('./maintenance-prompt-quality-runner').readSources(plan.protocol, attachments);
  if (preregistration.payload.observedAt > payload.issuedAt) {
    throw new Error('Prompt-quality preregistration postdates spending approval');
  }
  requireIndependentOwner(owner, plan.protocol, reviewerRegistry);
  verifyDestinations(payload, options);
  return { payload, billing };
}

function verifyPromptQualityLiveApproval(options, operatorTrust) {
  return copy(verifyApproval(options, operatorTrust).payload);
}

function credentialInJson(value, credentials) {
  if (typeof value === 'string') return credentials.some(credential => value.includes(credential));
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => credentialInJson(key, credentials) ||
    credentialInJson(child, credentials));
}

function hasCredential(bytes, credentials) {
  return credentials.some(credential => bytes.includes(credential));
}

function shapeForImage(bridge, payload, request) {
  const { artifact } = request.build;
  if (C.digest(request.build) !== request.buildHash || !payload.images.some(image => same(image, artifact))) {
    throw new Error('Prompt-quality build no longer matches the approved image');
  }
  // The existing helper accepts only bytes and SHA-256 in the build descriptor.
  // It independently checks the archive manifest during readiness and each shape.
  const build = { ...request.build, artifact: { bytes: artifact.bytes, sha256: artifact.sha256 } };
  return bridge.shapeOffline({ ...request, build, buildHash: C.digest(build) });
}

async function runPromptQualityLive(options, operatorTrust, credentialFiles) {
  const { attachments, ...jsonOptions } = options;
  const input = { ...copy(jsonOptions), attachments: attachments instanceof Map ?
    new Map([...attachments].map(([id, bytes]) => [id, Buffer.isBuffer(bytes) ? Buffer.from(bytes) : bytes])) : undefined };
  const { payload, billing } = verifyApproval(input, operatorTrust);
  const filePins = copy(credentialFiles);
  const { runBoundPromptQuality } = require('./maintenance-prompt-quality-runner');
  const providersByCall = new Map(input.plan.calls.map(({ id }) => [
    id, id.endsWith(':independent') ? 'openai' : id.split(':', 1)[0],
  ]));
  const bridge = imageBridge(input.imageRuntime, input, { ...payload, ...payload.imageRuntime });
  const inputCheck = input.plan.protocol.anthropicInputCheck;
  let readCredential;
  let execution;
  let checkedCall;
  const checkCurrent = () => requireCurrent(payload, billing);
  function checkRequest({ id, provider, bytes, sha256 }) {
    checkCurrent();
    if (!PROVIDERS.includes(provider) || providersByCall.get(id) !== provider ||
        !Buffer.isBuffer(bytes) || sha(bytes) !== sha256) {
      throw new Error('Prompt-quality delivery requires approved provider and verified request bytes');
    }
    readCredential ??= prepareDependencySmokeCredentials(filePins, payload.accounts);
    const credentials = PROVIDERS.map(name => readCredential({ provider: name, accountId: payload.accounts[name] }));
    if (hasCredential(bytes, credentials) || credentialInJson(parseJsonBytes(bytes), credentials)) {
      throw new Error('Credential-bearing prompt-quality request');
    }
    checkCurrent();
    return credentials;
  }

  async function checkAnthropicInput(call, credentials) {
    checkedCall = undefined;
    const { bytes, sha256, id } = call;
    const result = await countAnthropicInputTokens({
      bytes, credential: credentials[PROVIDERS.indexOf('anthropic')], accountId: payload.accounts.anthropic,
    });
    checkCurrent();
    if (!exact(result, ['inputTokens', 'requestId']) || !Number.isSafeInteger(result.inputTokens) ||
        result.inputTokens < 1 || typeof result.requestId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,200}$/.test(result.requestId) ||
        credentials.some(credential => result.requestId.includes(credential))) {
      throw new Error('Unsupported Anthropic input count receipt');
    }
    if (result.inputTokens <= inputCheck.maxEstimatedInputTokens) {
      checkedCall = { id, sha256 };
    }
    return result;
  }
  try {
    await bridge.ready();
    checkCurrent();
    verifyDestinations(payload, input);
    execution = {
      origin: 'captured-runtime',
      beforeReserve(call) {
        const credentials = checkRequest(call);
        if (inputCheck && call.provider === 'anthropic') return checkAnthropicInput(call, credentials);
      },
      async deliver(call) {
        const { provider, bytes } = call;
        const credentials = checkRequest(call);
        if (inputCheck && provider === 'anthropic') {
          const checked = checkedCall;
          checkedCall = undefined;
          if (checked?.id !== call.id || checked.sha256 !== call.sha256) {
            throw new Error('Anthropic delivery requires a matching unused input check');
          }
        }
        const receipt = await sendProviderBytes({
          provider, bytes, accountId: payload.accounts[provider], credential: credentials[PROVIDERS.indexOf(provider)],
        });
        if (receipt.requestId && credentials.some(credential => receipt.requestId.includes(credential))) {
          throw new Error('Credential-bearing prompt-quality response; charge unknown');
        }
        const opaqueReceipt = { status: receipt.status, requestId: receipt.requestId };
        if (hasCredential(receipt.response, credentials)) return opaqueReceipt;
        let containsCredential;
        try {
          containsCredential = receipt.response.length && credentialInJson(parseJsonBytes(receipt.response), credentials);
        } catch {
          return opaqueReceipt;
        }
        return containsCredential ? opaqueReceipt : receipt;
      },
    };
    approvedExecutions.add(execution);
    return await runBoundPromptQuality({
      ...input,
      approvedPlanHash: payload.planHash,
      now: new Date().toISOString(),
      shapeRequest: request => shapeForImage(bridge, payload, request),
      replayResponse: (digest, response) => bridge.replay(digest, response),
    }, execution);
  } finally {
    approvedExecutions.delete(execution);
    readCredential = undefined;
    await bridge.close();
  }
}

module.exports = {
  isApprovedPromptQualityExecution,
  promptQualityApprovalMessage,
  promptQualityLiveJournalDirectory,
  runPromptQualityLive,
  verifyPromptQualityLiveApproval,
};
