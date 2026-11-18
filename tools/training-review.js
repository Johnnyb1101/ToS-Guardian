'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const review = require('./training-review-lib');
const dataset = require('./training-dataset-lib');

const MAX_BODY_BYTES = 256 * 1024;
const PAGE = fs.readFileSync(path.join(__dirname, 'training-review.html'), 'utf8');

function sendJson(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin'
  });
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
    const error = new Error('body too large'); error.status = 413; throw error;
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      const error = new Error('body too large'); error.status = 413; throw error;
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function expectedOrigin(req) { return `http://127.0.0.1:${req.socket.localPort}`; }
function allowedRead(req) {
  const origin = expectedOrigin(req);
  return req.socket.localAddress === '127.0.0.1' && req.socket.remoteAddress === '127.0.0.1' &&
    req.headers.host === origin.slice('http://'.length) &&
    (!req.headers.origin || req.headers.origin === origin) &&
    (!req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']));
}
function allowedWrite(req, token) {
  return req.headers.origin === expectedOrigin(req) && req.headers['x-review-token'] === token &&
    req.headers['content-type'] === 'application/json' &&
    (!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'same-origin');
}

function createServer({ prepDir, loadPreparation = () => require('./training-preparation').loadPreparation(prepDir) }) {
  const token = crypto.randomBytes(32).toString('hex');
  loadPreparation();
  return http.createServer(async (req, res) => {
    try {
      if (!allowedRead(req)) { sendJson(res, 403, { error: 'invalid_origin' }); return; }
      if (!req.url.startsWith('/') || req.url.startsWith('//')) { sendJson(res, 400, { error: 'invalid_url' }); return; }
      const url = new URL(req.url, expectedOrigin(req));
      if (url.origin !== expectedOrigin(req) || url.search || url.hash) { sendJson(res, 404, { error: 'not_found' }); return; }
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
          'Cross-Origin-Resource-Policy': 'same-origin',
          'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        });
        res.end(PAGE);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const prep = loadPreparation();
        const { records, histories, latest } = review.readReviews(prepDir, prep);
        const approval = Object.fromEntries(prep.cases.map(item => {
          const result = dataset.validateHistory(item, prep.rubric, histories[item.caseId]);
          return [item.caseId, { valid: result.approvalValid, reasons: result.approvalReasons }];
        }));
        const cases = prep.cases.map(item => ({
          caseId: item.caseId, domain: item.domain, sourceText: item.sourceText,
          sourceHash: item.sourceHash,
          proposals: item.proposals.map(proposal => ({ sample: proposal.sample, unverified: true, fields: proposal.fields }))
        }));
        sendJson(res, 200, {
          cases, rubricHash: prep.rubric.hash, fields: review.FIELD_KEYS,
          latest, approval, revisionCount: records.length, token
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/revisions') {
        if (!allowedWrite(req, token)) { sendJson(res, 403, { error: 'write_not_allowed' }); return; }
        const submission = await readBody(req);
        const prep = loadPreparation();
        const record = review.appendReview(prepDir, prep, submission);
        sendJson(res, 201, { ok: true, revision: record.revision, hash: record.hash });
        return;
      }
      sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      if (error.status === 413) sendJson(res, 413, { error: 'body_too_large' });
      else if (error instanceof SyntaxError || error.code === 'ERR_INVALID_URL') sendJson(res, 400, { error: 'invalid_request' });
      else if (/invalid|unknown|must|stale|changed|requires|missing|not found|quote|approval|uncertain|review|hash|incomplete|duplicate|empty|unsupported|not-found/i.test(error.message)) {
        const reason = error.message === 'review has changed; reload before saving'
          ? error.message : 'Review could not be saved. Check required fields and exact source quotes.';
        sendJson(res, 400, { error: 'invalid_review', reason });
      } else sendJson(res, 500, { error: 'server_error' });
    }
  });
}

function main(argv) {
  const [command, location, ...rest] = argv;
  if (command !== 'serve' || !location || !(rest.length === 0 || rest.length === 2 && rest[0] === '--port')) {
    throw new Error('Usage: node tools/training-review.js serve <prepDir> [--port 3126]');
  }
  const port = rest.length ? Number(rest[1]) : 3126;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('port must be 1–65535');
  const prepDir = path.resolve(location);
  const server = createServer({ prepDir });
  server.listen(port, '127.0.0.1', () => console.log(`Local training review: http://127.0.0.1:${port}/`));
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { createServer, main };
