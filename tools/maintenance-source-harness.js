'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { localPath } = require('./maintenance-local-path');
const { digest, seal } = require('./final-corpus-lib');
const { FLAGS } = require('./maintenance-evaluation-lib');
const FILES = Object.freeze(['analysisOperations.js', 'llmRelay.js', 'siteValidation.js', 'node_modules/tldts/dist/cjs/index.js', 'package.json', 'package-lock.json']);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function captureSource(directory) {
  const root = localPath(directory);
  const sources = {};
  const files = FILES.map(name => {
    const file = localPath(path.join(root, ...name.split('/')));
    const fd = fs.openSync(file, 'r');
    let bytes;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 10000000) throw new Error('Invalid or oversized captured module');
      bytes = fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('Captured module is not valid UTF-8');
    sources[name] = text;
    return { name, sha256: hash(bytes), bytes: bytes.length };
  });
  return { manifest: seal({ kind: 'maintenance-module-capture', v: 1, files }), sources };
}

function executeSource(capture, operation) {
  const manifest = capture?.manifest;
  if (!manifest || manifest.kind !== 'maintenance-module-capture' || manifest.v !== 1 || !Array.isArray(manifest.files) || manifest.files.length !== FILES.length) throw new Error('Invalid source capture');
  const { hash: manifestHash, ...body } = manifest;
  if (manifestHash !== digest(body) || JSON.stringify(Object.keys(capture.sources || {}).sort()) !== JSON.stringify([...FILES].sort())) throw new Error('Source capture binding mismatch');
  FILES.forEach((name, index) => {
    const record = manifest.files[index], source = capture.sources[name];
    if (record?.name !== name || typeof source !== 'string' || record.sha256 !== hash(Buffer.from(source)) || record.bytes !== Buffer.byteLength(source)) throw new Error('Captured bytes changed');
  });
  const modules = new Map();
  function load(name) {
    if (modules.has(name)) return modules.get(name);
    if (!FILES.includes(name) || !name.endsWith('.js')) throw new Error('Unexpected module dependency');
    const module = { exports: {} }; modules.set(name, module.exports);
    const requireCaptured = dependency => {
      if (dependency === 'node:crypto') return { createHash: crypto.createHash };
      if (name === 'analysisOperations.js' && dependency === './siteValidation') return load('siteValidation.js');
      if (name === 'siteValidation.js' && dependency === 'tldts') return load('node_modules/tldts/dist/cjs/index.js');
      throw new Error('Unexpected module dependency');
    };
    const context = vm.createContext({ module, exports: module.exports, require: requireCaptured, URL });
    new vm.Script(capture.sources[name], { filename: name }).runInContext(context, { timeout: 1000 });
    modules.set(name, module.exports);
    return module.exports;
  }
  const context = vm.createContext({ operations: load('analysisOperations.js'), relay: load('llmRelay.js'), input: JSON.parse(JSON.stringify(operation)) });
  const output = new vm.Script(`
    const operationResult = operations.validateOperationRequest(input);
    if (!operationResult.valid) throw new Error(operationResult.reason);
    const validated = relay.validateAnalyzeRequest(operationResult.relayRequest);
    if (!validated.valid) throw new Error(validated.reason);
    const shaped = relay.buildProviderRequest(validated, 'OFFLINE-NOT-A-CREDENTIAL');
    JSON.stringify({ operation: operationResult.operation, request: { url: shaped.url, body: shaped.body } });
  `).runInContext(context, { timeout: 1000 });
  const result = JSON.parse(output);
  return seal({ kind: 'maintenance-module-execution', v: 1, ...FLAGS,
    captureHash: manifestHash, inputHash: digest(operation), outputHash: digest(result), result,
    actualRuntime: { node: process.version, platform: process.platform, arch: process.arch },
    provenance: 'captured-module-bytes-executed-with-offline-host-bindings',
    limitations: ['Not a deployed image, whole application or authenticated build execution',
      'Trusted reviewed source only: Node vm is not a security sandbox', 'No provider calls, credential lookup or signing occurred'] });
}

module.exports = { captureSource, executeSource };
