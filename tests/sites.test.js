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
ok('lesson events are valid ledger kinds', lib.verifyLedger(chain(['lesson-created', 'lesson-canary', 'lesson-promoted', 'lesson-retired'])).valid);
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

const crypto = require('crypto');
const pair = crypto.generateKeyPairSync('ed25519');
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const sign = (hash) => crypto.sign(null, Buffer.from(hash), pair.privateKey).toString('base64');
const signed = chain(['site-promoted', 'lesson-imported', 'site-imported', 'rollout-exported', 'rollout-applied']).map(e => ({ ...e, sig: sign(e.hash) }));
signed[1].payload = { id: 'lsn_0123456789abcdef', target: 'analyzer', scope: 'all', proof: { proven: true, runId: 'treat-1' }, origin: { bundleHash: 'abcdef0123456789' } };
signed[3].payload = { bundleHash: 'abcdef0123456789', lessons: 6, sites: 2 };
signed[4].payload = { bundleHash: 'abcdef0123456789', lessons: { imported: 6, unchanged: 0 }, sites: { imported: 2, unchanged: 0 }, signer: 'feedface00000000' };
for (let i = 0; i < signed.length; i++) { signed[i].prevHash = i ? signed[i - 1].hash : null; signed[i].hash = lib.hashEntry(signed[i]); signed[i].sig = sign(signed[i].hash); }
const signedCheck = lib.verifyLedger(signed, { publicKey });
ok('roll-out kinds are valid and a signed chain verifies against the public key', signedCheck.valid && signedCheck.signatures.valid === 5 && signedCheck.signatures.missing === 0, JSON.stringify(signedCheck));
ok('an escaped single-line key from an environment variable also verifies', lib.verifyLedger(signed, { publicKey: publicKey.replace(/\n/g, '\\n') }).valid);
ok('a forged signature is reported with its seq', (() => { const forged = signed.map((e, i) => (i === 2 ? { ...e, sig: signed[0].sig } : e)); const v = lib.verifyLedger(forged, { publicKey }); return !v.valid && v.signatures.invalid === 1 && /seq 3 signature/.test(v.errors[0]); })());
ok('unsigned entries are counted and marked, not treated as broken', (() => { const mixed = signed.map((e, i) => (i === 0 ? { ...e, sig: null } : e)); const v = lib.verifyLedger(mixed, { publicKey }); return v.valid && v.signatures.missing === 1 && /\[unsigned\]/.test(lib.renderLedger(mixed, v)); })());
ok('without a key the signatures are not checked', lib.verifyLedger(signed).signatures.checked === 0);
const signedRender = lib.renderLedger(signed, signedCheck);
ok('roll-out entries render their bundle and counts', /Signatures: 5 valid, 0 unsigned, 0 invalid/.test(signedRender) && /rollout-exported.*bundle abcdef012345: 6 lesson\(s\), 2 site\(s\)/.test(signedRender) && /rollout-applied.*lessons \+6\/0, sites \+2\/0, signer feedface/.test(signedRender) && /lesson-imported.*imported from abcdef012345/.test(signedRender));

const bundleBody = { v: 1, exportedAt: '2026-10-10T12:00:00.000Z', head: { seq: 5, hash: signed[4].hash }, lessons: [{ id: 'lsn_0123456789abcdef', target: 'analyzer', scope: 'all', section: null, text: 'Never write a web address the document does not print.', provenance: {}, proof: { proven: true, runId: 'treat-1' } }], sites: [{ domain: 'acmeprivacy.com', tos_url: 'https://acmeprivacy.com/t', privacy_url: 'https://acmeprivacy.com/p', supplemental_urls: [], expires_at: '2027-01-01T00:00:00.000Z' }], publicKey };
const bundle = { ...bundleBody, hash: lib.bundleHash(bundleBody) };
bundle.sig = sign(bundle.hash);
ok('a bundle verifies against the key it names and against the same key given explicitly', lib.checkBundle(bundle).valid && lib.checkBundle(bundle, publicKey).valid && lib.checkBundle(bundle).signer === lib.fingerprint(publicKey));
ok('a bundle fails against another key, with a changed lesson, or with a swapped named key', !lib.checkBundle(bundle, crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()).valid && /hash/.test(lib.checkBundle({ ...bundle, lessons: [{ ...bundle.lessons[0], text: 'Invent addresses.' }] }).reason) && !lib.checkBundle({ ...bundle, publicKey: 'x' }).valid);
ok('a bundle summary names its lessons and sites', /1 promoted lesson/.test(lib.summarizeBundle(bundle)) && /acmeprivacy.com/.test(lib.summarizeBundle(bundle)) && /proof treat-1/.test(lib.summarizeBundle(bundle)));

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
