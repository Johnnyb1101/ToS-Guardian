'use strict';

const assert = require('node:assert/strict');
const T = require('../tools/training-dataset-lib');
const { clone, reseal, domainFor, makeFixture } = require('./training-test-fixtures');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok ${name}`); }
function approve(f, truth = f.truth, history = []) { return T.createRevision(f.item, f.rubric, history, { status: 'approved', reviewer: 'human', reviewedAt: '2026-10-17T12:00:00.000Z', note: '', groundTruth: truth }); }

test('frozen case and rubric are strict, hash-bound training records', () => {
  const f = makeFixture();
  assert.equal(T.validateCase(f.item, f.inventory).valid, true);
  assert.equal(T.validateRubric(f.rubric).valid, true);
  f.item.sourceText += ' changed';
  assert.equal(T.validateCase(f.item, f.inventory).valid, false);
  assert.equal(T.validateCase(null, null).valid, false);
  assert.equal(T.validateInventory({}).valid, false);
  assert.equal(T.validateInventory(reseal({ ...f.inventory, finalDomains: 'bad' })).valid, false);
});
test('unexpected fields and final-purpose masquerading are rejected', () => {
  for (const mutate of [f => { f.item.riskScore = 50; }, f => { f.item.kind = 'step2-final-corpus'; }, f => { f.item.proposals[0].fields.bottomLine = 'bad'; }, f => { f.item.provenance.extra = 'bad'; }]) {
    const f = makeFixture(); mutate(f); f.item = reseal(f.item);
    assert.equal(T.validateCase(f.item, f.inventory).valid, false);
  }
});
test('work split is independently recomputed and manifest pins must match', () => {
  const f = makeFixture(); f.inventory.sources[0].domain = domainFor('holdout');
  f.inventory = reseal(f.inventory);
  assert.match(T.validateInventory(f.inventory).reasons.join(';'), /split mismatch/);
  const g = makeFixture(); g.item.provenance.manifestHash = T.hashText('other'); g.item = reseal(g.item);
  assert.match(T.validateCase(g.item, g.inventory).reasons.join(';'), /frozen manifest/);
  g.inventory.files[0].hash = T.hashText('changed'); g.inventory = reseal(g.inventory);
  assert.equal(T.validateInventory(g.inventory).valid, false);
});
test('known validation and final domains or source hashes cannot train', () => {
  for (const contaminate of [f => f.inventory.finalDomains.push(f.item.domain), f => f.inventory.finalSourceHashes.push(f.item.sourceHash), f => {
    const source = { ...f.inventory.sources[0], domain: domainFor('holdout'), split: 'holdout' };
    f.inventory.sources.push(source);
  }]) {
    const f = makeFixture(); contaminate(f); f.inventory = reseal(f.inventory);
    assert.match(T.validateCase(f.item, f.inventory).reasons.join(';'), /contamination/);
    assert.throws(() => T.exportApproved(f.cases, f.histories, f.inventory), /contamination/);
  }
});
test('proposal artifacts must stay unverified and match inventory pins', () => {
  for (const change of [p => { p.unverified = false; }, p => { p.artifactHash = T.hashText('changed'); }]) {
    const f = makeFixture(); change(f.item.proposals[0]); f.item = reseal(f.item);
    assert.equal(T.validateCase(f.item, f.inventory).valid, false);
  }
});
test('missing fields, invented quotations and whitespace evidence block approval', () => {
  for (const change of [t => { delete t.fields.dataDeletion; }, t => { t.fields.dataCollection.quotes = ['not in the captured source']; }, t => { t.fields.dataCollection.quotes = [' ']; }, t => { t.fields.dataCollection.quotes = []; }, t => { t.fields.dataCollection.answer = ''; }]) {
    const f = makeFixture(); change(f.truth);
    assert.throws(() => approve(f), /invalid review revision/);
  }
});
test('incomplete capture, unread fields, unchecked conditions and uncertainty block approval', () => {
  for (const name of T.RUBRIC.confirmations) {
    const f = makeFixture(); f.truth.confirmations[name] = false;
    assert.throws(() => approve(f), /confirmation required/);
  }
  const f = makeFixture(); f.truth.fields.dataCollection.status = 'uncertain';
  assert.throws(() => approve(f), /uncertain blocks approval/);
});
test('not-found uses fixed answer and a manual absence review note', () => {
  const f = makeFixture();
  f.truth.fields.autoRenewal = { status: 'not-found', answer: T.NOT_FOUND, quotes: [], note: 'Read full captured source; no relevant clause found.' };
  assert.equal(approve(f).status, 'approved');
  f.truth.fields.autoRenewal.note = '';
  assert.throws(() => approve(f), /not-found requires/);
  f.truth.fields.autoRenewal.note = 'Checked'; f.truth.fields.autoRenewal.answer = 'No auto-renewal.';
  assert.throws(() => approve(f), /not-found requires/);
});
test('drafts may preserve incomplete human edits without becoming ground truth', () => {
  const f = makeFixture(); f.truth.confirmations.sourceComplete = false; f.truth.fields.dataCollection.quotes = [];
  const draft = T.createRevision(f.item, f.rubric, [], { status: 'needs-review', reviewer: 'human', reviewedAt: '2026-10-17T12:00:00Z', groundTruth: f.truth });
  assert.equal(T.validateHistory(f.item, f.rubric, [draft]).valid, true);
  assert.equal(T.exportApproved(f.cases, { [f.item.caseId]: [draft] }, f.inventory).examples.length, 0);
});
test('review chain detects edited answers, broken links and removed revisions', () => {
  const f = makeFixture(); const second = approve(f, f.truth, f.history);
  assert.equal(T.validateHistory(f.item, f.rubric, [...f.history, second]).valid, true);
  second.groundTruth.fields.dataCollection.answer = 'tampered';
  assert.equal(T.validateHistory(f.item, f.rubric, [...f.history, second]).valid, false);
  const g = makeFixture(); const next = approve(g, g.truth, g.history);
  assert.equal(T.validateHistory(g.item, g.rubric, [next]).valid, false);
});
test('changed case or rubric invalidates old approval; later correction and exclusion revoke it', () => {
  for (const status of ['needs-review', 'needs-correction', 'excluded']) {
    const f = makeFixture(); const rev = T.createRevision(f.item, f.rubric, f.history, { status, reviewer: 'human', reviewedAt: '2026-10-18T12:00:00Z', groundTruth: null });
    assert.equal(T.exportApproved(f.cases, { [f.item.caseId]: [...f.history, rev] }, f.inventory).examples.length, 0);
  }
  const f = makeFixture(); f.rubric.instructions += ' Additional review instruction.'; f.rubric = reseal(f.rubric);
  assert.equal(T.exportApproved(f.cases, f.histories, f.inventory, { rubric: f.rubric }).examples.length, 0);
  const g = makeFixture(); g.item.proposals = []; g.item = reseal(g.item);
  assert.equal(T.validateHistory(g.item, g.rubric, g.history).approvalValid, false);
});
test('three old AI proposals export one approved six-field example, never extra labels or evidence', () => {
  const f = makeFixture(); const exported = T.exportApproved(f.cases, f.histories, f.inventory);
  assert.equal(exported.examples.length, 1);
  assert.equal(exported.manifest.exampleCount, 1);
  const [example] = exported.examples;
  assert.deepEqual(Object.keys(example), ['messages']);
  assert.deepEqual(example.messages.map(m => m.role), ['system', 'user', 'assistant']);
  assert.equal(example.messages[1].content, f.item.sourceText);
  assert.deepEqual(Object.keys(JSON.parse(example.messages[2].content)).sort(), [...T.FIELDS].sort());
  assert.doesNotMatch(JSON.stringify(example), /Unverified old AI answer|reviewer|quotes|riskScore|bottomLine/);
  assert.equal(T.exportApproved(f.cases, {}, f.inventory).examples.length, 0);
});
test('duplicate source examples collapse across domain aliases and duplicate cases fail', () => {
  const f = makeFixture(); const domain = domainFor('work', 1000);
  f.inventory.sources.push({ ...f.inventory.sources[0], domain }); f.inventory = reseal(f.inventory);
  const second = T.createCase({ domain, sourceText: f.item.sourceText, provenance: f.item.provenance, proposals: [] }, f.inventory);
  const review = T.createRevision(second, f.rubric, [], { status: 'approved', reviewer: 'human', reviewedAt: '2026-10-17T12:00:00Z', groundTruth: f.truth });
  const output = T.exportApproved([...f.cases, second], { ...f.histories, [second.caseId]: [review] }, f.inventory);
  assert.equal(output.examples.length, 1); assert.match(output.manifest.skipped[0].reasons[0], /duplicate source/);
  assert.throws(() => T.exportApproved([...f.cases, f.item], f.histories, f.inventory), /duplicate case/);
});
test('unsafe JSON and malformed evidence fail closed without coercion', () => {
  const f = makeFixture(); const bad = clone(f.truth); bad.fields.dataCollection.quotes = [undefined];
  assert.equal(T.validateGroundTruth(f.item, bad).valid, false);
  assert.equal(T.validateGroundTruth(f.item, null).valid, false);
  assert.equal(T.validateGroundTruth(null, f.truth).valid, false);
  assert.equal(T.validateHistory(f.item, null, f.history).valid, false);
  const unsafe = JSON.parse('{"__proto__": true}');
  assert.equal(T.validateInventory(unsafe).valid, false);
});
console.log(`${passed} training dataset tests passed`);
