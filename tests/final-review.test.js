'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { seal, hashText, digest } = require('../tools/final-corpus-lib');
const review = require('../tools/final-review-lib');
const { prepare, loadReview, createServer } = require('../tools/final-review');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`  ok    ${name}`); }
function artifact(arm, siteId, sample) {
  const analysisSource = 'Policy: We share account details with service providers.\nDeletion requests may be sent by email.\nQuoted text: <script>alert(1)</script>';
  const summary = 'The company shares account details with service providers.';
  const critic = { dataSharing: 'grounded' };
  return seal({
    v: 1, kind: 'step2-artifact', artifactId: crypto.randomUUID(), attempt: 1, previousAttemptHash: null,
    arm, siteId, sample, status: 'ok', mock: true, diagnosticOnly: true, promotionEligible: false, evaluationPassed: false,
    configHash: hashText(`${arm}-config`), protocolHash: hashText('protocol'),
    sourceHash: hashText('frozen corpus text'), analysisSource, summary, critic,
    analysisSourceHash: hashText(analysisSource), summaryHash: hashText(summary), criticHash: digest(critic),
    usage: null, latencyMs: null
  });
}
function retry(previous, status) {
  const { hash, error, ...body } = previous;
  const summary = status === 'ok' ? 'Revised summary: account details are shared with service providers.' : '';
  const critic = status === 'ok' ? { dataSharing: 'grounded' } : null;
  return seal({
    ...body, artifactId: crypto.randomUUID(), attempt: previous.attempt + 1, previousAttemptHash: hash, status,
    summary, summaryHash: hashText(summary), critic, criticHash: digest(critic),
    ...(status === 'failed' ? { error: 'mock failure' } : {})
  });
}
function request(port, method, route, headers = {}, body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: route, headers }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: res.headers['content-type']?.startsWith('application/json') ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
async function run() {
  const artifacts = [artifact('control', 'site-alpha', 1), artifact('treatment', 'site-alpha', 1)];
  const seed = hashText('blinding seed');
  const first = review.buildReviewPackage({ artifacts, seed });
  const again = review.buildReviewPackage({ artifacts: [...artifacts].reverse(), seed });
  check('opaque IDs are stable under input order and public package omits private metadata', () => {
    assert.deepEqual(first.publicPackage, again.publicPackage);
    assert.match(first.publicPackage.items[0].itemId, /^[a-f0-9]{32}$/);
    const text = JSON.stringify(first.publicPackage);
    for (const secret of ['site-alpha', artifacts[0].configHash, artifacts[0].protocolHash, 'critic', 'control', 'treatment']) assert.equal(text.includes(secret), false, secret);
    assert.equal(first.publicPackage.items[0].analysisSource, artifacts[0].analysisSource);
    assert.equal(first.publicPackage.diagnosticOnly, true);
    assert.equal(first.publicPackage.promotionEligible, false);
    assert.equal(first.privateBindings.evaluationPassed, false);
  });
  check('retained failed attempts permit a successful retry and hide latest failed slots', () => {
    const failedControl = retry(artifacts[0], 'failed');
    const successControl = retry(failedControl, 'ok');
    const failedTreatment = retry(artifacts[1], 'failed');
    const history = [artifacts[0], artifacts[1], failedControl, failedTreatment, successControl];
    const prepared = review.buildReviewPackage({ artifacts: history, seed });
    assert.equal(prepared.publicPackage.items.length, 1);
    assert.equal(prepared.publicPackage.items[0].summary, successControl.summary);
    assert.equal(Object.values(prepared.privateBindings.bindings)[0].artifactHash, successControl.hash);
    assert.equal(review.validatePackage(prepared.publicPackage, prepared.privateBindings, history), true);
    assert.throws(() => review.validatePackage(prepared.publicPackage, prepared.privateBindings, [...history, retry(successControl, 'failed')]), /no current successful artifacts/);
    assert.throws(() => review.buildReviewPackage({ artifacts: [artifacts[0], failedControl], seed }), /no current successful artifacts/);
    assert.throws(() => review.buildReviewPackage({ artifacts: [artifacts[0], { ...failedControl, previousAttemptHash: hashText('wrong') }], seed }), /stale|chain/);
    assert.throws(() => review.buildReviewPackage({ artifacts: [artifacts[0], { ...failedControl, status: 'unknown' }], seed }), /invalid artifact status/);
  });
  const id = first.publicPackage.items[0].itemId;
  const submission = {
    itemId: id, finding: 'claim', verdict: 'unsure',
    subject: 'shares account details with service providers',
    sourceEvidence: 'We share account details with service providers.', note: 'The exact scope of account details remains unclear.'
  };
  check('only exact summary and source quotations are accepted', () => {
    assert.throws(() => review.validateSubmission({ ...submission, sourceEvidence: '<script>alert(2)</script>' }, first.publicPackage, first.privateBindings), /exact displayed source/);
    assert.throws(() => review.validateSubmission({ ...submission, subject: 'invented summary' }, first.publicPackage, first.privateBindings), /exact displayed summary/);
    assert.throws(() => review.validateSubmission({ ...submission, note: '' }, first.publicPackage, first.privateBindings), /need a note/);
    assert.throws(() => review.validateSubmission({ ...submission, configHash: artifacts[0].configHash }, first.publicPackage, first.privateBindings), /unexpected review field/);
  });
  check('each public item must bind to a distinct artifact', () => {
    const ids = first.publicPackage.items.map(item => item.itemId);
    const duplicate = JSON.parse(JSON.stringify(first.privateBindings));
    duplicate.bindings[ids[1]] = duplicate.bindings[ids[0]];
    assert.throws(() => review.validatePackage(first.publicPackage, duplicate, artifacts), /duplicate artifact binding/);
  });
  const tempBase = fs.realpathSync(os.tmpdir());
  const temp = fs.mkdtempSync(path.join(tempBase, 'tos-final-review-'));
  const artifactFile = path.join(temp, 'artifacts.json');
  const reviewDir = path.join(temp, 'review');
  fs.writeFileSync(artifactFile, JSON.stringify(artifacts));
  let server;
  try {
    const result = prepare(artifactFile, reviewDir, seed);
    check('prepare writes separate public and private files and refuses overwrite', () => {
      assert.equal(result.items, 2);
      assert.deepEqual(loadReview(reviewDir, artifactFile).publicPackage, first.publicPackage);
      assert.throws(() => prepare(artifactFile, reviewDir, seed), /already exists/);
    });
    const one = review.appendAttempt(reviewDir, submission, first.publicPackage, first.privateBindings, artifacts);
    const two = review.appendAttempt(reviewDir, { ...submission, verdict: 'supported', note: '' }, first.publicPackage, first.privateBindings, artifacts);
    check('duplicate judgments append linked attempts while unsure remains recorded unresolved', () => {
      const all = review.readAttempts(reviewDir, first.publicPackage, first.privateBindings, artifacts);
      assert.equal(all.length, 2);
      assert.equal(all[0].verdict, 'unsure');
      assert.equal(all[1].verdict, 'supported');
      assert.equal(two.attempt, 2);
      assert.equal(two.previousAttemptHash, one.hash);
      assert.equal(all[0].artifactHash, first.privateBindings.bindings[id].artifactHash);
      assert.equal(all[0].sourceHash, first.privateBindings.bindings[id].sourceHash);
      assert.equal(all[0].analysisSourceHash, first.privateBindings.bindings[id].analysisSourceHash);
      assert.equal(all[0].diagnosticOnly, true);
      assert.equal(all[0].promotionEligible, false);
      assert.equal(all[0].evaluationPassed, false);
    });
    check('omission is a distinct evidence-backed finding', () => {
      const omitted = review.appendAttempt(reviewDir, { ...submission, finding: 'omission', verdict: 'supported', subject: 'The summary omits deletion requests.', sourceEvidence: 'Deletion requests may be sent by email.', note: 'No deletion guidance appears in the summary.' }, first.publicPackage, first.privateBindings, artifacts);
      assert.equal(omitted.finding, 'omission');
      assert.equal(omitted.attempt, 3);
    });
    check('changed artifacts and tampered saved attempts are rejected', () => {
      const changed = { ...artifacts[0], summary: 'Changed summary' };
      assert.throws(() => review.validatePackage(first.publicPackage, first.privateBindings, [changed, artifacts[1]]), /stale/);
      const { hash: oldHash, ...body } = artifacts[0];
      const changedConfig = seal({ ...body, configHash: hashText('changed-config') });
      assert.notEqual(changedConfig.hash, oldHash);
      assert.throws(() => review.validatePackage(first.publicPackage, first.privateBindings, [changedConfig, artifacts[1]]), /stale or tampered/);
      const attemptsPath = path.join(reviewDir, 'attempts.jsonl');
      const saved = fs.readFileSync(attemptsPath, 'utf8');
      const rows = saved.trimEnd().split('\n');
      rows[0] = JSON.stringify({ ...JSON.parse(rows[0]), verdict: 'unsupported' });
      fs.writeFileSync(attemptsPath, rows.join('\n') + '\n');
      assert.throws(() => review.readAttempts(reviewDir, first.publicPackage, first.privateBindings, artifacts), /tampered/);
      const rebound = JSON.parse(saved.split('\n')[0]);
      rebound.configHash = hashText('tampered-config');
      rebound.hash = review.sealedHash(rebound);
      rows[0] = JSON.stringify(rebound);
      fs.writeFileSync(attemptsPath, rows.join('\n') + '\n');
      assert.throws(() => review.readAttempts(reviewDir, first.publicPackage, first.privateBindings, artifacts), /stale review configHash/);
      fs.writeFileSync(attemptsPath, saved);
    });
    server = createServer({ reviewDir, artifactFile });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const stateResponse = await request(port, 'GET', '/api/state');
    const state = stateResponse.json;
    check('browser state contains only public items and redacted attempts', () => {
      assert.equal(stateResponse.status, 200);
      assert.equal(state.package.items.length, 2);
      assert.equal(state.attempts.length, 3);
      const text = stateResponse.text;
      for (const secret of ['site-alpha', artifacts[0].configHash, artifacts[0].protocolHash, 'artifactHash', 'sourceHash', 'criticHash', 'arm']) assert.equal(text.includes(secret), false, secret);
      assert.equal(state.attempts[0].verdict, 'unsure');
      assert.equal(state.attempts[0].diagnosticOnly, true);
      assert.equal(state.attempts[0].promotionEligible, false);
    });
    const body = JSON.stringify(submission);
    const writeHeaders = { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', 'X-Review-Token': state.token };
    const cross = await request(port, 'POST', '/api/attempts', { ...writeHeaders, Origin: 'https://evil.example' }, body);
    const noToken = await request(port, 'POST', '/api/attempts', { ...writeHeaders, 'X-Review-Token': 'wrong' }, body);
    const badHost = await request(port, 'POST', '/api/attempts', { ...writeHeaders, Host: `evil.example:${port}` }, body);
    const large = await request(port, 'POST', '/api/attempts', writeHeaders, 'x'.repeat(16 * 1024 + 1));
    check('local write route rejects cross origin, missing token, bad host and oversized bodies', () => {
      assert.equal(cross.status, 403);
      assert.equal(noToken.status, 403);
      assert.equal(badHost.status, 403);
      assert.equal(large.status, 413);
    });
    const accepted = await request(port, 'POST', '/api/attempts', writeHeaders, body);
    check('authorized write appends and no private file is served', () => {
      assert.equal(accepted.status, 201);
      assert.equal(review.readAttempts(reviewDir, first.publicPackage, first.privateBindings, artifacts).length, 4);
    });
    const privateRoute = await request(port, 'GET', '/bindings.private.json');
    const traversal = await request(port, 'GET', '/%2e%2e/bindings.private.json');
    const malformed = await request(port, 'GET', 'http://[');
    const page = await request(port, 'GET', '/');
    check('routes do not expose bindings and page treats review text as text', () => {
      assert.equal(privateRoute.status, 404);
      assert.equal(traversal.status, 404);
      assert.equal(malformed.status, 400);
      assert.equal(page.status, 200);
      assert.match(page.text, /textContent/);
      assert.doesNotMatch(page.text, /innerHTML|localStorage/);
      assert.doesNotMatch(page.text, /alert\(1\)/);
      assert.match(page.headers['content-security-policy'], /default-src 'none'/);
    });
    fs.writeFileSync(artifactFile, JSON.stringify([{ ...artifacts[0], summary: 'stale' }, artifacts[1]]));
    const stale = await request(port, 'POST', '/api/attempts', writeHeaders, body);
    check('server rejects saves when the current artifact file changes', () => assert.equal(stale.status, 400));
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    if (fs.existsSync(temp)) {
      const resolved = fs.realpathSync(temp);
      assert.ok(resolved.startsWith(tempBase + path.sep) && path.basename(resolved).startsWith('tos-final-review-'), 'refusing unsafe test cleanup path');
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
  console.log(`\nSummary: ${passed} passed, 0 failed`);
}
run().catch(error => { console.error(error); process.exitCode = 1; });
