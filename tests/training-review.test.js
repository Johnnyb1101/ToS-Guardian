'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const D = require('../tools/training-dataset-lib');
const R = require('../tools/training-review-lib');
const { createServer } = require('../tools/training-review');

let passed = 0;
function check(name, callback) { callback(); passed++; console.log(`  ok    ${name}`); }

function fixture() {
  const domain = 'training-review.com';
  const sourceText = 'Residents in certain regions may ask us to delete profile data, unless retention is required by law.\nWe may share device IDs with vendors.\n<script>alert(1)</script>';
  const manifestPath = 'C:\\sample\\manifest.json';
  const frozenPath = 'C:\\sample\\policy.json';
  const artifactPath = 'C:\\sample\\artifact.json';
  const manifestHash = D.hashText('manifest');
  const frozenHash = D.hashText('frozen');
  const artifactHash = D.hashText('artifact');
  const provenance = { manifestPath, manifestHash, frozenPath, frozenHash, textHash: D.hashText(sourceText), sourceKind: 'enriched' };
  const inventory = D.seal({
    v: 1, kind: 'training-source-inventory', complete: true,
    sources: [{ domain, split: 'work', sourceHash: D.hashText(sourceText), ...provenance, looksLegal: true }],
    files: [{ path: manifestPath, hash: manifestHash }, { path: frozenPath, hash: frozenHash }, { path: artifactPath, hash: artifactHash }],
    finalDomains: [], finalSourceHashes: [], excluded: []
  });
  const proposal = { artifactPath, artifactHash, sample: 1, runId: 'historical', analysisSourceHash: D.hashText(sourceText), unverified: true, fields: { dataDeletion: 'Everyone can delete all data at any time.' } };
  const item = D.createCase({ domain, sourceText, provenance, proposals: [proposal] }, inventory);
  return { inventory, cases: [item], rubric: D.RUBRIC };
}

function truth(item) {
  const fields = Object.fromEntries(D.FIELDS.map(key => [key, {
    status: 'supported', answer: 'Review the regional conditions in the source.',
    quotes: ['Residents in certain regions may ask us to delete profile data, unless retention is required by law.'], note: ''
  }]));
  return { confirmations: { sourceComplete: true, reviewedAllFields: true, conditionsChecked: true }, fields };
}

function submission(item, status, groundTruth, baseHash = null) {
  return { caseId: item.caseId, baseHash, status, reviewer: 'Reviewer A', reviewedAt: new Date().toISOString(), note: '', groundTruth };
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
  const prep = fixture();
  const item = prep.cases[0];
  const initial = R.initialGroundTruth(item);
  check('unverified proposal can start an editable draft without approvals or evidence', () => {
    assert.equal(initial.fields.dataDeletion.answer, 'Everyone can delete all data at any time.');
    assert.equal(initial.fields.dataDeletion.status, 'supported');
    assert.deepEqual(initial.fields.dataDeletion.quotes, []);
    assert.deepEqual(Object.values(initial.confirmations), [false, false, false]);
    assert.equal(D.validateGroundTruth(item, initial, { approval: false }).valid, true);
    assert.equal(D.validateGroundTruth(item, initial).valid, false);
  });
  const corrected = truth(item);
  check('approval requires exact source quotes and all manual confirmations', () => {
    assert.equal(D.validateGroundTruth(item, corrected).valid, true);
    assert.equal(D.validateGroundTruth(item, { ...corrected, confirmations: { ...corrected.confirmations, conditionsChecked: false } }).valid, false);
    assert.equal(D.validateGroundTruth(item, { ...corrected, fields: { ...corrected.fields, dataDeletion: { ...corrected.fields.dataDeletion, quotes: ['not present'] } } }).valid, false);
    assert.equal(D.validateGroundTruth(item, { ...corrected, fields: { ...corrected.fields, dataDeletion: { ...corrected.fields.dataDeletion, status: 'uncertain' } } }).valid, false);
  });
  check('not found uses the fixed answer, no quotes, and a human note', () => {
    const deletion = { status: 'not-found', answer: D.NOT_FOUND, quotes: [], note: 'Searched the full saved capture for a deletion right.' };
    const withAbsence = { ...corrected, fields: { ...corrected.fields, dataDeletion: deletion } };
    assert.equal(D.validateGroundTruth(item, withAbsence).valid, true);
    assert.equal(D.validateGroundTruth(item, { ...withAbsence, fields: { ...withAbsence.fields, dataDeletion: { ...deletion, note: '' } } }).valid, false);
    assert.equal(D.validateGroundTruth(item, { ...withAbsence, fields: { ...withAbsence.fields, dataDeletion: { ...deletion, answer: 'No deletion right exists.' } } }).valid, false);
  });
  const tempBase = fs.realpathSync(os.tmpdir());
  const prepDir = fs.mkdtempSync(path.join(tempBase, 'tos-training-review-'));
  let server;
  try {
    const draft = R.appendReview(prepDir, prep, submission(item, 'needs-review', initial));
    check('draft saves as revision one, bound to case and rubric', () => {
      assert.equal(draft.status, 'needs-review');
      assert.equal(draft.caseHash, item.hash);
      assert.equal(draft.rubricHash, prep.rubric.hash);
      assert.equal(draft.revision, 1);
      assert.equal(R.readReviews(prepDir, prep).records.length, 1);
    });
    assert.throws(() => R.appendReview(prepDir, prep, submission(item, 'approved', corrected)), /review has changed/);
    const approved = R.appendReview(prepDir, prep, submission(item, 'approved', corrected, draft.hash));
    const correction = R.appendReview(prepDir, prep, submission(item, 'needs-correction', corrected, approved.hash));
    check('latest correction revokes an older approval without rewriting history', () => {
      const { records, histories, latest } = R.readReviews(prepDir, prep);
      assert.equal(records.length, 3);
      assert.equal(correction.previousHash, approved.hash);
      assert.equal(latest[item.caseId].status, 'needs-correction');
      assert.equal(D.validateHistory(item, prep.rubric, histories[item.caseId]).approvalValid, false);
      assert.equal(D.exportApproved(prep.cases, histories, prep.inventory).examples.length, 0);
    });
    check('changed proposals or rubric make the old approved revision stale', () => {
      const { hash: caseSeal, ...caseBody } = item;
      const { hash: rubricSeal, ...rubricBody } = prep.rubric;
      const changedCase = D.seal({ ...caseBody, proposals: [{ ...item.proposals[0], fields: { dataDeletion: 'Changed proposal' } }] });
      const changedRubric = D.seal({ ...rubricBody, instructions: prep.rubric.instructions + ' Recheck every quote.' });
      assert.equal(D.validateHistory(changedCase, prep.rubric, [draft, approved]).approvalValid, false);
      assert.equal(D.validateHistory(item, changedRubric, [draft, approved]).approvalValid, false);
    });
    server = createServer({ prepDir, loadPreparation: () => prep });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const stateResponse = await request(port, 'GET', '/api/state');
    const state = stateResponse.json;
    check('state exposes source and proposals without local private paths', () => {
      assert.equal(stateResponse.status, 200);
      assert.equal(state.cases[0].sourceText, item.sourceText);
      assert.equal(state.cases[0].proposals[0].unverified, true);
      assert.equal(state.latest[item.caseId].status, 'needs-correction');
      for (const privatePath of [item.proposals[0].artifactPath, item.provenance.manifestPath, item.provenance.frozenPath]) {
        assert.equal(stateResponse.text.includes(privatePath), false);
      }
    });
    const headers = { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', 'X-Review-Token': state.token };
    const body = JSON.stringify(submission(item, 'excluded', corrected, correction.hash));
    const cross = await request(port, 'GET', '/api/state', { Origin: 'https://evil.example' });
    const badHost = await request(port, 'GET', '/api/state', { Host: `evil.example:${port}` });
    const noToken = await request(port, 'POST', '/api/revisions', { ...headers, 'X-Review-Token': 'wrong' }, body);
    const tooLarge = await request(port, 'POST', '/api/revisions', headers, 'x'.repeat(256 * 1024 + 1));
    check('loopback server rejects cross origin, bad host, missing token and oversized body', () => {
      assert.equal(cross.status, 403);
      assert.equal(badHost.status, 403);
      assert.equal(noToken.status, 403);
      assert.equal(tooLarge.status, 413);
    });
    const accepted = await request(port, 'POST', '/api/revisions', headers, body);
    const page = await request(port, 'GET', '/');
    const privateRoute = await request(port, 'GET', '/reviews.jsonl');
    const traversal = await request(port, 'GET', '/%2e%2e/reviews.jsonl');
    const malformed = await request(port, 'GET', 'http://[');
    check('authorized save appends, while routes and HTML keep private files and source markup inert', () => {
      assert.equal(accepted.status, 201);
      assert.equal(R.readReviews(prepDir, prep).records.length, 4);
      assert.equal(privateRoute.status, 404);
      assert.equal(traversal.status, 404);
      assert.equal(malformed.status, 400);
      assert.equal(page.status, 200);
      assert.match(page.text, /source'\)\.textContent = trainingCase\.sourceText/);
      assert.doesNotMatch(page.text, /innerHTML|<script>alert\(1\)<\/script>/);
      assert.match(page.headers['content-security-policy'], /default-src 'none'/);
    });
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    if (fs.existsSync(prepDir)) {
      const resolved = fs.realpathSync(prepDir);
      assert.ok(resolved.startsWith(tempBase + path.sep) && path.basename(resolved).startsWith('tos-training-review-'));
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
  console.log(`\nSummary: ${passed} passed, 0 failed`);
}
run().catch(error => { console.error(error); process.exitCode = 1; });
