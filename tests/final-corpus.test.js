'use strict';

const assert = require('node:assert/strict');
const C = require('../tools/final-corpus-lib');
const { releaseConfigHash } = require('../tools/sites-lib');
const { makeFixture, makeRelease, makeLesson, reseal } = require('./final-test-fixtures');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok ${name}`); }

test('canonical hashes ignore object order but preserve exact text and array order', () => {
  assert.equal(C.digest({ b: 2, a: 1 }), C.digest({ a: 1, b: 2 }));
  assert.notEqual(C.digest([1, 2]), C.digest([2, 1]));
  assert.notEqual(C.hashText('text\n'), C.hashText('text'));
});
test('non-JSON, sparse, cyclic, accessor and dangerous keys fail closed', () => {
  const cyclic = {}; cyclic.self = cyclic;
  for (const value of [undefined, NaN, Infinity, [undefined], new Array(2), { a: undefined }, new Date(), cyclic, JSON.parse('{"__proto__": 1}'), Object.defineProperty({}, 'x', { get() { throw Error('must not run'); }, enumerable: true })]) assert.throws(() => C.digest(value));
});
test('exact empty-vs-six release pair accepts only fixed critic/sites/policy', () => {
  const f = makeFixture();
  assert.equal(C.validateReleasePair(f.controlRelease, f.treatmentRelease, f.protocol.selectedLessonIds).valid, true);
  f.treatmentRelease.config.policy.selection.order = 'different';
  f.treatmentRelease.configHash = releaseConfigHash(f.treatmentRelease.config);
  assert.match(C.validateReleasePair(f.controlRelease, f.treatmentRelease, f.protocol.selectedLessonIds).reasons.join(';'), /fixed critic, sites, or runtime policy/);
});
test('wrong selected IDs, extra lessons and nonempty control are rejected', () => {
  const f = makeFixture();
  assert.equal(C.validateReleasePair(f.controlRelease, f.treatmentRelease, [...f.protocol.selectedLessonIds.slice(1), 'other']).valid, false);
  assert.equal(C.validateReleasePair(f.controlRelease, makeRelease([...f.treatmentRelease.config.lessons, makeLesson(6)]), f.protocol.selectedLessonIds).valid, false);
  assert.equal(C.validateReleasePair(makeRelease([makeLesson(0)]), f.treatmentRelease, f.protocol.selectedLessonIds).valid, false);
  assert.equal(C.validateReleasePair(f.controlRelease, f.treatmentRelease, Array(6).fill('same')).valid, false);
});
test('valid fresh fixture binds frozen historical inventory and provenance', () => {
  const f = makeFixture();
  assert.equal(C.validateCorpus(f.corpus, f.history).valid, true);
  f.corpus.sites[0].sourceText += ' changed';
  assert.equal(C.validateCorpus(f.corpus, f.history).valid, false);
});
test('domain subdomains, normalized organizations and exact source hashes flag contamination', () => {
  for (const mutate of [f => f.history.domains.push('sub.fresh-corpus.com'), f => f.history.organizationIds.push('  FRESH ORGANIZATION '), f => f.history.sourceHashes.push(f.corpus.sites[0].sourceHash)]) {
    const f = makeFixture(); mutate(f);
    f.corpus.historyHash = C.digest(f.history); f.corpus = reseal(f.corpus);
    assert.match(C.validateCorpus(f.corpus, f.history).reasons.join(';'), /contamination/);
  }
});
test('duplicate organizations/sites/text and wrong origin provenance fail', () => {
  const f = makeFixture();
  f.corpus.sites.push({ ...f.corpus.sites[0], siteId: 'another' }); f.corpus = reseal(f.corpus);
  assert.match(C.validateCorpus(f.corpus, f.history).reasons.join(';'), /duplicate/);
  const g = makeFixture(); g.corpus.sites[0].provenance.url = 'https://other-corpus.com/privacy'; g.corpus = reseal(g.corpus);
  assert.match(C.validateCorpus(g.corpus, g.history).reasons.join(';'), /provenance/);
});
test('history omission and learning-enabled corpus are rejected', () => {
  const f = makeFixture(); f.history.inventoryIncomplete = true;
  assert.match(C.validateCorpus(f.corpus, f.history).reasons.join(';'), /inventory incomplete/);
  f.corpus.learningAllowed = true; f.corpus = reseal(f.corpus);
  assert.match(C.validateCorpus(f.corpus, f.history).reasons.join(';'), /learning disabled/);
  assert.equal(C.validateCorpus(null, null).valid, false);
});
console.log(`${passed} final corpus tests passed`);
