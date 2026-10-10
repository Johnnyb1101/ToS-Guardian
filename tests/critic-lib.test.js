const C = require('../tools/critic-lib');
const { SECTIONS } = require('../tools/jury-lib');

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (condition) { console.log(`  ok    ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

console.log('Critic proofs');

function juryRaw(fabrications) {
  return JSON.stringify({
    sections: Object.fromEntries(SECTIONS.map(s => [s, { accuracy: 'correct', completeness: 'complete', notes: '' }])),
    bottomLine: { fair: true, notes: '' }, riskLevel: { summary: 'High', jury: 'High', notes: '' },
    fabrications: Array.from({ length: fabrications }, (_, i) => `invented ${i}`), omissions: []
  });
}

const grounded = Object.fromEntries(SECTIONS.map(s => [s, 'grounded']));

function artifact({ runId, domain, sample, split, fabrications, critic, lessonsHash = 'c0', label = 'Strong', summary }) {
  return {
    v: 1, runId, domain, sample, split, docType: 'financial', textHash: 't', episodeId: `${domain}-${sample}`,
    analyzer: { status: 'ok', model: 'claude-sonnet-4-6', analysisChars: 1000, lessonsHash: 'a0', lessonsArm: 'none' },
    summary: summary || `🧭 RISK LEVEL\nHigh\n${domain}#${sample}`, analysisSource: 'source text',
    critic: critic === 'failed' ? { failed: true, _reason: 'unparseable' } : { ...critic, _lessonsHash: lessonsHash, _writeReceipt: null },
    verdict: { label, score: label === 'Strong' ? 100 : 85, risk: 'High', issues: [], optOutLinks: ['https://x.example/opt-out'] }, cost: 0.04,
    jury: { anthropic: { model: 'claude-opus-5', raw: juryRaw(fabrications), usageRecord: { model: 'claude-opus-5', input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 } } }
  };
}

const sites = [['a.com', 'work'], ['b.com', 'work'], ['c.com', 'work'], ['d.com', 'work'], ['e.com', 'work'], ['f.com', 'work'], ['g.com', 'work'], ['h.com', 'holdout'], ['i.com', 'holdout'], ['j.com', 'holdout']];
// odd samples carry a jury fabrication, even samples are clean
const fabricated = (sample) => sample % 2 === 1 ? 1 : 0;

function run(runId, criticFor, extra = {}) {
  const out = [];
  for (const [domain, split] of sites) for (const sample of [1, 2, 3]) {
    const spec = criticFor(domain, sample);
    out.push(artifact({ runId, domain, sample, split, fabrications: fabricated(sample), ...spec, ...(extra.summaryFor ? { summary: extra.summaryFor(domain, sample) } : {}) }));
  }
  return out;
}

const control = run('control', () => ({ critic: grounded, lessonsHash: 'c0' }));
const sharp = run('sharp', (domain, sample) => ({ critic: fabricated(sample) ? { ...grounded, howToOptOut: 'unsupported' } : grounded, lessonsHash: 'c1' }));
const proof = C.proveCritic({ controlArtifacts: control, treatmentArtifacts: sharp, meta: { runId: 'sharp', controlRunId: 'control' } });
ok('A critic that starts catching fabrications without false alarms is proven', proof.proven === true, proof.summary);
ok('Catch rate moved from 0 to 100 on the work split', proof.metrics.catchRate.work.n === 7 && proof.metrics.catchRate.work.mean === 1, JSON.stringify(proof.metrics.catchRate.work));
ok('False alarms stayed at zero', proof.metrics.falseAlarmRate.all.mean === 0);
ok('Proof names the single treatment lesson set', proof.lessonsHash === 'c1' && proof.controlLessonsHashes.join() === 'c0');
ok('All paired analyses were identical', proof.samples.paired === 30 && proof.samples.mismatched === 0);
ok('Proof carries the critic kind for the lessons route', proof.kind === 'critic' && typeof proof.summary === 'string');

const noisy = run('noisy', () => ({ critic: { ...grounded, dataSelling: 'vague' }, lessonsHash: 'c2' }));
const noisyProof = C.proveCritic({ controlArtifacts: control, treatmentArtifacts: noisy });
ok('Flagging every verdict is not proven', noisyProof.proven === false);
ok('The false-alarm rise is the stated reason', noisyProof.reasons.some(r => /false alarms may have risen/.test(r)), noisyProof.reasons.join('; '));

const mismatched = run('mismatched', (domain, sample) => ({ critic: fabricated(sample) ? { ...grounded, howToOptOut: 'unsupported' } : grounded, lessonsHash: 'c1' }), { summaryFor: (domain, sample) => `different ${domain}#${sample}` });
const mismatchedProof = C.proveCritic({ controlArtifacts: control, treatmentArtifacts: mismatched });
ok('Different analyses are refused', mismatchedProof.proven === false && mismatchedProof.reasons.some(r => /analyses differ on 30/.test(r)), mismatchedProof.reasons.join('; '));

const mixed = run('mixed', (domain, sample) => ({ critic: fabricated(sample) ? { ...grounded, howToOptOut: 'unsupported' } : grounded, lessonsHash: domain < 'f' ? 'c1' : 'c9' }));
const mixedProof = C.proveCritic({ controlArtifacts: control, treatmentArtifacts: mixed });
ok('Two lesson sets in the treatment are refused', mixedProof.proven === false && mixedProof.reasons.some(r => /2 lesson sets/.test(r)));

const brittle = run('brittle', (domain, sample) => (sample === 3 ? { critic: 'failed' } : { critic: fabricated(sample) ? { ...grounded, howToOptOut: 'unsupported' } : grounded, lessonsHash: 'c1' }));
const brittleProof = C.proveCritic({ controlArtifacts: control, treatmentArtifacts: brittle });
ok('A third of the critic answers failing to parse is refused', brittleProof.proven === false && brittleProof.reasons.some(r => /failed to parse on 33%/.test(r)), brittleProof.reasons.join('; '));
ok('Parse failure rates are reported for both arms', brittleProof.failure.control === 0 && Math.abs(brittleProof.failure.treatment - 1 / 3) < 1e-9);

const unchanged = run('unchanged', () => ({ critic: grounded, lessonsHash: 'c1' }));
const unchangedProof = C.proveCritic({ controlArtifacts: control, treatmentArtifacts: unchanged });
ok('No movement is inside the noise', unchangedProof.proven === false && unchangedProof.reasons.some(r => /inside the noise/.test(r)));

const markdown = C.renderCriticProof(proof);
ok('Rendered proof has the header, the rule and the site table', /^# Critic proof — sharp against control/.test(markdown) && /Rule: proven when/.test(markdown) && /\| a\.com \| work \|/.test(markdown));

const source = control[0];
const composed = C.composeCriticArtifact(source, { runId: 'recheck', critic: { ...grounded, howToOptOut: 'unsupported', _lessonsHash: 'c1' }, evaluation: { label: 'Adequate', score: 80, issues: ['critic: howToOptOut unsupported by source'], warning: null }, usage: [{ model: 'claude-sonnet-4-6', input: 10, output: 2, cacheRead: 0, cacheWrite: 0 }], cost: 0.03, unpriced: 0, error: '', durationMs: 1200, startedAt: '2026-10-10T00:00:00.000Z' });
ok('Composed artifact keeps the analysis, source and jury verdict', composed.summary === source.summary && composed.analysisSource === source.analysisSource && composed.jury === source.jury);
ok('Composed artifact records what the critic said before', composed.criticOf.runId === 'control' && composed.criticOf.labels.howToOptOut === 'grounded' && composed.criticOf.verdict.label === 'Strong' && composed.criticOf.lessonsHash === 'c0');
ok('Composed artifact carries the new verdict, run id and cost', composed.runId === 'recheck' && composed.verdict.label === 'Adequate' && composed.verdict.risk === 'High' && composed.verdict.optOutLinks.length === 1 && composed.cost === 0.03);
const failedSource = artifact({ runId: 'control', domain: 'z.com', sample: 1, split: 'work', fabrications: 0, critic: 'failed' });
ok('A failed source critic is recorded as failed with no labels', C.composeCriticArtifact(failedSource, { runId: 'r', critic: grounded, evaluation: null, usage: [], cost: 0 }).criticOf.failed === true && C.composeCriticArtifact(failedSource, { runId: 'r', critic: grounded, evaluation: null }).criticOf.labels === null);

const perSite = C.perSiteCritic(sharp, 'anthropic');
ok('Per-site rates separate caught, clean and failed verdicts', perSite.sites['a.com'].catchRate === 1 && perSite.sites['a.com'].falseAlarmRate === 0 && perSite.sites['a.com'].failedRate === 0);
ok('Label flips are counted against the recorded earlier verdict', C.proveCritic({ controlArtifacts: control, treatmentArtifacts: sharp.map(a => ({ ...a, criticOf: { runId: 'control', verdict: { label: 'Strong', score: 100 } }, verdict: { ...a.verdict, label: a.sample % 2 ? 'Adequate' : 'Strong' } })) }).labelFlips.flips['Strong to Adequate'] === 20);
ok('Concern count reads unsupported and vague labels', C.concernCount({ ...grounded, dataSelling: 'vague', howToOptOut: 'unsupported' }) === 2);
const flagged = run('flagged', (domain, sample) => ({ critic: fabricated(sample) ? { ...grounded, flags: ['step 4 names a menu path absent from the source'] } : grounded, lessonsHash: 'c1' }));
const flaggedProof = C.proveCritic({ controlArtifacts: control, treatmentArtifacts: flagged });
ok('A flag without a label change counts as noticed but not caught', flaggedProof.metrics.noticeRate.work.mean === 1 && flaggedProof.metrics.catchRate.work.mean === 0 && flaggedProof.proven === false);

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
