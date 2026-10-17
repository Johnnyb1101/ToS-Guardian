'use strict';

const crypto = require('crypto');
const { parse: parseDomain } = require('../vendor/tldts-7.4.8.umd.min.js');

const LEDGER_KINDS = Object.freeze(['site-promoted', 'site-refreshed', 'site-rejected', 'halt-set', 'halt-cleared', 'lesson-created', 'lesson-canary', 'lesson-promoted', 'lesson-retired', 'lesson-candidate', 'lesson-imported', 'site-imported', 'rollout-exported', 'rollout-applied']);
const BUNDLE_VERSION = 2;
const RELEASE_VERSION = 2;
const BUNDLE_PURPOSE = 'tos-guardian.release-bundle.v2\n';
const AUTHORIZATION_PURPOSE = 'tos-guardian.release-activation.v2\n';
const DOCUMENT_TYPES = Object.freeze(['financial', 'health', 'education', 'government', 'social', 'media', 'commerce', 'gaming', 'technology', 'other']);
const RELEASE_TARGETS = Object.freeze(['analyzer', 'critic']);
const LESSON_SECTIONS = Object.freeze(['dataCollection', 'dataSelling', 'optOutRights', 'howToOptOut', 'autoRenewal', 'dataDeletion', 'riskLevel']);
const POLICY_VERSIONS = Object.freeze(['resolver', 'classifier', 'excerpt', 'escalation', 'evaluator', 'siteLookup', 'pipeline']);
const RELEASE_SITE_PATHS = Object.freeze(['known-urls', 'page-links', 'link-text', 'homepage-footer', 'candidates', 'frozen', 'unknown']);
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function strictCanonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(strictCanonicalJson).join(',')}]`;
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    const keys = Object.keys(value).sort();
    if (keys.some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) throw new Error('unsafe configuration key');
    return `{${keys.map(key => `${JSON.stringify(key)}:${strictCanonicalJson(value[key])}`).join(',')}}`;
  }
  throw new Error('configuration must contain finite JSON values only');
}

const strictDigest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : strictCanonicalJson(value), 'utf8').digest('hex');
const strictClone = value => JSON.parse(strictCanonicalJson(value));

function registrableDomain(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const input = value.trim();
    const url = new URL(input.includes('://') ? input : `https://${input}`);
    if (url.username || url.password) return null;
    const hostname = url.hostname.toLowerCase().replace(/\.+$/, '');
    const parsed = parseDomain(hostname, { allowPrivateDomains: true, detectSpecialUse: true });
    return parsed.isIp || parsed.isSpecialUse || !parsed.domain ? null : parsed.domain.toLowerCase();
  } catch { return null; }
}

function canonicalDomainKey(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const input = value.trim();
    const url = new URL(input.includes('://') ? input : `https://${input}`);
    if (url.username || url.password) return false;
    const hostname = url.hostname.toLowerCase().replace(/\.+$/, '');
    return input === hostname && hostname === registrableDomain(input);
  } catch { return false; }
}

function canonicalLesson(input, index) {
  if (!isObject(input) || !RELEASE_TARGETS.includes(input.target) || !nonempty(input.text) || input.text.length < 20 || input.text.length > 600 || /[<>]/.test(input.text)) throw new Error('invalid release lesson');
  const text = input.text.trim().replace(/\s+/g, ' ');
  const id = `lsn_${strictDigest(`${input.target}\n${text}`).slice(0, 16)}`;
  if (input.id !== id) throw new Error('release lesson id does not match its target and text');
  const scope = input.scope === undefined ? 'all' : input.scope;
  const section = input.section === undefined ? null : input.section;
  const order = input.order === undefined ? index : input.order;
  if ((scope !== 'all' && !DOCUMENT_TYPES.includes(scope)) || (section !== null && !LESSON_SECTIONS.includes(section)) || !Number.isSafeInteger(order) || order < 0) throw new Error('invalid lesson scope, section, or order');
  return { id, target: input.target, text, scope, section, order };
}

function canonicalSite(input) {
  if (!isObject(input) || !canonicalDomainKey(input.domain)) throw new Error('invalid release site');
  for (const value of [input.tos_url, input.privacy_url]) {
    let url;
    try { url = new URL(value); } catch { throw new Error('invalid release site'); }
    if (url.protocol !== 'https:' || url.username || url.password || registrableDomain(url.hostname) !== input.domain) throw new Error('invalid release site');
  }
  const supplemental = input.supplemental_urls === undefined ? [] : input.supplemental_urls;
  if (!Array.isArray(supplemental) || supplemental.length > 5 || new Set(supplemental).size !== supplemental.length) throw new Error('invalid supplemental site URLs');
  const cleanUrl = value => {
    if (typeof value !== 'string') throw new Error('invalid site URL');
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || registrableDomain(url.hostname) !== input.domain || url.href !== value) throw new Error('site URLs must be canonical HTTPS URLs on the site domain');
    return value;
  };
  const tos = cleanUrl(input.tos_url);
  const privacy = cleanUrl(input.privacy_url);
  const extra = supplemental.map(cleanUrl).sort();
  const urlsHash = strictDigest({ tos, privacy, supplemental: extra });
  if (input.urls_hash !== undefined && input.urls_hash !== urlsHash) throw new Error('site URL hash mismatch');
  if (!RELEASE_SITE_PATHS.includes(input.path)) throw new Error('invalid site discovery path');
  if (typeof input.verified_at !== 'string' || typeof input.expires_at !== 'string' || !Number.isFinite(Date.parse(input.verified_at)) || !Number.isFinite(Date.parse(input.expires_at)) || Date.parse(input.verified_at) >= Date.parse(input.expires_at)) throw new Error('invalid site verification lifetime');
  return { domain: input.domain, tos_url: tos, privacy_url: privacy, supplemental_urls: extra, path: input.path, urls_hash: urlsHash, verified_at: new Date(input.verified_at).toISOString(), expires_at: new Date(input.expires_at).toISOString(), evidence: input.evidence === undefined ? null : strictClone(input.evidence) };
}

function canonicalReleaseConfig(config) {
  const { lessons, sites, policy } = config;
  if (!Array.isArray(lessons) || lessons.length > 200 || !Array.isArray(sites) || sites.length > 5000) throw new Error('invalid release members or release too large');
  if (!isObject(policy) || !isObject(policy.models) || !Object.keys(policy.models).length || !isObject(policy.promptHashes) || !isObject(policy.versions) || !isObject(policy.limits) || !isObject(policy.selection)) throw new Error('release requires the complete runtime policy');
  if (['analyzer', 'critic', 'jury'].some(key => !/^[a-f0-9]{64}$/.test(policy.promptHashes[key] || ''))) throw new Error('release requires analyzer, critic, and jury prompt hashes');
  if (!/^[a-f0-9]{64}$/.test(policy.rubricHash || '')) throw new Error('release requires the jury rubric hash');
  if (POLICY_VERSIONS.some(key => !nonempty(policy.versions[key]))) throw new Error('release requires all runtime version fingerprints');
  if (policy.limits.maxLessonsPerTarget !== 12) throw new Error('unsupported lesson selection limit');
  if (!Object.keys(policy.selection).length) throw new Error('release requires explicit selection policy');
  strictCanonicalJson(policy);
  const normalizedLessons = lessons.map(canonicalLesson).sort((a, b) => compareText(a.target, b.target) || a.order - b.order || compareText(a.id, b.id));
  if (new Set(normalizedLessons.map(lesson => lesson.id)).size !== normalizedLessons.length) throw new Error('duplicate release lesson');
  if (new Set(normalizedLessons.map(lesson => `${lesson.target}:${lesson.order}`)).size !== normalizedLessons.length) throw new Error('duplicate lesson order within target');
  for (const target of RELEASE_TARGETS) for (const docType of DOCUMENT_TYPES) {
    if (normalizedLessons.filter(lesson => lesson.target === target && (lesson.scope === 'all' || lesson.scope === docType)).length > policy.limits.maxLessonsPerTarget) throw new Error('release exceeds selected lesson limit; no truncation is permitted');
  }
  const normalizedSites = sites.map(canonicalSite).sort((a, b) => compareText(a.domain, b.domain));
  if (new Set(normalizedSites.map(site => site.domain)).size !== normalizedSites.length) throw new Error('duplicate release site');
  return { lessons: normalizedLessons, sites: normalizedSites, policy: strictClone(policy) };
}

function releaseConfigHash(config) {
  return crypto.createHash('sha256').update(strictCanonicalJson({ v: RELEASE_VERSION, config }), 'utf8').digest('hex');
}

function releaseLessonsHash(release, target, docType) {
  const selected = release.config.lessons.filter(lesson => lesson.target === target && (lesson.scope === 'all' || lesson.scope === docType));
  return crypto.createHash('sha256').update(strictCanonicalJson(selected), 'utf8').digest('hex');
}

function hashEntry(entry) {
  return sha256({ seq: entry.seq, prevHash: entry.prevHash, kind: entry.kind, domain: entry.domain, payload: entry.payload, createdAt: entry.createdAt });
}

function normalizePem(value) {
  return typeof value === 'string' ? value.replace(/\\n/g, '\n').trim() : '';
}

function verifySignature(publicKeyPem, text, signature) {
  try {
    const key = crypto.createPublicKey(normalizePem(publicKeyPem));
    if (key.asymmetricKeyType !== 'ed25519') return false;
    return crypto.verify(null, Buffer.from(String(text), 'utf8'), key, Buffer.from(String(signature || ''), 'base64'));
  } catch (e) {
    return false;
  }
}

function fingerprint(publicKeyPem) {
  const pem = normalizePem(publicKeyPem);
  return pem ? crypto.createHash('sha256').update(pem).digest('hex').slice(0, 16) : null;
}

function samePublicKey(leftPem, rightPem) {
  const left = crypto.createPublicKey(normalizePem(leftPem)).export({ type: 'spki', format: 'der' });
  const right = crypto.createPublicKey(normalizePem(rightPem)).export({ type: 'spki', format: 'der' });
  return left.equals(right);
}

function trainerHeaders(headers = {}) {
  const token = process.env.TRAINER_ACCESS_TOKEN;
  return token ? { ...headers, Authorization: `Bearer ${token}` } : { ...headers };
}

function verifyLedger(entries, { publicKey = null } = {}) {
  const errors = [];
  const signatures = { checked: 0, valid: 0, invalid: 0, missing: 0 };
  let prev = null;
  for (const entry of entries) {
    if (prev && entry.seq !== prev.seq + 1) errors.push(`seq ${entry.seq} does not follow ${prev.seq}`);
    if (prev && entry.prevHash !== prev.hash) errors.push(`seq ${entry.seq} prevHash does not match seq ${prev.seq}`);
    if (!prev && entry.prevHash !== null) errors.push(`seq ${entry.seq} is first but has a prevHash`);
    if (hashEntry(entry) !== entry.hash) errors.push(`seq ${entry.seq} hash does not match its content`);
    if (!LEDGER_KINDS.includes(entry.kind)) errors.push(`seq ${entry.seq} has unknown kind ${entry.kind}`);
    if (publicKey) {
      signatures.checked++;
      if (!entry.sig) signatures.missing++;
      else if (verifySignature(publicKey, entry.hash, entry.sig)) signatures.valid++;
      else { signatures.invalid++; errors.push(`seq ${entry.seq} signature does not verify`); }
    }
    prev = entry;
  }
  return { valid: errors.length === 0, errors, length: entries.length, head: prev ? prev.hash : null, signatures };
}

function bundleHash(bundle) {
  const { sig, hash, ...body } = bundle;
  return crypto.createHash('sha256').update(strictCanonicalJson(body), 'utf8').digest('hex');
}

function checkRelease(release, expectedConfigHash = null) {
  try {
    if (!isObject(release) || release.v !== RELEASE_VERSION || !/^[a-f0-9]{64}$/.test(release.configHash || '') || !isObject(release.config)) throw new Error('not a version 2 release');
    const config = canonicalReleaseConfig(release.config);
    const canonicalRelease = { v: RELEASE_VERSION, configHash: releaseConfigHash(config), config };
    if (strictCanonicalJson(canonicalRelease) !== strictCanonicalJson(release)) throw new Error('release is noncanonical or its configuration hash does not match');
    if (expectedConfigHash && release.configHash !== expectedConfigHash) throw new Error('release configHash differs from requested hash');
    return { valid: true, configHash: release.configHash };
  } catch (error) { return { valid: false, reason: error.message }; }
}

async function fetchRelease(proxyUrl, configHash, fetchImpl = fetch) {
  if (typeof configHash !== 'string' || !/^[a-f0-9]{64}$/.test(configHash)) throw new Error('A 64-character configHash is required');
  const response = await fetchImpl(`${proxyUrl}/learning/releases/${configHash}`, { headers: trainerHeaders() });
  if (!response.ok) throw new Error(`Release ${configHash} unavailable (HTTP ${response.status})`);
  const data = await response.json();
  const release = data && data.release;
  const check = checkRelease(release, configHash);
  if (!check.valid) throw new Error(check.reason);
  return release;
}

function checkAuthorization(authorization, release, approvalKey, { environment = null, active = null, now = new Date() } = {}) {
  const releaseCheck = checkRelease(release);
  if (!releaseCheck.valid) return releaseCheck;
  if (!approvalKey) return { valid: false, reason: 'independent approval key is required' };
  const p = authorization && authorization.payload;
  if (!p || p.v !== 2 || p.kind !== 'release-activation' || !['activate', 'rollback'].includes(p.action) || !/^[a-zA-Z0-9_-]{16,128}$/.test(p.authorizationId || '')) return { valid: false, reason: 'invalid release authorization' };
  if (environment && p.environment !== environment) return { valid: false, reason: 'authorization destination mismatch' };
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(p.environment || '') || p.configHash !== release.configHash) return { valid: false, reason: 'authorization configuration mismatch' };
  const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (!Number.isSafeInteger(p.expectedGeneration) || p.expectedGeneration < 0 || (p.expectedConfigHash !== null && !isHash(p.expectedConfigHash)) || (p.expectedHeadHash !== null && !isHash(p.expectedHeadHash))) return { valid: false, reason: 'invalid expected release state' };
  if ((p.expectedGeneration === 0) !== (p.expectedConfigHash === null && p.expectedHeadHash === null) || (p.expectedGeneration > 0 && (!p.expectedConfigHash || !p.expectedHeadHash)) || (p.action === 'rollback' && p.expectedGeneration === 0)) return { valid: false, reason: 'inconsistent prior release binding' };
  if (active && (active.environment !== p.environment || active.generation !== p.expectedGeneration || active.configHash !== p.expectedConfigHash || active.headHash !== p.expectedHeadHash)) return { valid: false, reason: 'authorization expected state mismatch' };
  const issued = Date.parse(p.issuedAt);
  const expires = Date.parse(p.expiresAt);
  if (typeof p.issuedAt !== 'string' || typeof p.expiresAt !== 'string' || !Number.isFinite(issued) || !Number.isFinite(expires) || issued > new Date(now).getTime() || expires <= new Date(now).getTime() || expires <= issued) return { valid: false, reason: 'authorization expired or not yet valid' };
  const evidence = p.evidence;
  if (!evidence || evidence.phase !== 'step2-final' || evidence.configHash !== release.configHash || evidence.evaluationPassed !== true || evidence.promotionEligible !== true || evidence.diagnosticOnly !== false || ['evidenceHash', 'protocolHash', 'corpusHash'].some(key => !isHash(evidence[key]))) return { valid: false, reason: 'diagnostic evidence cannot authorize release activation' };
  const payloadKeys = ['v', 'kind', 'authorizationId', 'action', 'environment', 'configHash', 'expectedGeneration', 'expectedConfigHash', 'expectedHeadHash', 'issuedAt', 'expiresAt', 'evidence'];
  if (Object.keys(p).some(key => !payloadKeys.includes(key)) || Object.keys(evidence).some(key => !['phase', 'configHash', 'evidenceHash', 'protocolHash', 'corpusHash', 'evaluationPassed', 'promotionEligible', 'diagnosticOnly'].includes(key)) || Object.keys(authorization).some(key => !['payload', 'signature'].includes(key))) return { valid: false, reason: 'unknown authorization fields' };
  let message;
  try { message = AUTHORIZATION_PURPOSE + strictCanonicalJson(p); } catch (error) { return { valid: false, reason: error.message }; }
  if (!verifySignature(approvalKey, message, authorization.signature)) return { valid: false, reason: 'owner approval signature does not verify' };
  return { valid: true, payload: p };
}

function checkBundle(bundle, publicKey = null, approvalKey = null, options = {}) {
  try {
    if (!bundle || typeof bundle !== 'object' || bundle.v !== BUNDLE_VERSION || bundle.kind !== 'complete-release') return { valid: false, reason: 'legacy or unsupported release bundle; version 2 is required' };
    if (Object.keys(bundle).some(key => !['v', 'kind', 'exportedAt', 'release', 'authorization', 'publicKey', 'hash', 'sig'].includes(key))) return { valid: false, reason: 'unknown bundle fields' };
    const releaseCheck = checkRelease(bundle.release);
    if (!releaseCheck.valid) return releaseCheck;
    if (!bundle.authorization || bundle.authorization.payload?.configHash !== bundle.release.configHash) return { valid: false, reason: 'bundle authorization does not bind this complete release' };
    if (typeof bundle.exportedAt !== 'string' || !Number.isFinite(Date.parse(bundle.exportedAt))) return { valid: false, reason: 'invalid export timestamp' };
    if (bundleHash(bundle) !== bundle.hash) return { valid: false, reason: 'bundle hash does not match its content' };
    const key = publicKey || bundle.publicKey;
    if (!verifySignature(key, BUNDLE_PURPOSE + bundle.hash, bundle.sig) || normalizePem(key) !== normalizePem(bundle.publicKey)) return { valid: false, reason: 'bundle transport signature does not verify' };
    if (approvalKey) {
      if (samePublicKey(approvalKey, key)) return { valid: false, reason: 'owner approval key must be independent of transport signer' };
      const authCheck = checkAuthorization(bundle.authorization, bundle.release, approvalKey, options);
      if (!authCheck.valid) return authCheck;
    }
    strictCanonicalJson(bundle);
    return { valid: true, signer: fingerprint(key), ownerVerified: !!approvalKey };
  } catch (error) { return { valid: false, reason: error.message }; }
}

function summarizeBundle(bundle) {
  bundle = bundle && typeof bundle === 'object' ? bundle : {};
  const lines = [];
  const release = bundle && bundle.release || {};
  const config = release.config && typeof release.config === 'object' ? release.config : {};
  const lessons = Array.isArray(config.lessons) ? config.lessons : [];
  const sites = Array.isArray(config.sites) ? config.sites : [];
  const auth = bundle.authorization && bundle.authorization.payload || {};
  lines.push(`Complete release bundle ${bundle.hash ? bundle.hash.slice(0, 12) : '?'} exported ${bundle.exportedAt || '?'}, transport signer ${fingerprint(bundle.publicKey) || 'unknown'}`);
  lines.push(`  config ${release.configHash || '?'}; ${lessons.length} lesson(s), ${sites.length} site(s)`);
  lines.push(`  destination ${auth.environment || '?'}, action ${auth.action || '?'}, expected generation ${auth.expectedGeneration ?? '?'}, prior config ${auth.expectedConfigHash || 'none'}`);
  return lines.join('\n');
}

function proposalFromManifestEntry(entry) {
  const urls = Array.isArray(entry.documentUrls) ? entry.documentUrls : [];
  if (!entry.looksLegal || urls.length < 2) return null;
  const tos = urls.find(u => /terms|tos|agreement|conditions|legal/i.test(u)) || urls[0];
  const privacy = urls.find(u => u !== tos && /privacy|notice/i.test(u)) || urls.find(u => u !== tos);
  if (!tos || !privacy) return null;
  const supplemental = urls.filter(u => u !== tos && u !== privacy).slice(0, 5);
  return { domain: entry.domain, tos_url: tos, privacy_url: privacy, supplemental_urls: supplemental, path: entry.path === 'frozen' ? 'unknown' : (entry.path || 'unknown'), source: 'trainer' };
}

function short(hash) {
  return typeof hash === 'string' ? hash.slice(0, 12) : '?';
}

function describeEntry(e) {
  const p = e.payload || {};
  if (e.kind === 'site-promoted' || e.kind === 'site-refreshed') return `${p.urls ? p.urls.tos : ''} + ${p.urls ? p.urls.privacy : ''}${p.evidence ? ` (${p.evidence.trainer ? 'trainer' : `${p.evidence.days} days`})` : ''} until ${p.expiresAt || '?'}`;
  if (e.kind === 'site-imported') return `${p.urls ? p.urls.tos : ''} + ${p.urls ? p.urls.privacy : ''} until ${p.expiresAt || '?'} (roll-out ${p.origin ? short(p.origin.bundleHash) : '?'})`;
  if (e.kind === 'site-rejected') return (p.verification && p.verification.reason) || 'rejected';
  if (e.kind === 'rollout-exported') return `bundle ${short(p.bundleHash)}: ${p.lessons} lesson(s), ${p.sites} site(s)`;
  if (e.kind === 'rollout-applied') return `bundle ${short(p.bundleHash)}: lessons +${p.lessons ? p.lessons.imported : 0}/${p.lessons ? p.lessons.unchanged : 0}, sites +${p.sites ? p.sites.imported : 0}/${p.sites ? p.sites.unchanged : 0}${p.signer ? `, signer ${p.signer}` : ''}`;
  if (e.kind.startsWith('lesson-')) return `${p.id || '?'}${p.target ? ` ${p.target}` : ''}${p.scope && p.scope !== 'all' ? ` ${p.scope}` : ''}${p.from ? ` from ${p.from}` : ''}${p.proof ? ` (proof ${p.proof.proven ? 'proven' : 'not proven'}${p.proof.runId ? `, ${p.proof.runId}` : ''})` : ''}${p.origin ? ` imported from ${short(p.origin.bundleHash)}` : ''}`;
  return p.reason || '';
}

function renderLedger(entries, verification) {
  const lines = [];
  lines.push(`Ledger: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, chain ${verification.valid ? 'verified' : 'BROKEN'}${verification.head ? `, head ${verification.head.slice(0, 12)}` : ''}`);
  const s = verification.signatures;
  if (s && s.checked) lines.push(`Signatures: ${s.valid} valid, ${s.missing} unsigned, ${s.invalid} invalid`);
  for (const error of verification.errors) lines.push(`  ! ${error}`);
  for (const e of entries) lines.push(`  ${String(e.seq).padStart(4)}  ${e.createdAt.slice(0, 10)}  ${e.kind.padEnd(17)} ${(e.domain || '-').padEnd(22)} ${describeEntry(e)}${s && s.checked ? (e.sig ? '' : '  [unsigned]') : ''}`);
  return lines.join('\n');
}

module.exports = { LEDGER_KINDS, BUNDLE_VERSION, RELEASE_VERSION, BUNDLE_PURPOSE, AUTHORIZATION_PURPOSE, canonical, sha256, strictCanonicalJson, releaseConfigHash, releaseLessonsHash, trainerHeaders, hashEntry, normalizePem, verifySignature, fingerprint, verifyLedger, bundleHash, checkBundle, checkAuthorization, checkRelease, fetchRelease, summarizeBundle, proposalFromManifestEntry, renderLedger };
