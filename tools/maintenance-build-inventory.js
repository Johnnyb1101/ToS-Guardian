'use strict';
// Complete byte inventory of a supplied clean installation. This is retained
// evidence, not proof that these files were deployed or that an evaluation ran.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { seal, canonicalJson, digest } = require('./final-corpus-lib');
const { localPath, localTree } = require('./maintenance-local-path');
const { executingRuntime } = require('./maintenance-artifact-manifest');
function captureBuild(directory) {
  if (!path.isAbsolute(directory)) throw Error('Absolute build directory required');
  const root = process.platform === 'win32' ? localPath(directory) : fs.realpathSync(directory);
  if (!fs.statSync(root).isDirectory()) throw Error('Build directory required');
  const files = [], seen = new Set();
  function walk(relative) {
    const folder = path.join(root, relative);
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (!entry.name || /[\\/:\x00-\x1f]/.test(entry.name) || ['.','..','.git'].includes(entry.name)) throw Error('Unexpected build path');
      const name = relative ? relative + '/' + entry.name : entry.name;
      const file = path.join(root, ...name.split('/'));
      const before = fs.lstatSync(file);
      if (before.isSymbolicLink()) throw Error('Build inventory rejects links');
      if (before.isDirectory()) { walk(name); continue; }
      if (!before.isFile() || before.size > 1000000000 || files.length >= 100000 || seen.has(name.toLowerCase())) throw Error('Invalid or ambiguous build file');
      seen.add(name.toLowerCase());
      const fd = fs.openSync(file, 'r'), h = crypto.createHash('sha256'), buffer = Buffer.alloc(65536);
      let bytes = 0;
      try {
        for (let count; (count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) { h.update(buffer.subarray(0,count)); bytes += count; }
        const after = fs.fstatSync(fd);
        if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw Error('Build changed during inventory');
      } finally { fs.closeSync(fd); }
      files.push({ path: name, bytes, sha256: h.digest('hex') });
    }
  }
  if (process.platform === 'win32') {
    // A single native guarded walk checks every reparse tag before any Node
    // traversal/read. A second walk below measures the now-validated tree.
    localTree(root);
  }
  walk('');
  if (!files.length) throw Error('Empty build inventory');
  files.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return seal({ v: 1, kind: 'maintenance-installed-build-inventory', runtime: executingRuntime(), files });
}
function verifyBuild(directory, expected) {
  if (!expected || expected.hash !== digest(Object.fromEntries(Object.entries(expected).filter(([key]) => key !== 'hash')))) throw Error('Build inventory seal mismatch');
  const measured = captureBuild(directory);
  if (canonicalJson(measured) !== canonicalJson(expected)) throw Error('Installed build inventory changed');
  return measured;
}
module.exports = { captureBuild, verifyBuild };
