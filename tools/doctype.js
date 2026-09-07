// TOS Guardian — document type classifier (learning loop, phase 1)
//
// Puts a frozen legal-document source into one of a few coarse types so the
// reference set stays stratified and, later, lessons can be recalled by type.
// Keyword-based and deterministic on purpose: cheap, explainable, and the
// manifest lets a human override the result per site.

'use strict';

const DOCUMENT_TYPES = Object.freeze([
  'financial', 'health', 'education', 'government', 'social', 'media',
  'commerce', 'gaming', 'technology', 'other'
]);

// Each phrase is matched case-insensitively as a whole word or phrase. Weights
// favor terms that are near-unique to a type (regulatory names, notice titles)
// over generic ones that appear in most policies.
const SIGNALS = Object.freeze({
  financial: [
    ['gramm-leach-bliley', 4], ['glba', 4], ['nonaffiliates', 4], ['creditworthiness', 4],
    ['what does .{0,60} do with your personal information', 4], ['joint marketing', 3],
    ['fair credit reporting', 3], ['account balances', 2], ['payment history', 2],
    ['credit union', 3], ['brokerage', 2], ['securities', 1], ['bank', 1], ['loan', 1],
    ['fdic', 3], ['ncua', 3], ['finra', 3], ['investment adviser', 3], ['cryptocurrency', 2]
  ],
  health: [
    ['hipaa', 4], ['protected health information', 4], ['notice of privacy practices', 4],
    ['health care provider', 3], ['medical records', 3], ['patient', 2], ['diagnosis', 2],
    ['prescription', 2], ['telehealth', 3], ['covered entity', 3]
  ],
  education: [
    ['ferpa', 4], ['student records', 4], ['tuition', 3], ['enrollment', 2], ['university', 2],
    ['course', 1], ['student', 1], ['academic', 2], ['campus', 2], ['financial aid', 3]
  ],
  government: [
    ['public records', 3], ['freedom of information', 4], ['privacy act of 1974', 4],
    ['federal agency', 3], ['government agency', 2], ['official use', 2], ['citizen', 1]
  ],
  social: [
    ['followers', 3], ['your profile', 2], ['posts you', 2], ['people you follow', 3],
    ['direct messages', 3], ['friends', 2], ['content you share', 3], ['your feed', 3],
    ['community guidelines', 3], ['stories', 1], ['creator', 1]
  ],
  media: [
    ['subscription', 2], ['articles', 2], ['newsletter', 2], ['journalism', 3], ['editorial', 2],
    ['newsroom', 3], ['paywall', 3], ['broadcast', 2], ['podcast', 1], ['advertising partners', 1]
  ],
  commerce: [
    ['shipping', 3], ['your order', 3], ['shopping cart', 3], ['merchant', 2], ['returns', 2],
    ['checkout', 3], ['seller', 2], ['buyer', 2], ['marketplace', 2], ['gift card', 2], ['refund', 1]
  ],
  gaming: [
    ['in-game', 4], ['players', 3], ['gameplay', 4], ['virtual items', 4], ['virtual currency', 3],
    ['game', 1], ['esports', 3], ['loot', 2], ['streamer', 1]
  ],
  technology: [
    ['api', 2], ['developer', 2], ['workspace', 2], ['software', 1], ['service level', 3],
    ['open source', 2], ['repository', 3], ['cloud storage', 3], ['end user license', 2],
    ['telemetry', 2], ['browser', 1], ['search engine', 3]
  ]
});

const DOMAIN_HINTS = Object.freeze([
  [/\.edu$/i, 'education', 6],
  [/\.gov$/i, 'government', 6],
  [/\.(bank|credit|financial)$/i, 'financial', 4],
  [/\.(health|clinic)$/i, 'health', 4]
]);

const MIN_SCORE = 4;

function countMatches(text, phrase) {
  const pattern = new RegExp(`(?<![a-z0-9])${phrase}(?![a-z0-9])`, 'gi');
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

// Returns { type, scores } where scores maps every type to its weighted count.
// A phrase contributes weight × min(count, 5), so a term repeated a hundred
// times cannot single-handedly decide the type.
function classifyDocumentType(text, domain) {
  const haystack = String(text || '').slice(0, 300000).toLowerCase();
  const scores = {};
  for (const type of DOCUMENT_TYPES) scores[type] = 0;
  for (const [type, signals] of Object.entries(SIGNALS)) {
    for (const [phrase, weight] of signals) {
      const count = countMatches(haystack, phrase);
      if (count > 0) scores[type] += weight * Math.min(count, 5);
    }
  }
  for (const [pattern, type, weight] of DOMAIN_HINTS) {
    if (pattern.test(String(domain || ''))) scores[type] += weight;
  }
  let best = 'other';
  let bestScore = 0;
  for (const type of DOCUMENT_TYPES) {
    if (type === 'other') continue;
    if (scores[type] > bestScore) { best = type; bestScore = scores[type]; }
  }
  return { type: bestScore >= MIN_SCORE ? best : 'other', scores };
}

module.exports = { DOCUMENT_TYPES, MIN_SCORE, classifyDocumentType };
