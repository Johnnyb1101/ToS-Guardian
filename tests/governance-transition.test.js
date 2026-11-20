'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const G=require('../tools/governance-transition'),C=require('../tools/final-corpus-lib');
const {makeRelease,makeLesson}=require('./final-test-fixtures');const {releaseConfigHash,checkAuthorization}=require('../tools/sites-lib');
const clone=x=>JSON.parse(JSON.stringify(x));
const pair=()=>crypto.generateKeyPairSync('ed25519');
const owner=pair(),online=pair(),wrong=pair();
const pem=k=>k.export({type:'spki',format:'pem'});
const fp=k=>crypto.createHash('sha256').update(k.export({type:'spki',format:'der'})).digest('hex');
function release(seed){const r=makeRelease([]);r.config.policy.versions.serverPipeline=C.hashText(seed);r.config.policy.cache={shared:'disabled'};r.configHash=releaseConfigHash(r.config);return r;}
const manifest=(name,seed)=>C.seal({files:[{path:name,bytes:1,sha256:C.hashText(seed)}]});
function rawInput(){const baseline=release('old');return {destination:{environment:'test',projectId:'fixture-project',serviceId:'fixture-service',databaseId:'fixture-database'},active:{generation:7,configHash:baseline.configHash,headHash:C.hashText('release-head'),governanceEpoch:0,governanceRegistryId:'fixture-registry',governanceHeadHash:C.hashText('gov-head'),installedVerifierHash:C.hashText('old-verifier'),installedMigrationManifestHash:C.hashText('installed-migrations'),halted:false},standardDocumentHash:C.hashText('fixture standard'),verifierHash:C.hashText('fixture verifier'),ownerKeyFingerprint:fp(owner.publicKey),baseline,candidate:release('new'),baselineManifest:manifest('index.js','old'),candidateManifest:manifest('index.js','new'),migrationManifest:manifest('migrations/001.sql','migration')};}
function input(){const i=rawInput();i.candidate.config.policy.versions.migrationManifest=i.migrationManifest.hash;i.candidate.configHash=releaseConfigHash(i.candidate.config);return i;}
function withRecovery(i=input()){
 const release=clone(i.candidate);
 release.config.policy.versions.serverPipeline=C.hashText('recovery pipeline');
 release.configHash=releaseConfigHash(release.config);
 return {...i,baselineManifest:manifest('artifacts/release-build','B'),candidateManifest:manifest('artifacts/release-build','C'),recovery:{release,manifest:manifest('artifacts/release-build','R')}};
}
const meta={authorizationId:'synthetic_authorization_0001',issuedAt:'2026-11-15T00:00:00Z',expiresAt:'2026-11-15T01:00:00Z'};
function context(p){return {trustedOwnerKey:pem(owner.publicKey),onlinePublicKeys:[pem(online.publicKey)],destination:clone(p.destination),active:clone(p.active),reviewedPlanHash:p.hash,reviewedVerifierHash:p.verifierHash,reviewedStandardHash:p.standardDocumentHash,consumedAuthorizationIds:[],now:'2026-11-15T00:30:00Z'};}
function envelope(p,m=meta,key=owner.privateKey,purpose=G.PURPOSE){const payload=G.payloadFor(p,m);return {payload,signature:crypto.sign(null,Buffer.from(purpose+C.canonicalJson(payload)),key).toString('base64')};}
let n=0;function test(s,f){f();n++;console.log('ok '+s);}
test('independent ephemeral fixture signature verifies without authorizing adoption',()=>{const p=G.preparePlan(input()),r=G.verifyEnvelope(envelope(p),p,context(p));assert.equal(r.valid,true);assert.equal(r.envelopeIntegrityVerified,true);for(const k of ['adoptionAllowed','productionReady','productionApplied','releasePromotionEligible'])assert.equal(r[k],false);});
test('wrong key, wrong purpose, embedded key, old kind and missing key rejected',()=>{const p=G.preparePlan(input());assert.equal(G.verifyEnvelope(envelope(p,meta,wrong.privateKey),p,context(p)).valid,false);assert.equal(G.verifyEnvelope(envelope(p,meta,owner.privateKey,'tos-guardian.release-activation.v2\n'),p,context(p)).valid,false);const e=envelope(p);e.publicKey=pem(owner.publicKey);assert.equal(G.verifyEnvelope(e,p,context(p)).valid,false);const c=context(p);c.trustedOwnerKey=null;assert.equal(G.verifyEnvelope(envelope(p),p,c).valid,false);const e2=envelope(p);e2.payload.kind='baseline-bootstrap';assert.equal(G.verifyEnvelope(e2,p,context(p)).valid,false);});
test('owner must differ from known online keys and match pinned identity',()=>{const p=G.preparePlan(input()),c=context(p);c.onlinePublicKeys=[pem(owner.publicKey)];assert.equal(G.verifyEnvelope(envelope(p),p,c).valid,false);c.onlinePublicKeys=[];assert.equal(G.verifyEnvelope(envelope(p),p,c).valid,false);c.onlinePublicKeys=[pem(online.publicKey)];c.trustedOwnerKey=pem(wrong.publicKey);assert.equal(G.verifyEnvelope(envelope(p),p,c).valid,false);});
test('snapshot, registry, database, verifier and review pins cannot drift',()=>{const p=G.preparePlan(input());for(const mutate of [c=>c.active.generation++,c=>c.active.governanceHeadHash=C.hashText('other'),c=>c.active.governanceRegistryId='other',c=>c.active.installedMigrationManifestHash=C.hashText('other'),c=>c.destination.databaseId='other',c=>c.reviewedVerifierHash=C.hashText('other'),c=>c.reviewedPlanHash=C.hashText('other')]){const c=context(p);mutate(c);assert.equal(G.verifyEnvelope(envelope(p),p,c).valid,false);}});
test('consumed ID and epoch downgrade denied; no release generation reset',()=>{const p=G.preparePlan(input()),c=context(p);c.consumedAuthorizationIds=[meta.authorizationId];assert.equal(G.verifyEnvelope(envelope(p),p,c).valid,false);for(const mutate of [i=>i.active.governanceEpoch=1,i=>i.active.generation=0,i=>i.active.halted=true]){const i=input();mutate(i);assert.throws(()=>G.preparePlan(i));}});
test('expiry, future issue, invalid clock and over24h lifetime denied',()=>{const p=G.preparePlan(input());for(const m of [{...meta,expiresAt:'2026-11-15T00:20:00Z'},{...meta,issuedAt:'2026-11-15T00:40:00Z'},{...meta,expiresAt:'2026-11-17T00:00:00Z'}])assert.equal(G.verifyEnvelope(envelope(p,m),p,context(p)).valid,false);const c=context(p);c.now='invalid';assert.equal(G.verifyEnvelope(envelope(p),p,c).valid,false);});
test('learning, model, prompt and cache changes forbidden even if config rehashed',()=>{for(const mutate of [r=>r.config.policy.cache.shared='enabled',r=>r.config.policy.models.anthropic.default='other',r=>r.config.policy.promptHashes.analyzer=C.hashText('other')]){const i=input();mutate(i.candidate);i.candidate.configHash=releaseConfigHash(i.candidate.config);assert.throws(()=>G.preparePlan(i),/Forbidden/);}});
test('manifest tamper, collision paths and unknown fields rejected',()=>{const p=G.preparePlan(input());p.candidateManifest.files[0].sha256=C.hashText('tampered');assert.throws(()=>G.validatePlan(p),/Manifest/);const i=input();i.extra=true;assert.throws(()=>G.preparePlan(i),/fields/);assert.throws(()=>G.checkManifest(C.seal({files:[{path:'A.js',sha256:C.hashText('a'),bytes:1},{path:'a.js',sha256:C.hashText('a'),bytes:1}]})),/Duplicate/);assert.throws(()=>G.checkManifest(manifest('../escape','a')),/path/);});
test('migration order bound and altered payload rejected',()=>{const i=input();i.migrationManifest=C.seal({files:[{path:'migrations/002.sql',sha256:C.hashText('b'),bytes:1},{path:'migrations/001.sql',sha256:C.hashText('a'),bytes:1}]});i.candidate.config.policy.versions.migrationManifest=i.migrationManifest.hash;i.candidate.configHash=releaseConfigHash(i.candidate.config);const p=G.preparePlan(i),e=envelope(p);const q=clone(p);q.migrationManifest=C.seal({files:[...q.migrationManifest.files].reverse()});const {hash,...body}=q;const altered=C.seal(body);assert.equal(G.verifyEnvelope(e,altered,context(altered)).valid,false);e.payload.nextGovernanceEpoch=2;assert.equal(G.verifyEnvelope(e,p,context(p)).valid,false);});
test('separator collision, malformed runtime identity and unbound migration rejected',()=>{for(const mutate of [i=>{i.candidate.config.policy.versions.serverPipeline=i.baseline.config.policy.versions.serverPipeline;i.candidate.config.policy['versions.serverPipeline']='collision';},i=>delete i.candidate.config.policy.versions.serverPipeline,i=>i.candidate.config.policy.versions.serverPipeline={},i=>i.candidate.config.policy.versions.storageSchema='invalid',i=>i.candidate.config.policy.versions.migrationManifest=C.hashText('wrong')]){const i=input();mutate(i);i.candidate.configHash=releaseConfigHash(i.candidate.config);assert.throws(()=>G.preparePlan(i));}});
test('ordinary release gate rejects governance envelope',()=>{const p=G.preparePlan(input());assert.equal(checkAuthorization(envelope(p),p.candidate,pem(owner.publicKey)).valid,false);});
test('v1 plans keep their original hash and envelope shape when recovery is optional',()=>{
 const {recovery,...i}=withRecovery();
 const original=C.seal({v:1,kind:'governance-transition-plan',...i,nextGovernanceEpoch:1,fromStandard:'step2-final/v2',toStandard:'maintenance-final/v1',policyDiff:['policy.versions.migrationManifest','policy.versions.serverPipeline']});
 assert.deepEqual(G.preparePlan(i),original);
 const extended=G.preparePlan({...i,recovery}),signed=envelope(extended);
 assert.equal(G.verifyEnvelope(signed,extended,context(extended)).valid,true);
 assert.deepEqual(signed.payload,{...envelope(original).payload,planHash:extended.hash});
 assert.notEqual(original.hash,extended.hash);
 assert.equal(G.verifyEnvelope(signed,original,context(original)).valid,false);
 assert.equal(G.verifyEnvelope(envelope(original),extended,context(extended)).valid,false);
});
test('recovery reserves two exactly representable forward generations',()=>{
 const i=withRecovery();
 i.active.generation=Number.MAX_SAFE_INTEGER-2;
 assert.doesNotThrow(()=>G.preparePlan(i));
 i.active.generation++;
 assert.throws(()=>G.preparePlan(i),/Insufficient release generations/);
 delete i.recovery;
 assert.doesNotThrow(()=>G.preparePlan(i));
});
test('signed adoption pins the exact recovery release and complete build manifest',()=>{
 const i=withRecovery(),p=G.preparePlan(i),signed=envelope(p);
 for(const mutate of [
  r=>{r.release.config.policy.versions.serverPipeline=C.hashText('other pipeline');r.release.configHash=releaseConfigHash(r.release.config);},
  r=>{r.manifest=manifest('artifacts/release-build','S');},
  r=>{r.manifest=C.seal({files:[{...r.manifest.files[0],bytes:2}]});},
  r=>{r.manifest=C.seal({files:[...r.manifest.files,...manifest('index.js','source').files]});}
 ]){
  const changed=clone(i);mutate(changed.recovery);
  assert.throws(()=>G.validatePlan({...p,recovery:changed.recovery}),/Plan hash mismatch/);
  const updated=G.preparePlan(changed);
  assert.equal(G.verifyEnvelope(signed,updated,context(updated)).valid,false);
 }
});
test('recovery requires nonempty distinct builds for all three releases',()=>{
 for(const index of [0,1,2]){
  const i=withRecovery();
  const sources=[i.baselineManifest,i.candidateManifest,i.recovery.manifest];
  const source=sources[index],other=sources[(index+1)%sources.length].files[0];
  for(const [file,reason] of [
   [{...source.files[0],path:'source/index.js'},/nonempty artifacts/],
   [{...source.files[0],bytes:0},/nonempty artifacts/],
   [{...other,bytes:other.bytes+1},/distinct release-build digests/]
  ]){
   Object.assign(source,C.seal({files:[file]}));
   assert.throws(()=>G.preparePlan(i),reason);
  }
 }
});
test('recovery must be distinct and preserve candidate schema, migration and learning configuration',()=>{
 for(const mutate of [
  config=>{config.policy.versions.migrationManifest=C.hashText('other migration');},
  config=>{config.policy.versions.storageSchema=C.hashText('other storage schema');},
  config=>{config.policy.versions.baselineSchema=C.hashText('other baseline schema');},
  config=>{config.policy.models.anthropic.default='other';},
  config=>{config.policy.promptHashes.analyzer=C.hashText('other prompt');},
  config=>{config.lessons=[makeLesson(0)];}
 ]){
  const i=withRecovery(),r=i.recovery.release;
  mutate(r.config);r.configHash=releaseConfigHash(r.config);
  assert.throws(()=>G.preparePlan(i),/changing only/);
 }
 const i=withRecovery();
 i.recovery.release=clone(i.candidate);
 assert.throws(()=>G.preparePlan(i),/distinct/);
 i.baseline.config.policy.versions.migrationManifest=i.migrationManifest.hash;
 i.active.configHash=i.baseline.configHash=releaseConfigHash(i.baseline.config);
 i.recovery.release=clone(i.baseline);
 assert.throws(()=>G.preparePlan(i),/distinct/);
 for(const release of [i.baseline,i.candidate]){
  release.config.policy.cache.shared='enabled';
  release.configHash=releaseConfigHash(release.config);
 }
 i.active.configHash=i.baseline.configHash;
 assert.throws(()=>G.preparePlan(withRecovery(i)),/disabled shared cache/);
});
test('recovery rejects malformed release, fields and missing or empty build artifacts',()=>{
 for(const mutate of [
  i=>{i.recovery=null;},i=>{i.recovery.extra=true;},i=>{delete i.recovery.manifest;},
  i=>{i.recovery.release.configHash=C.hashText('invalid');},
  i=>{const r=i.recovery.release;r.config.policy.versions.serverPipeline='other';r.configHash=releaseConfigHash(r.config);},
  i=>{i.recovery.manifest=manifest('source/index.js','R');},
  i=>{i.recovery.manifest=C.seal({files:[{...i.recovery.manifest.files[0],bytes:0}]});},
  i=>{i.recovery.manifest.files[0].bytes++;}
 ]){
  const i=withRecovery();mutate(i);
  assert.throws(()=>G.preparePlan(i));
 }
});
if(process.platform==='win32')test('local file capture checks actual bytes and changed contents',()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'governance-fixture-'));try{fs.writeFileSync(path.join(root,'a.js'),'first');const a=G.captureManifest(root,['a.js']);fs.writeFileSync(path.join(root,'a.js'),'second');const b=G.captureManifest(root,['a.js']);assert.notEqual(a.hash,b.hash);assert.throws(()=>G.captureManifest(root,['../escape']));}finally{fs.rmSync(path.join(root,'a.js'));fs.rmdirSync(root);}});
else test('filesystem capture fails closed off Windows',()=>assert.throws(()=>G.captureManifest('/tmp',['a.js']),/Windows/));
console.log(n+' governance integrity test groups passed; ephemeral fixture signatures only');
