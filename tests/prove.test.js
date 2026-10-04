const P = require('../tools/prove-lib');
const { candidatesToLessons, renderLessonList } = require('../tools/lessons-lib');
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
    domain, sample, split, docType: 'financial',
    analyzer: { status: 'ok', model: 'claude-sonnet-4-6', analysisChars: 1000, lessonsHash, lessonsArm: lessonsHash === 'h0' ? 'none' : 'pinned' },
    summary: '🧭 RISK LEVEL\nHigh', analysisSource: 'x',
    critic: { dataCollection: 'grounded', dataSelling: 'grounded', optOutRights: 'grounded', howToOptOut: 'grounded', autoRenewal: 'skipped', dataDeletion: 'grounded' },
    verdict: { label: 'Strong', score: 100, risk: 'High', issues: [] }, cost: 0.1,
    jury: { anthropic: { model: 'claude-opus-5', raw, usageRecord: { model: 'claude-opus-5', input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 } } }
  };
}

function run(domains, scoreFor, hash) {
  const out = [];
  for (const [domain, split] of domains) for (const sample of [1, 2, 3]) out.push(artifact(domain, sample, split, scoreFor(domain, sample), hash));
  return out;
}

const domains = [['a.com', 'work'], ['b.com', 'work'], ['c.com', 'work'], ['d.com', 'work'], ['e.com', 'work'], ['f.com', 'work'], ['g.com', 'holdout'], ['h.com', 'holdout'], ['i.com', 'holdout']];
const control = run(domains, () => 60, 'h0');

ok('the bootstrap is deterministic and brackets the mean', (() => { const a = P.bootstrapMeanInterval([1, 2, 3, 4, 5], 2000, 3); const b = P.bootstrapMeanInterval([1, 2, 3, 4, 5], 2000, 3); return a.lower === b.lower && a.lower < 3 && a.upper > 3; })());
ok('a single value has no interval', P.bootstrapMeanInterval([4]).lower === null);

ok('the fixture scores are what the jury math says', (() => { const one = P.perSite([artifact('z.com', 1, 'work', 60, 'h0')], 'anthropic').sites['z.com']; const two = P.perSite([artifact('z.com', 1, 'work', 100, 'h1')], 'anthropic').sites['z.com']; return one.score === 60 && two.score === 100 && one.fabricationRate === 2 && one.incompleteRate === 1 && two.incompleteRate === 0; })());

{
  const treatment = run(domains, () => 100, 'h1');
  const proof = P.prove({ controlArtifacts: control, treatmentArtifacts: treatment, meta: { runId: 't', controlRunId: 'c' } });
  ok('a clear gain on work and holdout is proven', proof.proven && proof.lessonsHash === 'h1' && proof.metrics.score.work.n === 6 && proof.metrics.score.holdout.n === 3, JSON.stringify(proof.reasons));
  ok('the fabrication and incompleteness metrics move the right way', proof.metrics.fabricationRate.work.mean < 0 && proof.metrics.incompleteRate.work.mean < 0);
  const md = P.renderProof(proof);
  ok('the proof renders the verdict, the rule, and the per-site table', md.startsWith('# Proof — t against c') && md.includes('Proven:') && md.includes('| a.com |') && md.includes('| score | work |'));
}

{
  const noisyControl = run(domains, (d, s) => s === 2 ? 70 : 60, 'h0');
  const treatment = run(domains, (d, s) => s === 1 ? 70 : 60, 'h1');
  const proof = P.prove({ controlArtifacts: noisyControl, treatmentArtifacts: treatment });
  ok('a change inside the noise is not proven', !proof.proven && proof.reasons.some(r => /inside the noise|below the/.test(r)), JSON.stringify(proof.reasons));
  ok('an unproven proof says why', P.renderProof(proof).includes('## Why not proven'));
}

{
  const treatment = run(domains, (d) => ['g.com', 'h.com', 'i.com'].includes(d) ? 30 : 100, 'h1');
  const proof = P.prove({ controlArtifacts: control, treatmentArtifacts: treatment });
  ok('a work gain with a holdout collapse is not proven', !proof.proven && proof.reasons.some(r => /holdout/.test(r)), JSON.stringify(proof.reasons));
}

{
  const treatment = run(domains, () => 100, 'h1').map((a, i) => i % 2 ? { ...a, analyzer: { ...a.analyzer, lessonsHash: 'h2' } } : a);
  const proof = P.prove({ controlArtifacts: control, treatmentArtifacts: treatment });
  ok('a treatment that ran under two lesson sets is not a proof', !proof.proven && proof.reasons.some(r => /lesson sets/.test(r)));
}

{
  const few = domains.slice(0, 3);
  const proof = P.prove({ controlArtifacts: run(few, () => 60, 'h0'), treatmentArtifacts: run(few, () => 100, 'h1') });
  ok('too few paired work sites is not a proof', !proof.proven && proof.reasons.some(r => /at least 5/.test(r)));
}

{
  const treatment = run(domains.filter(([d]) => d !== 'b.com'), () => 100, 'h1');
  const proof = P.prove({ controlArtifacts: control, treatmentArtifacts: treatment });
  ok('sites missing from one arm are left out of the pairing', proof.metrics.score.work.n === 5 && !proof.metrics.score.sites.some(d => d.domain === 'b.com'));
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
ok('the lesson list renders status, target, scope, and provenance', renderLessonList([{ id: 'lsn_0123456789abcdef', status: 'promoted', target: 'analyzer', scope: 'financial', section: null, text: 'Never add a menu path.', provenance: { runId: 'baseline-1', candidateId: 'L013' }, proof: { proven: true, runId: 'treat-1' } }]).includes('proof proven (treat-1)') && renderLessonList([]) === 'No lessons.');

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
