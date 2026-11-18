'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const C = require('../tools/final-corpus-lib');
const M = require('../tools/maintenance-evaluation-lib');
const CLI = require('../tools/maintenance-evaluation');
const { lexicalPath, localPath } = require('../tools/maintenance-local-path');
const { makeRelease, makeLesson, reseal } = require('./final-test-fixtures');
const { releaseConfigHash, checkAuthorization } = require('../tools/sites-lib');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tos-maintenance-test-'));
const clone = value => JSON.parse(JSON.stringify(value));
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok ${name}`); }
function release(seed) {
  const r = makeRelease([]);
  r.config.policy.versions.serverPipeline = C.hashText(seed);
  r.config.policy.cache = { shared: 'disabled' };
  r.configHash = releaseConfigHash(r.config);
  return r;
}
function file(name, text) { const p = path.join(root, name); fs.writeFileSync(p, text); return p; }
const artifact = file('build.tar', 'synthetic build fixture, not a deployable image');
const log = file('test.log', 'synthetic test and review evidence');
const runtime = { node: '22.23.3', npm: '10.9.8', platform: 'linux', arch: 'x64' };
const fixtureDigest = p => { const bytes = fs.readFileSync(p); return { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }; };
function protocol() {
  const build = seed => ({ release: release(seed), artifact: fixtureDigest(artifact), runtime: { ...runtime } });
  return M.createProtocol(build('baseline'), build('candidate'));
}
function records(p) {
  return [['test', M.TESTS], ['review', M.REVIEWS]].flatMap(([kind, ids]) => ids.map(id => C.seal({ v: 1, kind, id, protocolHash: p.hash,
    candidateConfigHash: p.candidate.release.configHash, candidateArtifactHash: p.candidate.artifact.sha256,
    outcome: 'pass', author: 'synthetic fixture', summary: 'Fixture only, not actual execution', attachment: fixtureDigest(log) })));
}
const cli = args => spawnSync(process.execPath, [path.resolve(__dirname, '../tools/maintenance-evaluation.js'), ...args], { encoding: 'utf8' });

try {
  test('runtime-only pair binds exact artifact bytes and retains every safety flag', () => {
    const p = protocol();
    assert.equal(M.validateProtocol(p).valid, true);
    assert.equal(p.candidate.artifact.sha256, fixtureDigest(artifact).sha256);
    assert.deepEqual(M.evaluatePreparation(p).pending.length, M.TESTS.length + M.REVIEWS.length);
    assert.equal(M.evaluatePreparation(p).structurallyComplete, false);
  });
  test('complete supplied evidence stays diagnostic and cannot become final proof', () => {
    const p = protocol(), report = M.evaluatePreparation(p, records(p));
    assert.equal(report.structurallyComplete, true);
    for (const [key, value] of Object.entries(M.FLAGS)) assert.equal(report[key], value);
    assert.equal(report.phase, undefined);
    assert.equal(checkAuthorization({ payload: report }, p.candidate.release, 'not-a-key').valid, false);
  });
  test('all fixed release contents including lessons, prompts, cache and limits are protected', () => {
    for (const mutate of [
      c => c.lessons.push(makeLesson(0)), c => { c.policy.promptHashes.analyzer = C.hashText('new'); },
      c => { c.policy.cache.shared = 'enabled'; }, c => { c.policy.models.anthropic.default = 'different'; },
      c => { c.policy.limits.maxLessonsPerTarget = 11; }, c => { c.policy.versions.pipeline = C.hashText('extension'); }
    ]) {
      let p = protocol(); mutate(p.candidate.release.config);
      p.candidate.release.configHash = releaseConfigHash(p.candidate.release.config); p = reseal(p);
      assert.equal(M.validateProtocol(p).valid, false);
    }
  });
  test('removed checks, extra allowed policy changes, approvals and eligibility fail closed even resealed', () => {
    for (const mutate of [p => p.requiredTests.pop(), p => p.requiredReviews.pop(), p => p.allowedPolicyChanges.push('cache.shared'),
      p => { p.liveProtocol = {}; }, p => { p.diagnosticOnly = false; }, p => { p.evaluationPassed = true; },
      p => { p.promotionEligible = true; }, p => { p.kind = 'step2-final'; }, p => { p.approved = true; }]) {
      const p = protocol(); mutate(p); assert.equal(M.validateProtocol(reseal(p)).valid, false);
    }
  });
  test('missing runtime fingerprints and invalid declared runtime or release hashes are rejected', () => {
    for (const mutate of [p => { delete p.candidate.release.config.policy.versions.serverPipeline; }, p => { p.candidate.runtime.node = ''; },
      p => { p.candidate.release.configHash = C.hashText('wrong'); }, p => { p.candidate.artifact.bytes = 0; }]) {
      const p = protocol(); mutate(p); assert.equal(M.validateProtocol(reseal(p)).valid, false);
    }
  });
  test('delimiter-containing keys cannot impersonate missing schema fields', () => {
    const malformed = { 'arch|node': 'not either field', npm: 'x', platform: 'x' };
    assert.throws(() => M.bindBuild(release('candidate'), artifact, malformed), /Declare exact/);
    const p = protocol(); p.candidate.runtime = malformed;
    assert.equal(M.validateProtocol(reseal(p)).valid, false);
    const r = records(protocol()); delete r[0].author; delete r[0].summary; r[0]['author|summary'] = 'not either';
    r[0] = reseal(r[0]); assert.equal(M.evaluatePreparation(protocol(), r).structurallyComplete, false);
  });
  test('UNC, device, drive-relative, alternate stream and reserved names are rejected before filesystem access', () => {
    for (const unsafe of ['\\\\server\\share\\file', '//server/share/file', '\\\\?\\C:\\file', '\\\\.\\C:\\file', 'C:file', 'C:', '\\rooted', 'file:stream', 'NUL', 'CON.txt', 'folder.\\file', 'file\u0000']) {
      assert.throws(() => lexicalPath(unsafe, 'C:\\safe'));
      assert.throws(() => M.hashFile(unsafe));
    }
    assert.equal(lexicalPath('child/file', 'C:\\safe'), 'C:\\safe\\child\\file');
    if (process.platform === 'win32') {
      const secondary = process.env.SystemRoot[0].toUpperCase() === 'Z' ? 'Y:\\file' : 'Z:\\file';
      assert.throws(() => localPath(secondary), /system drive/);
    } else assert.throws(() => localPath(artifact), /Windows system-drive/);
    assert.equal(cli(['check', '\\\\server\\share']).status, 1);
  });
  test(process.platform === 'win32' ? 'existing junction ancestors block build, input and output access' : 'unsupported platform rejects every filesystem entry point', () => {
    if (process.platform !== 'win32') {
      assert.throws(() => M.hashFile(artifact), /Windows system-drive/);
      assert.throws(() => CLI.initialize(path.join(root, 'prep'), path.join(root, 'spec.json')), /Windows system-drive/);
      assert.throws(() => CLI.load(root), /Windows system-drive/);
      return;
    }
    const linked = path.join(root, 'junction');
    fs.symlinkSync(root, linked, 'junction');
    try {
      assert.throws(() => M.hashFile(path.join(linked, 'build.tar')), /Reparse/);
      assert.throws(() => localPath(path.join(linked, 'new', 'output.json'), { allowMissing: true }), /Reparse/);
      assert.throws(() => CLI.initialize(path.join(root, 'unsafe-prep'), path.join(linked, 'spec.json')), /Reparse/);
      assert.throws(() => CLI.load(linked), /Reparse/);
    } finally { fs.unlinkSync(linked); }
  });
  test('skipped, failed, unresolved and missing reviews or tests cannot be complete', () => {
    const p = protocol();
    for (const outcome of ['skipped', 'fail', 'unresolved']) {
      const r = records(p); r[0] = reseal({ ...r[0], outcome }); assert.equal(M.evaluatePreparation(p, r).structurallyComplete, false);
    }
    assert.equal(M.evaluatePreparation(p, records(p).slice(0, -1)).structurallyComplete, false);
  });
  test('stale evidence and duplicates are rejected without falling back to another pass', () => {
    const p = protocol();
    for (const key of ['protocolHash', 'candidateConfigHash', 'candidateArtifactHash']) {
      const r = records(p); r[0] = reseal({ ...r[0], [key]: C.hashText('stale') }); assert.equal(M.evaluatePreparation(p, r).structurallyComplete, false);
    }
    const r = records(p); r.push(r[0]); assert.equal(M.evaluatePreparation(p, r).structurallyComplete, false);
  });
  test('malformed inputs, unsealed edits, empty or unauthored attachments fail closed', () => {
    for (const p of [null, {}, [], { kind: 'maintenance-preparation' }]) assert.equal(M.evaluatePreparation(p).structurallyComplete, false);
    const p = protocol(); assert.equal(M.evaluatePreparation(p, [null]).structurallyComplete, false);
    assert.equal(M.evaluatePreparation(p, {}).structurallyComplete, false);
    for (const mutate of [r => { r.author = ''; }, r => { r.attachment.bytes = 0; }, r => { r.summary = ''; }, r => { r.unexpected = true; }]) {
      const r = records(p); mutate(r[0]); r[0] = reseal(r[0]); assert.equal(M.evaluatePreparation(p, r).structurallyComplete, false);
    }
    const r = records(p); r[0].summary = 'changed'; assert.equal(M.evaluatePreparation(p, r).structurallyComplete, false);
    assert.throws(() => M.hashFile(file('empty', '')), process.platform === 'win32' ? /Empty/ : /Windows system-drive/);
    assert.throws(() => M.checkLocalFile('relative.tar', p.candidate.artifact), /absolute/);
  });
  test(process.platform === 'win32' ? 'CLI init/check/report rehash local builds, preserve reports and never return evaluation success' : 'unsupported platform CLI checks fail explicitly without a report', () => {
    if (process.platform !== 'win32') {
      for (const command of ['check', 'report']) {
        const result = cli([command, root]); assert.equal(result.status, 1); assert.match(result.stderr, /Windows system-drive/);
      }
      return;
    }
    assert.deepEqual(M.bindBuild(release('candidate'), artifact, runtime), protocol().candidate);
    assert.deepEqual(M.recordEvidence(protocol(), { kind: 'test', id: M.TESTS[0], outcome: 'pass', author: 'synthetic fixture', summary: 'Fixture only, not actual execution', attachmentFile: log }), records(protocol())[0]);
    const baselineRelease = file('baseline.json', JSON.stringify(release('baseline')));
    const candidateRelease = file('candidate.json', JSON.stringify(release('candidate')));
    const spec = file('spec.json', JSON.stringify({ baseline: { releaseFile: baselineRelease, artifactFile: artifact, runtime }, candidate: { releaseFile: candidateRelease, artifactFile: artifact, runtime } }));
    const dir = path.join(root, 'prep');
    assert.equal(cli(['init', dir, spec]).status, 0);
    assert.equal(cli(['init', dir, spec]).status, 1);
    assert.equal(cli(['check', dir]).status, 2);
    assert.equal(cli(['report', dir]).status, 2); assert.equal(cli(['report', dir]).status, 2);
    assert.equal(fs.readdirSync(dir).filter(n => n.startsWith('maintenance-report-')).length, 2);
    const p = JSON.parse(fs.readFileSync(path.join(dir, 'protocol.json'))), r = records(p);
    fs.writeFileSync(path.join(dir, 'evidence.json'), JSON.stringify(r));
    const locations = JSON.parse(fs.readFileSync(path.join(dir, 'locations.json')));
    locations.evidence = Object.fromEntries(r.map(x => [x.hash, log]));
    fs.writeFileSync(path.join(dir, 'locations.json'), JSON.stringify(locations));
    assert.equal(CLI.load(dir).structurallyComplete, true);
    assert.equal(cli(['check', dir]).status, 2);
    fs.appendFileSync(log, 'changed'); assert.equal(cli(['check', dir]).status, 1);
    fs.writeFileSync(log, 'synthetic test and review evidence');
    fs.appendFileSync(artifact, 'changed'); assert.equal(cli(['check', dir]).status, 1);
    fs.writeFileSync(artifact, 'synthetic build fixture, not a deployable image');
  });
  test('CLI rejects execution, signing, activation and unknown arguments', () => {
    assert.equal(cli(['--help']).status, 0);
    for (const command of ['run', 'execute', 'approve', 'sign', 'deploy', 'activate']) assert.equal(cli([command, root]).status, 1);
    assert.equal(cli(['check', root, '--production']).status, 1);
  });
  test(process.platform === 'win32' ? 'independent final CLI verifies retained fixture bytes and keeps offline fixtures ineligible' : 'final CLI rejects unsupported local-filesystem access', () => {
    if (process.platform !== 'win32') {
      assert.equal(cli(['final-check', root, path.join(root, 'reviewers.json')]).status, 1);
      return;
    }
    const fixture = require('./maintenance-final-fixtures').makeFinalFixture({ compactBytes: true });
    const dir = path.join(root, 'final-fixture'); fs.mkdirSync(dir);
    const save = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
    const locations = { attachments: {} };
    for (const [hash, bytes] of Object.entries(fixture.context.attachments)) {
      const attachment = path.join(dir, `${hash}.bin`); fs.writeFileSync(attachment, bytes); locations.attachments[hash] = attachment;
    }
    save('final-protocol.json', fixture.protocol); save('final-evidence.json', fixture.evidence); save('final-locations.json', locations);
    const registry = file('external-reviewers.json', JSON.stringify(fixture.context.trustedReviewers));
    const checked = cli(['final-check', dir, registry]);
    assert.equal(checked.status, 2, checked.stderr);
    const finalReport = JSON.parse(checked.stdout);
    assert.equal(finalReport.contractSatisfied, true, finalReport.reasons.join('; '));
    assert.equal(finalReport.evaluationPassed, false); assert.equal(finalReport.promotionEligible, false);
    assert.equal(cli(['final-report', dir, registry]).status, 2);
    assert.equal(fs.readdirSync(dir).filter(name => name.startsWith('maintenance-final-report-')).length, 1);
    fs.writeFileSync(locations.attachments[fixture.builds.candidate.artifact.sha256], 'changed build fixture bytes');
    const tampered = cli(['final-check', dir, registry]); assert.equal(tampered.status, 2);
    assert.equal(JSON.parse(tampered.stdout).contractSatisfied, false);
    assert.equal(cli(['final-check', dir]).status, 1);
  });
  console.log(`${passed} maintenance preparation tests passed`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
