'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const M = require('./maintenance-evaluation-lib');
const { localPath } = require('./maintenance-local-path');

const read = file => JSON.parse(fs.readFileSync(localPath(file), 'utf8'));
const writeNew = (file, data) => fs.writeFileSync(localPath(file, { allowMissing: true }), JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });

function initialize(directory, specFile) {
  const target = localPath(directory, { allowMissing: true }), specPath = localPath(specFile), spec = read(specPath), base = path.dirname(specPath);
  if (fs.existsSync(target)) throw new Error('Choose a new preparation directory; existing work is never overwritten');
  if (!spec || JSON.stringify(Object.keys(spec).sort()) !== JSON.stringify(['baseline', 'candidate'])) throw new Error('Spec requires baseline and candidate only');
  const builds = {}, locations = { builds: {}, evidence: {} };
  for (const arm of ['baseline', 'candidate']) {
    const entry = spec[arm];
    if (!entry || JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(['artifactFile', 'releaseFile', 'runtime']) || typeof entry.artifactFile !== 'string' || typeof entry.releaseFile !== 'string') throw new Error('Each build needs releaseFile, artifactFile and runtime');
    const artifact = localPath(entry.artifactFile, { base });
    builds[arm] = M.bindBuild(read(localPath(entry.releaseFile, { base })), artifact, entry.runtime);
    locations.builds[arm] = artifact;
  }
  const protocol = M.createProtocol(builds.baseline, builds.candidate);
  const check = M.validateProtocol(protocol);
  if (!check.valid) throw new Error(check.reasons.join('; '));
  fs.mkdirSync(localPath(path.dirname(target), { allowMissing: true }), { recursive: true });
  fs.mkdirSync(localPath(target, { allowMissing: true }));
  writeNew(path.join(target, 'protocol.json'), protocol);
  writeNew(path.join(target, 'locations.json'), locations);
  writeNew(path.join(target, 'evidence.json'), []);
  return { status: 'offline-preparation-created', ...M.FLAGS };
}

function load(directory) {
  directory = localPath(directory);
  const protocol = read(path.join(directory, 'protocol.json'));
  const records = read(path.join(directory, 'evidence.json'));
  const locations = read(path.join(directory, 'locations.json'));
  const check = M.validateProtocol(protocol);
  if (!check.valid) throw new Error(check.reasons.join('; '));
  if (!Array.isArray(records)) throw new Error('Evidence must be an array');
  for (const arm of ['baseline', 'candidate']) M.checkLocalFile(locations?.builds?.[arm], protocol[arm].artifact);
  for (const record of records) M.checkLocalFile(locations?.evidence?.[record.hash], record.attachment);
  return M.evaluatePreparation(protocol, records);
}

function loadFinal(directory, trustFile, now = new Date()) {
  const F = require('./maintenance-final-evidence');
  const boundedBytes = (file, limit) => {
    const fd = fs.openSync(localPath(file), 'r'), chunks = [];
    let bytes = 0;
    try {
      if (!fs.fstatSync(fd).isFile()) throw Error('Final attachment must be a regular local file');
      const buffer = Buffer.alloc(65536);
      for (let count; (count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) {
        bytes += count;
        if (bytes > limit) throw Error('Final attachment exceeds byte limit');
        chunks.push(Buffer.from(buffer.subarray(0, count)));
      }
      if (!bytes) throw Error('Final attachment must be nonempty');
      return Buffer.concat(chunks, bytes);
    } finally { fs.closeSync(fd); }
  };
  const finalJson = file => JSON.parse(boundedBytes(file, F.MAX_BYTES).toString('utf8'));
  directory = localPath(directory);
  const protocol = finalJson(path.join(directory, 'final-protocol.json'));
  const evidence = finalJson(path.join(directory, 'final-evidence.json'));
  const locations = finalJson(path.join(directory, 'final-locations.json'));
  const trustedReviewers = finalJson(trustFile);
  if (!locations || JSON.stringify(Object.keys(locations)) !== JSON.stringify(['attachments']) || !locations.attachments || typeof locations.attachments !== 'object' || Array.isArray(locations.attachments)) throw Error('Final locations must contain an attachment hash to absolute local file map');
  const attachments = {};
  let totalBytes = 0;
  for (const [hash, file] of Object.entries(locations.attachments)) {
    if (!/^[a-f0-9]{64}$/.test(hash) || typeof file !== 'string' || !path.isAbsolute(file)) throw Error('Final attachment paths must be absolute local files keyed by SHA-256');
    attachments[hash] = boundedBytes(file, F.MAX_BUILD_BYTES);
    totalBytes += attachments[hash].length;
    if (totalBytes > F.MAX_TOTAL_BYTES) throw Error('Final attachment package exceeds byte limit');
  }
  return F.validateFinalEvidence(protocol, evidence, { attachments, trustedReviewers, now: new Date(now).toISOString() });
}

function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Local-file preparation: init <newDir> <spec.json> | check <dir> | report <dir>. Independent final verifier: final-check <dir> <external-reviewer-registry.json> | final-report <dir> <external-reviewer-registry.json>. No provider/HTTP, execute, approve, sign or deploy command.');
    return 0;
  }
  const [command, directory, specFile] = args;
  if (command === 'init' && args.length === 3) { console.log(JSON.stringify(initialize(directory, specFile), null, 2)); return 0; }
  if (['final-check', 'final-report'].includes(command) && args.length === 3) {
    const report = loadFinal(directory, specFile);
    if (command === 'final-report') writeNew(path.join(directory, `maintenance-final-report-${crypto.randomUUID()}.json`), report);
    console.log(JSON.stringify(report, null, 2));
    return report.promotionEligible ? 0 : 2;
  }
  if (!['check', 'report'].includes(command) || args.length !== 2) throw new Error('Expected offline init, check or report; live execution and signing are unavailable');
  const report = load(directory);
  if (command === 'report') writeNew(path.join(directory, `maintenance-report-${crypto.randomUUID()}.json`), report);
  console.log(JSON.stringify(report, null, 2));
  return 2;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { initialize, load, loadFinal, main };
