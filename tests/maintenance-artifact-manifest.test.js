'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { captureClosure, verifyClosure, captureExecution, verifyExecution, migrationInventory } = require('../tools/maintenance-artifact-manifest');
const { seal } = require('../tools/final-corpus-lib');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tos-manifest-test-'));
const roots = { extension: root };
try {
  fs.writeFileSync(path.join(root, 'verifier.js'), 'module.exports = 1;\n');
  const closure = captureClosure(roots, ['extension/verifier.js']);
  assert.deepEqual(verifyClosure(roots, closure), closure);
  const execution = captureExecution(roots, ['extension/verifier.js']);
  assert.deepEqual(verifyExecution(roots, execution), execution);
  const runtime = { ...execution.runtime, node: 'v0.0.0' };
  assert.throws(() => verifyExecution(roots, seal({ sources: execution.sources, runtime })), /runtime differs/);
  fs.writeFileSync(path.join(root, 'verifier.js'), 'module.exports = 2;\n');
  assert.throws(() => verifyClosure(roots, closure), /differ/);
  assert.throws(() => captureClosure(roots, ['extension/../escape']), /Unsafe/);
  assert.throws(() => captureClosure(roots, ['other/verifier.js']), /Unknown/);
  const nativeLstat = fs.lstatSync;
  let metadataCalls = 0;
  try {
    fs.lstatSync = () => { metadataCalls++; throw Error('metadata before native guard'); };
    assert.throws(() => captureClosure({ extension: '\\\\server\\share\\folder' }, ['extension/a.js']), /UNC/);
    assert.throws(() => captureClosure({ extension: 'Z:\\mapped' }, ['extension/a.js']), /system drive/);
    assert.equal(metadataCalls, 0);
  } finally { fs.lstatSync = nativeLstat; }
  const nativeReadDir = fs.readdirSync;
  let directoryReads = 0;
  try {
    fs.readdirSync = () => { directoryReads++; throw Error('directory read before native guard'); };
    assert.throws(() => migrationInventory('\\\\server\\share\\folder'), /UNC/);
    assert.equal(directoryReads, 0);
  } finally { fs.readdirSync = nativeReadDir; }
  assert.throws(() => captureClosure(roots, ['extension/verifier.js', 'extension/Verifier.js']), /Duplicate/);
  assert.throws(() => verifyClosure(roots, { ...closure, hash: '0'.repeat(64) }), /seal/);
  assert.throws(() => verifyClosure(roots, seal({ files: [{ ...closure.files[0], ignored: true }] })), /differ/);
  fs.mkdirSync(path.join(root, 'migrations'));
  const sql = path.join(root, 'migrations', '0001_fixture.sql');
  fs.writeFileSync(sql, 'select 1;\r\n');
  const crlf = migrationInventory(root);
  fs.writeFileSync(sql, 'select 1;\n');
  assert.deepEqual(migrationInventory(root), crlf);
  fs.writeFileSync(path.join(root, 'migrations', '0002_fixture.psql'), '\\ir 0001_fixture.sql\n');
  const complete = migrationInventory(root);
  assert.equal(complete.files.length, 2);
  assert.notEqual(complete.hash, crlf.hash);
  fs.mkdirSync(path.join(root, 'migrations', 'unreviewed'));
  assert.throws(() => migrationInventory(root), /flat regular/);
  console.log('PASS artifact byte changes, unsafe/duplicate paths, manifest tampering, complete migration inventory and CRLF normalization');
} finally {
  // mkdtemp returns a dedicated directory created by this test, never user input.
  fs.rmSync(root, { recursive: true, force: true });
}
