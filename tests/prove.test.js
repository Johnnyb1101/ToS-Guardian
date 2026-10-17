const P = require('../tools/prove-lib');
const { candidatesToLessons, reviseCandidate, renderLessonList } = require('../tools/lessons-lib');
const { hash } = require('../tools/evaluation-lib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { SECTIONS } = require('../tools/jury-lib');

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (condition) { console.log(`  ok    ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

console.log('Prove');

function verdict(accuracy, completeness, fabrications = 0) {
  return JSON.stringify({
    sections: Object.fromEntries(SECTIONS.map(s => [s, { accuracy, completeness, notes: '' }])),
    bottomLine: { fair: true, notes: '' }, riskLevel: { summary: 'High', jury: 'High', notes: '' },
    fabrications: Array.from({ length: fabrications }, (_, i) => `made-up ${i}`), omissions: []
  });
}

function verdictFor(score) {
  return score >= 90 ? verdict('correct', 'complete', (100 - score) / 10) : verdict('correct', 'partial', (80 - score) / 10);
}

function artifact(domain, sample, split, score, lessonsHash) {
  const raw = verdictFor(score);
  return {
    runId: lessonsHash === 'h0' ? 'c' : 't', domain, sample, split, docType: 'financial', textHash: hash(domain),
    analyzer: { status: 'ok', model: 'claude-sonnet-4-6', analysisChars: 1000, lessonsHash: hash(lessonsHash), promptHash: hash('analyzer-prompt'), lessonsArm: lessonsHash === 'h0' ? 'none' : 'pinned' },
    summary: '🧭 RISK LEVEL\nHigh', analysisSource: 'x',
    criticConfig: { model: 'critic-model', promptHash: hash('critic-prompt'), lessonsHash: hash('fixed-critic-lessons') },
    critic: { dataCollection: 'grounded', dataSelling: 'grounded', optOutRights: 'grounded', howToOptOut: 'grounded', autoRenewal: 'skipped', dataDeletion: 'grounded' },
    verdict: { label: 'Strong', score: 100, risk: 'High', issues: [] }, cost: 0.1,
    jury: { anthropic: { model: 'claude-opus-5', promptHash: hash('jury-prompt'), rubricHash: hash('rubric'), sourceHash: hash('x'), summaryHash: hash('🧭 RISK LEVEL\nHigh'), raw, usageRecord: { model: 'claude-opus-5', input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 } } }
  };
}

function run(domains, scoreFor, hash) {
  const out = [];
  for (const [domain, split] of domains) for (const sample of [1, 2, 3]) out.push(artifact(domain, sample, split, scoreFor(domain, sample), hash));
  return out;
}

const domains = [['a.com', 'work'], ['b.com', 'work'], ['c.com', 'work'], ['j.com', 'work'], ['e.com', 'work'], ['f.com', 'work'], ['k.com', 'holdout'], ['h.com', 'holdout'], ['i.com', 'holdout']];
const control = run(domains, () => 60, 'h0');
const declaration = (sites = domains, samples = [1, 2, 3]) => sites.map(([domain, split]) => ({ domain, split, docType: 'financial', textHash: hash(domain), samples }));
const controlMeta = { runId: 'c', evaluationSet: declaration() };
const treatmentMeta = { runId: 't', evaluationSet: declaration() };
const evaluate = (opts = {}) => P.prove({ controlArtifacts: control, treatmentArtifacts: run(domains, () => 100, 'h1'), controlMeta, treatmentMeta, ...opts });

ok('the bootstrap is deterministic and brackets the mean', (() => { const a = P.bootstrapMeanInterval([1, 2, 3, 4, 5], 2000, 3); const b = P.bootstrapMeanInterval([1, 2, 3, 4, 5], 2000, 3); return a.lower === b.lower && a.lower < 3 && a.upper > 3; })());
ok('a single value has no interval', P.bootstrapMeanInterval([4]).lower === null);

ok('the fixture scores are what the jury math says', (() => { const one = P.perSite([artifact('z.com', 1, 'work', 60, 'h0')], 'anthropic').sites['z.com']; const two = P.perSite([artifact('z.com', 1, 'work', 100, 'h1')], 'anthropic').sites['z.com']; return one.score === 60 && two.score === 100 && one.fabricationRate === 2 && one.incompleteRate === 1 && two.incompleteRate === 0; })());

{
  const treatment = run(domains, () => 100, 'h1');
  const proof = evaluate({ controlArtifacts: control, treatmentArtifacts: treatment, meta: { runId: 't', controlRunId: 'c' } });
  ok('a clear gain on work and validation passes diagnostics only', proof.evaluationPassed && !proof.proven && proof.diagnosticOnly && !proof.promotionEligible && proof.lessonsHash === hash('h1') && proof.metrics.score.work.n === 6 && proof.metrics.score.validation.n === 3, JSON.stringify(proof.reasons));
  ok('the fabrication and incompleteness metrics move the right way', proof.metrics.fabricationRate.work.mean < 0 && proof.metrics.incompleteRate.work.mean < 0);
  const md = P.renderProof(proof);
  ok('the proof renders the verdict, the rule, and the per-site table', md.startsWith('# DIAGNOSTIC evaluation — t against c') && md.includes('DIAGNOSTIC evaluation passed:') && md.includes('cannot authorize promotion') && md.includes('| a.com |') && md.includes('| score | work |'));
}

{
  const noisyControl = run(domains, (d, s) => s === 2 ? 70 : 60, 'h0');
  const treatment = run(domains, (d, s) => s === 1 ? 70 : 60, 'h1');
  const proof = evaluate({ controlArtifacts: noisyControl, treatmentArtifacts: treatment });
  ok('a change inside the noise is not proven', !proof.evaluationPassed && !proof.proven && proof.reasons.some(r => /inside the noise|below the/.test(r)), JSON.stringify(proof.reasons));
  ok('an unproven proof says why', P.renderProof(proof).includes('## Why evaluation failed'));
}

{
  const treatment = run(domains, (d) => ['k.com', 'h.com', 'i.com'].includes(d) ? 30 : 100, 'h1');
  const proof = evaluate({ controlArtifacts: control, treatmentArtifacts: treatment });
  ok('a work gain with a holdout collapse is not proven', !proof.evaluationPassed && !proof.proven && proof.reasons.some(r => /validation/.test(r)), JSON.stringify(proof.reasons));
}

{
  const treatment = run(domains, () => 100, 'h1').map((a, i) => i % 2 ? { ...a, analyzer: { ...a.analyzer, lessonsHash: hash('h2') } } : a);
  const proof = evaluate({ controlArtifacts: control, treatmentArtifacts: treatment });
  ok('a treatment that ran under two lesson sets is not a proof', !proof.evaluationPassed && !proof.proven && proof.reasons.some(r => /lesson sets/.test(r)));
}

{
  const few = domains.slice(0, 3);
  const proof = evaluate({ controlArtifacts: run(few, () => 60, 'h0'), treatmentArtifacts: run(few, () => 100, 'h1') });
  ok('too few paired work sites is not a proof', !proof.evaluationPassed && !proof.proven && proof.reasons.some(r => /at least 5/.test(r)));
}

{
  const treatment = run(domains.filter(([d]) => d !== 'b.com'), () => 100, 'h1');
  const proof = evaluate({ controlArtifacts: control, treatmentArtifacts: treatment });
  ok('sites missing from one arm fail complete declared-set evaluation', !proof.evaluationPassed && proof.reasons.some(r => /b.com.*missing declared record/.test(r)));
}

function rejects(label, change, pattern) {
  const opts = JSON.parse(JSON.stringify({ controlArtifacts: control, treatmentArtifacts: run(domains, () => 100, 'h1'), controlMeta, treatmentMeta }));
  change(opts);
  const proof = evaluate(opts);
  ok(label, !proof.evaluationPassed && !proof.proven && proof.diagnosticOnly && !proof.promotionEligible && proof.reasons.some(r => pattern.test(r)), JSON.stringify(proof.reasons));
}

rejects('legacy artifacts without a declaration fail closed', o => { o.controlMeta = null; o.treatmentMeta = null; }, /missing declared evaluation set/);
rejects('unsupported jurors fail evaluation', o => { o.juror = 'other'; }, /juror must be/);
rejects('a declared site omitted from both arms cannot disappear from evaluation', o => {
  o.controlArtifacts = o.controlArtifacts.filter(a => a.domain !== 'a.com');
  o.treatmentArtifacts = o.treatmentArtifacts.filter(a => a.domain !== 'a.com');
}, /a.com.*missing declared record/);
rejects('a single absent paired sample fails completeness', o => o.treatmentArtifacts.pop(), /missing declared record/);
rejects('duplicate records cannot increase sample counts', o => o.treatmentArtifacts.push(o.treatmentArtifacts[0]), /duplicate record/);
rejects('extra undeclared records fail evaluation', o => o.treatmentArtifacts.push({ ...o.treatmentArtifacts[0], sample: 4 }), /undeclared record/);
rejects('duplicate declared sites fail evaluation', o => o.treatmentMeta.evaluationSet.push(o.treatmentMeta.evaluationSet[0]), /duplicate declared site/);
rejects('invalid domain keys fail closed without reaching summary grouping', o => {
  for (const arm of ['control', 'treatment']) {
    o[`${arm}Meta`].evaluationSet[0].domain = '__proto__';
    o[`${arm}Artifacts`].filter(a => a.domain === 'a.com').forEach(a => { a.domain = '__proto__'; });
  }
}, /invalid declared site/);
rejects('invalid document types fail closed without reaching summary grouping', o => {
  for (const arm of ['control', 'treatment']) {
    o[`${arm}Meta`].evaluationSet[0].docType = 'constructor';
    o[`${arm}Artifacts`].filter(a => a.domain === 'a.com').forEach(a => { a.docType = 'constructor'; });
  }
}, /invalid declared site/);
rejects('invalid evaluator labels fail closed without reaching summary grouping', o => { o.treatmentArtifacts[0].verdict.label = '__proto__'; }, /invalid evaluator verdict/);
rejects('malformed record identities fail closed without string coercion', o => { o.treatmentArtifacts[0].domain = { toString: 'invalid' }; }, /invalid artifact domain/);
rejects('invalid jury usage cannot crash cost calculation', o => { o.treatmentArtifacts[0].jury.anthropic.usageRecord.model = { toString: 'invalid' }; }, /invalid jury usage/);
rejects('repeated declared samples fail evaluation', o => { o.treatmentMeta.evaluationSet[0].samples = [1, 1, 2]; }, /invalid declared site/);
rejects('two paired samples per site are insufficient', o => {
  for (const arm of ['control', 'treatment']) {
    o[`${arm}Meta`].evaluationSet.forEach(s => { s.samples = [1, 2]; });
    o[`${arm}Artifacts`] = o[`${arm}Artifacts`].filter(a => a.sample < 3);
  }
}, /at least 3 unique/);
rejects('two validation sites are insufficient even with all declared samples', o => {
  for (const arm of ['control', 'treatment']) {
    o[`${arm}Meta`].evaluationSet = o[`${arm}Meta`].evaluationSet.filter(s => s.domain !== 'i.com');
    o[`${arm}Artifacts`] = o[`${arm}Artifacts`].filter(a => a.domain !== 'i.com');
  }
}, /need at least 3/);
rejects('a string sample ID does not match a declared numeric sample', o => { o.treatmentArtifacts[0].sample = '1'; }, /undeclared record/);
rejects('an artifact from another run is rejected', o => { o.treatmentArtifacts[0].runId = 'other'; }, /incompatible runId/);
rejects('different declarations cannot silently intersect', o => { o.treatmentMeta.evaluationSet[0].docType = 'other'; }, /declared evaluation sets are incompatible/);
rejects('a document hash mismatch is rejected', o => { o.treatmentArtifacts[0].textHash = hash('different'); }, /document or split differs/);
rejects('a split mismatch is rejected', o => { o.treatmentArtifacts[0].split = 'validation'; }, /document or split differs/);
rejects('both arms cannot reassign the fixed validation split', o => {
  for (const arm of ['control', 'treatment']) {
    o[`${arm}Meta`].evaluationSet.find(s => s.domain === 'a.com').split = 'validation';
    o[`${arm}Artifacts`].filter(a => a.domain === 'a.com').forEach(a => { a.split = 'validation'; });
  }
}, /differs from the fixed corpus split/);
rejects('failed analyzer records cannot be graded as successful', o => { o.treatmentArtifacts[0].analyzer.status = 'error'; }, /failed or missing analyzer/);
rejects('analyzer errors cannot hide behind an ok status', o => { o.treatmentArtifacts[0].error = 'timeout'; }, /failed or missing analyzer/);
rejects('missing jury verdict is rejected', o => { delete o.treatmentArtifacts[0].jury.anthropic; }, /invalid or missing jury verdict/);
rejects('a jury error cannot hide behind valid raw text', o => { o.treatmentArtifacts[0].jury.anthropic.error = 'no JSON'; }, /missing or invalid jury/);
rejects('trailing commas are not silently repaired into evaluation evidence', o => { o.treatmentArtifacts[0].jury.anthropic.raw = o.treatmentArtifacts[0].jury.anthropic.raw.replace(/}$/, ',}'); }, /invalid or missing jury verdict/);
rejects('missing fabrication lists cannot silently become zero counts', o => {
  const v = JSON.parse(o.treatmentArtifacts[0].jury.anthropic.raw); delete v.fabrications; o.treatmentArtifacts[0].jury.anthropic.raw = JSON.stringify(v);
}, /invalid or missing jury verdict/);
rejects('invalid fabrication entries cannot be silently filtered away', o => {
  const v = JSON.parse(o.treatmentArtifacts[0].jury.anthropic.raw); v.fabrications = [null]; o.treatmentArtifacts[0].jury.anthropic.raw = JSON.stringify(v);
}, /invalid or missing jury verdict/);
rejects('verdict labels must be strings rather than coercible arrays', o => {
  const v = JSON.parse(o.treatmentArtifacts[0].jury.anthropic.raw); v.sections.dataCollection.accuracy = ['correct']; o.treatmentArtifacts[0].jury.anthropic.raw = JSON.stringify(v);
}, /invalid or missing jury verdict/);
rejects('all not-applicable verdicts cannot supply numeric evidence', o => {
  const v = JSON.parse(o.treatmentArtifacts[0].jury.anthropic.raw);
  for (const section of Object.values(v.sections)) { section.accuracy = 'not-applicable'; section.completeness = 'not-applicable'; }
  o.treatmentArtifacts[0].jury.anthropic.raw = JSON.stringify(v);
}, /invalid or missing jury verdict/);
for (const field of ['model', 'promptHash']) rejects(`analyzer ${field} must stay fixed across arms`, o => { o.treatmentArtifacts.forEach(a => { a.analyzer[field] = field === 'model' ? 'other-model' : hash('other'); }); }, /incompatible analyzer/);
for (const field of ['model', 'promptHash', 'rubricHash']) rejects(`jury ${field} must stay fixed across arms`, o => { o.treatmentArtifacts.forEach(a => { a.jury.anthropic[field] = field === 'model' ? 'other-model' : hash('other'); }); }, /incompatible analyzer/);
for (const field of ['model', 'promptHash', 'lessonsHash']) rejects(`critic ${field} must stay fixed across arms`, o => { o.treatmentArtifacts.forEach(a => { a.criticConfig[field] = field === 'model' ? 'other-model' : hash('other'); }); }, /incompatible analyzer/);
rejects('metadata absent from both arms cannot count as matching', o => {
  [...o.controlArtifacts, ...o.treatmentArtifacts].forEach(a => { delete a.analyzer.promptHash; });
}, /missing or invalid analyzer/);
rejects('missing critic results fail even when metadata matches', o => { delete o.treatmentArtifacts[0].critic; }, /failed or invalid critic/);
rejects('failed critic results fail even when metadata matches', o => { o.treatmentArtifacts[0].critic.failed = true; }, /failed or invalid critic/);
rejects('a jury grade cannot bind to a changed summary', o => { o.treatmentArtifacts[0].summary += ' changed'; }, /does not match graded content/);
rejects('a jury grade cannot bind to changed source text', o => { o.treatmentArtifacts[0].analysisSource += ' changed'; }, /does not match graded content/);
rejects('correctly rebound grades with different analyzed sources are incompatible', o => {
  o.treatmentArtifacts[0].analysisSource = 'changed'; o.treatmentArtifacts[0].jury.anthropic.sourceHash = hash('changed');
}, /incompatible analyzed source hashes/);
rejects('mixed control lesson sets fail evaluation', o => { o.controlArtifacts[0].analyzer.lessonsHash = hash('different'); }, /control ran under 2 lesson sets/);
rejects('a negative validation mean fails even with its interval above the loss floor', o => {
  o.treatmentArtifacts = run(domains, (d, sample) => d === 'k.com' && sample === 1 ? 50 : ['k.com', 'h.com', 'i.com'].includes(d) ? 60 : 100, 'h1');
}, /validation mean must be nonnegative/);
rejects('a positive validation mean cannot excuse a lower interval below minus five', o => {
  o.treatmentArtifacts = run(domains, d => d === 'k.com' ? 50 : ['h.com', 'i.com'].includes(d) ? 70 : 100, 'h1');
}, /validation interval falls below/);
rejects('fabrication increases block a higher overall score at a site and split', o => {
  for (const a of o.controlArtifacts) a.jury.anthropic.raw = verdict('correct', 'partial', 0);
  for (const a of o.treatmentArtifacts) a.jury.anthropic.raw = verdict('correct', 'complete', 1);
}, /fabrication count increased on work split/);
rejects('a fabrication regression at one site cannot be offset by other sites', o => {
  for (const a of o.controlArtifacts) a.jury.anthropic.raw = verdict('correct', 'partial', a.domain === 'a.com' ? 0 : 2);
  for (const a of o.treatmentArtifacts) a.jury.anthropic.raw = verdict('correct', 'complete', a.domain === 'a.com' ? 1 : 0);
}, /fabrication count increased at a.com/);
rejects('fabrications above the display normalization cap still count', o => {
  for (const a of o.controlArtifacts.filter(a => a.domain === 'a.com')) a.jury.anthropic.raw = verdict('correct', 'partial', 21);
  for (const a of o.treatmentArtifacts.filter(a => a.domain === 'a.com')) a.jury.anthropic.raw = verdict('correct', 'complete', 22);
}, /fabrication count increased at a.com: 63 to 66/);
for (const opts of [{ minGain: NaN }, { minGain: 0 }, { maxHoldoutLoss: Infinity }, { maxHoldoutLoss: 6 }, { resamples: 0 }]) {
  const proof = evaluate(opts);
  ok(`unsafe statistical options fail closed: ${JSON.stringify(opts)}`, !proof.evaluationPassed);
}

{
  const treatment = run(domains, () => 100, 'h1');
  treatment.forEach(a => { if (a.split === 'holdout') a.split = 'validation'; a.jury.anthropic.score = { score: -999 }; a.jury.anthropic.verdict = { valid: false }; });
  const proof = evaluate({ treatmentArtifacts: treatment });
  ok('holdout maps to validation and scores are recomputed from raw verdicts', proof.evaluationPassed && proof.metrics.score.validation.mean === 40);
}

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tos-evaluation-test-'));
  try {
    for (const [arm, records, meta] of [['control', control, controlMeta], ['treatment', run(domains, () => 100, 'h1'), treatmentMeta]]) {
      const dir = path.join(root, arm);
      fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(meta));
      records.forEach(a => fs.writeFileSync(path.join(dir, 'artifacts', `${a.domain}.${a.sample}.json`), JSON.stringify(a)));
    }
    const treatment = path.join(root, 'treatment');
    const historical = '{"proven":true,"historical":true}\n';
    fs.writeFileSync(path.join(treatment, 'proof.json'), historical);
    const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../tools/prove.js'), treatment, '--control', path.join(root, 'control')], { encoding: 'utf8' });
    const report = JSON.parse(fs.readFileSync(path.join(treatment, 'step1a', 'evaluation', 'evaluation.json'), 'utf8'));
    ok('CLI writes isolated diagnostic output and leaves historical proof unchanged', cli.status === 0 && report.evaluationPassed && report.proven === false && fs.readFileSync(path.join(treatment, 'proof.json'), 'utf8') === historical, cli.stderr);
    fs.unlinkSync(path.join(treatment, 'artifacts', 'a.com.1.json'));
    const incomplete = spawnSync(process.execPath, [path.resolve(__dirname, '../tools/prove.js'), treatment, '--control', path.join(root, 'control')], { encoding: 'utf8' });
    ok('CLI returns failure for incomplete declared evidence', incomplete.status === 2 && JSON.parse(fs.readFileSync(path.join(treatment, 'step1a', 'evaluation', 'evaluation.json'), 'utf8')).evaluationPassed === false, incomplete.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const candidates = [
  { id: 'L013', kind: 'lesson', target: 'analyzer', scope: 'all', section: null, text: 'Never add a menu path.', why: '35 menu paths' },
  { id: 'L014', kind: 'lesson', target: 'critic', scope: 'all', section: null, text: 'Treat a menu path absent from the source as unsupported.', why: 'blind spots' },
  { id: 'L003', kind: 'lesson', target: 'analyzer', scope: 'all', section: 'dataSelling', text: 'Name every recipient category.', why: '95% partial' },
  { id: 'L011', kind: 'lesson', target: 'analyzer', scope: 'technology', section: 'dataDeletion', text: 'State retention.', why: '100%' },
  { id: 'L027', kind: 'code', target: 'analyzer-prompt', scope: 'all', section: 'howToOptOut', text: 'Change the fallback.', why: 'fallback' },
  { id: 'L034', kind: 'note', target: 'proof-design', scope: 'all', section: null, text: 'Three samples.', why: 'variance' }
];
const picked = candidatesToLessons(candidates, { ids: ['L013', 'L014', 'L027', 'L034'], runId: 'baseline-1' });
ok('only lesson candidates become lessons, with provenance', picked.length === 2 && picked[0].target === 'analyzer' && picked[1].target === 'critic' && picked[0].provenance.candidateId === 'L013' && picked[0].provenance.runId === 'baseline-1' && picked[0].scope === 'all' && picked[0].section === null);
ok('scope and section carry over and a target filter applies', candidatesToLessons(candidates, { target: 'analyzer' }).length === 3 && candidatesToLessons(candidates, { ids: ['L011'] })[0].scope === 'technology' && candidatesToLessons(candidates, { ids: ['L011'] })[0].section === 'dataDeletion');
const revised = reviseCandidate(candidates, 'L011', 'State retention only in the words the document uses; when it is silent, say so.', { id: 'L011b', runId: 'baseline-1', after: 'proof-bundle2' });
ok('a revised candidate keeps target, scope and section, takes the new text and names its parent', revised.target === 'analyzer' && revised.scope === 'technology' && revised.section === 'dataDeletion' && revised.text.startsWith('State retention only') && revised.provenance.candidateId === 'L011b' && revised.provenance.runId === 'baseline-1' && /^Revised L011 after proof-bundle2: 100%/.test(revised.provenance.why));
ok('revising an unknown or non-lesson candidate, or with empty text, yields nothing', reviseCandidate(candidates, 'L999', 'x') === null && reviseCandidate(candidates, 'L027', 'x') === null && reviseCandidate(candidates, 'L013', '  ') === null && reviseCandidate(candidates, 'L013', 'x').provenance.candidateId === 'L013r');
ok('the lesson list renders status, target, scope, and provenance', renderLessonList([{ id: 'lsn_0123456789abcdef', status: 'promoted', target: 'analyzer', scope: 'financial', section: null, text: 'Never add a menu path.', provenance: { runId: 'baseline-1', candidateId: 'L013' }, proof: { proven: true, runId: 'treat-1' } }]).includes('proof proven (treat-1)') && renderLessonList([]) === 'No lessons.');

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
