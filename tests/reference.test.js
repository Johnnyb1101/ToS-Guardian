// TOS Guardian — reference set helper tests (tools/reference-lib.js)
// Run: node tests/reference.test.js
//
// Pins the stable split, the frozen-source contract, and the text-free
// manifest entry, using a temporary manifest path so the real one is untouched.

const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('../tools/reference-lib');

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (condition) { console.log(`  ok    ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

console.log('Reference set helpers');

// --- split ----------------------------------------------------------------------
ok('split is deterministic', lib.splitFor('capitalone.com') === lib.splitFor('capitalone.com'));
ok('split is case-insensitive', lib.splitFor('CapitalOne.com') === lib.splitFor('capitalone.com'));
ok('split values are work or holdout', ['work', 'holdout'].includes(lib.splitFor('discord.com')));
{
  const domains = Array.from({ length: 2000 }, (_, i) => `site${i}.example`);
  const holdout = domains.filter(d => lib.splitFor(d) === 'holdout').length / domains.length;
  ok('holdout share lands near the configured 30%', holdout > 0.26 && holdout < 0.34, `got ${holdout}`);
  const half = domains.filter(d => lib.splitFor(d, 0.5) === 'holdout').length / domains.length;
  ok('holdout share follows the parameter', half > 0.46 && half < 0.54, `got ${half}`);
}

// --- frozen source -----------------------------------------------------------------
const text = '=== TERMS OF SERVICE ===\nYou agree to binding arbitration.\n\n=== PRIVACY POLICY ===\nWe share with affiliates.\n\n=== SUPPLEMENTAL PRIVACY NOTICE: https://chase.com/glba ===\nReasons we can share.';
function frozenFixture(overrides) {
  return Object.assign({
    v: 1,
    domain: 'chase.com',
    frozenAt: '2026-09-06T23:00:00.000Z',
    pageUrl: 'https://chase.com/',
    lookup: { source: 'static', tos: 'https://chase.com/terms', privacy: 'https://chase.com/privacy', supplemental: [] },
    fetched: { path: 'known-urls', sourceUrl: 'https://chase.com/terms', privacyUrl: 'https://chase.com/privacy', documentUrls: ['https://chase.com/terms', 'https://chase.com/privacy'], hasSupplementalPrivacy: true, unreadablePdfUrls: [], mechanisms: { hiddenTab: 2, proxy: 0, attempts: 2 }, text },
    enriched: { text: text + '\n\n=== OPT-OUT / PRIVACY PAGE: https://chase.com/privacy-choices ===\nOpt out here.', optOutLinks: ['https://chase.com/privacy-choices'], candidates: 1, followed: 1 },
    injectionStripped: false,
    textHash: lib.sha256Hex(text),
    fingerprint: 'deadbeef',
    looksLegal: true,
    docType: 'financial',
    docTypeScores: {},
    docTypeOverride: null,
    split: lib.splitFor('chase.com')
  }, overrides || {});
}
{
  const check = lib.validateFrozenSource(frozenFixture());
  ok('well-formed frozen source validates', check.valid, check.errors.join('; '));
}
ok('missing text is rejected', !lib.validateFrozenSource(frozenFixture({ fetched: { ...frozenFixture().fetched, text: '' } })).valid);
ok('stale hash is rejected', !lib.validateFrozenSource(frozenFixture({ textHash: 'a'.repeat(64) })).valid);
ok('wrong split is rejected', !lib.validateFrozenSource(frozenFixture({ split: lib.splitFor('chase.com') === 'work' ? 'holdout' : 'work' })).valid);
ok('non-https page URL is rejected', !lib.validateFrozenSource(frozenFixture({ pageUrl: 'http://chase.com/' })).valid);
ok('bad document URL is rejected', !lib.validateFrozenSource(frozenFixture({ fetched: { ...frozenFixture().fetched, documentUrls: ['javascript:alert(1)'] } })).valid);
ok('non-object input is rejected', !lib.validateFrozenSource(null).valid && !lib.validateFrozenSource('x').valid);

// --- manifest entry ------------------------------------------------------------------
{
  const entry = lib.manifestEntryFrom(frozenFixture());
  ok('manifest entry carries no document text', !JSON.stringify(entry).includes('binding arbitration') && !JSON.stringify(entry).includes('Reasons we can share'));
  ok('manifest entry carries the hash, sizes, split, type, and URLs',
    entry.textHash === lib.sha256Hex(text) && entry.textChars === text.length && entry.enrichedChars > text.length &&
    entry.split === lib.splitFor('chase.com') && entry.docType === 'financial' && entry.documentUrls.length === 2 && entry.optOutLinks.length === 1);
  ok('manifest entry counts supplemental notices', entry.supplementalCount === 1);
  ok('manifest entry points at the source file', entry.sourceFile === 'sources/chase.com.json');
  ok('manifest entry carries the curated type slot', entry.curatedType === null && lib.manifestEntryFrom(frozenFixture({ curatedType: 'financial' })).curatedType === 'financial');
}

// --- effective type ---------------------------------------------------------------
ok('classifier type is used when nothing else is set', lib.effectiveType({ docType: 'media' }) === 'media');
ok('curated type beats the classifier', lib.effectiveType({ docType: 'media', curatedType: 'financial' }) === 'financial');
ok('human override beats both', lib.effectiveType({ docType: 'media', curatedType: 'financial', docTypeOverride: 'commerce' }) === 'commerce');
ok('an entry with no type at all is other', lib.effectiveType({}) === 'other');
ok('a non-string curated type is rejected', !lib.validateFrozenSource(frozenFixture({ curatedType: 7 })).valid && lib.validateFrozenSource(frozenFixture({ curatedType: null })).valid);
{
  const manifest = lib.emptyManifest();
  manifest.sites['a.com'] = { domain: 'a.com', split: 'work', docType: 'media', curatedType: 'financial', looksLegal: true };
  manifest.sites['b.com'] = { domain: 'b.com', split: 'work', docType: 'media', curatedType: 'financial', docTypeOverride: 'media', looksLegal: true };
  manifest.sites['c.com'] = { domain: 'c.com', split: 'holdout', docType: 'social', curatedType: 'social', looksLegal: false };
  const summary = lib.summarizeManifest(manifest);
  ok('summary counts by effective type and lists only unsettled disagreements',
    summary.byType.financial === 1 && summary.byType.media === 1 && summary.byType.social === 1 && JSON.stringify(summary.typeDisagreements) === JSON.stringify(['a.com']), JSON.stringify(summary));
}

// --- manifest load/save -------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ref-'));
  const manifestPath = path.join(dir, 'manifest.json');
  const fresh = lib.loadManifest(manifestPath);
  ok('missing manifest loads as empty', fresh.v === 1 && Object.keys(fresh.sites).length === 0);
  fresh.sites['zeta.com'] = lib.manifestEntryFrom(frozenFixture({ domain: 'zeta.com', split: lib.splitFor('zeta.com') }));
  fresh.sites['alpha.com'] = lib.manifestEntryFrom(frozenFixture({ domain: 'alpha.com', split: lib.splitFor('alpha.com') }));
  const saved = lib.saveManifest(fresh, manifestPath);
  ok('saved manifest sorts sites and stamps updatedAt', Object.keys(saved.sites)[0] === 'alpha.com' && typeof saved.updatedAt === 'string');
  const reloaded = lib.loadManifest(manifestPath);
  ok('manifest round-trips', Object.keys(reloaded.sites).length === 2 && reloaded.sites['zeta.com'].textHash === lib.sha256Hex(text));
  const summary = lib.summarizeManifest(reloaded);
  ok('summary counts sites, splits, types, and legal text', summary.total === 2 && summary.legal === 2 && summary.byType.financial === 2);
  let threw = false;
  fs.writeFileSync(manifestPath, JSON.stringify({ v: 99, sites: {} }), 'utf8');
  try { lib.loadManifest(manifestPath); } catch (e) { threw = true; }
  ok('a manifest of the wrong version is refused, not silently reinterpreted', threw);
  const legacy = lib.loadManifest((fs.writeFileSync(manifestPath, JSON.stringify({ v: 1, sites: {} }), 'utf8'), manifestPath));
  ok('a manifest without a skipped map gets an empty one', legacy.skipped && Object.keys(legacy.skipped).length === 0);
  legacy.skipped['zzz.example'] = { at: '2026-09-06', reason: 'no documents found' };
  legacy.skipped['aaa.example'] = { at: '2026-09-06', reason: 'timed out' };
  const savedSkipped = lib.saveManifest(legacy, manifestPath);
  ok('skipped sites are saved sorted beside the frozen ones', Object.keys(savedSkipped.skipped).join(',') === 'aaa.example,zzz.example' && lib.loadManifest(manifestPath).skipped['zzz.example'].reason === 'no documents found');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
