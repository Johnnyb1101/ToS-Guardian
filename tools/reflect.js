const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const lib = require('./reflect-lib');
const refLib = require('./reference-lib');

function usage(code) {
  console.log('Usage: node tools/reflect.js <runDir> [--juror anthropic|openai]');
  process.exit(code);
}

function loadArtifacts(runDir) {
  const dir = path.join(runDir, 'artifacts');
  if (!fs.existsSync(dir)) throw new Error(`No artifacts directory at ${dir}`);
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

function loadJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function gitCommit(cwd) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch (e) {
    return null;
  }
}

function reflect(runDir, opts = {}) {
  const juror = opts.juror || 'anthropic';
  const artifacts = loadArtifacts(runDir);
  const manifest = refLib.loadManifest();
  const meta = loadJson(path.join(runDir, 'run.json')) || {};
  const marks = loadJson(path.join(runDir, 'spotcheck', 'marks.json'));
  const findings = lib.reflectRun({
    artifacts, manifest, marks, juror,
    meta: { runId: meta.runId || path.basename(runDir), proxy: meta.proxy, startedAt: meta.startedAt, gitCommit: gitCommit(path.resolve(__dirname, '..')) }
  });
  const outDir = path.join(runDir, 'reflect');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'findings.json'), JSON.stringify(findings, null, 2) + '\n', 'utf8');
  const markdown = lib.renderFindings(findings);
  fs.writeFileSync(path.join(outDir, 'findings.md'), markdown, 'utf8');
  return { findings, markdown, outDir };
}

module.exports = { reflect, loadArtifacts };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opts = { juror: 'anthropic' };
  let runDir = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') usage(0);
    else if (a === '--juror') opts.juror = argv[++i];
    else if (a.startsWith('--')) { console.error(`Unknown option: ${a}`); process.exit(1); }
    else runDir = a;
  }
  if (!runDir) usage(1);
  const { markdown, outDir } = reflect(path.resolve(runDir), opts);
  console.log(markdown);
  console.log(`Written to ${outDir}`);
}
