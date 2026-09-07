// TOS Guardian — reference set helpers (learning loop, phase 1)
//
// Pure functions behind tools/reference.js: the stable work/holdout split, the
// frozen-source record and its validator, and the committed manifest. No
// network, no vm, so tests/reference.test.js can cover them directly.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FROZEN_SOURCE_VERSION = 1;
const MANIFEST_VERSION = 1;
const DEFAULT_HOLDOUT_SHARE = 0.3;

const REFERENCE_DIR = path.resolve(__dirname, '..', 'reference');
const SOURCES_DIR = path.join(REFERENCE_DIR, 'sources');
const RUNS_DIR = path.join(REFERENCE_DIR, 'runs');
const MANIFEST_PATH = path.join(REFERENCE_DIR, 'manifest.json');

// The split is a pure function of the domain, so it never changes as sites are
// added or removed, and no one can move a site between splits by re-running.
function splitFor(domain, holdoutShare = DEFAULT_HOLDOUT_SHARE) {
  const digest = crypto.createHash('sha256').update(`tos-guardian-reference-split:${String(domain).toLowerCase()}`).digest();
  const unit = digest.readUInt32BE(0) / 0x100000000;
  return unit < holdoutShare ? 'holdout' : 'work';
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isUrlList(value) {
  return Array.isArray(value) && value.every(u => typeof u === 'string' && /^https?:\/\//.test(u));
}

// A frozen source is exactly what the pipeline would hand the analyzer, plus
// the facts a replay and the manifest need. `fetched.text` is the combined
// document text before link-following; `enriched.text` is after it, which is
// what analyzeWithModel budgets and sends.
function validateFrozenSource(frozen) {
  const errors = [];
  if (!isPlainObject(frozen)) return { valid: false, errors: ['frozen source must be an object'] };
  if (frozen.v !== FROZEN_SOURCE_VERSION) errors.push(`v must be ${FROZEN_SOURCE_VERSION}`);
  if (typeof frozen.domain !== 'string' || !/^[a-z0-9.-]+$/.test(frozen.domain)) errors.push('domain must be a lowercase registrable domain');
  if (typeof frozen.frozenAt !== 'string' || Number.isNaN(Date.parse(frozen.frozenAt))) errors.push('frozenAt must be an ISO timestamp');
  if (typeof frozen.pageUrl !== 'string' || !/^https:\/\//.test(frozen.pageUrl)) errors.push('pageUrl must be an https URL');
  if (!isPlainObject(frozen.fetched)) errors.push('fetched must be an object');
  else {
    if (typeof frozen.fetched.text !== 'string' || frozen.fetched.text.length === 0) errors.push('fetched.text must be a non-empty string');
    if (typeof frozen.fetched.path !== 'string') errors.push('fetched.path must be a string');
    if (!isUrlList(frozen.fetched.documentUrls)) errors.push('fetched.documentUrls must be a list of http(s) URLs');
  }
  if (!isPlainObject(frozen.enriched)) errors.push('enriched must be an object');
  else {
    if (typeof frozen.enriched.text !== 'string' || frozen.enriched.text.length === 0) errors.push('enriched.text must be a non-empty string');
    if (!isUrlList(frozen.enriched.optOutLinks)) errors.push('enriched.optOutLinks must be a list of http(s) URLs');
  }
  if (typeof frozen.textHash !== 'string' || !/^[0-9a-f]{64}$/.test(frozen.textHash)) errors.push('textHash must be a sha256 hex digest');
  if (frozen.fetched && typeof frozen.fetched.text === 'string' && frozen.textHash !== sha256Hex(frozen.fetched.text)) errors.push('textHash does not match fetched.text');
  if (typeof frozen.looksLegal !== 'boolean') errors.push('looksLegal must be a boolean');
  if (typeof frozen.docType !== 'string') errors.push('docType must be a string');
  if (frozen.curatedType !== undefined && frozen.curatedType !== null && typeof frozen.curatedType !== 'string') errors.push('curatedType must be a string or null');
  if (frozen.split !== 'work' && frozen.split !== 'holdout') errors.push('split must be work or holdout');
  if (frozen.split !== undefined && typeof frozen.domain === 'string' && frozen.split !== splitFor(frozen.domain)) errors.push('split does not match the deterministic split for the domain');
  return { valid: errors.length === 0, errors };
}

// The committed, text-free view of a frozen source.
function manifestEntryFrom(frozen) {
  return {
    domain: frozen.domain,
    frozenAt: frozen.frozenAt,
    split: frozen.split,
    docType: frozen.docType,
    curatedType: frozen.curatedType || null,
    docTypeOverride: frozen.docTypeOverride || null,
    textHash: frozen.textHash,
    textChars: frozen.fetched.text.length,
    enrichedChars: frozen.enriched.text.length,
    looksLegal: frozen.looksLegal,
    path: frozen.fetched.path,
    documentUrls: frozen.fetched.documentUrls.slice(),
    optOutLinks: frozen.enriched.optOutLinks.slice(),
    supplementalCount: (frozen.fetched.text.split('=== SUPPLEMENTAL PRIVACY NOTICE').length - 1),
    injectionStripped: !!frozen.injectionStripped,
    sourceFile: `sources/${frozen.domain}.json`
  };
}

// The type tools should use for a site: a human override wins, then the type
// the curated list gave it, then the classifier's guess.
function effectiveType(entry) {
  return entry.docTypeOverride || entry.curatedType || entry.docType || 'other';
}

function emptyManifest() {
  return { v: MANIFEST_VERSION, updatedAt: null, holdoutShare: DEFAULT_HOLDOUT_SHARE, sites: {}, skipped: {} };
}

function loadManifest(manifestPath = MANIFEST_PATH) {
  if (!fs.existsSync(manifestPath)) return emptyManifest();
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!isPlainObject(parsed) || parsed.v !== MANIFEST_VERSION || !isPlainObject(parsed.sites)) {
    throw new Error(`${manifestPath} is not a version ${MANIFEST_VERSION} manifest`);
  }
  if (!isPlainObject(parsed.skipped)) parsed.skipped = {};
  return parsed;
}

function saveManifest(manifest, manifestPath = MANIFEST_PATH) {
  const ordered = { ...manifest, updatedAt: new Date().toISOString(), sites: {}, skipped: {} };
  for (const domain of Object.keys(manifest.sites).sort()) ordered.sites[domain] = manifest.sites[domain];
  for (const domain of Object.keys(manifest.skipped || {}).sort()) ordered.skipped[domain] = manifest.skipped[domain];
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(ordered, null, 2) + '\n', 'utf8');
  return ordered;
}

function summarizeManifest(manifest) {
  const sites = Object.values(manifest.sites || {});
  const count = (fn) => sites.reduce((acc, s) => { const k = fn(s); acc[k] = (acc[k] || 0) + 1; return acc; }, {});
  return {
    total: sites.length,
    bySplit: count(s => s.split),
    byType: count(effectiveType),
    legal: sites.filter(s => s.looksLegal).length,
    typeDisagreements: sites.filter(s => s.curatedType && s.curatedType !== s.docType && !s.docTypeOverride).map(s => s.domain).sort()
  };
}

module.exports = {
  FROZEN_SOURCE_VERSION,
  MANIFEST_VERSION,
  DEFAULT_HOLDOUT_SHARE,
  REFERENCE_DIR,
  SOURCES_DIR,
  RUNS_DIR,
  MANIFEST_PATH,
  splitFor,
  sha256Hex,
  validateFrozenSource,
  manifestEntryFrom,
  effectiveType,
  emptyManifest,
  loadManifest,
  saveManifest,
  summarizeManifest
};
