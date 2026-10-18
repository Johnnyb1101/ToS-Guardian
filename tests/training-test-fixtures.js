'use strict';

const T = require('../tools/training-dataset-lib');
const { splitFor } = require('../tools/reference-lib');
const clone = value => JSON.parse(JSON.stringify(value));
function reseal(value) { const { hash, ...body } = value; return T.seal(body); }
function domainFor(split, offset = 0) {
  for (let n = offset; ; n++) { const domain = `training-fixture-${n}.com`; if (splitFor(domain) === split) return domain; }
}
function makeFixture() {
  const domain = domainFor('work');
  const sourceText = 'We collect email addresses. We do not sell personal data. California residents may opt out of sharing. Use the privacy form to opt out. Subscriptions renew monthly unless cancelled before renewal. You may request deletion using the account settings.';
  const provenance = { manifestPath: 'reference/manifest.json', manifestHash: T.hashText('manifest'), frozenPath: `reference/sources/${domain}.json`, frozenHash: T.hashText('frozen'), textHash: T.hashText(sourceText), sourceKind: 'enriched' };
  const files = [{ path: provenance.manifestPath, hash: provenance.manifestHash }, { path: provenance.frozenPath, hash: provenance.frozenHash }];
  const proposals = [1, 2, 3].map(sample => {
    const artifactPath = `reference/runs/example/${domain}-${sample}.json`, artifactHash = T.hashText(`artifact${sample}`);
    files.push({ path: artifactPath, hash: artifactHash });
    return { artifactPath, artifactHash, sample, runId: 'example', analysisSourceHash: T.hashText(sourceText), unverified: true, fields: Object.fromEntries(T.FIELDS.map(field => [field, 'Unverified old AI answer'])) };
  });
  const inventory = T.seal({ v: 1, kind: 'training-source-inventory', complete: true, sources: [{ domain, split: 'work', sourceHash: T.hashText(sourceText), ...provenance, looksLegal: true }], files, finalDomains: [], finalSourceHashes: [] });
  const item = T.createCase({ domain, sourceText, provenance, proposals }, inventory);
  const sentences = sourceText.match(/[^.]+\./g).map(s => s.trim());
  const truth = { confirmations: { sourceComplete: true, reviewedAllFields: true, conditionsChecked: true }, fields: Object.fromEntries(T.FIELDS.map((field, index) => [field, { status: 'supported', answer: sentences[index], quotes: [sentences[index]], note: '' }])) };
  const rubric = clone(T.RUBRIC);
  const review = T.createRevision(item, rubric, [], { status: 'approved', reviewer: 'human fixture reviewer', reviewedAt: '2026-10-17T12:00:00.000Z', note: 'Checked complete capture manually.', groundTruth: truth });
  return { item, cases: [item], inventory, rubric, truth, review, history: [review], histories: { [item.caseId]: [review] } };
}
module.exports = { clone, reseal, domainFor, makeFixture };
