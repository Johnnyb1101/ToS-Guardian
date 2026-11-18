'use strict';
const fs=require('node:fs');
const path=require('node:path');
const D=require('./training-dataset-lib');
const {buildPreparation}=require('./training-inventory-lib');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const writeNew=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx'});

function prepare(prepDir,{referenceRoot=path.resolve(__dirname,'../reference'),runDir,limit=6}={}) {
  const directory=path.resolve(prepDir);
  if(fs.existsSync(directory))throw Error('Preparation directory already exists; choose a new location');
  const location={referenceRoot:fs.realpathSync(referenceRoot),runDir:fs.realpathSync(runDir||path.join(referenceRoot,'runs/baseline-1')),limit};
  const prep=buildPreparation(location);
  fs.mkdirSync(directory,{recursive:true});
  for(const [name,value] of Object.entries({'location.json':location,'inventory.json':prep.inventory,'cases.json':prep.cases,'rubric.json':prep.rubric}))writeNew(path.join(directory,name),value);
  fs.writeFileSync(path.join(directory,'reviews.jsonl'),'',{flag:'wx'});
  return {directory,cases:prep.cases.length,draftProposals:prep.cases.reduce((n,c)=>n+c.proposals.length,0),approved:0,trainingStarted:false};
}

function loadPreparation(prepDir) {
  const location=read(path.join(prepDir,'location.json'));
  if(!location||!path.isAbsolute(location.referenceRoot||'')||!path.isAbsolute(location.runDir||''))throw Error('Preparation requires absolute historical source locations');
  const current=buildPreparation(location),inventory=read(path.join(prepDir,'inventory.json')),cases=read(path.join(prepDir,'cases.json')),rubric=read(path.join(prepDir,'rubric.json'));
  if(D.digest(current.inventory)!==D.digest(inventory))throw Error('Historical inventory or final exclusions changed; create a new preparation');
  if(D.digest(current.cases)!==D.digest(cases))throw Error('Training cases or AI draft proposals changed; corrections must be saved as review revisions');
  if(D.digest(D.RUBRIC)!==D.digest(rubric))throw Error('Review rubric changed; create a new preparation and review again');
  for(const item of cases){const checked=D.validateCase(item,inventory);if(!checked.valid)throw Error(checked.reasons.join('; '));}
  return {inventory,cases,rubric};
}

function collectExport(prepDir) {
  const prep=loadPreparation(prepDir);
  const reviews=require('./training-review-lib').readReviews(prepDir,prep);
  const result=D.exportApproved(prep.cases,reviews.histories,prep.inventory,{rubric:prep.rubric});
  const jsonl=result.examples.map(example=>D.canonicalJson(example)).join('\n')+(result.examples.length?'\n':'');
  if(reviews.logHash!==D.hashText(fs.readFileSync(path.join(prepDir,'reviews.jsonl'),'utf8')))throw Error('Review log changed during export; retry after saving reviews');
  const manifest=D.seal({v:1,kind:'training-preparation-export',datasetManifest:result.manifest,dataHash:D.hashText(jsonl),reviewLogHash:reviews.logHash,trainingStarted:false});
  return {jsonl,manifest,reviews:reviews.records};
}
function exportDataset(prepDir,outDir) {
  const result=collectExport(prepDir);
  if(!result.manifest.datasetManifest.exampleCount)throw Error('No manually approved examples are exportable yet');
  if(fs.existsSync(outDir))throw Error('Export directory already exists; preserve the snapshot and choose a new location');
  fs.mkdirSync(outDir,{recursive:true});
  fs.writeFileSync(path.join(outDir,'examples.jsonl'),result.jsonl,{flag:'wx'});
  writeNew(path.join(outDir,'manifest.json'),result.manifest);
  writeNew(path.join(outDir,'review-evidence.json'),result.reviews);
  return result.manifest;
}
function verifyExport(prepDir,outDir) {
  const current=collectExport(prepDir),saved=read(path.join(outDir,'manifest.json'));
  if(D.digest(current.manifest)!==D.digest(saved)||fs.readFileSync(path.join(outDir,'examples.jsonl'),'utf8')!==current.jsonl||D.digest(read(path.join(outDir,'review-evidence.json')))!==D.digest(current.reviews))throw Error('Export is stale or altered; do not use it for training');
  return {valid:true,exampleCount:saved.datasetManifest.exampleCount,trainingStarted:false};
}
function main(args) {
  const [command,directory,...rest]=args;
  if(!command||command==='--help'){console.log('Local only: prepare <newDir> [--reference <dir>] [--run <absoluteRunDir>] [--limit 6] | check <dir> | export <dir> <newOutDir> | verify-export <dir> <outDir>');return 0;}
  if(!directory)throw Error('A preparation directory is required');
  if(command==='prepare') {
    const opts={};for(let i=0;i<rest.length;i+=2){if(!['--reference','--run','--limit'].includes(rest[i])||rest[i+1]===undefined)throw Error('Unexpected preparation arguments');opts[{'--reference':'referenceRoot','--run':'runDir','--limit':'limit'}[rest[i]]]=rest[i]==='--limit'?Number(rest[i+1]):path.resolve(rest[i+1]);}
    console.log(JSON.stringify(prepare(directory,opts),null,2));return 0;
  }
  if(command==='check'&&rest.length===0){const prep=loadPreparation(directory),reviews=require('./training-review-lib').readReviews(directory,prep),result=D.exportApproved(prep.cases,reviews.histories,prep.inventory,{rubric:prep.rubric});console.log(JSON.stringify({cases:prep.cases.length,approvedExportable:result.examples.length,skipped:result.manifest.skipped,trainingStarted:false},null,2));return 0;}
  if(command==='export'&&rest.length===1){console.log(JSON.stringify(exportDataset(directory,path.resolve(rest[0])),null,2));return 0;}
  if(command==='verify-export'&&rest.length===1){console.log(JSON.stringify(verifyExport(directory,path.resolve(rest[0])),null,2));return 0;}
  throw Error('Only offline prepare/check/export/verify-export commands are available; no training or provider execution exists');
}
module.exports={prepare,loadPreparation,collectExport,exportDataset,verifyExport,main};
if(require.main===module){try{process.exitCode=main(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=1;}}
