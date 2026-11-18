'use strict';
const assert=require('node:assert/strict'), fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const {localPaths,localTree}=require('../tools/maintenance-local-path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'tos-path-batch-'));
try {
  const a=path.join(root,'a.txt'),b=path.join(root,'b.txt');
  fs.writeFileSync(a,'a');fs.writeFileSync(b,'b');
  assert.deepEqual(localPaths([a,b]),[a,b]);
  assert.deepEqual(localTree(root).sort(),[a,b].sort());
  assert.throws(()=>localPaths([a,'\\\\server\\share\\file']),/UNC/);
  assert.throws(()=>localPaths([a,path.join(root,'missing.txt')]),/verification failed/i);
  const target=path.join(root,'target'),link=path.join(root,'junction');
  fs.mkdirSync(target);fs.writeFileSync(path.join(target,'data'),'fixture');
  fs.symlinkSync(target,link,'junction');
  assert.throws(()=>localPaths([a,path.join(link,'data')]),/Reparse|junction/i);
  assert.throws(()=>localTree(root),/Reparse|junction/i);
  assert.throws(()=>localPaths([]),/Nonempty/);
  console.log('PASS batched native path checks retain UNC, missing-path and second-entry junction rejection');
} finally { fs.rmSync(root,{recursive:true,force:true}); }
