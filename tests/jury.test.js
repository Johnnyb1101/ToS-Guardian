const J = require('../tools/jury-lib');

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (condition) { console.log(`  ok    ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

console.log('Jury scoring');

function section(accuracy, completeness, notes = '') {
  return { accuracy, completeness, notes };
}

function perfectVerdict(overrides = {}) {
  return {
    sections: {
      dataCollection: section('correct', 'complete'),
      dataSelling: section('correct', 'complete'),
      optOutRights: section('correct', 'complete'),
      howToOptOut: section('correct', 'complete'),
      autoRenewal: section('not-applicable', 'not-applicable'),
      dataDeletion: section('correct', 'complete')
    },
    bottomLine: { fair: true, notes: '' },
    riskLevel: { summary: 'High', jury: 'High', notes: '' },
    fabrications: [],
    omissions: [],
    ...overrides
  };
}

const fenced = '```json\n' + JSON.stringify(perfectVerdict()) + '\n```';
ok('parses a fenced JSON verdict', J.parseJuryJson(fenced) && J.parseJuryJson(fenced).sections.dataSelling.accuracy === 'correct');
ok('parses a verdict wrapped in prose', J.parseJuryJson('Here is my grading: ' + JSON.stringify(perfectVerdict()) + ' Done.') !== null);
ok('rejects text without JSON', J.parseJuryJson('no verdict here') === null && J.parseJuryJson(null) === null);
ok('rejects malformed JSON', J.parseJuryJson('{"sections": ') === null);
{
  const full = JSON.stringify(perfectVerdict());
  ok('repairs a verdict missing its last closing brace', J.parseJuryJson(full.slice(0, -1)) !== null && J.parseJuryJson(full.slice(0, -1)).riskLevel.jury === 'High');
  const slipped = full.replace('}},"bottomLine"', '},"bottomLine"');
  const repaired = J.normalizeVerdict(J.parseJuryJson(slipped));
  ok('a brace dropped after the last section still yields a valid verdict', repaired.valid && repaired.riskLevel.jury === 'High' && repaired.bottomLine.fair === true, repaired.errors.join('; '));
  const trailingComma = full.replace('}},"bottomLine"', '},\n  },\n  "bottomLine"').replace('"omissions":[]}', '"omissions":[],\n}');
  const commaFixed = J.normalizeVerdict(J.parseJuryJson(trailingComma));
  ok('trailing commas before a closing brace are repaired', commaFixed.valid && commaFixed.riskLevel.jury === 'High', commaFixed.errors.join('; '));
  ok('a comma inside a string is left alone', J.parseJuryJson('{"a": "x, }", "b": 1}').a === 'x, }');
}

{
  const v = J.normalizeVerdict(perfectVerdict());
  ok('a well-formed verdict is valid', v.valid, v.errors.join('; '));
  ok('labels are lowercased and synonyms of not-applicable are accepted',
    J.normalizeVerdict(perfectVerdict({ sections: { ...perfectVerdict().sections, autoRenewal: section('N/A', 'Not Applicable') } })).sections.autoRenewal.accuracy === 'not-applicable');
  const bad = J.normalizeVerdict(perfectVerdict({ sections: { ...perfectVerdict().sections, dataSelling: section('partially_grounded', 'complete') } }));
  ok('an invented label is an error', !bad.valid && /dataSelling\.accuracy/.test(bad.errors[0]));
  ok('a verdict without a jury risk is an error', !J.normalizeVerdict(perfectVerdict({ riskLevel: { summary: 'High', jury: '', notes: '' } })).valid);
  ok('a non-object verdict is invalid, not a crash', !J.normalizeVerdict(null).valid && !J.normalizeVerdict('x').valid);
  ok('lists keep only strings', J.normalizeVerdict(perfectVerdict({ fabrications: ['a', 7, 'b'] })).fabrications.length === 2);
}

{
  ok('a perfect verdict scores 100', J.scoreVerdict(J.normalizeVerdict(perfectVerdict())).score === 100);
  const oneMajor = J.normalizeVerdict(perfectVerdict({ sections: { ...perfectVerdict().sections, dataSelling: section('major', 'complete') } }));
  ok('one major error in five applicable sections costs twelve points', J.scoreVerdict(oneMajor).score === 88, String(J.scoreVerdict(oneMajor).score));
  const partial = J.normalizeVerdict(perfectVerdict({ sections: { ...perfectVerdict().sections, optOutRights: section('correct', 'partial') } }));
  ok('a partial section costs four points', J.scoreVerdict(partial).score === 96, String(J.scoreVerdict(partial).score));
  const fabricated = J.normalizeVerdict(perfectVerdict({ fabrications: ['claims a 30-day refund window'] }));
  ok('each fabrication costs a further ten points', J.scoreVerdict(fabricated).score === 90);
  const allNa = J.normalizeVerdict(perfectVerdict({ sections: Object.fromEntries(J.SECTIONS.map(n => [n, section('not-applicable', 'not-applicable')])) }));
  ok('a verdict with no applicable section has no score', J.scoreVerdict(allNa).score === null && J.scoreVerdict(allNa).applicable === 0);
  const floor = J.normalizeVerdict(perfectVerdict({ sections: Object.fromEntries(J.SECTIONS.map(n => [n, section('fabricated', 'missing')])), fabrications: ['a', 'b', 'c'] }));
  ok('the score never goes below zero', J.scoreVerdict(floor).score === 0);
}

ok('reads the risk level out of a summary', J.riskFromSummary('🧭 BOTTOM LINE\nx\n\n🧭 RISK LEVEL\nModerate\n\n📥 WHAT THEY COLLECT') === 'Moderate');
ok('reads a bolded risk level', J.riskFromSummary('**🧭 RISK LEVEL**\n**High**') === 'High');
ok('missing risk level is reported as missing', J.riskFromSummary('no risk line') === 'missing' && J.riskFromSummary(null) === 'missing');
ok('risk distance counts steps and refuses unknowns', J.riskDistance('Low', 'High') === 2 && J.riskDistance('Moderate', 'High') === 1 && J.riskDistance('missing', 'High') === null);

{
  const verdict = J.normalizeVerdict(perfectVerdict({ sections: { ...perfectVerdict().sections, dataSelling: section('major', 'complete'), howToOptOut: section('minor', 'partial') } }));
  const critic = { dataCollection: 'grounded', dataSelling: 'grounded', optOutRights: 'unsupported', howToOptOut: 'vague', autoRenewal: 'skipped', dataDeletion: 'grounded', flags: [] };
  const agreement = J.criticAgreement(critic, verdict);
  ok('critic agreement compares acceptable-versus-not per section',
    agreement.compared === 6 && agreement.perSection.dataSelling === 'disagree' && agreement.perSection.optOutRights === 'disagree' && agreement.perSection.howToOptOut === 'disagree' && agreement.perSection.autoRenewal === 'agree',
    JSON.stringify(agreement));
  ok('agreement rate is agreed over compared', agreement.agreed === 3 && agreement.rate === 0.5);
  ok('a failed critic compares nothing', J.criticAgreement(null, verdict).compared === 0 && J.criticAgreement(null, verdict).rate === null);
}

function artifact(domain, split, docType, verdictOverrides, extra = {}) {
  const verdict = J.normalizeVerdict(perfectVerdict(verdictOverrides));
  return {
    v: 1, runId: 'r', domain, sample: 1, split, docType, episodeId: '0123456789abcdef',
    analyzer: { status: 'ok', model: 'claude-sonnet-4-6', usage: {} },
    summary: '🧭 RISK LEVEL\nHigh\n',
    critic: { dataCollection: 'grounded', dataSelling: 'grounded', optOutRights: 'grounded', howToOptOut: 'grounded', autoRenewal: 'skipped', dataDeletion: 'grounded' },
    verdict: { label: 'Strong', score: 85, risk: 'High' },
    cost: 0.1,
    jury: { anthropic: { model: 'claude-opus-5', verdict, score: J.scoreVerdict(verdict), usageRecord: { model: 'claude-opus-5', input: 20000, output: 1000, cacheRead: 0, cacheWrite: 0 } } },
    ...extra
  };
}

{
  const artifacts = [
    artifact('a.com', 'work', 'financial', {}),
    artifact('b.com', 'work', 'social', { sections: { ...perfectVerdict().sections, dataSelling: section('major', 'complete') }, riskLevel: { summary: 'High', jury: 'Low', notes: '' } }),
    artifact('c.com', 'holdout', 'financial', { fabrications: ['invented a refund window'] }),
    artifact('d.com', 'holdout', 'media', {}, { analyzer: { status: 'error', model: '' }, summary: null, error: 'relay error' }),
    artifact('e.com', 'work', 'media', {}, { jury: {} })
  ];
  const summary = J.summarizeRun(artifacts, { juror: 'anthropic' });
  ok('grades the artifacts that have a valid verdict and lists the rest', summary.graded === 3 && summary.problems.length === 2 && /analyzer error/.test(summary.problems[0].problem) && /not graded/.test(summary.problems[1].problem), JSON.stringify(summary.problems));
  ok('scores by split use the jury score', summary.bySplit.work.n === 2 && summary.bySplit.work.mean === 94 && summary.bySplit.holdout.mean === 90, JSON.stringify(summary.bySplit));
  ok('section error rate counts major and fabricated verdicts', summary.sections.dataSelling.errorRate === 1 / 3 && summary.sections.dataCollection.errorRate === 0);
  ok('critic agreement is aggregated over compared sections', summary.criticAgreement.compared === 18 && summary.criticAgreement.agreed === 17, JSON.stringify(summary.criticAgreement));
  ok('risk agreement separates exact from far', summary.risk.exact === 2 && summary.risk.far === 1);
  ok('fabrications are counted and attributed', summary.fabrications.total === 1 && summary.fabrications.top[0].domain === 'c.com');
  ok('jury cost is priced from the usage records', summary.cost.jury > 0 && summary.cost.juryUnpriced === 0 && Math.abs(summary.cost.replay - 0.5) < 1e-9, JSON.stringify(summary.cost));
  const rawOnly = artifact('f.com', 'work', 'social', {}, { jury: { anthropic: { model: 'claude-opus-5', raw: JSON.stringify(perfectVerdict()).slice(0, -1), error: 'jury returned no JSON', usageRecord: { model: 'claude-opus-5', input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 } } } });
  const reparsed = J.summarizeRun([rawOnly], { juror: 'anthropic' });
  ok('a stored raw verdict is re-parsed with the current parser, so old failures recover', reparsed.graded === 1 && reparsed.rows[0].juryScore === 100, JSON.stringify(reparsed.problems));
  const failedCall = artifact('g.com', 'work', 'social', {}, { jury: { anthropic: { model: 'claude-opus-5', raw: 'nothing useful', error: 'jury returned no JSON', usageRecord: { model: 'claude-opus-5', input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 } } } });
  ok('a failed jury call still counts toward jury cost', J.summarizeRun([failedCall], { juror: 'anthropic' }).cost.jury > 0);
  const markdown = J.renderReport(summary, { runId: 'replay-test', proxy: 'http://localhost:3000' });
  ok('report names the run, the sites, and the ungraded ones',
    markdown.includes('# Jury baseline — replay-test') && markdown.includes('| a.com |') && markdown.includes('| c.com |') && markdown.includes('d.com sample 1: analyzer error'));
  ok('report carries the section table and the cost line', markdown.includes('| dataSelling | 3 | 33% |') && /Cost: replay \$0\.5000/.test(markdown), markdown.split('\n').find(l => l.startsWith('| dataSelling')));
  ok('an empty run renders without crashing', J.renderReport(J.summarizeRun([], {}), {}).includes('no graded sites'));
}

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
