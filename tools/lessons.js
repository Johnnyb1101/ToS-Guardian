const fs = require('fs');
const path = require('path');
const { resolveProxyTarget } = require('./batch-lib');
const { candidatesToLessons, reviseCandidate, renderLessonList } = require('./lessons-lib');
const { dream } = require('./dream');

function usage(code) {
  console.log('Usage:');
  console.log('  node tools/lessons.js list --proxy <url>');
  console.log('  node tools/lessons.js create <runDir> --proxy <url> --ids L013,L015 [--target analyzer|critic]   register dream candidates as lessons');
  console.log('  node tools/lessons.js revise <runDir> <candidateId> --text "<rule>" --proxy <url> [--id L005b] [--after proof-bundle2]   register a reworded candidate with its parent in the provenance');
  console.log('  node tools/lessons.js status <lessonId> <canary|promoted|retired|candidate> --proxy <url> [--proof <runDir>]');
  process.exit(code);
}

const argv = process.argv.slice(2);
const command = argv.shift();
if (!command || command === '--help' || command === '-h') usage(0);
if (!['list', 'create', 'revise', 'status'].includes(command)) usage(1);

const opts = { proxy: null, ids: null, target: null, proof: null, text: null, id: null, after: null };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--proxy') opts.proxy = argv[++i];
  else if (a === '--ids') opts.ids = String(argv[++i]).split(',').map(s => s.trim()).filter(Boolean);
  else if (a === '--target') opts.target = argv[++i];
  else if (a === '--proof') opts.proof = argv[++i];
  else if (a === '--text') opts.text = argv[++i];
  else if (a === '--id') opts.id = argv[++i];
  else if (a === '--after') opts.after = argv[++i];
  else if (a.startsWith('--')) { console.error(`Unknown option: ${a}`); process.exit(1); }
  else positional.push(a);
}

const target = resolveProxyTarget({ proxy: opts.proxy, env: process.env });
if (target.error) { console.error(target.error); process.exit(1); }
if (target.isProduction) { console.error('Lessons are managed on the dev proxy only.'); process.exit(1); }

async function json(method, route, body) {
  const response = await fetch(`${target.url}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: response.status, data };
}

async function list() {
  const { status, data } = await json('GET', '/lessons');
  if (status !== 200) { console.error(`status ${status}: ${JSON.stringify(data)} (the lessons routes exist only on a proxy with TRAINER_OPERATIONS=1)`); process.exit(1); }
  console.log(renderLessonList(data.lessons));
}

async function create() {
  const runDir = positional[0];
  if (!runDir) usage(1);
  dream(path.resolve(runDir));
  const file = path.join(path.resolve(runDir), 'step1a', 'dream', 'lessons.json');
  if (!fs.existsSync(file)) { console.error(`No dream output at ${file}; run tools/dream.js first.`); process.exit(1); }
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  const lessons = candidatesToLessons(record.candidates, { ids: opts.ids, target: opts.target, runId: record.runId });
  if (!lessons.length) { console.error('No lesson candidates matched.'); process.exit(1); }
  for (const lesson of lessons) {
    const { status, data } = await json('POST', '/lessons', lesson);
    const id = data.lesson ? data.lesson.id : '?';
    console.log(`${(lesson.provenance.candidateId || '').padEnd(6)} -> ${status === 200 ? `${data.status} ${id}` : `http ${status} ${data.reason || data.error || ''}`}`);
  }
}

async function revise() {
  const [runDir, candidateId] = positional;
  if (!runDir || !candidateId || !opts.text) usage(1);
  dream(path.resolve(runDir));
  const file = path.join(path.resolve(runDir), 'step1a', 'dream', 'lessons.json');
  if (!fs.existsSync(file)) { console.error(`No dream output at ${file}; run tools/dream.js first.`); process.exit(1); }
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  const lesson = reviseCandidate(record.candidates, candidateId, opts.text, { id: opts.id, runId: record.runId, after: opts.after });
  if (!lesson) { console.error(`No lesson candidate ${candidateId} in ${file}.`); process.exit(1); }
  const { status, data } = await json('POST', '/lessons', lesson);
  const id = data.lesson ? data.lesson.id : '?';
  console.log(`${lesson.provenance.candidateId.padEnd(6)} -> ${status === 200 ? `${data.status} ${id}` : `http ${status} ${data.reason || data.error || ''}`}`);
}

async function setStatus() {
  const [id, status] = positional;
  if (!id || !status) usage(1);
  let proof;
  if (opts.proof) {
    const runDir = path.resolve(opts.proof);
    if (['evaluation', 'critic-evaluation'].some(name => fs.existsSync(path.join(runDir, 'step1a', name, 'evaluation.json')))) throw new Error('This run has a diagnostic evaluation; its historical proof cannot authorize a new lesson status change. Step 1B is pending.');
    const file = path.join(runDir, 'proof.json');
    if (!fs.existsSync(file)) { console.error(`No proof at ${file}; run tools/prove.js first.`); process.exit(1); }
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (p.diagnosticOnly || p.promotionEligible === false) throw new Error('Diagnostic evaluation cannot authorize a lesson status change; Step 1B is pending.');
    proof = { runId: p.runId, controlRunId: p.controlRunId, proven: p.proven === true, summary: p.summary };
  }
  const { status: http, data } = await json('POST', `/lessons/${encodeURIComponent(id)}/status`, { status, proof });
  if (http !== 200) { console.error(`status ${http}: ${JSON.stringify(data)}`); process.exit(1); }
  console.log(`${id}: ${data.lesson.status} (ledger seq ${data.ledgerSeq})`);
}

({ list, create, revise, status: setStatus })[command]().catch(err => { console.error(err); process.exit(1); });
