const lib = require('../tools/sites-lib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (condition) { console.log(`  ok    ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

console.log('Site tools');

{
  const previous = process.env.TRAINER_ACCESS_TOKEN;
  process.env.TRAINER_ACCESS_TOKEN = 'test-only-trainer-token';
  const headers = lib.trainerHeaders({ 'Content-Type': 'application/json' });
  ok('trainer requests carry a bearer token without changing other headers', headers.Authorization === 'Bearer test-only-trainer-token' && headers['Content-Type'] === 'application/json');
  if (previous === undefined) delete process.env.TRAINER_ACCESS_TOKEN;
  else process.env.TRAINER_ACCESS_TOKEN = previous;
  ok('mock requests remain usable when no trainer token is configured', previous === undefined ? !Object.hasOwn(lib.trainerHeaders(), 'Authorization') : lib.trainerHeaders().Authorization === `Bearer ${previous}`);
}

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

const owner = crypto.generateKeyPairSync('ed25519');
const ownerKey = owner.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const policy = { models: { anthropic: { default: 'a', escalated: 'b', jury: 'c' }, openai: { default: 'd', escalated: 'e', jury: 'f' } }, promptHashes: { analyzer: 'a'.repeat(64), critic: 'b'.repeat(64), jury: 'c'.repeat(64) }, rubricHash: 'e'.repeat(64), versions: Object.fromEntries(['resolver', 'classifier', 'excerpt', 'escalation', 'evaluator', 'siteLookup', 'pipeline'].map(k => [k, 'd'.repeat(64)])), limits: { maxLessonsPerTarget: 12 }, selection: { order: 'explicit' } };
const config = { lessons: [], sites: [], policy };
const release = { v: 2, configHash: lib.releaseConfigHash(config), config };
ok('release config hash matches the proxy canonical versioned hash vector', release.configHash === 'e6e3800012536d12e96f06300ab7a76e2cd222fd16b2dca84bd98f749506fcf3');
{
  const memberRelease = (lessons, sites) => {
    const memberConfig = { lessons, sites, policy };
    return { v: 2, configHash: lib.releaseConfigHash(memberConfig), config: memberConfig };
  };
  const lessonText = 'Name only privacy choices supported by the actual source text.';
  const analyzerLesson = { id: `lsn_${crypto.createHash('sha256').update(`analyzer\n${lessonText}`).digest('hex').slice(0, 16)}`, target: 'analyzer', text: lessonText, scope: 'all', section: null, order: 0 };
  const criticText = 'Flag a missing opt-out only when the actual source omits one.';
  const criticLesson = { id: `lsn_${crypto.createHash('sha256').update(`critic\n${criticText}`).digest('hex').slice(0, 16)}`, target: 'critic', text: criticText, scope: 'financial', section: 'optOutRights', order: 0 };
  const tos = 'https://acmeprivacy.com/terms';
  const privacy = 'https://acmeprivacy.com/privacy';
  const site = { domain: 'acmeprivacy.com', tos_url: tos, privacy_url: privacy, supplemental_urls: [], path: 'known-urls', urls_hash: crypto.createHash('sha256').update(lib.strictCanonicalJson({ tos, privacy, supplemental: [] })).digest('hex'), verified_at: '2026-10-01T00:00:00.000Z', expires_at: '2026-11-01T00:00:00.000Z', evidence: null };
  ok('canonical complete lessons and site members validate', lib.checkRelease(memberRelease([analyzerLesson, criticLesson], [site])).valid);
  const rejected = [
    ['null lesson', [null], [], /invalid release lesson/],
    ['invalid lesson scope', [{ ...analyzerLesson, scope: 'unrecognized' }], [], /invalid lesson scope/],
    ['duplicate lesson id', [analyzerLesson, analyzerLesson], [], /duplicate release lesson/],
    ['duplicate lesson order', [analyzerLesson, { ...analyzerLesson, id: `lsn_${crypto.createHash('sha256').update('analyzer\nAnother source-supported privacy choice must be named clearly.').digest('hex').slice(0, 16)}`, text: 'Another source-supported privacy choice must be named clearly.' }], [], /duplicate lesson order/],
    ['unsorted lessons', [criticLesson, analyzerLesson], [], /noncanonical/],
    ['noncanonical lesson text', [{ ...analyzerLesson, text: `  ${lessonText}  ` }], [], /noncanonical/],
    ['cross-domain URL', [], [{ ...site, privacy_url: 'https://other.com/privacy' }], /invalid release site/],
    ['URL with query', [], [{ ...site, tos_url: `${tos}?next=1` }], /canonical HTTPS URLs/],
    ['expired verification lifetime', [], [{ ...site, expires_at: '2026-09-01T00:00:00.000Z' }], /verification lifetime/],
    ['duplicate site domain', [], [site, site], /duplicate release site/],
    ['private suffix as site key', [], [{ ...site, domain: 'github.io' }], /invalid release site/]
  ];
  for (const [label, lessons, sites, reason] of rejected) {
    const checked = lib.checkRelease(memberRelease(lessons, sites));
    ok(`rehashed ${label} is rejected like the proxy`, !checked.valid && reason.test(checked.reason), checked.reason);
  }
}
ok('a release without runtime models or jury rubric cannot be evaluated', (() => {
  const withoutModels = { ...config, policy: { ...policy, models: {} } };
  const withoutRubric = { ...config, policy: { ...policy, rubricHash: undefined } };
  return /complete runtime policy/.test(lib.checkRelease({ v: 2, configHash: lib.releaseConfigHash(withoutModels), config: withoutModels }).reason) &&
    /rubric/.test(lib.checkRelease({ v: 2, configHash: '0'.repeat(64), config: withoutRubric }).reason);
})());
const issuedAt = new Date(Date.now() - 60_000).toISOString();
const expiresAt = new Date(Date.now() + 60_000).toISOString();
const payload = { v: 2, kind: 'release-activation', authorizationId: 'approval_0123456789', action: 'activate', environment: 'production', configHash: release.configHash, expectedGeneration: 0, expectedConfigHash: null, expectedHeadHash: null, issuedAt, expiresAt, evidence: { phase: 'step2-final', configHash: release.configHash, evidenceHash: 'e'.repeat(64), protocolHash: 'f'.repeat(64), corpusHash: '0'.repeat(64), evaluationPassed: true, promotionEligible: true, diagnosticOnly: false } };
const authorization = { payload, signature: crypto.sign(null, Buffer.from(lib.AUTHORIZATION_PURPOSE + lib.strictCanonicalJson(payload)), owner.privateKey).toString('base64') };
const bundleBody = { v: 2, kind: 'complete-release', exportedAt: new Date().toISOString(), release, authorization, publicKey };
const bundle = { ...bundleBody, hash: lib.bundleHash(bundleBody) };
bundle.sig = sign(lib.BUNDLE_PURPOSE + bundle.hash);
const active = { environment: 'production', generation: 0, configHash: null, headHash: null };
ok('a complete release bundle verifies both trusted signatures and prior state', lib.checkBundle(bundle, publicKey, ownerKey, { active }).valid && lib.checkBundle(bundle, publicKey, ownerKey, { active }).ownerVerified && lib.checkBundle(bundle).signer === lib.fingerprint(publicKey));
ok('owner approval must use a key independent of the transport signer', /independent/.test(lib.checkBundle(bundle, publicKey, publicKey, { active }).reason));
ok('the same key with different PEM line endings is not an independent owner', /independent/.test(lib.checkBundle(bundle, publicKey, publicKey.replace(/\n/g, '\r\n'), { active }).reason));
ok('a bundle fails against another transport key, changed config, or swapped named key', !lib.checkBundle(bundle, crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()).valid && /release lesson/.test(lib.checkBundle({ ...bundle, release: { ...release, config: { ...config, lessons: [{ text: 'changed' }] } } }).reason) && !lib.checkBundle({ ...bundle, publicKey: 'x' }).valid);
ok('a diagnostic authorization and stale destination state cannot activate', !lib.checkBundle({ ...bundle, authorization: { ...authorization, payload: { ...payload, evidence: { ...payload.evidence, diagnosticOnly: true } } } }, publicKey, ownerKey).valid && /expected state mismatch/.test(lib.checkBundle(bundle, publicKey, ownerKey, { active: { ...active, generation: 1 } }).reason));
ok('legacy per-lesson bundles are rejected', /version 2/.test(lib.checkBundle({ v: 1, lessons: [], sites: [] }).reason));
ok('a bundle summary names the complete config and destination', lib.summarizeBundle(bundle).includes(release.configHash) && lib.summarizeBundle(bundle).includes('production'));

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-rollout-show-'));
  try {
    const bundlePath = path.join(dir, 'bundle.json');
    const transportPath = path.join(dir, 'transport.pem');
    const ownerPath = path.join(dir, 'owner.pem');
    fs.writeFileSync(bundlePath, JSON.stringify(bundle));
    fs.writeFileSync(transportPath, publicKey);
    fs.writeFileSync(ownerPath, ownerKey);
    const cli = path.join(__dirname, '..', 'tools', 'rollout.js');
    const inspected = spawnSync(process.execPath, [cli, 'show', bundlePath, '--transport-key', transportPath, '--approval-key', ownerPath], { encoding: 'utf8' });
    ok('rollout show verifies both supplied keys without submitting a bundle', inspected.status === 0 && /owner approval verified against supplied key/.test(inspected.stdout));
    const unsafe = spawnSync(process.execPath, [cli, 'import', bundlePath, '--proxy', 'http://127.0.0.1:9'], { encoding: 'utf8' });
    ok('rollout import refuses to contact a destination without explicit trust keys', unsafe.status !== 0 && /explicit --approval-key/.test(unsafe.stderr));
    fs.writeFileSync(ownerPath, publicKey.replace(/\n/g, '\r\n'));
    const sameKey = spawnSync(process.execPath, [cli, 'show', bundlePath, '--transport-key', transportPath, '--approval-key', ownerPath], { encoding: 'utf8' });
    ok('rollout CLI refuses the same key under different PEM formatting', sameKey.status !== 0 && /independent owner|independent of transport/.test(sameKey.stdout));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
