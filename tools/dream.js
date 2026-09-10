const fs = require('fs');
const path = require('path');
const { dreamLessons, renderLessons } = require('./dream-lib');
const { reflect } = require('./reflect');

function usage(code) {
  console.log('Usage: node tools/dream.js <runDir> [--juror anthropic|openai]');
  process.exit(code);
}

function dream(runDir, opts = {}) {
  const findingsPath = path.join(runDir, 'reflect', 'findings.json');
  const findings = fs.existsSync(findingsPath) ? JSON.parse(fs.readFileSync(findingsPath, 'utf8')) : reflect(runDir, opts).findings;
  const candidates = dreamLessons(findings);
  const outDir = path.join(runDir, 'dream');
  fs.mkdirSync(outDir, { recursive: true });
  const record = { v: 1, runId: findings.runId, generatedAt: new Date().toISOString(), juror: findings.juror, snapshot: findings.snapshot, candidates };
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
