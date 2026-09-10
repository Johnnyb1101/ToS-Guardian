'use strict';

const crypto = require('crypto');

const LEDGER_KINDS = Object.freeze(['site-promoted', 'site-refreshed', 'site-rejected', 'halt-set', 'halt-cleared']);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

function hashEntry(entry) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical({ seq: entry.seq, prevHash: entry.prevHash, kind: entry.kind, domain: entry.domain, payload: entry.payload, createdAt: entry.createdAt }))).digest('hex');
}

function verifyLedger(entries) {
  const errors = [];
  let prev = null;
  for (const entry of entries) {
    if (prev && entry.seq !== prev.seq + 1) errors.push(`seq ${entry.seq} does not follow ${prev.seq}`);
    if (prev && entry.prevHash !== prev.hash) errors.push(`seq ${entry.seq} prevHash does not match seq ${prev.seq}`);
    if (!prev && entry.prevHash !== null) errors.push(`seq ${entry.seq} is first but has a prevHash`);
    if (hashEntry(entry) !== entry.hash) errors.push(`seq ${entry.seq} hash does not match its content`);
    if (!LEDGER_KINDS.includes(entry.kind)) errors.push(`seq ${entry.seq} has unknown kind ${entry.kind}`);
    prev = entry;
  }
  return { valid: errors.length === 0, errors, length: entries.length, head: prev ? prev.hash : null };
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

function renderLedger(entries, verification) {
  const lines = [];
  lines.push(`Ledger: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, chain ${verification.valid ? 'verified' : 'BROKEN'}${verification.head ? `, head ${verification.head.slice(0, 12)}` : ''}`);
  for (const error of verification.errors) lines.push(`  ! ${error}`);
  for (const e of entries) {
    const p = e.payload || {};
    const detail = e.kind === 'site-promoted' || e.kind === 'site-refreshed'
      ? `${p.urls ? p.urls.tos : ''} + ${p.urls ? p.urls.privacy : ''}${p.evidence ? ` (${p.evidence.trainer ? 'trainer' : `${p.evidence.days} days`})` : ''} until ${p.expiresAt || '?'}`
      : e.kind === 'site-rejected' ? (p.verification && p.verification.reason) || 'rejected' : (p.reason || '');
    lines.push(`  ${String(e.seq).padStart(4)}  ${e.createdAt.slice(0, 10)}  ${e.kind.padEnd(14)} ${(e.domain || '-').padEnd(22)} ${detail}`);
  }
  return lines.join('\n');
}

module.exports = { LEDGER_KINDS, hashEntry, verifyLedger, proposalFromManifestEntry, renderLedger };
