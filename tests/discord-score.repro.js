const fs = require('fs');
const path = require('path');
const vm = require('vm');

const repoRoot = path.resolve(__dirname, '..');
const logs = [];
const sandbox = {
  console: {
    log: (...args) => logs.push(args.join(' ')),
    warn: (...args) => logs.push(args.join(' ')),
    error: (...args) => logs.push(args.join(' '))
  }
};

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(repoRoot, 'evaluator.js'), 'utf8'), sandbox, {
  filename: 'evaluator.js'
});

const discordStyleAnalysis = `
🔴 DATA SELLING & SHARING
- Advertising partners: Discord may share information such as identifiers, device data, usage data, and activity information for ads and measurement.
- Service providers: Discord shares information with vendors that help provide hosting, analytics, payments, security, customer support, and similar services.
- Business transfers and legal reasons: Discord may share information during a merger, acquisition, legal request, safety investigation, or to protect rights and users.

🔴 OPT-OUT RIGHTS
- You can control personalized advertising and certain data uses in Discord privacy settings.
- You can opt out of some advertising cookies or similar tracking through browser/device controls.
- You can manage some marketing communications by changing notification or email preferences.

📋 HOW TO OPT OUT RIGHT NOW
Open Discord settings, go to Privacy & Safety, and review data-use and personalization controls. Use your browser or device privacy settings to limit cookies or ad tracking. For marketing messages, use the unsubscribe link or notification settings.

🟡 AUTO-RENEWAL & BILLING
Not covered in this document.

🟢 DATA DELETION RIGHTS
Discord says you can request deletion of your account or data, but this excerpt is thin on exact deletion steps beyond using account/privacy controls.
`;

function runCase(name, criticVerdict = null) {
  logs.length = 0;
  const result = sandbox.evaluateAnalysis(discordStyleAnalysis, criticVerdict);
  const evalLog = logs.find(line => line.includes('[Evaluator] Score:')) || '';
  const issues = evalLog.includes('Issues: ')
    ? evalLog.split('Issues: ')[1].split(', ').filter(issue => issue && issue !== 'none')
    : [];
  return {
    name,
    score: result.score,
    label: result.label,
    escalate: result.escalate,
    issues,
    log: evalLog
  };
}

const cases = [
  runCase('no critic: legitimate not-covered/thin sections only'),
  runCase('one critic vague: auto-renewal thin', {
    dataSelling: 'grounded',
    optOutRights: 'grounded',
    howToOptOut: 'grounded',
    autoRenewal: 'vague',
    dataDeletion: 'grounded'
  }),
  runCase('one critic vague: data deletion thin', {
    dataSelling: 'grounded',
    optOutRights: 'grounded',
    howToOptOut: 'grounded',
    autoRenewal: 'skipped',
    dataDeletion: 'vague'
  })
];

function assertCase(name, expected) {
  const item = cases.find(testCase => testCase.name === name);
  if (!item) throw new Error(`Missing case: ${name}`);

  for (const [key, value] of Object.entries(expected)) {
    if (Array.isArray(value)) {
      const got = JSON.stringify(item[key]);
      const want = JSON.stringify(value);
      if (got !== want) {
        throw new Error(`${name}: expected ${key} ${want}, got ${got}`);
      }
      continue;
    }

    if (item[key] !== value) {
      throw new Error(`${name}: expected ${key} ${value}, got ${item[key]}`);
    }
  }
}

assertCase('no critic: legitimate not-covered/thin sections only', {
  score: 100,
  label: 'Strong',
  escalate: false,
  issues: []
});
assertCase('one critic vague: auto-renewal thin', {
  score: 90,
  label: 'Adequate',
  escalate: true,
  issues: ['critic: autoRenewal too vague']
});
assertCase('one critic vague: data deletion thin', {
  score: 90,
  label: 'Adequate',
  escalate: true,
  issues: ['critic: dataDeletion too vague']
});

const headers = ['case', 'score', 'label', 'escalate', 'issues'];
const rows = cases.map(item => [
  item.name,
  String(item.score),
  item.label,
  String(item.escalate),
  item.issues.length ? JSON.stringify(item.issues) : '[]'
]);
const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(row => row[i].length)));
const format = row => row.map((cell, i) => cell.padEnd(widths[i])).join(' | ');

console.log(format(headers));
console.log(widths.map(w => '-'.repeat(w)).join('-|-'));
for (const row of rows) console.log(format(row));

console.log('\nRaw evaluator logs:');
for (const item of cases) console.log(`- ${item.name}: ${item.log}`);
