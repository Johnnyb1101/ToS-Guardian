'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const hashText = text => crypto.createHash('sha256').update(text).digest('hex');

// This inventories the supplied local history; it cannot establish that no other
// experiment, organization alias, or substantially similar document exists.
function buildHistory(referenceRoot) {
  const root = fs.realpathSync(referenceRoot);
  const domains = new Set(); const organizationIds = new Set(); const sourceHashes = new Set();
  const sources = [];
  function collect(value, key = '') {
    if (typeof value === 'string') {
      if (key === 'domain' && /^[a-z0-9.-]+\.[a-z]+$/.test(value)) domains.add(value);
      if (key === 'organizationId') organizationIds.add(value);
      if (['textHash', 'sourceHash', 'analysisSourceHash'].includes(key) && /^[a-f0-9]{64}$/.test(value)) sourceHashes.add(value);
      if (['analysisSource', 'sourceText', 'text'].includes(key) && value.length) sourceHashes.add(hashText(value));
    } else if (Array.isArray(value)) {
      for (const item of value) collect(item, key === 'sites' ? 'domain' : key);
    } else if (value && typeof value === 'object') {
      for (const [name, item] of Object.entries(value)) {
        if (key === 'sites' && /^[a-z0-9.-]+\.[a-z]+$/.test(name)) domains.add(name);
        collect(item, name);
      }
    }
  }
  function visit(file) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error('Historical inventory refuses symbolic links');
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
    } else if (stat.isFile() && file.endsWith('.json')) {
      const bytes = fs.readFileSync(file);
      const data = JSON.parse(bytes.toString('utf8'));
      sources.push({ path: path.relative(root, file).split(path.sep).join('/'), hash: hashText(bytes) });
      collect(data);
    }
  }
  for (const relative of ['manifest.json', 'sources', 'runs']) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) throw new Error(`Missing historical inventory input: ${relative}`);
    visit(file);
  }
  if (!sources.length) throw new Error('Historical inventory is empty');
  return {
    v: 1, inventoryIncomplete: false, sources,
    limitations: { organizationAliases: 'not-inferred', semanticDuplicates: 'not-screened', externalHistory: 'not-inventoried' },
    domains: [...domains].sort(), organizationIds: [...organizationIds].sort(), sourceHashes: [...sourceHashes].sort()
  };
}

module.exports = { buildHistory };
