'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildHistory } = require('./final-history-lib');
const { digest } = require('./final-corpus-lib');
const { createDraftProtocol, evaluatePreparation } = require('./final-evaluation-lib');

function writeNew(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {flag:'wx'});
}

function initialize(directory, referenceRoot = path.resolve(__dirname, '..', 'reference')) {
  const target = path.resolve(directory);
  if (fs.existsSync(target)) throw new Error('Preparation directory already exists; choose a new directory to preserve it');
  // Build the inventory before creating files so a corrupt history cannot leave
  // behind a package that appears initialized successfully.
  const history = buildHistory(referenceRoot);
  fs.mkdirSync(path.dirname(target), {recursive:true});
  fs.mkdirSync(target);
  const values = {
    'protocol.json': createDraftProtocol(), 'history.json': history,
    'history-location.json': { referenceRoot: fs.realpathSync(referenceRoot) },
    'corpus.json': null, 'control-release.json': null, 'treatment-release.json': null,
    'artifacts.json': [], 'grades.json': [], 'human-reviews.json': []
  };
  for (const [file, value] of Object.entries(values)) writeNew(path.join(target,file),value);
  return {directory:target,status:'UNAPPROVED',providerCallsEnabled:false,promotionEligible:false,historyFiles:history.sources.length};
}

function loadInputs(directory) {
  const read = file => JSON.parse(fs.readFileSync(path.join(directory,file),'utf8'));
  const history = read('history.json');
  const location = read('history-location.json');
  if (typeof location?.referenceRoot !== 'string' || !path.isAbsolute(location.referenceRoot)) throw new Error('Missing absolute local history location');
  if (digest(buildHistory(location.referenceRoot)) !== digest(history)) throw new Error('Historical inventory changed; create a new preparation and review corpus overlap again');
  let humanReviews = read('human-reviews.json');
  if (!Array.isArray(humanReviews)) throw new Error('human-reviews.json must be an array');
  const reviewDir = path.join(directory,'review');
  if (fs.existsSync(reviewDir)) {
    const { loadReview } = require('./final-review');
    const { readAttempts } = require('./final-review-lib');
    const { publicPackage, privateBindings, artifacts } = loadReview(reviewDir,path.join(directory,'artifacts.json'));
    const bound = readAttempts(reviewDir,publicPackage,privateBindings,artifacts);
    if (humanReviews.length && digest(humanReviews) !== digest(bound)) throw new Error('Imported human reviews differ from validated blinded review log');
    humanReviews = bound;
  } else if (humanReviews.length) throw new Error('Human reviews require the matching local blinded review package and attempt log');
  return {
    protocol:read('protocol.json'),history,corpus:read('corpus.json'),
    controlRelease:read('control-release.json'),treatmentRelease:read('treatment-release.json'),
    artifacts:read('artifacts.json'),grades:read('grades.json'),humanReviews
  };
}

function renderReport(report) {
  return '# Step 2 preparation report\n\n' +
    'Diagnostic preparation only. This report cannot authorize provider spending, owner signing, promotion, or deployment.\n\n' +
    '```json\n' + JSON.stringify(report,null,2) + '\n```\n';
}

function main(args) {
  const [command, directory, ...rest] = args;
  if (command === '--help' || !command) {
    console.log('Offline only: node tools/final-evaluation.js init <newDir> [--reference <historyDir>] | check <dir> | report <dir>');
    console.log('Recommended local output: reference/final/<unique-preparation-name>. There is no provider execution or approval command.');
    return 0;
  }
  if (!directory || !['init','check','report'].includes(command)) throw new Error('Expected offline init, check, or report and a directory; provider execution is unavailable');
  if (command==='init') {
    if (rest.length && (rest.length!==2 || rest[0]!=='--reference')) throw new Error('Unexpected initialization arguments');
    console.log(JSON.stringify(initialize(directory,rest[1]),null,2));
    return 0;
  }
  if (rest.length) throw new Error('Unexpected arguments');
  const report = evaluatePreparation(loadInputs(path.resolve(directory)));
  console.log(JSON.stringify(report,null,2));
  if (command==='report') {
    const stem = path.join(path.resolve(directory),'preparation-report-'+Date.now()+'-'+process.pid);
    writeNew(stem+'.json',report);
    fs.writeFileSync(stem+'.md',renderReport(report),{flag:'wx'});
    console.log('Saved '+stem+'.json and .md');
  }
  // There is intentionally no successful final-evaluation exit status in prep.
  return 2;
}

module.exports = { initialize, loadInputs, renderReport, main };
if(require.main===module) {
  try { process.exitCode=main(process.argv.slice(2)); }
  catch(error) { console.error(error.message); process.exitCode=1; }
}
