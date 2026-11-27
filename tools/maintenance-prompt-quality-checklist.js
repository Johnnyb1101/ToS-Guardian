'use strict';

const { parseUnambiguousJson } = require('./maintenance-observed-live-transport');

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function nonempty(text) {
  return typeof text === 'string' && text.isWellFormed() && text.trim().length > 0 && !text.includes('\0');
}

function passage(text, quote) {
  return nonempty(quote) && text.includes(quote);
}

function readChecklist(bytesText, sample, sourceText) {
  check(Buffer.byteLength(bytesText) <= 32 * 1024, 'Oversized source checklist');
  const list = parseUnambiguousJson(bytesText);
  check(exact(list, ['v', 'sampleId', 'sourceHash', 'items']) && list.v === 2 && list.sampleId === sample.id &&
    list.sourceHash === sample.source.sha256 && Array.isArray(list.items) && list.items.length > 0 && list.items.length <= 24,
  'Invalid source checklist identity or shape');
  const items = new Map();
  for (const item of list.items) {
    check(exact(item, ['id', 'condition', 'sourceQuote']) && typeof item.id === 'string' &&
      /^[A-Za-z0-9_-]{1,128}$/.test(item.id) && !items.has(item.id) && nonempty(item.condition) &&
      item.condition.length <= 500 && passage(sourceText, item.sourceQuote) && item.sourceQuote.length <= 600, 'Invalid checklist ID, condition or source passage');
    items.set(item.id, item);
  }
  return items;
}

function gradeFindings(text, sample, summary) {
  const findings = parseUnambiguousJson(text);
  check(exact(findings, ['v', 'claims', 'checkpoints']) && findings.v === 2 &&
    Array.isArray(findings.claims) && findings.claims.length > 0 && Array.isArray(findings.checkpoints) &&
    findings.checkpoints.length === sample.checkpoints.size, 'Incomplete independent findings');
  const seenQuotes = new Set();
  let accurate = 0, materialClaims = 0, fabrications = 0, covered = 0;
  for (const [index, claim] of findings.claims.entries()) {
    check(exact(claim, ['id', 'analyzerQuote', 'verdict', 'sourceQuote']) && claim.id === 'c' + (index + 1) &&
      passage(summary, claim.analyzerQuote) && ['supported', 'silence', 'inaccurate', 'fabricated'].includes(claim.verdict),
    'Invalid independent claim ID, quote or verdict');
    // Normalization catches quote-equivalent duplicates. Semantic paraphrases require grader judgment.
    const key = claim.analyzerQuote.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ').replace(/[.!?]+$/u, '');
    check(!seenQuotes.has(key), 'Repeated independent claim');
    seenQuotes.add(key);
    const validSource = passage(sample.text, claim.sourceQuote);
    check(claim.verdict === 'silence' ? claim.sourceQuote === null :
      validSource || (claim.verdict === 'fabricated' && claim.sourceQuote === null), 'Invalid independent claim source evidence');
    if (claim.verdict !== 'silence') materialClaims++;
    if (claim.verdict === 'supported') accurate++;
    if (claim.verdict === 'fabricated') fabrications++;
  }
  const seenIds = new Set();
  for (const row of findings.checkpoints) {
    check(exact(row, ['id', 'analyzerQuote', 'sourceQuote', 'covered']) && sample.checkpoints.has(row.id) &&
      !seenIds.has(row.id) && row.sourceQuote === sample.checkpoints.get(row.id).sourceQuote &&
      typeof row.covered === 'boolean' && (row.covered ? passage(summary, row.analyzerQuote) : row.analyzerQuote === null),
    'Invalid independent checkpoint ID or evidence');
    seenIds.add(row.id);
    if (row.covered) covered++;
  }
  return { accuracy: materialClaims ? accurate / materialClaims : 0, completeness: covered / sample.checkpoints.size,
    fabrications, findings };
}

module.exports = { readChecklist, gradeFindings };
