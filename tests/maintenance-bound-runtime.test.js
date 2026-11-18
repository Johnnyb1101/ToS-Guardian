'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {executeBound}=require('../tools/maintenance-bound-runtime');
const {seal}=require('../tools/final-corpus-lib');
let passed=0;function test(n,f){f();passed++;console.log('ok '+n);}
const sources={
 'analysisOperations.js':"exports.validateOperationRequest=(i,o)=>({valid:true,relayRequest:{lessons:o.lessons[i.operation]}});",
 'llmRelay.js':"exports.validateAnalyzeRequest=i=>({valid:true,...i});exports.buildProviderRequest=i=>({url:'offline',body:{lessons:i.lessons}});",
 'release-config.js':"exports.validateRelease=r=>({valid:r.v===2});exports.resolveRelease=(r,o)=>({lessons:r.config.lessons,lessonsHash:'fixture-hash'});",
 'release-policy.js':"exports.createRuntimePolicy=(h,o)=>({versions:{pipeline:h},cache:{shared:o.sharedCacheDisabled?'disabled':'enabled'},model:'fixture'});exports.samePolicy=(a,b)=>JSON.stringify(a)===JSON.stringify(b);",
 'docType.js':"exports.classifyDocumentType=()=>({type:'other'});",
 'siteValidation.js':'', 'siteLearning.js':'', 'package.json':'{}','package-lock.json':'{}',
 'node_modules/tldts/dist/cjs/index.js':'',
 'migrations/0006_release_activation.sql':'',
 'migrations/20261030040050_baseline_bootstrap.sql':''
};
function capture(s=sources){return {sources:{...s},manifest:seal({kind:'maintenance-runtime-capture',v:1,files:Object.keys(s).sort().map(name=>({name,bytes:Buffer.byteLength(s[name]),sha256:crypto.createHash('sha256').update(s[name]).digest('hex')}))})};}
const release={v:2,configHash:'fixture',config:{lessons:[{text:'fixture lesson'}],policy:{versions:{pipeline:'client-fixture'},cache:{shared:'disabled'},model:'fixture'}}};
const input={operation:'analyzer',documentText:'source'};
test('resolved supplied release lessons enter request; flags remain ineligible',()=>{const r=executeBound(capture(),release,input);assert.deepEqual(r.result.request.body.lessons,release.config.lessons);assert.equal(r.result.lessonCount,1);assert.equal(r.actualRuntime.node,process.version);assert.equal(r.promotionEligible,false);assert.equal(r.evaluationPassed,false);});
test('policy and invalid release fail closed',()=>{const r=JSON.parse(JSON.stringify(release));r.config.policy.model='wrong';assert.throws(()=>executeBound(capture(),r,input),/does not match/);assert.throws(()=>executeBound(capture(),{...release,v:1},input),/Invalid release/);});
test('changed bytes and changed manifest rejected',()=>{const c=capture();c.sources['llmRelay.js']+=' ';assert.throws(()=>executeBound(c,release,input),/changed/);const d=capture();d.manifest.files.pop();assert.throws(()=>executeBound(d,release,input),/binding/);});
test('missing, duplicate and path-escaping sources rejected',()=>{const s={...sources};delete s['release-config.js'];assert.throws(()=>executeBound(capture(s),release,input),/binding/);assert.throws(()=>executeBound(capture({...sources,'../escape.js':''}),release,input),/changed/);const c=capture();c.manifest.files.push(c.manifest.files[0]);assert.throws(()=>executeBound(c,release,input),/binding/);});
test('unexpected module access and infinite execution rejected',()=>{assert.throws(()=>executeBound(capture({...sources,'analysisOperations.js':"require('node:fs')"}),release,input),/Unexpected/);assert.throws(()=>executeBound(capture({...sources,'analysisOperations.js':'while(true){}'}),release,input),/timed out/);});
test('unsupported operations and source missing rejected',()=>{assert.throws(()=>executeBound(capture(),release,{...input,operation:'jury'}),/Unsupported/);assert.throws(()=>executeBound(capture(),release,{operation:'analyzer'}),/Source/);});
console.log(passed+' bound runtime test groups passed');
