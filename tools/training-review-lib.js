'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dataset = require('./training-dataset-lib');

const REVIEW_FILE = 'reviews.jsonl';
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const FIELD_KEYS = Object.freeze([...dataset.FIELDS]);

function reviewPath(prepDir) { return path.join(prepDir, REVIEW_FILE); }

function initialGroundTruth(trainingCase) {
  const fields = {};
  for (const key of FIELD_KEYS) {
    const answer = trainingCase.proposals.find(proposal => typeof proposal.fields?.[key] === 'string' && proposal.fields[key].trim())?.fields[key] || '';
    fields[key] = { status: answer ? 'supported' : 'uncertain', answer, quotes: [], note: '' };
  }
  return {
    confirmations: { sourceComplete: false, reviewedAllFields: false, conditionsChecked: false },
    fields
  };
}

function readReviews(prepDir, prep) {
  const { cases, rubric } = prep;
  const caseMap = new Map(cases.map(item => [item.caseId, item]));
  if (caseMap.size !== cases.length) throw new Error('duplicate training case ID');
  const file = reviewPath(prepDir);
  const histories = Object.fromEntries(cases.map(item => [item.caseId, []]));
  if (!fs.existsSync(file)) return { records: [], histories, latest: Object.fromEntries(cases.map(item => [item.caseId, null])), logHash: dataset.hashText('') };
  if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('review log must be a regular file');
  if (fs.statSync(file).size > MAX_LOG_BYTES) throw new Error('review log is too large');
  const raw = fs.readFileSync(file, 'utf8');
  if (raw && !raw.endsWith('\n')) throw new Error('review log has an incomplete final record');
  const records = [];
  for (const line of raw.split('\n').filter(Boolean)) {
    const revision = JSON.parse(line);
    if (!revision || !caseMap.has(revision.caseId)) throw new Error('review log contains an unknown case');
    histories[revision.caseId].push(revision);
    records.push(revision);
  }
  const latest = {};
  for (const item of cases) {
    const result = dataset.validateHistory(item, rubric, histories[item.caseId]);
    if (!result.valid) throw new Error(`invalid review history for ${item.caseId}: ${result.reasons.join('; ')}`);
    latest[item.caseId] = result.latest || null;
  }
  return { records, histories, latest, logHash: dataset.hashText(raw) };
}

function appendReview(prepDir, prep, submission) {
  const { cases, rubric } = prep;
  if (!submission || typeof submission !== 'object' || Array.isArray(submission) ||
      Object.keys(submission).some(key => !['caseId', 'baseHash', 'status', 'reviewer', 'reviewedAt', 'note', 'groundTruth'].includes(key))) {
    throw new Error('invalid review submission');
  }
  const trainingCase = cases.find(item => item.caseId === submission.caseId);
  if (!trainingCase) throw new Error('unknown training case');
  const { histories, latest } = readReviews(prepDir, prep);
  if ((submission.baseHash || null) !== (latest[trainingCase.caseId]?.hash || null)) throw new Error('review has changed; reload before saving');
  const { caseId, baseHash, ...input } = submission;
  const record = dataset.createRevision(trainingCase, rubric, histories[caseId], input);
  const file = reviewPath(prepDir);
  fs.appendFileSync(file, JSON.stringify(record) + '\n', { encoding: 'utf8', flag: 'a', mode: 0o600 });
  return record;
}

module.exports = { FIELD_KEYS, REVIEW_FILE, reviewPath, initialGroundTruth, readReviews, appendReview };
