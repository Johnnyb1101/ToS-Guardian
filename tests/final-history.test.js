'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildHistory } = require('../tools/final-history-lib');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-final-history-'));
try {
  fs.mkdirSync(path.join(root, 'sources')); fs.mkdirSync(path.join(root, 'runs'));
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({sites:{'old.example.com':{textHash:'a'.repeat(64)}}}));
  fs.writeFileSync(path.join(root, 'runs', 'run.json'), JSON.stringify({sites:['other.example.com'], organizationId:'old-org', analysisSource:'Historical exact source'}));
  const first = buildHistory(root);
  assert.deepEqual(first.domains, ['old.example.com', 'other.example.com']);
  assert.deepEqual(first.organizationIds, ['old-org']);
  assert(first.sourceHashes.includes(crypto.createHash('sha256').update('Historical exact source').digest('hex')));
  assert.deepEqual(first, buildHistory(root));
  const hash = first.sources.find(s=>s.path==='runs/run.json').hash;
  fs.appendFileSync(path.join(root, 'runs', 'run.json'), '\n');
  assert.notEqual(buildHistory(root).sources.find(s=>s.path==='runs/run.json').hash, hash);
  fs.writeFileSync(path.join(root, 'sources', 'invalid.json'), '{');
  assert.throws(()=>buildHistory(root), SyntaxError);
  fs.unlinkSync(path.join(root, 'sources', 'invalid.json'));
  fs.unlinkSync(path.join(root, 'manifest.json'));
  assert.throws(()=>buildHistory(root), /Missing historical/);
  console.log('Historical inventory: domain/org/source overlap, deterministic inventory, changed bytes, and missing/corrupt inputs checked; PASS');
} finally {
  const resolved=fs.realpathSync(root),temp=fs.realpathSync(os.tmpdir());
  if(!resolved.startsWith(temp+path.sep)||!path.basename(resolved).startsWith('tg-final-history-'))throw Error('Unsafe test cleanup');
  fs.rmSync(resolved,{recursive:true,force:true});
}
