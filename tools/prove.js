const fs = require('fs');
const path = require('path');
const { prove, renderProof, DEFAULT_MIN_GAIN, DEFAULT_MAX_HOLDOUT_LOSS } = require('./prove-lib');

function usage(code) {
  console.log('Usage: node tools/prove.js <treatmentRunDir> --control <controlRunDir> [--juror anthropic|openai] [--min-gain 3] [--max-holdout-loss 5]');
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
const opts = { control: null, juror: 'anthropic', minGain: DEFAULT_MIN_GAIN, maxHoldoutLoss: DEFAULT_MAX_HOLDOUT_LOSS };
let treatmentDir = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--control') opts.control = argv[++i];
  else if (a === '--juror') opts.juror = argv[++i];
  else if (a === '--min-gain') opts.minGain = Number(argv[++i]);
  else if (a === '--max-holdout-loss') opts.maxHoldoutLoss = Number(argv[++i]);
  else if (a.startsWith('--')) { console.error(`Unknown option: ${a}`); process.exit(1); }
  else treatmentDir = a;
}
if (!treatmentDir || !opts.control) usage(1);

const treatment = path.resolve(treatmentDir);
const control = path.resolve(opts.control);
const proof = prove({
  controlArtifacts: loadArtifacts(control),
  treatmentArtifacts: loadArtifacts(treatment),
  juror: opts.juror,
  minGain: opts.minGain,
  maxHoldoutLoss: opts.maxHoldoutLoss,
  meta: { runId: runIdOf(treatment), controlRunId: runIdOf(control) }
});
fs.writeFileSync(path.join(treatment, 'proof.json'), JSON.stringify(proof, null, 2) + '\n', 'utf8');
const markdown = renderProof(proof);
fs.writeFileSync(path.join(treatment, 'proof.md'), markdown, 'utf8');
console.log(markdown);
console.log(`Written to ${path.join(treatment, 'proof.md')}`);
process.exit(proof.proven ? 0 : 2);
