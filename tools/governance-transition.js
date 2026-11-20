'use strict';
// Offline governance envelope integrity only. No signer, network, persistence or activation API.
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {canonicalJson,digest,seal}=require('./final-corpus-lib');
const {checkRelease}=require('./sites-lib');
const {localPath}=require('./maintenance-local-path');
const {MAX_BUILD_BYTES}=require('./maintenance-final-evidence');
const PURPOSE='tos-guardian.governance-transition.v3\n';
const HASH=/^[a-f0-9]{64}$/;
const BUILD_ARCHIVE='artifacts/release-build';
const MAX_FILE_BYTES=64000000;
const RESULTS=Object.freeze({transitionReady:false,adoptionAllowed:false,productionReady:false,productionApplied:false,releasePromotionEligible:false});
const ALLOWED_DIFFS=['policy.versions.serverPipeline','policy.versions.storageSchema','policy.versions.baselineSchema','policy.versions.migrationManifest'];
function exact(v,keys,label){canonicalJson(v);if(!v||typeof v!=='object'||Array.isArray(v)||JSON.stringify(Object.keys(v).sort())!==JSON.stringify([...keys].sort()))throw Error('Invalid '+label+' fields');}
function hash(v,label){if(typeof v!=='string'||!HASH.test(v))throw Error('Invalid '+label);}
function identifier(v,label){if(typeof v!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v))throw Error('Invalid '+label);}
function relative(v){if(typeof v!=='string'||!v||v.length>240||!/^[A-Za-z0-9._/-]+$/.test(v)||v.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('Invalid manifest path');}
// Ordered manifests are the SQL migration inventory, not a build bundle.
function fileLimit(name,ordered){return !ordered&&name===BUILD_ARCHIVE?MAX_BUILD_BYTES:MAX_FILE_BYTES;}
function checkManifest(m,ordered=false){
 exact(m,['files','hash'],'manifest');if(!Array.isArray(m.files)||!m.files.length||m.files.length>10000)throw Error('Invalid manifest files');
 const names=[];
 for(const f of m.files){exact(f,['path','sha256','bytes'],'manifest file');relative(f.path);hash(f.sha256,'file digest');if(!Number.isSafeInteger(f.bytes)||f.bytes<0||f.bytes>fileLimit(f.path,ordered))throw Error('Invalid file size');names.push(f.path);}
 if(new Set(names.map(n=>n.toLowerCase())).size!==names.length)throw Error('Duplicate manifest paths');
 if(!ordered&&JSON.stringify(names)!==JSON.stringify([...names].sort()))throw Error('Unsorted source manifest');
 if(m.hash!==digest({files:m.files}))throw Error('Manifest hash mismatch');
}
function captureManifest(directory,paths,{ordered=false}={}){
 if(!Array.isArray(paths))throw Error('Paths required');
 const root=localPath(directory), names=ordered?[...paths]:[...paths].sort();
 const files=names.map(name=>{
  relative(name);
  const file=localPath(path.join(root,...name.split('/')));
  const fd=fs.openSync(file,'r');
  try{
   const before=fs.fstatSync(fd);
   const limit=fileLimit(name,ordered);
   if(!before.isFile()||before.size>limit)throw Error('Not a bounded regular file');
   if(limit===MAX_FILE_BYTES){
    const bytes=fs.readFileSync(fd);
    return {path:name,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};
   }
   const digest=crypto.createHash('sha256'),buffer=Buffer.alloc(1024*1024);
   let bytes=0;
   for(;;){
    const count=fs.readSync(fd,buffer,0,Math.min(buffer.length,limit-bytes+1),null);
    if(count===0)break;
    bytes+=count;
    if(bytes>limit)throw Error('Build archive grew beyond its limit during capture');
    digest.update(buffer.subarray(0,count));
   }
   const after=fs.fstatSync(fd);
   if(bytes!==before.size||bytes!==after.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw Error('Build archive changed during capture');
   return {path:name,sha256:digest.digest('hex'),bytes};
  }finally{fs.closeSync(fd);}
 });
 const m=seal({files});checkManifest(m,ordered);return m;
}
function rejectSeparatorKeys(value){if(value&&typeof value==='object'){for(const key of Object.keys(value)){if(key.includes('.'))throw Error('Configuration separator keys are forbidden');rejectSeparatorKeys(value[key]);}}}
function differences(a,b,p=''){
 if(canonicalJson(a)===canonicalJson(b))return [];
 if(a&&b&&typeof a==='object'&&typeof b==='object'&&!Array.isArray(a)&&!Array.isArray(b)){
  return [...new Set([...Object.keys(a),...Object.keys(b)])].sort().flatMap(k=>{
   const q=p?p+'.'+k:k;
   if(!Object.hasOwn(a,k)||!Object.hasOwn(b,k))return [q];
   return differences(a[k],b[k],q);
  });
 }
 return [p];
}
function checkDestination(d){exact(d,['environment','projectId','serviceId','databaseId'],'destination');if(typeof d.environment!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(d.environment))throw Error('Invalid environment');for(const k of ['projectId','serviceId','databaseId'])identifier(d[k],k);}
function checkActive(a){
 exact(a,['generation','configHash','headHash','governanceEpoch','governanceRegistryId','governanceHeadHash','installedVerifierHash','installedMigrationManifestHash','halted'],'active snapshot');
 if(!Number.isSafeInteger(a.generation)||a.generation<1||a.governanceEpoch!==0||a.halted!==false)throw Error('Initial governance transition requires existing unhalted epoch zero state');
 hash(a.configHash,'active configuration');hash(a.headHash,'active head');identifier(a.governanceRegistryId,'governance registry');for(const k of ['governanceHeadHash','installedVerifierHash','installedMigrationManifestHash'])hash(a[k],k);
}
function validatePlan(plan){
 const optionalFields=plan&&Object.hasOwn(plan,'recovery')?['recovery']:[];
 exact(plan,['v','kind','destination','active','nextGovernanceEpoch','fromStandard','toStandard','standardDocumentHash','verifierHash','ownerKeyFingerprint','baseline','candidate','baselineManifest','candidateManifest','migrationManifest','policyDiff','hash',...optionalFields],'plan');
 if(plan.v!==1||plan.kind!=='governance-transition-plan'||plan.nextGovernanceEpoch!==1||plan.fromStandard!=='step2-final/v2'||plan.toStandard!=='maintenance-final/v1')throw Error('Unsupported governance transition');
 checkDestination(plan.destination);checkActive(plan.active);
 hash(plan.standardDocumentHash,'standard document');hash(plan.verifierHash,'verifier');hash(plan.ownerKeyFingerprint,'owner key fingerprint');
 for(const r of [plan.baseline,plan.candidate]){rejectSeparatorKeys(r.config);const c=checkRelease(r);if(!c.valid)throw Error('Invalid release: '+c.reason);hash(r.config.policy.versions.serverPipeline,'serverPipeline');for(const key of ['storageSchema','baselineSchema','migrationManifest'])if(Object.hasOwn(r.config.policy.versions,key))hash(r.config.policy.versions[key],key);}
 if(plan.active.configHash!==plan.baseline.configHash||plan.baseline.configHash===plan.candidate.configHash)throw Error('Baseline/candidate binding mismatch');
 checkManifest(plan.baselineManifest);checkManifest(plan.candidateManifest);checkManifest(plan.migrationManifest,true);if(plan.candidate.config.policy.versions.migrationManifest!==plan.migrationManifest.hash)throw Error('Candidate migration manifest binding mismatch');
 const diff=differences(plan.baseline.config,plan.candidate.config);
 if(!diff.includes('policy.versions.serverPipeline')||diff.some(p=>!ALLOWED_DIFFS.includes(p))||canonicalJson(plan.policyDiff)!==canonicalJson(diff))throw Error('Forbidden or inaccurate configuration diff');
 if(Object.hasOwn(plan,'recovery')){
  if(plan.active.generation>Number.MAX_SAFE_INTEGER-2)throw Error('Insufficient release generations for adoption and recovery');
  exact(plan.recovery,['release','manifest'],'recovery');
  const {release,manifest}=plan.recovery;
  const checked=checkRelease(release);
  if(!checked.valid)throw Error('Invalid recovery release: '+checked.reason);
  rejectSeparatorKeys(release.config);
  hash(release.config.policy.versions.serverPipeline,'recovery serverPipeline');
  if(release.config.policy.cache?.shared!=='disabled')throw Error('Recovery requires disabled shared cache');
  const changes=differences(plan.candidate.config,release.config);
  if(release.configHash===plan.baseline.configHash||changes.length!==1||changes[0]!=='policy.versions.serverPipeline')throw Error('Recovery must be a distinct release changing only the candidate serverPipeline');
  checkManifest(manifest);
  const buildDigests=[plan.baselineManifest,plan.candidateManifest,manifest].map(source=>{
   const build=source.files.find(file=>file.path===BUILD_ARCHIVE);
   if(!build||build.bytes===0)throw Error('Each recovery plan manifest requires a nonempty artifacts/release-build');
   return build.sha256;
  });
  if(new Set(buildDigests).size!==buildDigests.length)throw Error('Recovery plan requires three distinct release-build digests');
 }
 const {hash:h,...body}=plan;if(h!==digest(body))throw Error('Plan hash mismatch');
 return plan;
}
function preparePlan(input){
 const optionalFields=input&&Object.hasOwn(input,'recovery')?['recovery']:[];
 exact(input,['destination','active','standardDocumentHash','verifierHash','ownerKeyFingerprint','baseline','candidate','baselineManifest','candidateManifest','migrationManifest',...optionalFields],'plan input');
 const p=seal({v:1,kind:'governance-transition-plan',...input,nextGovernanceEpoch:1,fromStandard:'step2-final/v2',toStandard:'maintenance-final/v1',policyDiff:differences(input.baseline.config,input.candidate.config)});
 validatePlan(p);return p;
}
function payloadFor(plan,{authorizationId,issuedAt,expiresAt}){
 validatePlan(plan);
 return {v:3,kind:'governance-transition',action:'adopt-maintenance-standard',authorizationId,issuedAt,expiresAt,planHash:plan.hash,destination:plan.destination,expected:plan.active,nextGovernanceEpoch:1,fromStandard:plan.fromStandard,toStandard:plan.toStandard,baselineConfigHash:plan.baseline.configHash,candidateConfigHash:plan.candidate.configHash,baselineManifestHash:plan.baselineManifest.hash,candidateManifestHash:plan.candidateManifest.hash,migrationManifestHash:plan.migrationManifest.hash,standardDocumentHash:plan.standardDocumentHash,verifierHash:plan.verifierHash,ownerKeyFingerprint:plan.ownerKeyFingerprint};
}
function keyIdentity(pem){const k=crypto.createPublicKey(pem);if(k.asymmetricKeyType!=='ed25519')throw Error('Owner key must be Ed25519');return k.export({type:'spki',format:'der'}).toString('hex');}
function message(payload){return PURPOSE+canonicalJson(payload);}
function verifyEnvelope(envelope,plan,context){
 try{
  validatePlan(plan);
  exact(envelope,['payload','signature'],'envelope');
  exact(context,['trustedOwnerKey','onlinePublicKeys','destination','active','reviewedPlanHash','reviewedVerifierHash','reviewedStandardHash','consumedAuthorizationIds','now'],'trusted context');
  const owner=keyIdentity(context.trustedOwnerKey);if(crypto.createHash('sha256').update(Buffer.from(owner,'hex')).digest('hex')!==plan.ownerKeyFingerprint)throw Error('Owner identity binding mismatch');
  if(!Array.isArray(context.onlinePublicKeys)||!context.onlinePublicKeys.length||context.onlinePublicKeys.some(k=>keyIdentity(k)===owner))throw Error('Independent owner and known online keys required');
  checkDestination(context.destination);checkActive(context.active);
  if(canonicalJson(context.destination)!==canonicalJson(plan.destination)||canonicalJson(context.active)!==canonicalJson(plan.active))throw Error('Destination or current state mismatch');
  if(context.reviewedPlanHash!==plan.hash||context.reviewedVerifierHash!==plan.verifierHash||context.reviewedStandardHash!==plan.standardDocumentHash)throw Error('Operator-reviewed pins mismatch');
  const p=envelope.payload;
  if(!p||typeof p.authorizationId!=='string'||!/^[a-zA-Z0-9_-]{16,128}$/.test(p.authorizationId))throw Error('Invalid authorization id');
  if(!Array.isArray(context.consumedAuthorizationIds)||context.consumedAuthorizationIds.some(i=>typeof i!=='string')||context.consumedAuthorizationIds.includes(p.authorizationId))throw Error('Authorization already consumed or unknown consumption state');
  const expected=payloadFor(plan,{authorizationId:p.authorizationId,issuedAt:p.issuedAt,expiresAt:p.expiresAt});
  if(canonicalJson(p)!==canonicalJson(expected))throw Error('Authorization does not exactly bind plan');
  const now=Date.parse(context.now),issued=Date.parse(p.issuedAt),expires=Date.parse(p.expiresAt);
  if([context.now,p.issuedAt,p.expiresAt].some(t=>typeof t!=='string')||![now,issued,expires].every(Number.isFinite)||issued>now||expires<=now||expires<=issued||expires-issued>86400000)throw Error('Invalid, expired or excessive approval lifetime');
  if(typeof envelope.signature!=='string'||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(envelope.signature))throw Error('Invalid signature encoding');
  const sig=Buffer.from(envelope.signature,'base64');
  if(sig.length!==64||sig.toString('base64')!==envelope.signature||!crypto.verify(null,Buffer.from(message(p)),context.trustedOwnerKey,sig))throw Error('Owner signature does not verify');
  return {valid:true,envelopeIntegrityVerified:true,...RESULTS,authorizationHash:digest(envelope),planHash:plan.hash,limitations:['Only caller-supplied snapshot and consumed-ID view checked; no atomic consumption','No database privilege isolation or anti-downgrade enforcement','Manifests bind declared/captured bytes, not deployed provenance or completeness','No report passes, signing, production migration, deployment or activation']};
 }catch(e){return {valid:false,envelopeIntegrityVerified:false,...RESULTS,reason:e.message};}
}
module.exports={PURPOSE,RESULTS,MAX_FILE_BYTES,MAX_BUILD_BYTES,captureManifest,checkManifest,differences,preparePlan,validatePlan,payloadFor,message,verifyEnvelope};
