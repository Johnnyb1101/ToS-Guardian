'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { initialize, loadInputs } = require('../tools/final-evaluation');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'tg-final-cli-'));
try {
  const history=path.join(root,'history');fs.mkdirSync(history);
  fs.mkdirSync(path.join(history,'sources'));fs.mkdirSync(path.join(history,'runs'));
  fs.writeFileSync(path.join(history,'manifest.json'),JSON.stringify({sites:{'old.example.com':{}}}));
  const prep=path.join(root,'prep');
  const outcome=initialize(prep,history);
  assert.equal(outcome.providerCallsEnabled,false);
  assert.equal(outcome.promotionEligible,false);
  assert.equal(loadInputs(prep).protocol.status,'UNAPPROVED');
  assert.throws(()=>initialize(prep,history),/already exists/);
  function run(...args){return spawnSync(process.execPath,[path.resolve(__dirname,'../tools/final-evaluation.js'),...args],{encoding:'utf8'});}
  const checked=run('check',prep);assert.equal(checked.status,2,checked.stderr);
  const result=JSON.parse(checked.stdout);assert.equal(result.promotionEligible,false);assert.equal(result.evaluationPassed,false);
  assert.equal(run('run',prep).status,1);
  const reported=run('report',prep);assert.equal(reported.status,2,reported.stderr);
  assert.equal(fs.readdirSync(prep).filter(f=>f.startsWith('preparation-report-')).length,2);
  const before=fs.readFileSync(path.join(prep,'protocol.json'),'utf8');
  assert.equal(run('check',prep,'--spend','100').status,1);
  assert.equal(fs.readFileSync(path.join(prep,'protocol.json'),'utf8'),before);
  fs.writeFileSync(path.join(prep,'human-reviews.json'),JSON.stringify([{kind:'forged-import'}]));
  assert.throws(()=>loadInputs(prep),/matching local blinded review/);
  fs.writeFileSync(path.join(prep,'human-reviews.json'),'[]');
  fs.writeFileSync(path.join(history,'runs','later.json'),JSON.stringify({domain:'newly-seen.example.com'}));
  const stale=run('check',prep);assert.equal(stale.status,1);assert.match(stale.stderr,/Historical inventory changed/);
  assert.equal(run('report',prep).status,1);
  assert.equal(fs.readdirSync(prep).filter(f=>f.startsWith('preparation-report-')).length,2);
  console.log('Offline CLI: draft initialization, no overwrite, incomplete exit, report artifacts and absent spend/run path checked; PASS');
} finally {
  const resolved=fs.realpathSync(root),temp=fs.realpathSync(os.tmpdir());
  if(!resolved.startsWith(temp+path.sep)||!path.basename(resolved).startsWith('tg-final-cli-'))throw Error('Unsafe test cleanup');
  fs.rmSync(resolved,{recursive:true,force:true});
}
