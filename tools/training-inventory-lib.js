'use strict';
const fs = require('node:fs');
const path = require('node:path');
const R = require('./reference-lib');
const { parseSummary } = require('./spotcheck-lib');
const { hashText, seal } = require('./final-corpus-lib');

function readPinned(file, files) {
  const resolved=fs.realpathSync(file),bytes=fs.readFileSync(resolved);
  files.set(resolved,hashText(bytes.toString('utf8')));
  return JSON.parse(bytes.toString('utf8'));
}
function within(root,file) {
  const resolved=fs.realpathSync(file);
  if(!resolved.startsWith(root+path.sep))throw Error('Input path escapes its declared root');
  return resolved;
}

function buildPreparation({referenceRoot,runDir,limit=6}) {
  const D=require('./training-dataset-lib');
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Sample limit must be an integer from 1 to 100');
  const root=fs.realpathSync(referenceRoot),runs=fs.realpathSync(path.join(root,'runs'));
  const run=within(runs,runDir),files=new Map(),excluded=[],sources=[],sourceTexts=new Map();
  const manifestPath=within(root,path.join(root,'manifest.json'));
  const manifest=readPinned(manifestPath,files);
  if(manifest.v!==1||!manifest.sites||typeof manifest.sites!=='object'||Array.isArray(manifest.sites)||manifest.holdoutShare!==0.3)throw Error('Invalid or incompatible historical manifest');
  const finalDomains=new Set(),finalSourceHashes=new Set();
  function collectFinal(value,key='') {
    if(typeof value==='string') {
      if(key==='domain')finalDomains.add(value);
      if(['sourceHash','textHash','analysisSourceHash'].includes(key)&&/^[a-f0-9]{64}$/.test(value))finalSourceHashes.add(value);
      if(['sourceText','analysisSource'].includes(key))finalSourceHashes.add(hashText(value));
    }else if(Array.isArray(value)){for(const child of value)collectFinal(child,key);}
    else if(value&&typeof value==='object'){for(const [name,child] of Object.entries(value))collectFinal(child,name);}
  }
  function visitFinal(directory) {
    for(const name of fs.readdirSync(directory).sort()) {
      const file=path.join(directory,name),stat=fs.lstatSync(file);
      if(stat.isSymbolicLink())throw Error('Final inventory refuses symbolic links');
      if(stat.isDirectory())visitFinal(file);
      else if(stat.isFile()&&name.endsWith('.json'))collectFinal(readPinned(file,files));
    }
  }
  if(fs.existsSync(path.join(root,'final')))visitFinal(path.join(root,'final'));
  // Include older validation analyzer inputs from every locally available run,
  // even when their normalized/capped text differs from today's frozen capture.
  function collectHoldout(value) {
    if(!value||typeof value!=='object')return;
    if(!Array.isArray(value)&&typeof value.domain==='string'&&R.splitFor(value.domain)==='holdout') {
      for(const key of ['sourceHash','textHash','analysisSourceHash'])if(/^[a-f0-9]{64}$/.test(value[key]||''))finalSourceHashes.add(value[key]);
      for(const key of ['sourceText','analysisSource'])if(typeof value[key]==='string'&&value[key])finalSourceHashes.add(hashText(value[key]));
    }
    for(const child of Object.values(value))if(child&&typeof child==='object')collectHoldout(child);
  }
  function visitRuns(directory) {
    for(const name of fs.readdirSync(directory).sort()) {
      const file=path.join(directory,name),stat=fs.lstatSync(file);
      if(stat.isSymbolicLink())throw Error('Run inventory refuses symbolic links');
      if(stat.isDirectory())visitRuns(file);
      else if(stat.isFile()&&name.endsWith('.json'))collectHoldout(readPinned(file,files));
    }
  }
  visitRuns(runs);
  for(const domain of Object.keys(manifest.sites).sort()) {
    const entry=manifest.sites[domain];
    if(!entry||entry.domain!==domain||entry.split!==R.splitFor(domain))throw Error('Manifest split/domain mismatch: '+domain);
    const file=within(fs.realpathSync(path.join(root,'sources')),path.join(root,entry.sourceFile));
    const frozen=readPinned(file,files),checked=R.validateFrozenSource(frozen);
    if(!checked.valid||frozen.domain!==domain||frozen.split!==entry.split||frozen.textHash!==entry.textHash)throw Error('Frozen policy/manifest mismatch: '+domain);
    const suitable=!!entry.looksLegal&&frozen.looksLegal&&!(frozen.fetched.unreadablePdfUrls||[]).length;
    if(!suitable)excluded.push({domain,reason:'Capture contains unreadable or unsuitable documents'});
    const sourceText=frozen.enriched.text;
    const record={domain,split:entry.split,sourceHash:hashText(sourceText),manifestPath,manifestHash:files.get(manifestPath),frozenPath:file,frozenHash:files.get(file),textHash:frozen.textHash,sourceKind:'enriched',looksLegal:suitable};
    sources.push(record);sourceTexts.set(domain,{sourceText,docType:R.effectiveType(entry)});
  }
  const metaPath=within(run,path.join(run,'run.json')),meta=readPinned(metaPath,files);
  if(typeof meta.runId!=='string'||meta.runId!==path.basename(run))throw Error('Run directory and runId mismatch');
  const artifactsRoot=fs.realpathSync(path.join(run,'artifacts')),proposals=new Map(),seen=new Set();
  for(const name of fs.readdirSync(artifactsRoot).filter(n=>n.endsWith('.json')).sort()) {
    const artifactPath=within(artifactsRoot,path.join(artifactsRoot,name)),a=readPinned(artifactPath,files);
    if(!a||typeof a.domain!=='string'||!Number.isSafeInteger(a.sample)||a.sample<1)throw Error('Invalid historical artifact identity');
    const identity=a.domain+'#'+a.sample;
    if(seen.has(identity))throw Error('Duplicate historical artifact: '+identity);seen.add(identity);
    const entry=manifest.sites[a.domain];
    if(!entry||a.split!==R.splitFor(a.domain)||a.split!==entry.split||a.runId!==meta.runId||a.textHash!==entry.textHash)throw Error('Historical artifact provenance mismatch: '+identity);
    if(a.split!=='work')continue;
    if(a.error||a.analyzer?.status!=='ok'||typeof a.summary!=='string'||!a.summary||typeof a.analysisSource!=='string'||!a.analysisSource){excluded.push({domain:a.domain,reason:'Failed or missing historical AI draft: '+identity});continue;}
    const parsed=parseSummary(a.summary),fields={};
    for(const key of D.FIELDS)fields[key]=(parsed.sections[key]?.items||[]).join('\n');
    const proposal={artifactPath,artifactHash:files.get(artifactPath),sample:a.sample,runId:a.runId,analysisSourceHash:hashText(a.analysisSource),unverified:true,fields};
    if(!proposals.has(a.domain))proposals.set(a.domain,[]);proposals.get(a.domain).push(proposal);
  }
  const eligible=[],used=new Set();
  for(const s of sources.filter(s=>s.split==='work'&&s.looksLegal)) {
    const {domain,sourceHash}=s;
    const denied=sources.some(other=>other.split!=='work'&&(other.sourceHash===sourceHash||other.textHash===s.textHash));
    if(denied||finalDomains.has(domain)||finalSourceHashes.has(sourceHash)||finalSourceHashes.has(s.textHash)){excluded.push({domain,reason:'Overlaps validation or final material'});continue;}
    if(used.has(sourceHash)){excluded.push({domain,reason:'Duplicate policy source'});continue;}used.add(sourceHash);
    if(!proposals.has(domain)){excluded.push({domain,reason:'No eligible historical draft'});continue;}
    eligible.push(s);
  }
  const inventory=seal({v:1,kind:'training-source-inventory',complete:true,sources,files:[...files].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([file,hash])=>({path:file,hash})),finalDomains:[...finalDomains].sort(),finalSourceHashes:[...finalSourceHashes].sort(),excluded});
  const groups=new Map();
  for(const s of eligible){
    const domain=s.domain;
    const {sourceText,docType}=sourceTexts.get(domain);
    const provenance=Object.fromEntries(['manifestPath','manifestHash','frozenPath','frozenHash','textHash','sourceKind'].map(key=>[key,s[key]]));
    const item=D.createCase({domain,sourceText,provenance,proposals:proposals.get(domain)},inventory);
    if(!groups.has(docType))groups.set(docType,[]);groups.get(docType).push(item);
  }
  const cases=[],types=[...groups.keys()].sort();
  while(cases.length<limit&&types.some(type=>groups.get(type).length))for(const type of types){if(cases.length>=limit)break;if(groups.get(type).length)cases.push(groups.get(type).shift());}
  if(!cases.length)throw Error('No eligible work-only policy examples available');
  return {inventory,cases,rubric:D.RUBRIC};
}

module.exports={buildPreparation};
