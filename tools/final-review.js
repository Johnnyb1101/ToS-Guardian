'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const review = require('./final-review-lib');

const MAX_BODY_BYTES = 16 * 1024;

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function loadArtifacts(file) {
  const artifacts = readJson(file);
  if (!Array.isArray(artifacts)) throw new Error('artifact file must contain a JSON array');
  return artifacts;
}
function files(reviewDir) {
  return { publicFile: path.join(reviewDir, 'public.json'), privateFile: path.join(reviewDir, 'bindings.private.json') };
}
function prepare(artifactFile, reviewDir, seed = crypto.randomBytes(32).toString('hex')) {
  if (fs.existsSync(reviewDir)) throw new Error('review directory already exists; keep the previous append-only work');
  const { publicPackage, privateBindings } = review.buildReviewPackage({ artifacts: loadArtifacts(artifactFile), seed });
  fs.mkdirSync(reviewDir, { recursive: true });
  const { publicFile, privateFile } = files(reviewDir);
  fs.writeFileSync(publicFile, JSON.stringify(publicPackage, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(privateFile, JSON.stringify(privateBindings, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return { items: publicPackage.items.length, reviewDir };
}
function loadReview(reviewDir, artifactFile) {
  const { publicFile, privateFile } = files(reviewDir);
  const publicPackage = readJson(publicFile);
  const privateBindings = readJson(privateFile);
  const artifacts = loadArtifacts(artifactFile);
  review.validatePackage(publicPackage, privateBindings, artifacts);
  return { publicPackage, privateBindings, artifacts };
}
function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(JSON.stringify(value));
}
async function readBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      const error = new Error('body too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function allowedHost(req) {
  const host = req.headers.host;
  const port = req.socket.localPort;
  return req.socket.localAddress === '127.0.0.1' && req.socket.remoteAddress === '127.0.0.1' && host === `127.0.0.1:${port}`;
}
function allowedWrite(req, token) {
  const expected = `http://127.0.0.1:${req.socket.localPort}`;
  return req.headers.origin === expected && req.headers['x-review-token'] === token &&
    req.headers['content-type'] === 'application/json' &&
    (!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'same-origin');
}
function createServer({ reviewDir, artifactFile }) {
  const page = fs.readFileSync(path.join(__dirname, 'final-review.html'), 'utf8');
  const token = crypto.randomBytes(32).toString('hex');
  loadReview(reviewDir, artifactFile);
  return http.createServer(async (req, res) => {
    try {
      if (!allowedHost(req)) { sendJson(res, 403, { error: 'invalid_host' }); return; }
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.search || url.hash) { sendJson(res, 404, { error: 'not_found' }); return; }
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
        });
        res.end(page);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const { publicPackage, privateBindings, artifacts } = loadReview(reviewDir, artifactFile);
        const attempts = review.readAttempts(reviewDir, publicPackage, privateBindings, artifacts);
        sendJson(res, 200, { package: publicPackage, attempts: review.publicAttempts(attempts), token });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/attempts') {
        if (!allowedWrite(req, token)) { sendJson(res, 403, { error: 'write_not_allowed' }); return; }
        const { publicPackage, privateBindings, artifacts } = loadReview(reviewDir, artifactFile);
        const submission = await readBody(req);
        const result = review.appendAttempt(reviewDir, submission, publicPackage, privateBindings, artifacts);
        sendJson(res, 201, { ok: true, attempt: result.attempt, hash: result.hash });
        return;
      }
      sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      if (error instanceof SyntaxError || error.code === 'ERR_INVALID_URL' || /invalid|unknown|must|stale|tampered|mismatch|differs|chain|unexpected|incomplete|requires|duplicate/.test(error.message)) {
        sendJson(res, error.status || 400, { error: 'invalid_review', reason: error.message });
      } else {
        sendJson(res, error.status || 500, { error: 'server_error' });
      }
    }
  });
}

function usage() {
  console.error('Usage: node tools/final-review.js prepare <artifacts.json> <reviewDir>');
  console.error('       node tools/final-review.js serve <reviewDir> <artifacts.json> [--port 3125]');
  process.exitCode = 1;
}

if (require.main === module) {
  try {
    const [command, first, second, ...rest] = process.argv.slice(2);
    if (command === 'prepare' && first && second && rest.length === 0) {
      const result = prepare(path.resolve(first), path.resolve(second));
      console.log(`Prepared ${result.items} blinded items in ${result.reviewDir}`);
    } else if (command === 'serve' && first && second && (rest.length === 0 || rest.length === 2 && rest[0] === '--port')) {
      const port = rest.length ? Number(rest[1]) : 3125;
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('port must be 1–65535');
      const server = createServer({ reviewDir: path.resolve(first), artifactFile: path.resolve(second) });
      server.listen(port, '127.0.0.1', () => console.log(`Blinded local review: http://127.0.0.1:${port}/`));
    } else usage();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { prepare, loadReview, createServer };
