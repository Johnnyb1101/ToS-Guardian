'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const C = require('./final-corpus-lib');
const { MAX_BYTES } = require('./maintenance-final-evidence');
const { localPath } = require('./maintenance-local-path');
const { runBoundEvaluation } = require('./maintenance-observed-runner');
const transport = require('./maintenance-observed-live-transport');

const PURPOSE = 'tos-guardian.maintenance-observed-live-approval.v1\n';
const bootstrapImageHelper = [
  'import base64, hashlib, pathlib, runpy, sys, tempfile',
  'source = base64.b64decode(sys.stdin.buffer.readline(200001).strip(), validate=True)',
  'if len(source) > 150000 or hashlib.sha256(source).hexdigest() != sys.argv[1]:',
  '    raise SystemExit("Image helper identity mismatch")',
  'with tempfile.TemporaryDirectory(prefix="tos-observed-launcher-", dir="/var/tmp") as root:',
  '    launcher = pathlib.Path(root) / "image-helper.py"',
  '    launcher.write_bytes(source)',
  '    sys.argv = [str(launcher)]',
  '    runpy.run_path(str(launcher), run_name="__main__")',
].join('\n');
const approvalFields = [
  'v', 'kind', 'approvalId', 'planHash', 'projectId', 'reviewerRegistryHash', 'preregistrationsHash',
  'billingEvidence', 'maximumMicrodollars', 'images', 'umociSha256', 'imageLauncherSha256',
  'builderFiles', 'outputDirectory', 'issuedAt', 'expiresAt', 'hash',
];
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const copy = value => JSON.parse(C.canonicalJson(value));
const same = (left, right) => C.canonicalJson(left) === C.canonicalJson(right);
const approvalMessage = payload => PURPOSE + C.canonicalJson(payload);

function liveJournalDirectory() {
  return localPath(path.join(os.homedir(), 'AppData', 'Local', 'ToSGuardian', 'observed-live'));
}

function currentApproval(payload) {
  const now = Date.now();
  const issued = Date.parse(payload.issuedAt), expires = Date.parse(payload.expiresAt);
  if (!date(payload.issuedAt) || !date(payload.expiresAt) || issued > now || expires <= now ||
      expires - issued > 86400000) throw new Error('Live approval is not current or has excessive lifetime');
}

function verifyApproval(input) {
  const { plan, reviewerRegistry, preregistrations, attachments, outputDirectory, trustedOwnerPublicKey } = input;
  const approval = copy(input.approval);
  if (!exact(approval, ['payload', 'signature']) || !exact(approval.payload, approvalFields)) {
    throw new Error('Signed live spending approval required');
  }
  const { payload, signature } = approval;
  const owner = crypto.createPublicKey(trustedOwnerPublicKey);
  const signedBytes = Buffer.from(String(signature), 'base64');
  if (payload.v !== 1 || payload.kind !== 'maintenance-observed-live-approval' ||
      C.bodyHash(payload) !== payload.hash || owner.asymmetricKeyType !== 'ed25519' ||
      signedBytes.length !== 64 || signedBytes.toString('base64') !== signature ||
      !crypto.verify(null, Buffer.from(approvalMessage(payload)), owner, signedBytes)) {
    throw new Error('Live approval signature did not verify');
  }
  currentApproval(payload);
  const ledger = liveJournalDirectory();
  const output = localPath(outputDirectory);
  if (payload.planHash !== plan?.hash || payload.approvalId !== plan.approvalId ||
      payload.maximumMicrodollars !== plan.limitMicrodollars || plan.journalDirectory !== ledger ||
      payload.outputDirectory !== output || payload.reviewerRegistryHash !== C.digest(reviewerRegistry) ||
      payload.preregistrationsHash !== C.digest(preregistrations) ||
      typeof payload.projectId !== 'string' || !/^proj_[A-Za-z0-9_-]{1,195}$/.test(payload.projectId)) {
    throw new Error('Live approval does not match the plan, project, ledger or pinned reviewers');
  }
  const ownerId = sha(owner.export({ type: 'spki', format: 'der' }));
  for (const protocol of Object.values(plan.protocols)) {
    for (const role of ['human', 'judge', 'scope', 'code']) {
      const reviewer = crypto.createPublicKey(reviewerRegistry[protocol.reviewers[role]]?.publicKey);
      if (sha(reviewer.export({ type: 'spki', format: 'der' })) === ownerId) {
        throw new Error('Spending approval must use a key independent of grading and final review');
      }
    }
  }
  const evidence = payload.billingEvidence;
  const bytes = attachments instanceof Map ? attachments.get(evidence?.sha256) : null;
  if (!exact(evidence, ['sha256', 'bytes']) || !Buffer.isBuffer(bytes) || bytes.length === 0 ||
      bytes.length > MAX_BYTES || bytes.length !== evidence.bytes || sha(bytes) !== evidence.sha256) {
    throw new Error('Approved account pricing and overhead evidence is missing or changed');
  }
  const artifacts = new Map(Object.values(plan.protocols).flatMap(protocol =>
    ['baseline', 'candidate'].map(arm => {
      const asset = protocol.preparation[arm].artifact;
      return [asset.sha256, asset.bytes];
    })));
  if (!Array.isArray(payload.images) || payload.images.length !== 3 ||
      new Set(payload.images.map(image => image?.sha256)).size !== artifacts.size ||
      payload.images.some(image => !exact(image, ['sha256', 'bytes', 'manifestDigest']) ||
        !artifacts.has(image.sha256) || image.bytes !== artifacts.get(image.sha256) ||
        typeof image.manifestDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(image.manifestDigest)) ||
      !C.isHash(payload.umociSha256) || !C.isHash(payload.imageLauncherSha256) ||
      !Array.isArray(payload.builderFiles) || payload.builderFiles.length === 0) {
    throw new Error('Live approval must bind all three archive and executable identities');
  }
  return payload;
}

function wslPath(file) {
  const absolute = localPath(file);
  return '/mnt/' + absolute[0].toLowerCase() + absolute.slice(2).replaceAll('\\', '/');
}

function imageBridge(settings, input, approval) {
  const launcher = localPath(path.join(__dirname, 'maintenance-observed-image.py'));
  const source = fs.readFileSync(launcher);
  if (source.length > 150000 || sha(source) !== approval.imageLauncherSha256 ||
      typeof settings?.umociPath !== 'string' || !/^\/[A-Za-z0-9_./-]+$/.test(settings.umociPath) ||
      settings.umociPath.split('/').includes('..')) throw new Error('Reviewed WSL image launcher and umoci required');
  const images = approval.images.map(image => ({ ...image, archivePath: wslPath(input.archiveLocations[image.sha256]) }));
  const builderRoot = wslPath(path.resolve(__dirname, '..'));
  const windows = process.env.SystemRoot;
  if (typeof windows !== 'string' || !/^[a-z]:\\Windows$/i.test(windows)) throw new Error('Trusted Windows WSL executable required');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(SystemRoot|WINDIR|PATH|TMP|TEMP)$/i.test(name)));
  const child = spawn(path.join(windows, 'System32', 'wsl.exe'),
    ['--user', 'root', '--exec', '/usr/bin/python3', '-I', '-c', bootstrapImageHelper, approval.imageLauncherSha256],
    { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const rows = lines[Symbol.asyncIterator]();
  let failed = false;
  child.on('error', () => { failed = true; });
  child.stdin.on('error', () => { failed = true; });
  const exited = new Promise(resolve => child.once('close', resolve));
  child.stdin.write(source.toString('base64') + '\n');
  async function exchange(body, timeout) {
    let timer;
    try {
      if (failed || child.killed) throw new Error('Image helper unavailable');
      child.stdin.write(C.canonicalJson(body) + '\n');
      const line = await Promise.race([rows.next(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Image helper deadline exceeded')), timeout);
      })]);
      if (line.done || failed || Buffer.byteLength(line.value) > 1200000) throw new Error('Image helper reply missing or too large');
      return transport.parseUnambiguousJson(line.value);
    } finally {
      clearTimeout(timer);
    }
  }
  async function measure(digest, action, input, field) {
    const image = images.find(item => item.sha256 === digest);
    if (!image) throw new Error('Image helper cannot measure an unapproved build');
    const envelope = { archiveSha256: digest };
    if (action) envelope.action = action;
    if (input !== undefined) envelope.input = input;
    const result = await exchange(envelope, action === 'inventory' ? 60000 : 20000);
    if (!exact(result, ['archiveSha256', 'manifestDigest', field]) ||
        result.archiveSha256 !== digest || result.manifestDigest !== image.manifestDigest) {
      throw new Error('Image helper returned a mismatched build');
    }
    return result[field];
  }
  return {
    async ready() {
      const reply = await exchange({ images, umociPath: settings.umociPath, umociSha256: approval.umociSha256,
        builderRoot, builderFiles: approval.builderFiles }, 180000);
      const expected = images.map(({ sha256, manifestDigest }) => ({ sha256, manifestDigest }));
      if (!exact(reply, ['ready']) || !same(reply.ready, expected)) throw new Error('Image helper could not verify the approved archive bindings');
    },
    async shape(input) {
      return measure(input.build.artifact.sha256, null, input, 'request');
    },
    async inventory(digest) {
      return measure(digest, 'inventory', undefined, 'inventory');
    },
    async shapeOffline(input) {
      return measure(input.build.artifact.sha256, 'shape', input, 'request');
    },
    async replay(digest, input) {
      return measure(digest, 'replay', input, 'replay');
    },
    async close() {
      child.stdin.end();
      lines.close();
      let timer;
      try {
        await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { child.kill(); resolve(); }, 10000); })]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// The owner key and billing/reviewer inputs are pinned by the trusted local operator.
// Only this supervisor reads a credential. It is never sent to the request-building child.
async function runObservedLive(options, readCredential) {
  if (typeof readCredential !== 'function') throw new Error('Operator-controlled credential reader required');
  const input = {
    ...options, plan: copy(options.plan), preregistrations: copy(options.preregistrations),
    reviewerRegistry: copy(options.reviewerRegistry), archiveLocations: copy(options.archiveLocations),
  };
  const approval = verifyApproval(input);
  const bridge = imageBridge(input.imageRuntime, input, approval);
  let credential;
  try {
    await bridge.ready();
    return await runBoundEvaluation({
      ...input, approvedPlanHash: approval.planHash, now: new Date().toISOString(),
      shapeRequest: request => bridge.shape(request),
    }, {
      origin: 'captured-runtime', parseJson: transport.parseUnambiguousJson,
      beforeReserve: () => currentApproval(approval),
      async deliver({ bytes, sha256 }) {
        if (credential === undefined) credential = await readCredential(approval.projectId);
        currentApproval(approval);
        return transport.sendObservedRequest({ bytes, sha256, credential, projectId: approval.projectId });
      },
    });
  } finally {
    credential = undefined;
    await bridge.close();
  }
}

module.exports = { approvalMessage, imageBridge, liveJournalDirectory, runObservedLive };
