const fs = require('fs');
const path = require('path');
const { proveCritic, renderCriticProof, DEFAULT_MIN_CATCH_GAIN, DEFAULT_MAX_FALSE_ALARM_RISE, DEFAULT_MAX_FAILURE_RISE, DEFAULT_MAX_HOLDOUT_LOSS } = require('./critic-lib');

function usage(code) {
  console.log('Usage: node tools/prove-critic.js <treatmentRunDir> --control <controlRunDir> [--out <dir>] [--juror anthropic|openai] [--min-catch-gain 0.10] [--max-false-alarm-rise 0.10] [--max-failure-rise 0.02] [--max-holdout-loss 0.10]');
  console.log('Both runs must hold the same analyses and jury verdicts; only the critic verdicts may differ. The proof is written to the treatment run unless --out names another directory.');
  process.exit(code);
}

function loadArtifacts(runDir) {
  const dir = path.join(runDir, 'artifacts');
  if (!fs.existsSync(dir)) throw new Error(`No artifacts directory at ${dir}`);
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

function runIdOf(runDir) {
  const metaPath = path.join(runDir, 'run.json');
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (typeof meta.runId === 'string') return meta.runId;
  }
  return path.basename(runDir);
}

const argv = process.argv.slice(2);
if (!argv.length || argv[0] === '--help' || argv[0] === '-h') usage(0);
const opts = { control: null, out: null, juror: 'anthropic', minCatchGain: DEFAULT_MIN_CATCH_GAIN, maxFalseAlarmRise: DEFAULT_MAX_FALSE_ALARM_RISE, maxFailureRise: DEFAULT_MAX_FAILURE_RISE, maxHoldoutLoss: DEFAULT_MAX_HOLDOUT_LOSS };
let treatmentDir = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--control') opts.control = argv[++i];
  else if (a === '--out') opts.out = argv[++i];
  else if (a === '--juror') opts.juror = argv[++i];
  else if (a === '--min-catch-gain') opts.minCatchGain = Number(argv[++i]);
  else if (a === '--max-false-alarm-rise') opts.maxFalseAlarmRise = Number(argv[++i]);
  else if (a === '--max-failure-rise') opts.maxFailureRise = Number(argv[++i]);
  else if (a === '--max-holdout-loss') opts.maxHoldoutLoss = Number(argv[++i]);
  else if (a.startsWith('--')) { console.error(`Unknown option: ${a}`); process.exit(1); }
  else treatmentDir = a;
}
if (!treatmentDir || !opts.control) usage(1);

const treatment = path.resolve(treatmentDir);
const control = path.resolve(opts.control);
const out = path.resolve(opts.out || treatment);
if (!opts.out && fs.existsSync(path.join(treatment, 'proof.json')) && !JSON.parse(fs.readFileSync(path.join(treatment, 'proof.json'), 'utf8')).kind) {
  console.error(`${treatment} already holds a jury-score proof; pass --out to write the critic proof elsewhere.`);
  process.exit(1);
}
const proof = proveCritic({
  controlArtifacts: loadArtifacts(control),
  treatmentArtifacts: loadArtifacts(treatment),
  juror: opts.juror,
  minCatchGain: opts.minCatchGain,
  maxFalseAlarmRise: opts.maxFalseAlarmRise,
  maxFailureRise: opts.maxFailureRise,
  maxHoldoutLoss: opts.maxHoldoutLoss,
  meta: { runId: runIdOf(treatment), controlRunId: runIdOf(control) }
});
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'proof.json'), JSON.stringify(proof, null, 2) + '\n', 'utf8');
const markdown = renderCriticProof(proof);
fs.writeFileSync(path.join(out, 'proof.md'), markdown, 'utf8');
console.log(markdown);
console.log(`Written to ${path.join(out, 'proof.md')}`);
process.exit(proof.proven ? 0 : 2);
