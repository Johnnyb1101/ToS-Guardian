'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { captureBuild, verifyBuild } = require('../tools/maintenance-build-inventory');
const root = fs.mkdtempSync(path.join(os.tmpdir(),'tos-build-inventory-'));
try {
  fs.mkdirSync(path.join(root,'node_modules','fixture'),{recursive:true});
  fs.writeFileSync(path.join(root,'package-lock.json'),'{}\n');
  const dependency = path.join(root,'node_modules','fixture','index.js');
  fs.writeFileSync(dependency,'exports.ok = true;\n');
  const expected = captureBuild(root);
  assert.equal(expected.files.length,2);
  assert.deepEqual(verifyBuild(root,expected),expected);
  fs.appendFileSync(dependency,'// altered dependency\n');
  assert.throws(()=>verifyBuild(root,expected),/changed/);
  fs.writeFileSync(dependency,'exports.ok = true;\n');
  fs.writeFileSync(path.join(root,'unexpected.js'),'exports.injected = true;');
  assert.throws(()=>verifyBuild(root,expected),/changed/);
  assert.throws(()=>verifyBuild(root,{...expected,hash:'0'.repeat(64)}),/seal/);
  const target=path.join(root,'target'),link=path.join(root,'junction');
  fs.mkdirSync(target);fs.symlinkSync(target,link,'junction');
  assert.throws(()=>captureBuild(root),/Reparse|junction|links/i);
  console.log('PASS complete build inventory binds dependencies, rejects added/changed files and altered seals');
} finally { fs.rmSync(root,{recursive:true,force:true}); }
