'use strict';

// Byte identities only. Completeness requires the caller to review the inventory
// and compare it with the executed dependency graph; this is not build provenance.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { seal, digest, canonicalJson } = require('./final-corpus-lib');
const { localPath, localPaths } = require('./maintenance-local-path');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function relative(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_.@/-]+$/.test(name) || name.split('/').some(p => !p || p === '.' || p === '..')) throw Error('Unsafe manifest path');
}
function regularFile(root, name, batched = false) {
  relative(name);
  if (!path.isAbsolute(root)) throw Error('Absolute local root required');
  const base = process.platform === 'win32' && !batched ? localPath(root) : path.resolve(root);
  const file = path.resolve(base, ...name.split('/'));
  if (!file.startsWith(base + path.sep)) throw Error('Manifest path escaped root');
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw Error('Symlink in manifest path');
  }
  const verified = process.platform === 'win32' && !batched ? localPath(file) : file;
  const stat = fs.statSync(verified);
  if (!stat.isFile() || stat.size > 64000000) throw Error('Manifest needs a bounded regular file');
  return verified;
}
function captureClosure(roots, inventory) {
  if (!roots || typeof roots !== 'object' || !Array.isArray(inventory) || !inventory.length || inventory.length > 10000) throw Error('Explicit roots and inventory required');
  const names = [...inventory].sort();
  if (new Set(names.map(n => typeof n === 'string' ? n.toLowerCase() : n)).size !== names.length) throw Error('Duplicate manifest paths');
  const descriptors = names.map(name => {
    relative(name);
    const slash = name.indexOf('/'), namespace = name.slice(0, slash), relativeName = name.slice(slash + 1);
    if (slash < 1 || !Object.hasOwn(roots, namespace)) throw Error('Unknown source root');
    const root = roots[namespace];
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw Error('Absolute local root required');
    const base = path.resolve(root), file = path.resolve(base, ...relativeName.split('/'));
    if (!file.startsWith(base + path.sep)) throw Error('Manifest path escaped root');
    return { root, relativeName, file };
  });
  // No metadata lookup or file open before Windows rejects network paths and
  // all ancestor reparse points. Do not move regularFile above this boundary.
  if (process.platform === 'win32') localPaths(descriptors.map(item => item.file));
  const files = names.map((name, index) => {
    const item = descriptors[index];
    const bytes = fs.readFileSync(regularFile(item.root, item.relativeName, true));
    return { path: name, bytes: bytes.length, sha256: hash(bytes) };
  });
  return seal({ files });
}
function verifyClosure(roots, expected) {
  if (!expected || !Array.isArray(expected.files) || Object.keys(expected).sort().join(',') !== 'files,hash') throw Error('Invalid closure manifest');
  if (expected.hash !== digest({ files: expected.files })) throw Error('Manifest seal mismatch');
  const measured = captureClosure(roots, expected.files.map(file => file.path));
  if (canonicalJson(measured) !== canonicalJson(expected)) throw Error('Installed dependency bytes differ from reviewed manifest');
  return measured;
}
function migrationInventory(proxyDirectory) {
  if (typeof proxyDirectory !== 'string' || !path.isAbsolute(proxyDirectory)) throw Error('Absolute local migration root required');
  const requested = path.join(proxyDirectory, 'migrations');
  const directory = process.platform === 'win32' ? localPath(requested) : requested;
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (entries.some(entry => !entry.isFile() || entry.isSymbolicLink())) throw Error('Migration inventory requires flat regular files');
  const names = entries.map(entry => entry.name).filter(name => /\.(sql|psql)$/.test(name)).sort();
  if (!names.length || new Set(names.map(n => n.toLowerCase())).size !== names.length) throw Error('Empty or ambiguous migrations');
  const files = names.map(name => {
    const bytes = fs.readFileSync(regularFile(proxyDirectory, `migrations/${name}`));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n?/g, '\n');
    return { path: `migrations/${name}`, bytes: Buffer.byteLength(text), sha256: hash(text) };
  });
  return seal({ files });
}
function executingRuntime() {
  const executable = fs.realpathSync(process.execPath);
  const stat = fs.statSync(executable);
  if (!stat.isFile() || stat.size < 1 || stat.size > 256000000) throw Error('Unexpected runtime executable');
  const fd = fs.openSync(executable, 'r');
  const hashing = crypto.createHash('sha256'), buffer = Buffer.alloc(65536);
  let bytes = 0;
  try {
    for (let count; (count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) { hashing.update(buffer.subarray(0, count)); bytes += count; }
  } finally { fs.closeSync(fd); }
  if (bytes !== stat.size) throw Error('Runtime changed during capture');
  return { node: process.version, platform: process.platform, arch: process.arch, executable: { bytes, sha256: hashing.digest('hex') } };
}
function captureExecution(roots, inventory) {
  return seal({ sources: captureClosure(roots, inventory), runtime: executingRuntime() });
}
function verifyExecution(roots, expected) {
  if (!expected || Object.keys(expected).sort().join(',') !== 'hash,runtime,sources' || expected.hash !== digest({ sources: expected.sources, runtime: expected.runtime })) throw Error('Invalid execution manifest');
  verifyClosure(roots, expected.sources);
  if (canonicalJson(executingRuntime()) !== canonicalJson(expected.runtime)) throw Error('Executing runtime differs from reviewed manifest');
  return JSON.parse(canonicalJson(expected));
}
module.exports = { captureClosure, verifyClosure, captureExecution, verifyExecution, executingRuntime, migrationInventory };
