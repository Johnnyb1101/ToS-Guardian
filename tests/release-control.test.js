'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path'),fs=require('node:fs');
const C=require('../tools/final-corpus-lib'),G=require('../tools/governance-transition');
const {createController,PURPOSE,RECOVERY_PURPOSE}=require('../release-control/controller');
const {createTransport}=require('../release-control/transport');
const fixture=require('./maintenance-final-fixtures').makeFinalFixture({mode:'observed'});
const pair=()=>crypto.generateKeyPairSync('ed25519'),owner=pair(),online=pair(),pem=k=>k.export({type:'spki',format:'pem'});
const manifest=n=>C.seal({files:[{path:n,bytes:1,sha256:C.hashText(n)}]});
const baseline=fixture.builds.baseline.release,candidate=JSON.parse(JSON.stringify(fixture.builds.candidate.release));
const migrationManifest=manifest('migration.sql');candidate.config.policy.versions.migrationManifest=migrationManifest.hash;candidate.configHash=require('../tools/sites-lib').releaseConfigHash(candidate.config);
const destination={environment:'test',projectId:'fixture',serviceId:'fixture',databaseId:'fixture'};
const active={generation:1,configHash:baseline.configHash,headHash:C.hashText('head'),halted:false,governanceEpoch:0,governanceRegistryId:'fixture',governanceHeadHash:C.hashText('gov'),installedVerifierHash:C.hashText('old-verifier'),installedMigrationManifestHash:C.hashText('old-migration')};
const buildManifest=(name,arm)=>C.seal({files:[{path:'artifacts/release-build',bytes:fixture.builds[arm].artifact.bytes,sha256:fixture.builds[arm].artifact.sha256},...manifest(name).files]});
const plan=G.preparePlan({destination,active,baseline,candidate,baselineManifest:buildManifest('old.js','baseline'),candidateManifest:buildManifest('new.js','candidate'),migrationManifest,standardDocumentHash:C.hashText('standard'),verifierHash:C.hashText('verifier'),ownerKeyFingerprint:crypto.createHash('sha256').update(owner.publicKey.export({type:'spki',format:'der'})).digest('hex')});
let calls=0;const config={transport:{rpc(){calls++;throw Error('unexpected database dispatch');}},trustedOwnerKey:pem(owner.publicKey),onlinePublicKeys:[pem(online.publicKey)],trustedReviewers:fixture.context.trustedReviewers,destination,reviewedPlan:plan,measureVerifier:()=>C.hashText('changed')};
const controller=createController(config);
const payload=G.payloadFor(plan,{authorizationId:'fixture_unit_adoption_0001',issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()});
const signed={payload,signature:crypto.sign(null,Buffer.from(G.message(payload)),owner.privateKey).toString('base64')};
(async()=>{
 await assert.rejects(controller.adopt(signed),/Measured controller closure changed/);assert.equal(calls,0);
 await assert.rejects(controller.adopt({...signed,signature:'invalid'}),/signature/);assert.equal(calls,0);
 await assert.rejects(controller.activate({},{}),/Evidence cannot supply reviewer trust/);assert.equal(calls,0);
 const evidenceContext={protocol:fixture.protocol,evidence:fixture.evidence,attachments:fixture.context.attachments};
 await assert.rejects(controller.recover({},evidenceContext),/No recovery release was declared/);assert.equal(calls,0);
 const recoveryRelease=structuredClone(candidate);
 recoveryRelease.config.policy.versions.serverPipeline=C.hashText('separate recovery runtime');
 recoveryRelease.configHash=require('../tools/sites-lib').releaseConfigHash(recoveryRelease.config);
 const recoveryPlan=G.preparePlan({
  destination,active,baseline,candidate,baselineManifest:plan.baselineManifest,candidateManifest:plan.candidateManifest,
  migrationManifest,standardDocumentHash:plan.standardDocumentHash,verifierHash:plan.verifierHash,
  ownerKeyFingerprint:plan.ownerKeyFingerprint,recovery:{release:recoveryRelease,manifest:manifest('artifacts/release-build')},
 });
 const adoption=G.payloadFor(recoveryPlan,{authorizationId:'fixture_recovery_adoption_001',issuedAt:payload.issuedAt,expiresAt:payload.expiresAt});
 const recoveryCalls=[];
 const recovery=createController({...config,reviewedPlan:recoveryPlan,measureVerifier:()=>recoveryPlan.verifierHash,transport:{rpc(name){
  recoveryCalls.push(name);
  if(name==='read_committed')return null;
  if(name==='read_state')return {destination,active};
  throw Error('unexpected publication');
 }}});
 const signedAdoption={payload:adoption,signature:crypto.sign(null,Buffer.from(G.message(adoption)),owner.privateKey).toString('base64')};
 await assert.rejects(recovery.adopt(signedAdoption),/Recovery migration must be installed/);
 assert.deepEqual(recoveryCalls,['read_committed','read_state']);
 for(const invalid of [{destination:{...destination,databaseId:'wrong'}},{planHash:C.hashText('other plan')}]) {
  const control={kind:'maintenance-recovery',destination,planHash:recoveryPlan.hash,...invalid};
  const envelope={payload:control,signature:crypto.sign(null,Buffer.from(RECOVERY_PURPOSE+C.canonicalJson(control)),owner.privateKey).toString('base64')};
  await assert.rejects(recovery.recover({
   controlEnvelope:envelope,authorization:{},release:recoveryRelease,event:{body:{}},
  },evidenceContext),/destination or plan mismatch/);
 }
 assert.deepEqual(recoveryCalls,['read_committed','read_state'],'a different destination or plan must not read a receipt');
 const standard='maintenance-dependency/v1';
 const {v,kind,nextGovernanceEpoch,fromStandard,toStandard,policyDiff,hash,recovery:recoveryInput,...planInput}=recoveryPlan;
 const laterActive={...active,governanceEpoch:1,generation:2};
 const laterPlan=G.preparePlan({...planInput,recovery:recoveryInput,active:laterActive,fromGovernanceEpoch:1,standard});
 const firstPlan=G.preparePlan({...planInput,fromGovernanceEpoch:0,standard});
 const versionedCalls=[];
 let state={destination,active:laterActive,governanceVersion:4,recoveryVersion:1,standard:'maintenance-final/v1',publicationComplete:false};
 const versioned=reviewedPlan=>createController({
  ...config,reviewedPlan,trustedRates:{},measureVerifier:()=>reviewedPlan.verifierHash,
  transport:{rpc(name,args){
   versionedCalls.push(name);
   if(name==='read_committed')return null;
   if(name==='read_state')return state;
   if(name==='adopt'){
    assert.deepEqual(args[2],reviewedPlan);
    return {adopted:true};
   }
   throw Error('unexpected publication');
  }},
 });
 const sign=(payload,message)=>({payload,signature:crypto.sign(null,Buffer.from(message),owner.privateKey).toString('base64')});
 const signAdoption=(reviewedPlan,purpose)=> {
  const approval=G.payloadFor(reviewedPlan,{...adoption,authorizationId:'fixture_versioned_adoption_01'});
  return sign(approval,purpose?purpose+C.canonicalJson(approval):G.message(approval));
 };
 const later=versioned(laterPlan);
 await assert.rejects(later.adopt(signAdoption(laterPlan,G.PURPOSE)),/signature/i);
 assert.deepEqual(versionedCalls,[]);
 await assert.rejects(later.adopt(signAdoption(laterPlan)),/Previous governance publication is incomplete/);
 assert.deepEqual(versionedCalls.splice(0),['read_committed','read_state']);
 state={...state,publicationComplete:true,activeBuild:laterPlan.baselineManifest.files.find(file=>file.path==='artifacts/release-build')};
 await assert.rejects(versioned(firstPlan).adopt(signAdoption(firstPlan)),/epoch|current state|snapshot/i);
 assert.deepEqual(versionedCalls.splice(0),['read_committed','read_state']);
 assert.deepEqual(await later.adopt(signAdoption(laterPlan)),{adopted:true});
 assert.deepEqual(versionedCalls.splice(0),['read_committed','read_state','adopt']);
 const installed={
  ...laterActive,governanceEpoch:laterPlan.nextGovernanceEpoch,
  installedVerifierHash:laterPlan.verifierHash,installedMigrationManifestHash:laterPlan.migrationManifest.hash,
 };
 state={...state,active:installed,standard,planHash:laterPlan.hash,standardDocumentHash:laterPlan.standardDocumentHash,publicationComplete:false};
 const authorization={payload:{action:'activate',authorizationId:adoption.authorizationId,issuedAt:adoption.issuedAt,expiresAt:adoption.expiresAt,evidence:{phase:'maintenance-final'}}};
 const event={body:{},hash:C.hashText('publication event')};
 const approval={
  v:1,kind:'maintenance-control',authorizationId:authorization.payload.authorizationId,
  issuedAt:authorization.payload.issuedAt,expiresAt:authorization.payload.expiresAt,destination,expected:installed,
  planHash:laterPlan.hash,authorizationHash:C.digest(authorization),releaseHash:C.digest(candidate),eventHash:event.hash,
 };
 const request={controlEnvelope:sign(approval,PURPOSE+C.canonicalJson(approval)),authorization,event,release:candidate};
 await assert.rejects(later.activate(request,evidenceContext),/Evidence phase does not match the adopted governance standard/);
 assert.deepEqual(versionedCalls.splice(0),['read_committed','read_state']);
 state={...state,standard:'maintenance-final/v1'};
 await assert.rejects(later.activate(request,evidenceContext),/Installed governance standard mismatch/);
 assert.deepEqual(versionedCalls.splice(0),['read_committed','read_state']);
 assert.throws(()=>createController({...config,onlinePublicKeys:[pem(owner.publicKey)]}),/Independent/);
 assert.throws(()=>createController({...config,destination:{...destination,databaseId:'wrong'}}),/destination/);
 const {hash:ignored,...body}=plan;const missingArtifact=C.seal({...body,candidateManifest:manifest('new.js')});
 assert.throws(()=>createController({...config,reviewedPlan:missingArtifact}),/artifact descriptors/);
 const inventory=fs.readFileSync(path.join(__dirname,'../release-control/catalog.sql'),'utf8').replace(/^--.*$/mg,'').trim().replace(/;$/,'');
 const forward=fs.readFileSync(path.join(__dirname,'../release-control/supabase/migrations/20261117230320_separated_release_control.sql'),'utf8');
 assert.equal(forward.split(inventory).length,3,'preflight and runtime inventory SQL must match reviewed source');
 const t={psql:process.execPath,host:'127.0.0.1',port:5432,database:'fixture',user:'tos_release_controller',password:'fixture',rootCertificate:__filename};
 assert.throws(()=>createTransport({...t,user:'service_role'}),/Restricted/);
 assert.throws(()=>createTransport({...t,host:'localhost sslmode=disable'}),/endpoint/);
 assert.throws(()=>createTransport({...t,rootCertificate:path.basename(__filename)}),/certificate/);
 assert.throws(()=>createTransport(t).rpc('arbitrary_sql',['drop table x']),/Unknown/);
 const cp=require('node:child_process'),spawn=cp.spawnSync,moduleId=require.resolve('../release-control/transport');let dispatched;
 try{
  cp.spawnSync=(executable,args,options)=>{dispatched={executable,args,options};return {status:0,stdout:'null'};};delete require.cache[moduleId];
  const fixed={...t},isolated=require('../release-control/transport').createTransport(fixed);fixed.psql='changed-after-construction';
  isolated.rpc('read_state',["x';\\! untrusted"]);
  assert.equal(dispatched.executable,process.execPath);
  assert.equal(dispatched.options.env.PGSSLMODE,'verify-full');assert.equal(dispatched.options.env.PGGSSENCMODE,'disable');
  assert.equal(dispatched.options.env.PGSSLCERTMODE,'disable');assert.equal(dispatched.options.env.PGSSLMINPROTOCOLVERSION,'TLSv1.2');
  assert.equal(dispatched.options.env.PGSERVICE,undefined);assert.equal(dispatched.options.env.PGSERVICEFILE,undefined);
  assert.ok(dispatched.args.includes('-X'));assert.ok(!dispatched.options.input.includes('untrusted'));
 }finally{cp.spawnSync=spawn;delete require.cache[moduleId];}
 console.log('PASS controller measurement/key/destination/trust failures before dispatch; fixed TLS transport inputs and RPC allowlist');
 console.log('PASS v4 adoption fences old epochs, unfinished publication and legacy signatures; publication fences mismatched standards and evidence phases');
})().catch(e=>{console.error(e);process.exitCode=1;});
