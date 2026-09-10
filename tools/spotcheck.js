const fs = require('fs');
const http = require('http');
const path = require('path');
const lib = require('./spotcheck-lib');

const MAX_BODY_BYTES = 5 * 1024 * 1024;

function usage(code) {
  console.log('Usage:');
  console.log('  node tools/spotcheck.js serve <runDir> [--port 3124] [--juror anthropic|openai]');
  console.log('  node tools/spotcheck.js agreement <runDir> [--juror anthropic|openai]');
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { port: 3124, juror: 'anthropic' };
  let runDir = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--juror') opts.juror = argv[++i];
    else if (a.startsWith('--')) { console.error(`Unknown option: ${a}`); process.exit(1); }
    else runDir = a;
  }
  if (!runDir) usage(1);
  return { runDir: path.resolve(runDir), opts };
}

function loadArtifacts(runDir) {
  const dir = path.join(runDir, 'artifacts');
  if (!fs.existsSync(dir)) throw new Error(`No artifacts directory at ${dir}`);
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

function marksPath(runDir) {
  return path.join(runDir, 'spotcheck', 'marks.json');
}

function loadMarks(runDir, runId) {
  const file = marksPath(runDir);
  if (!fs.existsSync(file)) return lib.emptyMarks(runId);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const problem = lib.validateMarks(parsed);
  if (problem) throw new Error(`${file}: ${problem}`);
  return parsed;
}

function runIdOf(runDir) {
  const metaPath = path.join(runDir, 'run.json');
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (typeof meta.runId === 'string') return meta.runId;
  }
  return path.basename(runDir);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function createServer(runDir, opts) {
  const runId = runIdOf(runDir);
  const artifacts = loadArtifacts(runDir);
  const model = lib.buildPageModel(artifacts, { juror: opts.juror });
  const page = fs.readFileSync(path.join(__dirname, 'spotcheck.html'), 'utf8');
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(page);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/model') {
        sendJson(res, 200, { runId, juror: opts.juror, sites: model });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/marks') {
        sendJson(res, 200, loadMarks(runDir, runId));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/marks') {
        let marks;
        try {
          marks = JSON.parse(await readBody(req));
        } catch (e) {
          sendJson(res, 400, { error: 'invalid_json', reason: e.message });
          return;
        }
        const problem = lib.validateMarks(marks);
        if (problem) { sendJson(res, 400, { error: 'invalid_marks', reason: problem }); return; }
        marks.runId = runId;
        marks.updatedAt = new Date().toISOString();
        fs.mkdirSync(path.dirname(marksPath(runDir)), { recursive: true });
        fs.writeFileSync(marksPath(runDir), JSON.stringify(marks, null, 2) + '\n', 'utf8');
        sendJson(res, 200, { ok: true, updatedAt: marks.updatedAt, file: marksPath(runDir) });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/agreement') {
        const result = lib.computeAgreement(artifacts, loadMarks(runDir, runId), { juror: opts.juror });
        sendJson(res, 200, { runId, markdown: lib.renderAgreement(result, { runId }), result });
        return;
      }
      sendJson(res, 404, { error: 'not_found' });
    } catch (e) {
      sendJson(res, 500, { error: 'server_error', reason: e.message });
    }
  });
  return { server, runId, sites: model.length };
}

function agreement(runDir, opts) {
  const runId = runIdOf(runDir);
  const artifacts = loadArtifacts(runDir);
  const result = lib.computeAgreement(artifacts, loadMarks(runDir, runId), { juror: opts.juror });
  const markdown = lib.renderAgreement(result, { runId });
  fs.mkdirSync(path.join(runDir, 'spotcheck'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'spotcheck', `agreement.${opts.juror}.md`), markdown, 'utf8');
  return markdown;
}

module.exports = { createServer, agreement, loadMarks, marksPath };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const command = argv.shift();
  if (!command || command === '--help' || command === '-h') usage(0);
  if (command !== 'serve' && command !== 'agreement') usage(1);
  const { runDir, opts } = parseArgs(argv);
  if (opts.juror !== 'anthropic' && opts.juror !== 'openai') { console.error('--juror must be anthropic or openai'); process.exit(1); }
  if (command === 'agreement') {
    console.log(agreement(runDir, opts));
    process.exit(0);
  }
  const { server, runId, sites } = createServer(runDir, opts);
  server.listen(opts.port, '127.0.0.1', () => {
    console.log(`TOS Guardian spot-check — ${runId}: ${sites} site(s), marks saved to ${marksPath(runDir)}`);
    console.log(`  open http://127.0.0.1:${opts.port}/ (local only; Ctrl+C to stop)`);
  });
}
