'use strict';
// Separate trust boundary. No server routes, signer, app secrets or default connection.
const crypto = require('node:crypto');
const C = require('../tools/final-corpus-lib');
const G = require('../tools/governance-transition');
const S = require('../tools/sites-lib');
const PURPOSE = 'tos-guardian.maintenance-control.v1\n';
const RECOVERY_PURPOSE = 'tos-guardian.maintenance-recovery.v1\n';
const EVENT_PURPOSE = 'tos-guardian.release-event.v2\n';
const clone = x => JSON.parse(C.canonicalJson(x));
const equal = (a,b) => C.canonicalJson(a) === C.canonicalJson(b);
function requireValid(ok, reason) { if (!ok) throw Error(reason); }
function keyFingerprint(pem) { const key=crypto.createPublicKey(pem); requireValid(key.asymmetricKeyType==='ed25519','Ed25519 public key required'); return crypto.createHash('sha256').update(key.export({type:'spki',format:'der'})).digest('hex'); }
function signature(envelope, key, purpose) {
  requireValid(envelope && equal(Object.keys(envelope).sort(),['payload','signature']), 'Invalid owner envelope');
  const sig=Buffer.from(envelope.signature||'','base64');
  requireValid(sig.length===64 && sig.toString('base64')===envelope.signature && crypto.verify(null,Buffer.from(purpose+C.canonicalJson(envelope.payload)),key,sig),'Owner signature failed');
}
function createController({transport, trustedOwnerKey, onlinePublicKeys, trustedReviewers=null, trustedRates=null, destination, reviewedPlan, measureVerifier, now=()=>new Date().toISOString()}) {
  requireValid(typeof trustedOwnerKey==='string' && Array.isArray(onlinePublicKeys) && onlinePublicKeys.every(k=>typeof k==='string'),'Immutable configured public-key strings required');
  const plan=clone(reviewedPlan), dest=clone(destination), keys=[...onlinePublicKeys];
  const reviewers=trustedReviewers===null?null:clone(trustedReviewers);
  const rates=trustedRates===null?null:clone(trustedRates);
  G.validatePlan(plan);
  const repeatable=plan.v===4;
  const standard=repeatable?plan.standard:plan.toStandard;
  const dependency=standard==='maintenance-dependency/v1';
  const phase=dependency?'maintenance-dependency':'maintenance-final';
  const artifacts={baseline:plan.baselineManifest.files.find(f=>f.path==='artifacts/release-build'),candidate:plan.candidateManifest.files.find(f=>f.path==='artifacts/release-build')};
  requireValid(artifacts.baseline && artifacts.candidate,'Signed complete build artifact descriptors required');
  const recoveryArtifact=plan.recovery?.manifest.files.find(file=>file.path==='artifacts/release-build');
  const needsArchiveLimit=[artifacts.baseline,artifacts.candidate,recoveryArtifact].some(file=>file && file.bytes>G.MAX_FILE_BYTES);
  const ownerFingerprint=keyFingerprint(trustedOwnerKey);
  requireValid(ownerFingerprint===plan.ownerKeyFingerprint && keys.length>0 && keys.every(k=>keyFingerprint(k)!==ownerFingerprint),'Independent pinned owner required');
  requireValid(equal(dest,plan.destination),'Pinned destination mismatch');
  function measure() { requireValid(measureVerifier()===plan.verifierHash,'Measured controller closure changed'); }
  async function prior(envelope, request) {
    measure();
    return transport.rpc('read_committed',[envelope.payload.authorizationId,C.canonicalJson(envelope),C.canonicalJson(request)]);
  }
  async function snapshot() { const state=await transport.rpc('read_state',[dest.environment]); requireValid(state && equal(state.destination,dest),'Measured database destination mismatch'); return state; }
  function verifyInstalledSupport(state) {
    requireValid(!repeatable || state.governanceVersion===4,'Repeatable governance migration must be installed before using a version 4 plan');
    requireValid(!plan.recovery || state.recoveryVersion===1,'Recovery migration must be installed before using a recovery plan');
    requireValid(!needsArchiveLimit || state.buildArchiveMaxBytes===G.MAX_BUILD_BYTES,'Build archive limit migration must be installed before using a large build archive');
  }
  async function publish(input, evidenceContext, recovery) {
      // Copy before any await so callers cannot change verified data before dispatch.
      const request=clone(input), envelope=request.controlEnvelope;
      requireValid(reviewers!==null,'Externally configured reviewer registry required');
      requireValid(!dependency || rates!==null,'Externally configured dependency rates required');
      requireValid(evidenceContext && equal(Object.keys(evidenceContext).sort(),['attachments','evidence','protocol']),'Evidence cannot supply reviewer trust or dependency rates');
      requireValid(!recovery || plan.recovery,'No recovery release was declared in the adopted plan');
      const kind = recovery ? 'maintenance-recovery' : 'maintenance-control';
      const source = recovery ? plan.candidate : plan.baseline;
      const target = recovery ? plan.recovery.release : plan.candidate;
      const sourceArtifact = recovery ? artifacts.candidate : artifacts.baseline;
      const targetArtifact = recovery ? recoveryArtifact : artifacts.candidate;
      const evidence={protocol:clone(evidenceContext.protocol),evidence:clone(evidenceContext.evidence),attachments:Object.fromEntries(Object.entries(evidenceContext.attachments).map(([key,value])=>[key,Buffer.from(value)])),trustedReviewers:reviewers};
      requireValid(equal(Object.keys(request).sort(),['authorization','controlEnvelope','event','release']),'Unexpected activation request fields');
      request.canonicalAuthorization=C.canonicalJson(request.authorization);
      request.canonicalRelease=C.canonicalJson({v:2,config:request.release.config});
      request.canonicalEvent=C.canonicalJson(request.event.body);
      signature(envelope,trustedOwnerKey,recovery ? RECOVERY_PURPOSE : PURPOSE);
      requireValid(envelope.payload?.kind===kind,'Wrong maintenance envelope kind');
      requireValid(equal(envelope.payload.destination??null,dest) && envelope.payload.planHash===plan.hash,'Maintenance envelope destination or plan mismatch');
      const previous=await prior(envelope,request); if(previous)return previous;
      const state=await snapshot(), active=state.active, auth=request.authorization, release=request.release, p=envelope.payload;
      verifyInstalledSupport(state);
      requireValid(active.governanceEpoch===plan.nextGovernanceEpoch && active.generation>=1 && active.halted===false,'Existing unhalted maintenance epoch required');
      requireValid(!repeatable || state.standard===standard,'Installed governance standard mismatch');
      requireValid(state.planHash===plan.hash && state.standardDocumentHash===plan.standardDocumentHash && active.installedVerifierHash===plan.verifierHash && active.installedMigrationManifestHash===plan.migrationManifest.hash,'Installed governance identity mismatch');
      const expected={v:1,kind,authorizationId:auth.payload.authorizationId,issuedAt:auth.payload.issuedAt,expiresAt:auth.payload.expiresAt,destination:dest,expected:active,planHash:plan.hash,authorizationHash:C.digest(auth),releaseHash:C.digest(release),eventHash:request.event.hash};
      requireValid(equal(p,expected),'Maintenance envelope binding mismatch');
      requireValid(Date.parse(p.expiresAt)-Date.parse(p.issuedAt)<=86400000,'Excessive owner approval lifetime');
      requireValid(auth.payload.action==='activate','Only forward publication is supported');
      requireValid(release.configHash===target.configHash && active.configHash===source.configHash,'Release outside adopted maintenance pair');
      if(recovery) {
        requireValid(equal(release,target),'Recovery release differs from the declared release');
        requireValid(active.generation===plan.active.generation+1,'Recovery requires the exact candidate generation');
      }
      requireValid(auth.payload.evidence.phase===phase,'Evidence phase does not match the adopted governance standard');
      const evidenceOptions=dependency?{dependencyEvidence:{...evidence,trustedRates:rates}}:{maintenanceEvidence:evidence};
      const checked=S.checkAuthorization(auth,release,trustedOwnerKey,{environment:dest.environment,active:{environment:dest.environment,...active},now:now(),...evidenceOptions});
      requireValid(checked.valid,checked.reason);
      if(dependency) {
        // Authorization verified the report and the attachment bytes bound by these descriptors.
        const {baseline,candidate}=evidence.protocol.builds;
        requireValid(baseline.configHash===source.configHash && candidate.configHash===target.configHash,'Evidence build pair mismatch');
        requireValid(baseline.image.sha256===sourceArtifact.sha256 && baseline.image.bytes===sourceArtifact.bytes &&
          candidate.image.sha256===targetArtifact.sha256 && candidate.image.bytes===targetArtifact.bytes,'Evidence artifacts differ from the adopted installed builds');
      } else {
        const M=require('../tools/maintenance-final-evidence');
        const report=M.validateFinalEvidence(evidence.protocol,evidence.evidence,{attachments:evidence.attachments,trustedReviewers:reviewers,now:now()});
        requireValid(report.promotionEligible===true && report.baselineConfigHash===active.configHash && report.configHash===release.configHash,'Evidence build pair mismatch');
        requireValid(report.baselineArtifactHash===sourceArtifact.sha256 && report.candidateArtifactHash===targetArtifact.sha256 && evidence.protocol.preparation.baseline.artifact.bytes===sourceArtifact.bytes && evidence.protocol.preparation.candidate.artifact.bytes===targetArtifact.bytes,'Evidence artifacts differ from the adopted installed builds');
      }
      const e=request.event,b=e.body;
      requireValid(keys.includes(e.publicKey) && S.verifySignature(e.publicKey,EVENT_PURPOSE+e.hash,e.signature) && C.digest(b)===e.hash,'Audit event signature failed');
      requireValid(b.v===2 && b.kind==='release-activated' && b.environment===dest.environment && b.generation===active.generation+1 && b.previousConfigHash===active.configHash && b.configHash===release.configHash && b.prevHash===active.headHash && b.authorizationId===p.authorizationId && b.authorizationHash===C.digest(auth) && Number.isFinite(Date.parse(b.createdAt)),'Audit event state mismatch');
      measure();
      return transport.rpc(recovery?'recover':'activate',[envelope,C.canonicalJson(envelope),request,C.canonicalJson(request)]);
  }
  return Object.freeze({
    async adopt(input) {
      const envelope=clone(input); signature(envelope,trustedOwnerKey,repeatable?G.PURPOSE_V4:G.PURPOSE);
      const {hash,...body}=plan;
      const previous=await prior(envelope,body); if(previous)return previous;
      const state=await snapshot();
      verifyInstalledSupport(state);
      if(repeatable && plan.fromGovernanceEpoch>0) {
        requireValid(state.publicationComplete===true,'Previous governance publication is incomplete');
        requireValid(equal(state.activeBuild??null,artifacts.baseline),'Baseline build differs from the previously published build');
      }
      const verified=G.verifyEnvelope(envelope,plan,{trustedOwnerKey,onlinePublicKeys:keys,destination:dest,active:state.active,reviewedPlanHash:plan.hash,reviewedVerifierHash:plan.verifierHash,reviewedStandardHash:plan.standardDocumentHash,consumedAuthorizationIds:[],now:now()});
      requireValid(verified.valid,verified.reason); measure();
      return transport.rpc('adopt',[envelope,C.canonicalJson(envelope),plan,C.canonicalJson(body)]);
    },
    activate(input, evidenceContext) { return publish(input,evidenceContext,false); },
    recover(input, evidenceContext) { return publish(input,evidenceContext,true); },
  });
}
module.exports={createController,PURPOSE,RECOVERY_PURPOSE,EVENT_PURPOSE,keyFingerprint};
