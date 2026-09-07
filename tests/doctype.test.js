// TOS Guardian — document type classifier tests (tools/doctype.js)
// Run: node tests/doctype.test.js

const { DOCUMENT_TYPES, classifyDocumentType } = require('../tools/doctype');

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (condition) { console.log(`  ok    ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

console.log('Document type classifier');

ok('type list ends with other', DOCUMENT_TYPES[DOCUMENT_TYPES.length - 1] === 'other');

const glba = `WHAT DOES NAVY FEDERAL DO WITH YOUR PERSONAL INFORMATION? Financial companies choose how they
share your personal information. Federal law gives consumers the right to limit some but not all sharing.
Reasons we can share your personal information: For our affiliates' everyday business purposes — information
about your creditworthiness. For nonaffiliates to market to you. Joint marketing with other financial companies.
Account balances and payment history. Under the Gramm-Leach-Bliley Act (GLBA) this credit union is insured by NCUA.`;
ok('GLBA notice is financial', classifyDocumentType(glba, 'navyfederal.org').type === 'financial', JSON.stringify(classifyDocumentType(glba).scores));

const social = `When you share posts you create, people you follow and your followers can see them in your feed.
Direct messages are private between you and the people you message. Content you share may be reposted.
Follow our community guidelines. Your profile shows your stories and the creators you follow.`;
ok('social network policy is social', classifyDocumentType(social, 'example.com').type === 'social');

const health = `This Notice of Privacy Practices describes how your protected health information may be used.
As a covered entity under HIPAA, your health care provider keeps medical records and prescription history.
Telehealth visits are recorded in your patient chart.`;
ok('HIPAA notice is health', classifyDocumentType(health, 'zocdoc.com').type === 'health');

const commerce = `Your order will ship within two business days. Items in your shopping cart are held for 30 minutes.
Returns are accepted within 30 days; refunds go to the original payment method. Sellers and buyers on our
marketplace must complete checkout through our platform. Gift card balances never expire.`;
ok('storefront terms are commerce', classifyDocumentType(commerce, 'shop.example').type === 'commerce');

const gaming = `In-game purchases of virtual items and virtual currency are final. Players agree that gameplay
recordings may be used in esports broadcasts. Loot boxes contain randomized virtual items.`;
ok('game terms are gaming', classifyDocumentType(gaming, 'game.example').type === 'gaming');

ok('.edu domain hint tips a thin document to education',
  classifyDocumentType('We respect your privacy. Contact us with questions.', 'harvard.edu').type === 'education');
ok('.gov domain hint tips a thin document to government',
  classifyDocumentType('We respect your privacy. Contact us with questions.', 'example.gov').type === 'government');

ok('a generic document with no signals is other', classifyDocumentType('We respect your privacy. Contact us with questions.', 'example.com').type === 'other');
ok('empty input is other, not an error', classifyDocumentType('', '').type === 'other' && classifyDocumentType(null, null).type === 'other');

{
  // A single phrase repeated hundreds of times cannot dominate by itself.
  const spam = 'game '.repeat(500) + glba;
  ok('repetition is capped so one word cannot outvote a regulatory notice', classifyDocumentType(spam, 'x.com').type === 'financial');
}

{
  const result = classifyDocumentType(glba, 'navyfederal.org');
  ok('scores cover every type', DOCUMENT_TYPES.every(t => typeof result.scores[t] === 'number'));
  ok('classification is deterministic', JSON.stringify(result) === JSON.stringify(classifyDocumentType(glba, 'navyfederal.org')));
}

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
