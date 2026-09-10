const lib = require('../tools/sites-lib');

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (condition) { console.log(`  ok    ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

console.log('Site tools');

function chain(kinds) {
  const entries = [];
  let prev = null;
  kinds.forEach((kind, i) => {
    const entry = { seq: i + 1, prevHash: prev ? prev.hash : null, kind, domain: kind.startsWith('site') ? 'acmeprivacy.com' : null, payload: { urls: { tos: 'https://acmeprivacy.com/t', privacy: 'https://acmeprivacy.com/p' }, evidence: { days: 3, trainer: false }, expiresAt: '2026-10-10T00:00:00.000Z', reason: 'owner' }, createdAt: '2026-09-10T00:00:00.000Z' };
    entry.hash = lib.hashEntry(entry);
    entries.push(entry);
    prev = entry;
  });
  return entries;
}

const good = chain(['site-promoted', 'halt-set', 'halt-cleared', 'site-refreshed']);
ok('a well-formed chain verifies with its head', lib.verifyLedger(good).valid && lib.verifyLedger(good).head === good[3].hash);
ok('an empty ledger verifies', lib.verifyLedger([]).valid && lib.verifyLedger([]).head === null);
{
  const tampered = JSON.parse(JSON.stringify(good));
  tampered[0].payload.urls.tos = 'https://evil.com/t';
  ok('a changed payload breaks its hash', !lib.verifyLedger(tampered).valid && /seq 1 hash/.test(lib.verifyLedger(tampered).errors[0]));
  const gap = [good[0], good[2], good[3]];
  ok('a missing entry breaks the chain', !lib.verifyLedger(gap).valid && /does not follow/.test(lib.verifyLedger(gap).errors[0]));
  const relinked = JSON.parse(JSON.stringify(good));
  relinked[1].prevHash = 'x';
  relinked[1].hash = lib.hashEntry(relinked[1]);
  ok('a re-hashed entry with the wrong link is still caught', !lib.verifyLedger(relinked).valid && /prevHash/.test(lib.verifyLedger(relinked).errors[0]));
  const unknown = chain(['site-promoted']);
  unknown[0].kind = 'site-invented';
  unknown[0].hash = lib.hashEntry(unknown[0]);
  ok('an unknown kind is rejected', !lib.verifyLedger(unknown).valid);
}

const entry = { domain: 'acmeprivacy.com', looksLegal: true, path: 'page-links', documentUrls: ['https://acmeprivacy.com/legal/terms-of-service', 'https://acmeprivacy.com/privacy-notice', 'https://acmeprivacy.com/glba'] };
const proposal = lib.proposalFromManifestEntry(entry);
ok('a manifest entry becomes a trainer proposal with terms, privacy, and supplemental urls',
  proposal && proposal.source === 'trainer' && proposal.tos_url === 'https://acmeprivacy.com/legal/terms-of-service' && proposal.privacy_url === 'https://acmeprivacy.com/privacy-notice' && proposal.supplemental_urls[0] === 'https://acmeprivacy.com/glba' && proposal.path === 'page-links', JSON.stringify(proposal));
ok('a shell or a single-url entry is not proposed', lib.proposalFromManifestEntry({ ...entry, looksLegal: false }) === null && lib.proposalFromManifestEntry({ ...entry, documentUrls: ['https://acmeprivacy.com/terms'] }) === null);
ok('a frozen path is reported as unknown', lib.proposalFromManifestEntry({ ...entry, path: 'frozen' }).path === 'unknown');
ok('two urls without keywords still yield a pair', lib.proposalFromManifestEntry({ ...entry, documentUrls: ['https://acmeprivacy.com/a', 'https://acmeprivacy.com/b'] }).privacy_url === 'https://acmeprivacy.com/b');

const rendered = lib.renderLedger(good, lib.verifyLedger(good));
ok('the ledger renders one line per entry with the verification verdict', rendered.includes('chain verified') && rendered.split('\n').length === 5 && rendered.includes('site-promoted') && rendered.includes('(3 days)'));
ok('a broken chain renders its errors', /BROKEN/.test(lib.renderLedger([good[1]], lib.verifyLedger([good[1]]))));

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
