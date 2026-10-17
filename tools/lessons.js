const fs = require('fs');
const path = require('path');
const { resolveProxyTarget } = require('./batch-lib');
const { candidatesToLessons, reviseCandidate, renderLessonList } = require('./lessons-lib');
const { dream } = require('./dream');
const { trainerHeaders } = require('./sites-lib');

function usage(code) {
  console.log('Usage:');
  console.log('  node tools/lessons.js list --proxy <url>');
  console.log('  node tools/lessons.js create <runDir> --proxy <url> --ids L013,L015 [--target analyzer|critic]   register dream candidates as lessons');
  console.log('  node tools/lessons.js revise <runDir> <candidateId> --text "<rule>" --proxy <url> [--id L005b] [--after proof-bundle2]   register a reworded candidate with its parent in the provenance');
  console.log('  node tools/lessons.js release <configHash> --proxy <url>                          inspect a complete immutable release');
  console.log('  Per-lesson status changes are retired; releases are activated as a whole with owner authorization.');
  process.exit(code);
}

const argv = process.argv.slice(2);
const command = argv.shift();
if (!command || command === '--help' || command === '-h') usage(0);
if (!['list', 'create', 'revise', 'status', 'release'].includes(command)) usage(1);

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
  const response = await fetch(`${target.url}${route}`, { method, headers: trainerHeaders({ 'Content-Type': 'application/json' }), body: body ? JSON.stringify(body) : undefined });
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
  throw new Error('Per-lesson status changes cannot authorize canary or promotion; submit a complete signed release with owner authorization. Diagnostic and historical proofs cannot authorize activation.');
}

async function showRelease() {
  const configHash = positional[0];
  if (!/^[a-f0-9]{64}$/.test(configHash || '')) usage(1);
  const release = await require('./sites-lib').fetchRelease(target.url, configHash);
  console.log(JSON.stringify({ configHash: release.configHash, lessons: release.config.lessons.length, sites: release.config.sites.length, policy: release.config.policy }, null, 2));
}

({ list, create, revise, status: setStatus, release: showRelease })[command]().catch(err => { console.error(err); process.exit(1); });
