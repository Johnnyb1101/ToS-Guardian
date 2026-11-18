'use strict';
// Executes trusted reviewed sources only. Node vm is not a hostile-code sandbox.
const fs=require('node:fs'), path=require('node:path'), vm=require('node:vm'), crypto=require('node:crypto');
const {localPath}=require('./maintenance-local-path');
const {digest,seal}=require('./final-corpus-lib');
const {FLAGS}=require('./maintenance-evaluation-lib');
const {migrationInventory}=require('./maintenance-artifact-manifest');
const EXTRA=['node_modules/tldts/dist/cjs/index.js','migrations/0006_release_activation.sql','migrations/20261030040050_baseline_bootstrap.sql'];
const REQUIRED=['analysisOperations.js','llmRelay.js','release-config.js','release-policy.js','docType.js','siteValidation.js','siteLearning.js','package.json','package-lock.json',...EXTRA];
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
function captureRuntime(directory){
 const root=localPath(directory);
 const migrations=migrationInventory(root);
 const names=fs.readdirSync(root).filter(n=>n.endsWith('.js')&&!/\.test\.js$|fixtures|\.sample\./.test(n)).concat(['package.json','package-lock.json',EXTRA[0],...migrations.files.map(f=>f.path)]).sort();
 const sources={};
 for(const name of names){
  const file=localPath(path.join(root,...name.split('/'))),bytes=fs.readFileSync(file);
  if(bytes.length>10000000||!Buffer.from(bytes.toString('utf8')).equals(bytes))throw Error('Invalid source bytes');
  sources[name]=bytes.toString('utf8');
 }
 return {manifest:seal({kind:'maintenance-runtime-capture',v:2,migrationManifest:migrations,files:names.map(name=>({name,bytes:Buffer.byteLength(sources[name]),sha256:hash(sources[name])}))}),sources};
}
function executeBound(capture,release,input){
 const m=capture?.manifest,s=capture?.sources;
 if(!m||m.kind!=='maintenance-runtime-capture'||![1,2].includes(m.v)||!Array.isArray(m.files)||!s)throw Error('Invalid runtime capture');
 const {hash:mh,...body}=m;
 const names=m.files.map(f=>f.name);
 if(mh!==digest(body)||new Set(names).size!==names.length||JSON.stringify(names)!==JSON.stringify([...names].sort())||JSON.stringify(Object.keys(s).sort())!==JSON.stringify(names)||REQUIRED.some(n=>!names.includes(n)))throw Error('Runtime manifest binding mismatch');
 for(const f of m.files){
  if(typeof f.name!=='string'||!( /^[a-zA-Z0-9.-]+$/.test(f.name)||EXTRA.includes(f.name)||(m.v===2&&/^migrations\/[A-Za-z0-9_.-]+\.(sql|psql)$/.test(f.name)))||typeof s[f.name]!=='string'||hash(s[f.name])!==f.sha256||Buffer.byteLength(s[f.name])!==f.bytes)throw Error('Runtime captured bytes changed');
 }
 if(m.v===2){
  const files=names.filter(n=>n.startsWith('migrations/')).map(name=>{const text=s[name].replace(/\r\n?/g,'\n');return {path:name,bytes:Buffer.byteLength(text),sha256:hash(text)};});
  if(JSON.stringify(seal({files}))!==JSON.stringify(m.migrationManifest))throw Error('Migration inventory binding mismatch');
 }
 const context=vm.createContext({URL,Buffer:{byteLength:Buffer.byteLength},hostHash:crypto.createHash,sourceJson:JSON.stringify(s),releaseJson:JSON.stringify(release),inputJson:JSON.stringify(input)});
 const result=new vm.Script(`
  const sources=JSON.parse(sourceJson), release=JSON.parse(releaseJson), input=JSON.parse(inputJson), cache={};
  function load(name){
   if(cache[name])return cache[name].exports;
   if(!['analysisOperations.js','llmRelay.js','release-config.js','release-policy.js','docType.js','siteValidation.js','node_modules/tldts/dist/cjs/index.js'].includes(name))throw Error('Unexpected runtime module');
   const module={exports:{}};cache[name]=module;
   const req=dep=>{
    if(dep==='crypto'||dep==='node:crypto')return {createHash:hostHash};
    if(name==='release-policy.js'&&dep==='node:fs')return {readdirSync:(p,options)=>{if(p==='/captured'&&!options)return Object.keys(sources).filter(n=>!n.includes('/'));if(p==='/captured/migrations'&&options?.withFileTypes===true)return Object.keys(sources).filter(n=>n.startsWith('migrations/')).map(n=>({name:n.slice(11),isFile:()=>true,isSymbolicLink:()=>false}));throw Error('Unexpected directory');},readFileSync:(p,encoding)=>{if(!p.startsWith('/captured/')||encoding!=='utf8'||!Object.hasOwn(sources,p.slice(10)))throw Error('Unexpected source read');return sources[p.slice(10)];}};
    if(name==='release-policy.js'&&dep==='node:path')return {join:(a,b)=>{const p=a+'/'+b;if((a!=='/captured'&&a!=='/captured/migrations')||(p!=='/captured/migrations'&&!Object.hasOwn(sources,p.slice(10))))throw Error('Unexpected source path');return p;}};
    if(dep==='tldts'&&name==='siteValidation.js')return load('node_modules/tldts/dist/cjs/index.js');
    const allowed={'analysisOperations.js':['./siteValidation'],'release-config.js':['./docType','./siteValidation'],'release-policy.js':['./llmRelay','./analysisOperations']};
    if(allowed[name]?.includes(dep))return load(dep.slice(2)+'.js');
    throw Error('Unexpected runtime dependency');
   };
   new Function('module','exports','require','__dirname',sources[name])(module,module.exports,req,'/captured');
   return module.exports;
  }
  const rc=load('release-config.js'),rp=load('release-policy.js');
  const checked=rc.validateRelease(release);if(!checked.valid)throw Error('Invalid release: '+checked.reason);
  const shared=release.config.policy.cache?.shared;
  if(!['disabled','enabled'].includes(shared))throw Error('Invalid cache mode');
  const actual=rp.createRuntimePolicy(release.config.policy.versions.pipeline,{sharedCacheDisabled:shared==='disabled'});
  if(!rp.samePolicy(actual,release.config.policy))throw Error('Release does not match captured runtime policy');
  if(!['analyzer','critic'].includes(input.operation))throw Error('Unsupported operation');
  const text=input.operation==='analyzer'?input.documentText:input.sourceText;
  if(typeof text!=='string')throw Error('Source required');
  const type=load('docType.js').classifyDocumentType(text,input.domain||'').type;
  const resolved=rc.resolveRelease(release,{target:input.operation,docType:type});
  const operation=load('analysisOperations.js').validateOperationRequest(input,{lessons:{[input.operation]:resolved.lessons}});
  if(!operation.valid)throw Error(operation.reason);
  const relay=load('llmRelay.js'),v=relay.validateAnalyzeRequest(operation.relayRequest);
  if(!v.valid)throw Error(v.reason);
  const request=relay.buildProviderRequest(v,'OFFLINE-NOT-A-CREDENTIAL');
  JSON.stringify({configHash:release.configHash,policy:actual,docType:type,lessonsHash:resolved.lessonsHash,lessonCount:resolved.lessons.length,request:{url:request.url,body:request.body}});
 `).runInContext(context,{timeout:2000});
 const out=JSON.parse(result);
 return seal({kind:'maintenance-bound-request',v:1,...FLAGS,captureHash:mh,releaseHash:digest(release),inputHash:digest(input),outputHash:digest(out),result:out,
 migrationManifestHash:m.v===2?m.migrationManifest.hash:null,
 actualRuntime:{node:process.version,platform:process.platform,arch:process.arch},
 limitations:['Trusted source module execution only, not hostile-code containment','No original deployed image, HTTP server, database or model inference','Client policy hash is supplied by release; extension bytes are not verified','Cache mode bound as configuration, not exercised','No provider dispatch or release authorization']});
}
module.exports={captureRuntime,executeBound};
