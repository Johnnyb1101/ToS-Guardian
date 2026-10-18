'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const P=require('../tools/training-preparation');
const I=require('../tools/training-inventory-lib');
const D=require('../tools/training-dataset-lib');
const R=require('../tools/reference-lib');
const V=require('../tools/training-review-lib');
const F=require('./training-test-fixtures');

function fixture(base) {
  const referenceRoot=path.join(base,'reference'),runDir=path.join(referenceRoot,'runs','fixture');
  fs.mkdirSync(path.join(referenceRoot,'sources'),{recursive:true});
  fs.mkdirSync(path.join(runDir,'artifacts'),{recursive:true});
  const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value));
  const manifest={v:1,holdoutShare:0.3,sites:{}};
  const work=F.domainFor('work'),holdout=F.domainFor('holdout');
  const text=F.makeFixture().item.sourceText;
  for(const [domain,source] of [[work,text],[holdout,'A distinct validation privacy policy. We collect names.']]) {
    const frozen={v:1,domain,frozenAt:'2026-10-17T00:00:00Z',pageUrl:'https://'+domain+'/privacy',fetched:{text:source,path:'/privacy',documentUrls:[]},enriched:{text:source,optOutLinks:[]},textHash:D.hashText(source),looksLegal:true,docType:'privacy',split:R.splitFor(domain)};
    write(path.join(referenceRoot,'sources',domain+'.json'),frozen);
    manifest.sites[domain]=R.manifestEntryFrom(frozen);
    for(let sample=1;sample<=3;sample++)write(path.join(runDir,'artifacts',domain+'-'+sample+'.json'),{domain,sample,runId:'fixture',split:frozen.split,textHash:frozen.textHash,analyzer:{status:'ok'},analysisSource:source,summary:'Data Collection\n- We collect names.\nData Selling\n- Unverified answer.'});
  }
  write(path.join(referenceRoot,'manifest.json'),manifest);write(path.join(runDir,'run.json'),{runId:'fixture'});
  return {referenceRoot,runDir,work,holdout,write,manifest};
}

const root=fs.mkdtempSync(path.join(os.tmpdir(),'tg-training-preparation-'));
let passed=0;
function test(name,fn){const dir=path.join(root,String(++passed));fs.mkdirSync(dir);fn(dir);console.log('PASS '+name);}
try {
  test('three drafts collapse to one work case; holdout remains excluded',dir=>{
    const f=fixture(dir),p=I.buildPreparation(f);
    assert.equal(p.cases.length,1);assert.equal(p.cases[0].proposals.length,3);
    assert.equal(p.cases[0].domain,f.work);assert.equal(p.inventory.sources.length,2);
    assert.ok(p.cases[0].proposals.every(p=>p.unverified));
  });
  test('unsuitable holdout still blocks exact source overlap',dir=>{
    const f=fixture(dir),file=path.join(f.referenceRoot,'sources',f.holdout+'.json');
    const frozen=JSON.parse(fs.readFileSync(file));frozen.fetched.text=F.makeFixture().item.sourceText;frozen.enriched.text=frozen.fetched.text;frozen.textHash=D.hashText(frozen.fetched.text);frozen.looksLegal=false;
    f.write(file,frozen);f.manifest.sites[f.holdout]=R.manifestEntryFrom(frozen);f.write(path.join(f.referenceRoot,'manifest.json'),f.manifest);
    for(let sample=1;sample<=3;sample++){const a=path.join(f.runDir,'artifacts',f.holdout+'-'+sample+'.json');const value=JSON.parse(fs.readFileSync(a));value.textHash=frozen.textHash;f.write(a,value);}
    assert.throws(()=>I.buildPreparation(f),/No eligible/);
  });
  test('known final domains and hashes block training',dir=>{
    const f=fixture(dir);fs.mkdirSync(path.join(f.referenceRoot,'final'));
    const file=path.join(f.referenceRoot,'final','corpus.json');
    f.write(file,{domain:f.work});assert.throws(()=>I.buildPreparation(f),/No eligible/);
    f.write(file,{sourceHash:D.hashText(F.makeFixture().item.sourceText)});assert.throws(()=>I.buildPreparation(f),/No eligible/);
  });
  test('older validation analyzer input from another run cannot train',dir=>{
    const f=fixture(dir),old=path.join(f.referenceRoot,'runs','older');fs.mkdirSync(old);
    f.write(path.join(old,'capture.json'),{domain:f.holdout,analysisSource:F.makeFixture().item.sourceText});
    assert.throws(()=>I.buildPreparation(f),/No eligible/);
  });
  test('mismatched provenance and duplicate drafts fail closed',dir=>{
    const f=fixture(dir),file=path.join(f.runDir,'artifacts',f.work+'-1.json'),a=JSON.parse(fs.readFileSync(file));
    f.write(file,{...a,textHash:'0'.repeat(64)});assert.throws(()=>I.buildPreparation(f),/provenance/);
    f.write(file,a);f.write(path.join(f.runDir,'artifacts','duplicate.json'),a);assert.throws(()=>I.buildPreparation(f),/Duplicate/);
  });
  test('drafts cannot export; explicit approval exports six fields and revocation invalidates snapshot',dir=>{
    const f=fixture(dir),prepDir=path.join(dir,'prep'),outDir=path.join(dir,'export');
    assert.equal(P.prepare(prepDir,f).approved,0);assert.throws(()=>P.exportDataset(prepDir,outDir),/No manually approved/);
    const prep=P.loadPreparation(prepDir),item=prep.cases[0];
    const review=V.appendReview(prepDir,prep,{caseId:item.caseId,baseHash:null,status:'approved',reviewer:'Synthetic fixture human',reviewedAt:'2026-10-17T12:00:00.000Z',note:'Synthetic only',groundTruth:F.makeFixture().truth});
    P.exportDataset(prepDir,outDir);assert.equal(P.verifyExport(prepDir,outDir).exampleCount,1);
    const example=JSON.parse(fs.readFileSync(path.join(outDir,'examples.jsonl'),'utf8'));
    assert.deepEqual(Object.keys(JSON.parse(example.messages[2].content)).sort(),[...D.FIELDS].sort());
    assert.throws(()=>P.exportDataset(prepDir,outDir),/already exists/);
    V.appendReview(prepDir,prep,{caseId:item.caseId,baseHash:review.hash,status:'excluded',reviewer:'Synthetic fixture human',reviewedAt:'2026-10-17T12:01:00.000Z',note:'Withdraw approval',groundTruth:null});
    assert.equal(P.collectExport(prepDir).manifest.datasetManifest.exampleCount,0);
    assert.throws(()=>P.verifyExport(prepDir,outDir),/stale or altered/);
  });
  test('changed captures, case files and rubric cannot silently reuse review',dir=>{
    const f=fixture(dir),prepDir=path.join(dir,'prep');P.prepare(prepDir,f);
    const casesFile=path.join(prepDir,'cases.json'),saved=fs.readFileSync(casesFile,'utf8');f.write(casesFile,[]);assert.throws(()=>P.loadPreparation(prepDir),/cases or AI/);fs.writeFileSync(casesFile,saved);
    const rubricFile=path.join(prepDir,'rubric.json'),rubric=fs.readFileSync(rubricFile,'utf8');f.write(rubricFile,{});assert.throws(()=>P.loadPreparation(prepDir),/rubric changed/);fs.writeFileSync(rubricFile,rubric);
    fs.appendFileSync(path.join(f.referenceRoot,'sources',f.work+'.json'),' ');assert.throws(()=>P.loadPreparation(prepDir),/inventory/);
  });
  test('export detects concurrent review changes and altered evidence or data',dir=>{
    const f=fixture(dir),prepDir=path.join(dir,'prep'),outDir=path.join(dir,'export');P.prepare(prepDir,f);
    const prep=P.loadPreparation(prepDir),item=prep.cases[0];
    const approved=V.appendReview(prepDir,prep,{caseId:item.caseId,baseHash:null,status:'approved',reviewer:'Synthetic fixture human',reviewedAt:'2026-10-17T12:00:00.000Z',note:'Synthetic only',groundTruth:F.makeFixture().truth});
    P.exportDataset(prepDir,outDir);
    const dataFile=path.join(outDir,'examples.jsonl'),data=fs.readFileSync(dataFile,'utf8');fs.appendFileSync(dataFile,' ');assert.throws(()=>P.verifyExport(prepDir,outDir),/stale or altered/);fs.writeFileSync(dataFile,data);
    const evidence=path.join(outDir,'review-evidence.json'),raw=fs.readFileSync(evidence,'utf8');f.write(evidence,[]);assert.throws(()=>P.verifyExport(prepDir,outDir),/stale or altered/);fs.writeFileSync(evidence,raw);
    const original=V.readReviews;
    V.readReviews=(...args)=>{const snapshot=original(...args);V.readReviews=original;V.appendReview(prepDir,prep,{caseId:item.caseId,baseHash:approved.hash,status:'needs-correction',reviewer:'Synthetic fixture human',reviewedAt:'2026-10-17T12:01:00.000Z',note:'Concurrent correction',groundTruth:null});return snapshot;};
    try{assert.throws(()=>P.collectExport(prepDir),/changed during export/);}finally{V.readReviews=original;}
  });
  test('new final material invalidates an existing preparation',dir=>{
    const f=fixture(dir),prepDir=path.join(dir,'prep');P.prepare(prepDir,f);
    fs.mkdirSync(path.join(f.referenceRoot,'final'));f.write(path.join(f.referenceRoot,'final','new.json'),{note:'New independently held final inventory'});
    assert.throws(()=>P.loadPreparation(prepDir),/inventory/);
  });
  test('CLI rejects provider execution and unsafe arguments',dir=>{
    assert.throws(()=>P.main(['train',dir]),/Only offline/);
    assert.throws(()=>P.main(['prepare',dir,'--limit','0']),/already exists|limit/);
    assert.throws(()=>P.main(['prepare',path.join(dir,'new'),'--provider','openai']),/Unexpected/);
  });
  console.log('Training preparation integration: '+passed+' passed; no model or provider execution');
} finally {
  const resolved=fs.realpathSync(root),temp=fs.realpathSync(os.tmpdir());
  if(!resolved.startsWith(temp+path.sep)||!path.basename(resolved).startsWith('tg-training-preparation-'))throw Error('Unsafe test cleanup');
  fs.rmSync(resolved,{recursive:true,force:true});
}
