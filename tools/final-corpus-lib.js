'use strict';

const crypto = require('node:crypto');
const { checkRelease } = require('./sites-lib');
const { DOCUMENT_TYPES } = require('./doctype');
const { parse: parseDomain } = require('../vendor/tldts-7.4.8.umd.min.js');

const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function registrableDomain(value) {
  if (!nonempty(value)) return null;
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    if (url.username || url.password) return null;
    const parsed = parseDomain(url.hostname.toLowerCase().replace(/\.+$/, ''), { allowPrivateDomains: true, detectSpecialUse: true });
    return parsed.isIp || parsed.isSpecialUse || !parsed.domain ? null : parsed.domain.toLowerCase();
  } catch { return null; }
}

// Reject values JSON.stringify would silently discard or coerce. This encoding
// is deliberately separate from the historical Step 1 diagnostic format.
function canonicalJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== 'object' || ancestors.has(value)) throw new Error('finite, acyclic JSON values required');
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('plain JSON objects required');
  if (Object.getOwnPropertySymbols(value).length) throw new Error('symbol keys are not JSON');
  const keys = Object.keys(value);
  if (keys.some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) throw new Error('unsafe JSON key');
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some(d => d.get || d.set)) throw new Error('JSON accessors are not allowed');
  const next = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) throw new Error('dense JSON arrays required');
    return `[${value.map(item => canonicalJson(item, next)).join(',')}]`;
  }
  if (Object.getOwnPropertyNames(value).length !== keys.length) throw new Error('hidden object properties are not JSON');
  return `{${keys.sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key], next)}`).join(',')}}`;
}

function hashText(value) {
  if (typeof value !== 'string') throw new Error('text must be a string');
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
const digest = value => hashText(canonicalJson(value));
function seal(body) {
  if (!object(body) || Object.hasOwn(body, 'hash')) throw new Error('seal requires an object without a hash');
  const copy = JSON.parse(canonicalJson(body));
  return { ...copy, hash: digest(copy) };
}
function bodyHash(value) {
  if (!object(value)) throw new Error('hashed record must be an object');
  canonicalJson(value);
  const { hash, ...body } = value;
  return digest(body);
}
function checkSeal(value, label, reasons) {
  try { if (!isHash(value?.hash) || bodyHash(value) !== value.hash) reasons.push(`${label}: hash mismatch`); }
  catch (error) { reasons.push(`${label}: ${error.message}`); }
}
const organizationKey = value => nonempty(value) ? value.trim().normalize('NFKC').toLowerCase().replace(/\s+/g, ' ') : null;

function validateReleasePair(control, treatment, selectedLessonIds) {
  const reasons = [];
  for (const [name, release] of [['control', control], ['treatment', treatment]]) {
    const check = checkRelease(release);
    if (!check.valid) reasons.push(`${name}: invalid release (${check.reason})`);
  }
  if (!Array.isArray(selectedLessonIds) || selectedLessonIds.length !== 6 || selectedLessonIds.some(id => !nonempty(id)) || new Set(selectedLessonIds).size !== 6) reasons.push('exactly six distinct selected Analyzer lesson IDs required');
  if (reasons.length) return { valid: false, reasons };
  const ca = control.config.lessons.filter(l => l.target === 'analyzer');
  const ta = treatment.config.lessons.filter(l => l.target === 'analyzer');
  if (ca.length !== 0) reasons.push('control must contain no Analyzer lessons');
  if (ta.length !== 6 || canonicalJson(ta.map(l => l.id).sort()) !== canonicalJson([...selectedLessonIds].sort())) reasons.push('treatment must contain exactly the six selected Analyzer lessons');
  const fixed = release => ({ ...release.config, lessons: release.config.lessons.filter(l => l.target !== 'analyzer') });
  if (digest(fixed(control)) !== digest(fixed(treatment))) reasons.push('fixed critic, sites, or runtime policy differ between releases');
  return { valid: !reasons.length, reasons };
}

function validateCorpus(corpus, history) {
  const reasons = [];
  checkSeal(corpus, 'corpus', reasons);
  if (corpus?.v !== 1 || corpus?.kind !== 'step2-final-corpus' || corpus?.purpose !== 'final-evaluation-only' || corpus?.learningAllowed !== false) reasons.push('corpus must be a separate final-evaluation-only corpus with learning disabled');
  if (!object(history) || history.v !== 1 || history.inventoryIncomplete !== false || !Array.isArray(history.sources) || !history.sources.length || history.sources.some(s => !nonempty(s?.path) || !isHash(s?.hash))) reasons.push('historical inventory incomplete: explicit frozen source inventory required');
  try { if (corpus?.historyHash !== digest(history)) reasons.push('corpus historical inventory hash mismatch'); }
  catch (error) { reasons.push(`history: ${error.message}`); }
  for (const key of ['domains', 'organizationIds', 'sourceHashes']) if (!Array.isArray(history?.[key])) reasons.push(`history: missing ${key}`);
  const historyDomains = new Set();
  for (const domain of Array.isArray(history?.domains) ? history.domains : []) {
    const key = registrableDomain(domain);
    if (!key) reasons.push('history: invalid domain'); else historyDomains.add(key);
  }
  const historyOrganizations = new Set();
  for (const organization of Array.isArray(history?.organizationIds) ? history.organizationIds : []) {
    const key = organizationKey(organization);
    if (!key) reasons.push('history: invalid organization'); else historyOrganizations.add(key);
  }
  const historyHashes = new Set(Array.isArray(history?.sourceHashes) ? history.sourceHashes : []);
  if ([...historyHashes].some(h => !isHash(h))) reasons.push('history: invalid source hash');
  const ids = new Set(), domains = new Set(), organizations = new Set(), hashes = new Set();
  if (!Array.isArray(corpus?.sites) || !corpus.sites.length) reasons.push('corpus requires frozen sites');
  for (const site of Array.isArray(corpus?.sites) ? corpus.sites : []) {
    if (!object(site)) { reasons.push('invalid corpus site'); continue; }
    const label = nonempty(site.siteId) ? site.siteId : 'unnamed site';
    const domain = registrableDomain(site.domain);
    const organization = organizationKey(site.organizationId);
    if (!nonempty(site.siteId) || ids.has(site.siteId)) reasons.push(`${label}: missing or duplicate site ID`);
    if (!domain || domain !== site.domain || domains.has(domain)) reasons.push(`${label}: noncanonical or duplicate registrable domain`);
    if (!organization || organizations.has(organization)) reasons.push(`${label}: missing or duplicate organization`);
    if (!DOCUMENT_TYPES.includes(site.docType)) reasons.push(`${label}: invalid document type`);
    if (!nonempty(site.sourceText) || !isHash(site.sourceHash) || (typeof site.sourceText === 'string' && hashText(site.sourceText) !== site.sourceHash) || hashes.has(site.sourceHash)) reasons.push(`${label}: missing, changed, or duplicate source text/hash`);
    const provenance = site.provenance;
    let url;
    try { url = new URL(provenance?.url); } catch { /* Report malformed provenance below. */ }
    if (!url || url.protocol !== 'https:' || url.username || url.password || registrableDomain(url.hostname) !== domain || !nonempty(provenance?.method) || !nonempty(provenance?.capturedAt) || !Number.isFinite(Date.parse(provenance.capturedAt))) reasons.push(`${label}: invalid source provenance`);
    if (historyDomains.has(domain)) reasons.push(`${label}: historical domain contamination`);
    if (historyOrganizations.has(organization)) reasons.push(`${label}: historical organization contamination`);
    if (historyHashes.has(site.sourceHash)) reasons.push(`${label}: historical text hash contamination`);
    ids.add(site.siteId); domains.add(domain); organizations.add(organization); hashes.add(site.sourceHash);
  }
  return { valid: !reasons.length, reasons, siteCount: ids.size, historyCoverage: 'supplied-inventory-only', limitations: ['organization aliases not inferred', 'semantic duplicates not screened', 'external history not inventoried'] };
}

module.exports = { canonicalJson, digest, hashText, seal, bodyHash, checkSeal, isHash, nonempty, organizationKey, validateReleasePair, checkReleasePair: validateReleasePair, validateCorpus };
