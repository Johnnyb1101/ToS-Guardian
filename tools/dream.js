const fs = require('fs');
const path = require('path');
const { assertWorkFindings, dreamLessons, renderLessons } = require('./dream-lib');
const { reflect, loadArtifacts } = require('./reflect');
const { selectWorkArtifacts } = require('./reflect-lib');
const { loadManifest } = require('./reference-lib');

function usage(code) {
  console.log('Usage: node tools/dream.js <runDir> [--juror anthropic|openai]');
  process.exit(code);
}

function dream(runDir, opts = {}) {
  const juror = opts.juror || 'anthropic';
  const findingsPath = path.join(runDir, 'step1a', 'reflect', 'findings.json');
  if (fs.existsSync(findingsPath)) {
    const cached = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
    assertWorkFindings(cached, { juror });
    const metaPath = path.join(runDir, 'run.json');
    const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
    const current = selectWorkArtifacts(loadArtifacts(runDir), loadManifest(), juror, meta.evaluationSet).provenance;
    if (cached.provenance.manifestHash !== current.manifestHash ||
        cached.provenance.evaluationSetHash !== current.evaluationSetHash ||
        JSON.stringify(cached.provenance.inputs) !== JSON.stringify(current.inputs) ||
        JSON.stringify(cached.provenance.excluded) !== JSON.stringify(current.excluded)) {
      throw new Error('Cached findings inputs changed; regenerate Step1A reflection');
    }
  }
  const findings = reflect(runDir, opts).findings;
  const candidates = dreamLessons(findings, { juror });
  const outDir = path.join(runDir, 'step1a', 'dream');
  fs.mkdirSync(outDir, { recursive: true });
  const record = { v: 1, runId: findings.runId, generatedAt: new Date().toISOString(), juror: findings.juror, snapshot: findings.snapshot, provenance: findings.provenance, candidates };
  fs.writeFileSync(path.join(outDir, 'lessons.json'), JSON.stringify(record, null, 2) + '\n', 'utf8');
  const markdown = renderLessons(candidates, { runId: findings.runId, generatedAt: findings.generatedAt });
  fs.writeFileSync(path.join(outDir, 'lessons.md'), markdown, 'utf8');
  return { candidates, markdown, outDir };
}

module.exports = { dream };

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
  const { markdown, outDir } = dream(path.resolve(runDir), opts);
  console.log(markdown);
  console.log(`Written to ${outDir}`);
}
