const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('../tools/spotcheck-lib');
const { createServer, agreement, marksPath } = require('../tools/spotcheck');

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (condition) { console.log(`  ok    ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

const SUMMARY = `🧭 BOTTOM LINE
Acorns collects your Social Security number and you must arbitrate disputes.

🧭 RISK LEVEL
High

📥 WHAT THEY COLLECT
- **SSN & gov IDs**: Social Security number, driver's license
- **Financial & account data**: Bank account numbers, balances

🔴 DATA SHARING & SELLING
- **Affiliates**: Transaction data for everyday business purposes

🔴 OPT-OUT RIGHTS
- **Affiliate marketing**: Call 855-604-5130

📋 HOW TO OPT OUT RIGHT NOW
1. **Affiliate marketing opt-out**: Call 855-604-5130
2. **Interest-based ads**: Click "Your Privacy Choices" in the footer

🟡 AUTO-RENEWAL & BILLING
No automatic charges mentioned in these documents.

🟢 DATA DELETION RIGHTS
Email support@acorns.com to request deletion.`;

(async () => {
  console.log('Spot-check');

  const parsed = lib.parseSummary(SUMMARY);
  ok('bottom line and risk level are read', parsed.bottomLine.startsWith('Acorns collects') && parsed.riskLevel === 'High');
  ok('bulleted and numbered lines become items with their markers stripped',
    parsed.sections.dataCollection.items.length === 2 && parsed.sections.howToOptOut.items.length === 2 && parsed.sections.howToOptOut.items[1].startsWith('**Interest-based ads**'));
  ok('the header variant "DATA SHARING & SELLING" maps to dataSelling', parsed.sections.dataSelling.items.length === 1);
  ok('single-sentence sections are one item each', parsed.sections.autoRenewal.items.length === 1 && parsed.sections.dataDeletion.items[0].startsWith('Email'));
  ok('a summary with bold headers and no emoji still parses', lib.parseSummary('**BOTTOM LINE**\nx\n**RISK LEVEL**\nLow\n**What They Collect**\n- a').sections.dataCollection.items.length === 1);
  ok('empty input parses to empty sections', lib.parseSummary(null).sections.dataDeletion.items.length === 0 && lib.parseSummary(null).riskLevel === 'missing');

  ok('valid marks validate', lib.validateMarks({ v: 1, sites: { 'a.com.1': { sections: { dataSelling: { items: { 0: 'supported' }, completeness: 'missing', note: '' } }, risk: 'High', bottomLineFair: true } } }) === null);
  ok('unknown marks are rejected', /unknown mark/.test(lib.validateMarks({ v: 1, sites: { 'a.com.1': { sections: { dataSelling: { items: { 0: 'maybe' } } } } } })));
  ok('unknown sections are rejected', /unknown section/.test(lib.validateMarks({ v: 1, sites: { 'a.com.1': { sections: { evil: { items: {} } } } } })));
  ok('bad site ids are rejected', /bad site id/.test(lib.validateMarks({ v: 1, sites: { '../x': {} } })));

  function juryRaw(overrides = {}) {
    const section = (a, c) => ({ accuracy: a, completeness: c, notes: '' });
    return JSON.stringify({
      sections: { dataCollection: section('correct', 'complete'), dataSelling: section('major', 'partial'), optOutRights: section('correct', 'partial'), howToOptOut: section('fabricated', 'complete'), autoRenewal: section('not-applicable', 'not-applicable'), dataDeletion: section('correct', 'complete') },
      bottomLine: { fair: true, notes: '' }, riskLevel: { summary: 'High', jury: 'High', notes: '' }, fabrications: ['x'], omissions: [], ...overrides
    });
  }
  const artifact = (domain, sample, extra = {}) => ({
    domain, sample, split: 'work', docType: 'financial', analyzer: { status: 'ok' }, summary: SUMMARY, analysisSource: '=== PRIVACY POLICY ===\nWe collect your SSN.',
    critic: { dataCollection: 'grounded', dataSelling: 'grounded', optOutRights: 'grounded', howToOptOut: 'unsupported', autoRenewal: 'skipped', dataDeletion: 'grounded' },
    verdict: { label: 'Strong', score: 100, risk: 'High', issues: [] },
    jury: { anthropic: { model: 'claude-opus-5', raw: juryRaw() } }, ...extra
  });

  const model = lib.buildPageModel([artifact('b.com', 1), artifact('a.com', 1), artifact('c.com', 1, { analyzer: { status: 'error' }, summary: null })]);
  ok('page model keeps analyzed sites in order with parsed summary, source, jury, and critic',
    model.length === 2 && model[0].id === 'a.com.1' && model[0].summary.sections.dataCollection.items.length === 2 && model[0].source.includes('SSN') && model[0].jury.score !== null && model[0].critic.howToOptOut === 'unsupported');

  const marks = {
    v: 1, sites: {
      'a.com.1': {
        sections: {
          dataCollection: { items: { 0: 'supported', 1: 'supported' }, completeness: 'complete' },
          dataSelling: { items: { 0: 'supported' }, completeness: 'complete' },
          optOutRights: { items: { 0: 'supported' }, completeness: 'missing' },
          howToOptOut: { items: { 0: 'supported', 1: 'not-supported' }, completeness: 'complete' },
          dataDeletion: { items: { 0: 'unsure' } }
        },
        risk: 'Moderate', bottomLineFair: true
      }
    }
  };
  const result = lib.computeAgreement([artifact('a.com', 1), artifact('b.com', 1)], marks);
  ok('unmarked sites are listed, marked ones counted', result.marked === 1 && result.unmarked[0] === 'b.com.1');
  ok('section agreement compares acceptable-versus-not with the jury',
    result.accuracy.compared === 5 && result.accuracy.agreed === 4 && result.perSection.dataSelling.rate === 0 && result.perSection.howToOptOut.rate === 1, JSON.stringify(result.accuracy));
  ok('completeness agreement compares complete-versus-not with the jury',
    result.completeness.compared === 4 && result.completeness.agreed === 3, JSON.stringify(result.completeness));
  ok('critic agreement is computed alongside', result.critic.compared === 5 && result.critic.agreed === 5, JSON.stringify(result.critic));
  ok('risk and bottom line are compared', result.risk.compared === 1 && result.risk.exact === 0 && result.bottomLine.compared === 1 && result.bottomLine.agreed === 1);
  ok('unsupported items are counted', result.items.marked === 7 && result.items.notSupported === 1);
  const markdown = lib.renderAgreement(result, { runId: 'r1' });
  ok('agreement report renders the tables', markdown.includes('# Spot-check agreement — r1') && markdown.includes('| a.com #1 |') && /section acceptable, you vs jury \| 5 \| 80%/.test(markdown), markdown.split('\n').slice(0, 12).join(' / '));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-spot-'));
  fs.mkdirSync(path.join(dir, 'artifacts'));
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ runId: 'spot-test' }), 'utf8');
  fs.writeFileSync(path.join(dir, 'artifacts', 'a.com.1.json'), JSON.stringify(artifact('a.com', 1)), 'utf8');
  const { server, runId, sites } = createServer(dir, { juror: 'anthropic' });
  ok('server builds the model from the run directory', runId === 'spot-test' && sites === 1);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${base}/`).then(r => r.text());
    ok('page is served', page.includes('<title>Spot-check</title>') && page.includes('/api/model'));
    const modelBody = await fetch(`${base}/api/model`).then(r => r.json());
    ok('model endpoint returns the sites', modelBody.runId === 'spot-test' && modelBody.sites.length === 1 && modelBody.sites[0].id === 'a.com.1');
    const empty = await fetch(`${base}/api/marks`).then(r => r.json());
    ok('marks start empty', empty.v === 1 && Object.keys(empty.sites).length === 0);
    const bad = await fetch(`${base}/api/marks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1, sites: { 'a.com.1': { sections: { dataSelling: { items: { 0: 'maybe' } } } } } }) });
    ok('invalid marks are refused', bad.status === 400);
    const saved = await fetch(`${base}/api/marks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(marks) }).then(r => r.json());
    ok('valid marks are saved to the run directory', saved.ok && fs.existsSync(marksPath(dir)) && JSON.parse(fs.readFileSync(marksPath(dir), 'utf8')).sites['a.com.1'].risk === 'Moderate');
    const reloaded = await fetch(`${base}/api/marks`).then(r => r.json());
    ok('saved marks are served back with the run id', reloaded.runId === 'spot-test' && reloaded.sites['a.com.1'].sections.optOutRights.completeness === 'missing');
    const agree = await fetch(`${base}/api/agreement`).then(r => r.json());
    ok('agreement endpoint reports on the saved marks', agree.result.marked === 1 && agree.markdown.includes('| a.com #1 |'));
    const md = agreement(dir, { juror: 'anthropic' });
    ok('agreement command writes the report beside the marks', md.includes('spot-test') && fs.existsSync(path.join(dir, 'spotcheck', 'agreement.anthropic.md')));
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\nSummary: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
