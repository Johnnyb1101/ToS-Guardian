'use strict';

const crypto = require('crypto');

const LEDGER_KINDS = Object.freeze(['site-promoted', 'site-refreshed', 'site-rejected', 'halt-set', 'halt-cleared', 'lesson-created', 'lesson-canary', 'lesson-promoted', 'lesson-retired', 'lesson-candidate', 'lesson-imported', 'site-imported', 'rollout-exported', 'rollout-applied']);
const BUNDLE_VERSION = 1;

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
  return sha256(body);
}

function checkBundle(bundle, publicKey = null) {
  if (!bundle || typeof bundle !== 'object' || bundle.v !== BUNDLE_VERSION) return { valid: false, reason: 'not a roll-out bundle' };
  if (!Array.isArray(bundle.lessons) || !Array.isArray(bundle.sites)) return { valid: false, reason: 'bundle lacks lessons or sites' };
  if (bundleHash(bundle) !== bundle.hash) return { valid: false, reason: 'bundle hash does not match its content' };
  const key = publicKey || bundle.publicKey;
  if (!verifySignature(key, bundle.hash, bundle.sig)) return { valid: false, reason: publicKey ? 'bundle signature does not verify against the given key' : 'bundle signature does not verify against the key it names' };
  if (publicKey && normalizePem(publicKey) !== normalizePem(bundle.publicKey)) return { valid: false, reason: 'bundle names a different key than the one it verifies against' };
  return { valid: true, signer: fingerprint(key) };
}

function summarizeBundle(bundle) {
  const lines = [];
  lines.push(`Roll-out bundle ${bundle.hash ? bundle.hash.slice(0, 12) : '?'} exported ${bundle.exportedAt || '?'}, signer ${fingerprint(bundle.publicKey) || 'unknown'}, source ledger head ${bundle.head && bundle.head.hash ? `${bundle.head.hash.slice(0, 12)} (seq ${bundle.head.seq})` : 'none'}`);
  lines.push(`  ${bundle.lessons.length} promoted lesson(s):`);
  for (const l of bundle.lessons) lines.push(`    ${l.id}  ${l.target.padEnd(8)} ${(l.scope || 'all').padEnd(10)} ${(l.section || '-').padEnd(15)} ${l.text.slice(0, 80)}${l.text.length > 80 ? '…' : ''}${l.proof && l.proof.runId ? `  (proof ${l.proof.runId})` : ''}`);
  lines.push(`  ${bundle.sites.length} learned site(s):`);
  for (const s of bundle.sites) lines.push(`    ${s.domain.padEnd(24)} ${s.tos_url} + ${s.privacy_url} until ${(s.expires_at || '?').slice(0, 10)}`);
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

module.exports = { LEDGER_KINDS, BUNDLE_VERSION, canonical, sha256, hashEntry, normalizePem, verifySignature, fingerprint, verifyLedger, bundleHash, checkBundle, summarizeBundle, proposalFromManifestEntry, renderLedger };
