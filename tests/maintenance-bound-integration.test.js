'use strict';
// Explicit artifact integration suite. Usage: node tests/maintenance-bound-integration.test.js <reconstruction-root> [independently-frozen-bindings.json]
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {captureRuntime,executeBound}=require('../tools/maintenance-bound-runtime');
const {localPath}=require('../tools/maintenance-local-path');
const {canonicalJson}=require('../tools/final-corpus-lib');
const crypto=require('node:crypto');
const {prepareOpenAIRequest,recordOpenAIResponse}=require('../tools/maintenance-provider-preflight');
const root=process.argv[2];if(!root)throw Error('Reconstruction root required; no implicit filesystem search');
const releases={},captures={},historical={baseline:['2afe5ea938fe138ee68f2880bfcd3d65131431a49c5da121e81955dfddaab085','1157c355356c71522f330048aecef02f125f256601f2118f5597e19c87fbf7ab'],candidate:['1fad3448d9ba79e9c5a45b1b8d3923e90d7ffa4783b2ce6f7b2d58faca94d932','df75225533652938188308aff95a2472ed114a03d497dba15f79e8b2738316a0']};
const binding=process.argv[3]?JSON.parse(fs.readFileSync(localPath(process.argv[3]),'utf8')):null;
if(binding){
 assert.deepEqual(Object.keys(binding).sort(),['baseline','candidate']);
 for(const arm of ['baseline','candidate']){assert.deepEqual(Object.keys(binding[arm]).sort(),['captureHash','configHash','serverPipeline']);for(const value of Object.values(binding[arm]))assert.match(value,/^[a-f0-9]{64}$/);}
}
const expected=binding?Object.fromEntries(['baseline','candidate'].map(arm=>[arm,[binding[arm].configHash,binding[arm].serverPipeline]])):historical;
for(const arm of ['baseline','candidate']){
 releases[arm]=JSON.parse(fs.readFileSync(localPath(path.join(root,arm+'-release.json')),'utf8'));
 assert.equal(releases[arm].configHash,expected[arm][0]);assert.equal(releases[arm].config.policy.versions.serverPipeline,expected[arm][1]);
 captures[arm]=captureRuntime(path.join(root,arm));
 if(binding)assert.equal(captures[arm].manifest.hash,binding[arm].captureHash,'Exact artifact bytes differ from independently frozen binding');
}
const source='Privacy Policy. We collect account email addresses. Contact privacy@example.com to request deletion.';
const inputs=['anthropic','openai'].flatMap(provider=>[{operation:'analyzer',provider,domain:'example.com',documentText:source},{operation:'critic',provider,domain:'example.com',sourceText:source,analysisSummary:'The service collects account email addresses.'}]);
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
let groups=0;
for(const arm of ['baseline','candidate']){
 for(const input of inputs){
  const r=executeBound(captures[arm],releases[arm],input);
  assert.equal(r.result.configHash,expected[arm][0]);assert.equal(r.result.lessonCount,0);
  assert.equal(r.result.request.body.model,input.provider==='openai'?'gpt-4o-mini':'claude-sonnet-4-6');
  assert.equal(r.result.request.body.max_tokens,input.operation==='analyzer'?1200:1000);
  assert.equal(r.promotionEligible,false);
  assert.throws(()=>executeBound(captures[arm],releases[arm==='baseline'?'candidate':'baseline'],input),/does not match/);
  const altered=JSON.parse(JSON.stringify(captures[arm]));altered.sources['analysisOperations.js']+='\n// altered';
  assert.throws(()=>executeBound(altered,releases[arm],input),/changed/);
  if(input.provider==='openai'){
   const request=r.result.request,preparation=prepareOpenAIRequest(request);
   const observation=recordOpenAIResponse(request,preparation,{object:'chat.completion',model:request.body.model,choices:[{index:0,message:{role:'assistant',content:'Fixture response.',refusal:null},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:10,total_tokens:110,prompt_tokens_details:{cached_tokens:0}}});
   assert.equal(observation.usage.inputTokens,100);assert.equal(observation.liveDispatchAllowed,false);
  }
  const synthetic=JSON.parse(JSON.stringify(releases[arm]));
  const text='Synthetic regression: identify supported deletion rights without inventing a contact method.';
  synthetic.config.lessons=[{id:'lsn_'+sha(input.operation+'\n'+text).slice(0,16),target:input.operation,text,scope:'all',section:null,order:0}];
  synthetic.configHash=sha(canonicalJson({v:2,config:synthetic.config}));
  const lesson=executeBound(captures[arm],synthetic,input);
  assert.equal(lesson.result.lessonCount,1);assert((input.provider==='openai'?lesson.result.request.body.messages[0].content:lesson.result.request.body.system).includes(text));
  groups++;console.log('ok '+arm+' '+input.provider+' '+input.operation+' exact policy, mismatch rejection and synthetic lesson propagation');
 }
}
console.log(groups+' real-module integration groups passed; no inference or release authorization');
