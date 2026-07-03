// TOS Guardian — Shared Utilities
// Loaded via manifest.json content_scripts (before content.js),
// popup.html <script> tag (before popup.js),
// and background.js importScripts()

// HTML entity escaping — prevents XSS from AI/cache output rendered via innerHTML (SECURITY-021)
function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// THE single gate for untrusted prose entering generated HTML (SECURITY-021).
// Escape FIRST, then convert markdown **bold** — so the only tag this can ever
// emit is our own <strong> wrapped around already-escaped text. Every body/
// fallback line formatSummary renders goes through here (or plain escapeHtml
// for fragments with no markdown). Guarded by tests/render-security.test.js.
function renderMarkdownLine(text) {
  return escapeHtml(text).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

// Strict shape check for URLs rendered as <a href> (opt-out links, unreadable-
// doc links — both can arrive from the community cache). https only, and no
// quote/angle/space characters ANYWHERE in the URL: escapeHtml already renders
// an embedded quote inert, but rejecting it outright means the output upholds
// the stronger invariant the render-security test enforces — no event-handler
// text inside any tag — without needing entity-decoding rules to prove safety.
// No legitimate opt-out URL contains a quote, so nothing real is lost.
function isRenderableHttpsUrl(url) {
  return typeof url === "string" && /^https:\/\/[^\s"'<>`]+$/.test(url);
}

// --- Registrable-domain (eTLD+1) keying ---
// Cache, acknowledgments and relays all key off the registrable domain so that
// sibling subdomains (www.x.com / login.x.com / oak.x.com) share one cache entry
// and don't double-fire or miss each other's analysis. This is a PRAGMATIC eTLD+1
// derivation, not the full Public Suffix List: it handles plain TLDs plus a curated
// set of common multi-label public suffixes (co.uk, com.au, ...). An unlisted
// multi-label ccTLD degrades to last-two-labels (slightly too broad) — which can
// only ever OVER-share a cache entry, and the 0.95 semantic check + content
// fingerprint will re-analyze if the documents actually differ, so it stays safe.
const MULTI_PART_TLDS = new Set([
  'co.uk','org.uk','gov.uk','ac.uk','me.uk','ltd.uk','plc.uk','net.uk',
  'com.au','net.au','org.au','edu.au','gov.au','id.au',
  'co.nz','net.nz','org.nz','govt.nz',
  'co.jp','or.jp','ne.jp','ac.jp','go.jp',
  'co.kr','or.kr',
  'co.in','net.in','org.in','gen.in','firm.in','ind.in',
  'com.br','net.br','org.br','gov.br',
  'com.mx','com.ar','com.sg','com.hk','com.tw','com.cn','net.cn','org.cn','gov.cn',
  'co.za','org.za','co.il','com.tr','gov.tr',
  'com.es','com.pl','com.ua','co.id','com.my','com.ph','com.vn'
]);

function registrableDomain(host) {
  if (!host) return host;
  let h = String(host).trim().toLowerCase().replace(/\.+$/, '');
  // Tolerate a full URL slipping in instead of a bare hostname.
  if (h.includes('/') || h.includes(':')) {
    try { h = new URL(h.includes('://') ? h : `https://${h}`).hostname.toLowerCase(); }
    catch (e) { h = h.split(/[\/:]/)[0]; }
  }
  if (!h) return h;
  // Leave IP literals (incl. bracketed IPv6) untouched.
  if (h.startsWith('[') || /^[0-9.]+$/.test(h)) return h;
  const labels = h.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_PART_TLDS.has(lastTwo)) return labels.slice(-3).join('.');
  return lastTwo;
}

// Acknowledgments ("Accept Risk and Continue") expire after this window so a one-time
// accept doesn't suppress the overlay forever — after it, the site is re-shown/re-
// analyzed, catching policy changes the user never re-reviewed. Acks are stored with a
// timestamp; this is the read-side TTL gate (a legacy non-numeric value reads as stale).
const ACK_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function isAckFresh(ackTime, now = Date.now()) {
  return typeof ackTime === "number" && (now - ackTime) < ACK_TTL_MS;
}

// Coordinate concurrent calls so identical in-flight work runs only once (FIXPLAN
// #13b). Returns run(key, fn, onJoin): if a promise is already in flight for `key`,
// returns that same promise (and calls onJoin(key) so the caller can log the join);
// otherwise starts fn(), tracks it until it settles, then frees the slot. A null
// key always runs independently. The settle handler only frees the slot if it's
// still the one it started — so a later run that replaced it isn't clobbered.
function createInFlightDeduper() {
  const inFlight = new Map();
  const start = (fn) => { try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e); } };
  return function run(key, fn, onJoin) {
    if (key == null) return start(fn);
    const existing = inFlight.get(key);
    if (existing) {
      if (onJoin) onJoin(key);
      return existing;
    }
    const promise = start(fn);
    inFlight.set(key, promise);
    promise.finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
    return promise;
  };
}

function isLikelyResourcePageUrl(url) {
  return /(?:^|[\/_-])(makingcents|blog|article|faq|tips|guide|learn|how-to|security-tips)(?:[\/_-]|$)/i.test(url || "");
}

// True for static-asset URLs that can never be a legal document — compiled JS/CSS
// bundles, source maps, images, fonts, data files. A JS bundle is sometimes linked as
// a "terms" drawer (Acorns oak.acorns.com: terms-and-conditions-drawer-*.js) and must
// never be fetched as a candidate. NOTE: .pdf is deliberately NOT excluded — the proxy
// extracts PDF text. (FIXPLAN #8)
function isAssetUrl(url) {
  if (!url) return false;
  let path = String(url);
  try { path = new URL(url, "https://x.invalid").pathname; } catch (e) { path = String(url).split(/[?#]/)[0]; }
  return /\.(js|mjs|cjs|css|map|json|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot|otf|mp4|webm|zip)$/i.test(path);
}

// Heuristic: does fetched text look like an actual legal/privacy document rather
// than navigation chrome or an unrendered SPA shell? The fetcher uses this to keep
// waiting for / preferring real policy content over a page skeleton. Pairs with
// the evaluator's retrieval-failure check as defense in depth: this reduces how
// often we analyze nav chrome; the evaluator catches it when we still do.
function looksLikeLegalDocument(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.toLowerCase();
  const indicators = [
    "personal information", "personal data", "we collect", "information we collect",
    "third part", "you agree", "your information", "data protection", "privacy policy",
    "terms of service", "terms of use", "terms and conditions", "we may share",
    "we use your", "cookies", "opt out", "opt-out", "your rights", "consent",
    "liability", "warrant", "indemnif", "governing law", "arbitration", "retention",
    "we process", "disclose", "applicable law", "our services"
  ];
  const hits = indicators.filter(k => t.includes(k)).length;
  // Substantial text with several legal markers, OR a high marker count outright.
  return (text.length >= 2000 && hits >= 4) || hits >= 7;
}

// Visible-text patterns for a link that points to the FULL document of a given
// kind (as opposed to a marketing/section link). Used to follow a legal "hub".
const FULL_DOC_LINK_PATTERNS = {
  privacy: /\b(online |consumer |full |complete |general |website )?privacy (policy|notice|statement)\b/i,
  tos: /\b(terms of (service|use)|terms (and|&) conditions|user agreement|cardholder agreement|membership agreement|deposit account agreement|account agreement)\b/i
};

// Qualifier words that mark a NARROW/jurisdiction-specific variant (e.g. the
// California or workplace notice) rather than the general policy. Only followed
// when no general document link exists.
const NARROW_LEGAL_QUALIFIERS = /\b(california|ccpa|cpra|nevada|virginia|colorado|workplace|employee|job applicant|recruit|children|kids|coppa|cookie|ad ?choices|advertising|health|hipaa|glba)\b/i;

// COMPLEMENTARY privacy notices that ADD coverage beyond the main policy — the
// canonical extra documents a single site splits its disclosures across. Used to
// gather supplemental notices (combine-then-summarize), NOT to find the main doc.
// Deliberately targeted so we never pull a second copy of the main "privacy policy".
const SUPPLEMENTAL_PRIVACY_LINK_PATTERNS = [
  // GLBA / financial "Consumer Privacy" notice — carries the canonical sharing
  // table ("Reasons we can share / Does X share? / Can you limit?").
  /\bconsumer privacy (policy|notice|disclosure)\b/i,
  /\b(glba|gramm[- ]?leach[- ]?bliley)\b/i,
  /\bfinancial privacy (notice|policy|disclosure)\b/i,
  /\bwhat do(es)? .{0,40} do with your personal information\b/i,
  // State consumer-rights notices.
  /\b(ccpa|cpra)\b/i,
  /\bcalifornia (consumer )?privacy( rights| notice| policy| statement)?\b/i,
  /\byour (california )?privacy (rights|choices)\b/i,
  /\bstate[- ]?(specific )?privacy (notice|rights|disclosures?)\b/i
];
// Highest-value supplement: the financial/GLBA consumer notice (the sharing grid).
const FINANCIAL_PRIVACY_LINK = /\b(consumer privacy|glba|gramm|financial privacy|what do(es)? .{0,40} do with your personal information)\b/i;
// State consumer-rights notices — classified BEFORE the financial notice so that
// "California Consumer Privacy Notice" isn't mistaken for the GLBA one (it contains
// the substring "consumer privacy").
const STATE_PRIVACY_LINK = /\b(california|ccpa|cpra|nevada|virginia|colorado|texas|state[- ]?specific|state privacy)\b/i;

// Scan a page's anchors for links whose visible text satisfies `textMatches`,
// returning [{ url, text, pathname }] with all the safety filtering applied:
// https only, same registrable host (no off-site jumps), no self-loop, dedupe,
// and skipping blog/FAQ resource pages. Shared by the hub-follow and supplemental
// gatherers. Security: callers MUST still pass each url through validateDocumentUrl
// before fetching, since hrefs come from page HTML.
function scanLegalAnchors(html, baseUrl, textMatches) {
  if (!html || typeof html !== 'string') return [];
  let base;
  try { base = new URL(baseUrl); } catch (e) { return []; }
  const baseHref = base.href.replace(/#.*$/, '');
  const baseRoot = base.hostname.replace(/^www\./, '');

  const anchors = [...html.matchAll(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const seen = new Set();
  const out = [];

  for (const m of anchors) {
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text || !textMatches(text)) continue;

    let abs;
    try { abs = new URL(m[1], base); } catch (e) { continue; }
    if (abs.protocol !== 'https:') continue;
    if (abs.hostname.replace(/^www\./, '') !== baseRoot) continue; // same host only
    const cleanHref = abs.href.replace(/#.*$/, '');
    if (cleanHref === baseHref) continue;            // no self-loop
    if (isLikelyResourcePageUrl(cleanHref)) continue; // skip blog/FAQ/etc.
    if (seen.has(cleanHref)) continue;
    seen.add(cleanHref);

    out.push({ url: cleanHref, text, pathname: abs.pathname });
  }
  return out;
}

// Banks, credit unions, and insurers commonly land you on a "Privacy & Security"
// HUB page that merely LINKS to the real policy documents instead of containing
// them. Given such a page's HTML, return the best deeper link to the actual full
// document for `kind` ('privacy' | 'tos'), resolved absolute against baseUrl — or
// null if none. Pure/synchronous so it is unit-testable; the caller fetches it.
function extractDeeperLegalLink(html, baseUrl, kind = 'privacy') {
  const pattern = FULL_DOC_LINK_PATTERNS[kind] || FULL_DOC_LINK_PATTERNS.privacy;
  const links = scanLegalAnchors(html, baseUrl, t => pattern.test(t));
  if (links.length === 0) return null;

  const scored = links.map(l => {
    const narrow = NARROW_LEGAL_QUALIFIERS.test(l.text) || NARROW_LEGAL_QUALIFIERS.test(l.pathname);
    const isPdf = /\.pdf($|\?)/i.test(l.pathname);
    // Prefer the general document over a jurisdiction-specific one, an HTML page
    // over a PDF (scanned PDFs often can't be extracted), the bare document name
    // over long marketing text, and a legal-looking path.
    let score = 0;
    if (!narrow) score += 100;
    if (!isPdf) score += 20;
    if (l.text.length <= 45) score += 10;
    if (/\/(privacy|policy|policies|legal|terms)/i.test(l.pathname)) score += 5;
    return { url: l.url, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].url;
}

// Gather up to `limit` COMPLEMENTARY privacy notices linked from a page (the
// GLBA/Consumer financial notice and any state/CCPA notices) so their text can be
// combined with the main policy for one unified analysis (combine-then-summarize).
// `exclude` holds urls already fetched (e.g. the primary policy) so we don't
// double-count. Returns absolute urls, highest-value first. Security: caller MUST
// still validateDocumentUrl each url before fetching.
// Build a normalization KEY (not a fetchable url) for comparing two supplemental
// links: lowercase host with a leading www. stripped (mirrors baseRoot above),
// trailing slash removed, and hash + query dropped. Legal notices are not
// query-parameterized, so this safely collapses www/apex, trailing-slash, and
// tracking-param variants that otherwise survive scanLegalAnchors' exact-href
// dedupe and would waste a fetch + one of the two reserved supplemental slots.
function supplementalDedupeKey(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const path = u.pathname.replace(/\/+$/, '');
    return host + path;
  } catch (e) {
    return (rawUrl || '').toLowerCase();
  }
}

function extractSupplementalPrivacyLinks(html, baseUrl, { exclude = [], limit = 2 } = {}) {
  const excludeSet = new Set((exclude || []).map(supplementalDedupeKey));
  const links = scanLegalAnchors(html, baseUrl, t => SUPPLEMENTAL_PRIVACY_LINK_PATTERNS.some(re => re.test(t)))
    .filter(l => !excludeSet.has(supplementalDedupeKey(l.url)));
  if (links.length === 0) return [];

  const scored = links.map(l => {
    const isState = STATE_PRIVACY_LINK.test(l.text) || STATE_PRIVACY_LINK.test(l.pathname);
    const isFinancial = FINANCIAL_PRIVACY_LINK.test(l.text) || FINANCIAL_PRIVACY_LINK.test(l.pathname);
    let score = 0;
    // The financial/GLBA consumer notice carries the sharing grid — most valuable.
    // Classify state FIRST so a "California Consumer Privacy" notice isn't scored
    // as the GLBA one just because it contains the words "consumer privacy".
    if (isState) score += 20;
    else if (isFinancial) score += 50;
    else score += 20;
    if (!/\.pdf($|\?)/i.test(l.pathname)) score += 5; // readable HTML slightly preferred
    return { url: l.url, score };
  });
  scored.sort((a, b) => b.score - a.score);
  // Drop equivalents (same notice via trailing-slash/www/query variants) before
  // the cap, keeping the highest-scored occurrence, so the two slots always hold
  // two genuinely distinct notices.
  const seenKeys = new Set();
  const deduped = [];
  for (const s of scored) {
    const key = supplementalDedupeKey(s.url);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    deduped.push(s.url);
  }
  return deduped.slice(0, limit);
}

// Remove evaluator-chrome markup (verdict badge / warning divs, and the textual
// "Analysis confidence:" line) that the analyzer LLM may have echoed from
// attacker-controlled document text. The genuine verdict is composed by the
// orchestrator AFTER this strip, so the analyzer can never contribute a trust
// badge to the rendered output. (SECURITY-022 — output-render verdict spoofing)
function stripEvalChrome(text) {
  if (!text) return "";
  return text
    .replace(/<div\s+class="tg-eval-(?:badge|warning)\b[^"]*"[^>]*>[\s\S]*?<\/div>/gi, "")
    .replace(/^[^\n]*Analysis confidence\s*:[^\n]*$/gim, "")
    .trim();
}

// Allowed risk verdicts. 'Unknown' is the trusted fallback used when the
// document couldn't be assessed — it is never proposed by the model.
const RISK_LEVELS = ['Low', 'Moderate', 'High'];

// Pull the analyzer's PROPOSED one-line bottom line and risk word out of its
// 🧭 BOTTOM LINE / 🧭 RISK LEVEL blocks (run after normalizeAnalysisHeaders so the
// markers are canonical). These are only proposals — the orchestrator validates
// the risk against RISK_LEVELS and gates it by analysis confidence before it is
// ever shown, so a poisoned document can't force a reassuring verdict.
function extractAnalyzerHeadline(summary) {
  if (!summary) return { bottomLine: null, risk: null };
  const NEXT_MARKER = /🧭|📥|🔴|📋|🟡|🟢/;

  const blockAfter = (label) => {
    const idx = summary.indexOf(label);
    if (idx === -1) return null;
    const after = summary.slice(idx + label.length);
    const endRel = after.search(NEXT_MARKER);
    return (endRel === -1 ? after : after.slice(0, endRel));
  };

  const blBlock = blockAfter('🧭 BOTTOM LINE');
  let bottomLine = blBlock ? (blBlock.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim() || null) : null;

  // Fallback: some models (notably Sonnet) occasionally drop the "🧭 BOTTOM LINE"
  // label and just write the sentence first. Recover it from the leading text
  // before the first 🧭/section marker so the overlay still gets a top summary.
  if (!bottomLine) {
    const firstMarker = summary.search(NEXT_MARKER);
    const lead = firstMarker === -1 ? '' : summary.slice(0, firstMarker);
    const cleaned = lead.replace(/<[^>]+>/g, '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
    if (cleaned && cleaned.length <= 320) bottomLine = cleaned;
  }

  let risk = null;
  const rlBlock = blockAfter('🧭 RISK LEVEL');
  if (rlBlock) {
    const m = rlBlock.match(/\b(low|moderate|high)\b/i);
    if (m) risk = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  }

  return { bottomLine, risk };
}

// Remove the headline blocks (🧭 BOTTOM LINE / RISK LEVEL) AND any echoed
// tg-risk / tg-bottomline markup from a body of text. Mirrors stripEvalChrome:
// the genuine bottom line + risk badge are composed by the orchestrator as
// trusted chrome, so the body the model produced must never contribute its own.
function stripHeadlineChrome(text) {
  if (!text) return "";
  return text
    .replace(/<div\s+class="tg-(?:risk|bottomline)\b[^"]*"[^>]*>[\s\S]*?<\/div>/gi, "")
    .replace(/🧭\s*BOTTOM LINE[\s\S]*?(?=[🧭🔴📋🟡🟢]|$)/gi, "")
    .replace(/🧭\s*RISK LEVEL[\s\S]*?(?=[🧭🔴📋🟡🟢]|$)/gi, "")
    // Any prose still left BEFORE the first section header is headline residue —
    // e.g. a bottom-line sentence the model wrote without its "🧭 BOTTOM LINE"
    // label. The trusted bottom line is recomposed by the orchestrator, so this
    // leftover must not leak into the body. (Only fires when a section marker
    // exists, so config/error messages with no sections are left intact.)
    .replace(/^[\s\S]*?(?=📥|🔴|📋|🟡|🟢)/, "")
    .trim();
}

function stripInjectionWarning(text) {
  if (!text) return "";
  return text
    .replace(/^[^\n]*Possible injection attempt detected[^\n]*$/gim, "")
    .replace(/^(?:Quick note|Note):\s*I (?:didn't|did not) (?:spot|find) any actual injection attempts?[^\n]*(?:\n|$)/gim, "")
    .trim();
}

// RENDERING RULE (SECURITY-021): `raw`, `optOutLinks`, and `unreadableDocs` are
// all UNTRUSTED (AI output that may echo attacker document text; community-cache
// entries). Every ${...} interpolated into HTML below must be one of:
//   (a) escapeHtml(...) / renderMarkdownLine(...) output,
//   (b) a constant or whitelist-validated token (e.g. riskClass, panelId),
//   (c) HTML previously built under rules (a)/(b).
// Never interpolate a raw variable. tests/render-security.test.js audits the
// output (allowed tags only, no event handlers, https-only hrefs) — run it
// after any change to this function.
function formatSummary(raw, optOutLinks = [], unreadableDocs = []) {
  if (!raw) return "";

  // Drop the cache-schema + content-fingerprint stamps (invisible markers) so
  // they never render.
  raw = raw.replace(/<!--\s*tg-schema:\d+\s*-->/g, "");
  raw = raw.replace(/<!--\s*tg-fp:[0-9a-f]+\s*-->/gi, "");

  let injectionWarning = "";
  const injectionPattern = /⚠️\s*Possible injection attempt detected in document[^\n]*/i;
  const injectionMatch = raw.match(injectionPattern);
  if (injectionMatch) {
    injectionWarning = `
      <div style="margin:8px 20px 0; padding:8px 12px; background:#fff4ed;
                  border:1px solid #f5c6a0; border-left:3px solid #e8590c; border-radius:8px;
                  font-size:12px; line-height:1.5; color:#9a3412;">
        🚨 ${escapeHtml(injectionMatch[0].replace(/^⚠️\s*/i, "").trim())}
      </div>`;
    raw = raw.replace(injectionMatch[0], "").trim();
  }

  let evalWarning = "";

  // Trusted chrome (eval warning/badge, bottom line, risk) is composed LAST by the
  // orchestrator. An attacker-echoed copy would appear EARLIER in the blob, so for
  // each we deliberately take the LAST match, rebuild it from escaped text, then
  // strip ALL such chrome from the body so no forged copy can leak into the output.
  // (SECURITY-022 — output-render verdict spoofing; see also SECURITY-021)
  const lastMatch = (re) => { const m = [...raw.matchAll(re)]; return m.length ? m[m.length - 1] : null; };
  const warningMatch = raw.match(/<div class="tg-eval-warning"[^>]*>(.*?)<\/div>/s);
  const badgeMatch   = lastMatch(/<div class="tg-eval-badge\s+(tg-eval-\w+)"[^>]*>(.*?)<\/div>/gs);
  const riskMatch    = lastMatch(/<div class="tg-risk\s+(tg-risk-\w+)"[^>]*>(.*?)<\/div>/gs);
  const bottomMatch  = lastMatch(/<div class="tg-bottomline"[^>]*>(.*?)<\/div>/gs);

  if (warningMatch) {
    evalWarning = `<div class="tg-eval-warning">${escapeHtml(warningMatch[1].replace(/<[^>]+>/g, '').trim())}</div>`;
  }

  // Confidence — demoted to muted small print (it measures how sure we are of the
  // READING, not how safe the site is, so it must not look like the headline verdict).
  let confidenceNote = "";
  if (badgeMatch) {
    confidenceNote = `<div class="tg-confidence-note">${escapeHtml(badgeMatch[2].replace(/<[^>]+>/g, '').trim())}</div>`;
  }

  // The bottom line — one plain sentence, shown first and prominently.
  let bottomLineHtml = "";
  if (bottomMatch) {
    const text = escapeHtml(bottomMatch[1].replace(/<[^>]+>/g, '').trim());
    if (text) bottomLineHtml = `<div class="tg-bottomline">${text}</div>`;
  }

  // The risk verdict — the loud, prominent signal. Label is derived from the
  // validated class (not echoed text) so wording is always ours.
  let riskHtml = "";
  if (riskMatch) {
    const riskClass = /^tg-risk-(low|moderate|high|unknown)$/.test(riskMatch[1]) ? riskMatch[1] : 'tg-risk-unknown';
    const riskLabels = {
      'tg-risk-low': '✓ Low concern',
      'tg-risk-moderate': '⚠️ Moderate concern',
      'tg-risk-high': '⚠️ High concern',
      'tg-risk-unknown': "❓ Couldn't assess — read it yourself"
    };
    riskHtml = `<div class="tg-risk ${riskClass}">${riskLabels[riskClass]}</div>`;
  }

  // Strip every trusted-chrome div from the body so none render inline or twice.
  raw = stripHeadlineChrome(stripEvalChrome(raw));

  const categoryMarkers = ["📥", "🔴", "📋", "🟡", "🟢"];
  const lines = raw.split("\n").map(l => l.trim()).filter(l => l !== "" && l !== "•");

  // Build opt-out links HTML once — shown up top (visible), since it's actionable.
  const validLinks = (optOutLinks || [])
    .map(url => url ? url.trim().replace(/\s+/g, '') : '')
    .filter(isRenderableHttpsUrl);
  const optOutHtml = validLinks.length > 0 ? `
    <div class="tg-optout-links">
      <div class="tg-optout-title">Opt-Out Links Found</div>
      ${validLinks.map(url => `<a class="tg-optout-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`).join("")}
    </div>` : "";

  // Documents we couldn't read (scanned/image-based PDFs) — shown honestly so the
  // user knows an important doc was skipped and can open it directly. (Honesty signal)
  const unreadableLinks = (unreadableDocs || [])
    .map(url => url ? url.trim().replace(/\s+/g, '') : '')
    .filter(isRenderableHttpsUrl);
  const unreadableHtml = unreadableLinks.length > 0 ? `
    <div class="tg-unreadable-docs">
      <div class="tg-unreadable-title">⚠️ Couldn't read ${unreadableLinks.length === 1 ? 'this document' : 'these documents'} (likely a scanned/image PDF) — open ${unreadableLinks.length === 1 ? 'it' : 'them'} directly:</div>
      ${unreadableLinks.map(url => `<a class="tg-unreadable-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`).join("")}
    </div>` : "";

  // The detailed sections are collected as {title, bodyLines} then rendered in a
  // FIXED canonical order (knownHeaders) regardless of the order the analyzer emitted
  // them, so WHAT THEY COLLECT always leads. (FIXPLAN #9 — Coinbase rendered it last.)
  const collected = [];
  let currentTitle = "";
  let currentBody  = [];

  const flush = () => {
    if (!currentTitle) return;
    // NOTE: bodyLines stay UNESCAPED plain text here — escaping happens at the
    // single point where they are interpolated into HTML (renderMarkdownLine in
    // the details render below), so text-vs-markup can never get confused by a
    // step added between cleanup and render. (SECURITY-021 centralization)
    const bodyLines = currentBody
      .map(l => l
        .replace(/^•\s*/, "")
        // Strip a leading markdown bullet marker ("- " / "* ") the analyzer emits.
        // Requires trailing whitespace so it never eats the "**" of a bold lead.
        .replace(/^[-*]\s+/, "")
        .replace(/\|[-\s|]+\|/g, '')
        .replace(/^\|\s*/g, '')
        .replace(/\s*\|$/g, '')
        .replace(/\s*\|\s*/g, ' — ')
        .trim())
      .filter(l => l !== "" && l !== "---" && l !== "—"
        && !l.match(/^It.s your right to/i)
        // Drop lines that are only punctuation / bullet / table chrome — e.g. a stray
        // "." the analyzer sometimes emits as a section body. (Empty-card fix)
        && !/^[.\-—•*\s|]+$/.test(l));

    // Auto-Renewal & Billing is HIDDEN when it carries no actual charge concern —
    // on privacy-heavy sites it's almost always "No automatic charges mentioned" /
    // "Not covered", which is dead weight. It still renders when there IS a charge
    // to warn about (subscription/streaming signups). Other "Not covered" sections
    // are deliberately kept — an absent deletion/opt-out right is itself meaningful.
    if (currentTitle === '🟡 AUTO-RENEWAL & BILLING') {
      const plain = currentBody.join(' ').toLowerCase();
      const noConcern = bodyLines.length === 0 ||
        /\b(no automatic charges|not covered|not mentioned|not applicable|none mentioned|no auto[- ]?renew|does not (auto[- ]?renew|charge))\b/.test(plain);
      if (noConcern) {
        currentBody = [];
        currentTitle = "";
        return;
      }
    }

    // A header the analyzer emitted with no real body (after the punctuation/junk
    // filter above) is not a section — skip it so it can't render as an empty card
    // or a hollow duplicate of the real one. (Empty/duplicate OPT-OUT RIGHTS fix)
    if (bodyLines.length === 0) {
      currentBody = [];
      currentTitle = "";
      return;
    }

    // De-dupe by canonical title: if the analyzer emitted the same section twice
    // (e.g. an empty OPT-OUT RIGHTS then the real one), merge the bullets into the
    // existing card instead of rendering two cards with the same heading.
    const existing = collected.find(c => c.title === currentTitle);
    if (existing) {
      existing.bodyLines.push(...bodyLines);
    } else {
      collected.push({ title: currentTitle, bodyLines });
    }

    currentBody = [];
    currentTitle = "";
  };

  const knownHeaders = [
    '📥 WHAT THEY COLLECT',
    '🔴 DATA SELLING & SHARING',
    '🔴 OPT-OUT RIGHTS',
    '📋 HOW TO OPT OUT RIGHT NOW',
    '🟡 AUTO-RENEWAL & BILLING',
    '🟢 DATA DELETION RIGHTS'
  ];

  for (const line of lines) {
    const cleanLine = line.replace(/^#+\s*/, '');
    if (categoryMarkers.some(m => cleanLine.startsWith(m))) {
      flush();
      const headerText = (h) => { const i = h.search(/[A-Z]/i); return i >= 0 ? h.slice(i) : h; };
      const matchedHeader = knownHeaders.find(h => cleanLine.startsWith(h) || cleanLine.toUpperCase().includes(headerText(h).toUpperCase()));
      if (matchedHeader) {
        currentTitle = matchedHeader;
        const remainder = cleanLine.slice(matchedHeader.length).replace(/^[:\s-]+/, '').trim();
        if (remainder) currentBody.push(remainder);
      } else {
        currentTitle = cleanLine;
      }
    }
    else if (cleanLine && cleanLine !== '---') { currentBody.push(cleanLine); }
  }
  flush();

  // Render sections in canonical knownHeaders order (stable sort keeps any unknown
  // section in its original spot, after the known ones). (FIXPLAN #9)
  const sectionOrder = (title) => {
    const i = knownHeaders.indexOf(title);
    return i === -1 ? knownHeaders.length : i;
  };
  collected.sort((a, b) => sectionOrder(a.title) - sectionOrder(b.title));

  // Show only the first (most important) bullet by default; the rest live in a
  // per-section "Show more" panel. (Per-section progressive disclosure.)
  const details = collected
    .map((sec, idx) => {
      const [mainLine, ...restLines] = sec.bodyLines;
      let bodyHtml = `<p style="margin:0 0 6px 0;">${renderMarkdownLine(mainLine)}</p>`;
      if (restLines.length > 0) {
        const panelId = `tg-more-${idx}`;
        bodyHtml += `<div class="tg-more" id="${panelId}">` +
          restLines.map(l => `<p style="margin:0 0 6px 0;">${renderMarkdownLine(l)}</p>`).join("") +
          `</div>`;
        bodyHtml += `<button class="tg-more-toggle" type="button" data-target="${panelId}">Show more ▾</button>`;
      }
      return `
        <div class="tg-category">
          <span class="tg-category-title">${escapeHtml(sec.title)}</span>
          <div class="tg-category-body">${bodyHtml}</div>
        </div>`;
    })
    .join("");
  const renderedSections = collected.length;

  // No recognized sections (e.g. a configuration/error/timeout message). This must
  // stay VISIBLE, not be tucked behind the collapse toggle.
  let fallback = "";
  if (renderedSections === 0 && lines.length > 0) {
    const bodyHtml = lines
      .map(line => `<p style="margin:0 0 6px 0;">${escapeHtml(line)}</p>`)
      .join("");
    fallback = `
      <div class="tg-category">
        <span class="tg-category-title">TOS Guardian</span>
        <div class="tg-category-body">${bodyHtml}</div>
      </div>`;
  }

  // --- Assemble: TL;DR head, then the sections (each shows one main point with
  // its own per-section "Show more"). ---
  // Head: injection warning, bottom line, risk, any failure warning, opt-out
  // links, any no-sections fallback message — then the section cards.
  let html = injectionWarning + bottomLineHtml + riskHtml + evalWarning + unreadableHtml + optOutHtml + fallback + details;

  // Confidence small print + AI disclaimer (disclaimer required per ESCALATION-005).
  html += confidenceNote;
  html += `<div style="margin:12px 20px 14px; padding-top:10px; border-top:1px solid #f0f0f0;
              font-size:11px; color:#999; text-align:center;">
    AI analysis may not be 100% accurate. Always review documents yourself for important decisions.
  </div>`;

  return html;
}

// Cache schema version. BUMP THIS whenever a change should retire previously
// cached analyses — a new/renamed section, a scoring/verdict fix, or any change
// to what gets BAKED INTO a stored summary (things derived at render time, like
// section formatting, auto-heal on read and do NOT need a bump). The orchestrator
// stamps every fresh analysis with this version (an invisible HTML comment inside
// the summary) and treats any cached entry below it as a MISS → re-analyze. Cost
// is one re-analysis per domain after a bump (then it carries the new version).
// v2 (2026-06-11): cache entries now carry a content fingerprint (tg-fp). Bumping
// from 1 flushes every legacy/unstamped entry once so each domain re-analyzes and
// is rewritten with a fingerprint (and any lingering bug-window entries retire).
const CACHE_SCHEMA_VERSION = 2;

// Read the schema version stamped into a stored summary (0 if unstamped/legacy).
function cacheSchemaVersion(summary) {
  const m = /<!--\s*tg-schema:(\d+)\s*-->/.exec(summary || '');
  return m ? parseInt(m[1], 10) : 0;
}

// The trusted chrome the orchestrator appends so a fresh analysis is stamped as
// current before it's cached. Appended once at write time.
function cacheSchemaStamp() {
  return `<!--tg-schema:${CACHE_SCHEMA_VERSION}-->`;
}

// A cached summary is current only if its stamped version is at least the current
// one. Anything older (or unstamped) is treated as a cache MISS so it refreshes
// instead of rendering stale until the 15-day TTL expires.
function isCurrentSchemaSummary(summary) {
  if (!summary || typeof summary !== 'string') return false;
  return cacheSchemaVersion(summary) >= CACHE_SCHEMA_VERSION;
}

// --- Content fingerprint (cache freshness / change detection) -------------
//
// A deterministic, full-doc-set fingerprint of the SOURCE documents we analyzed
// (the combined "=== TERMS === / === PRIVACY === / === SUPPLEMENTAL ===" text).
// Stamped into the cached summary at write time and recomputed from the live
// fetched documents on read; a mismatch means the documents materially changed,
// so we re-analyze instead of serving a stale summary.
//
// This is the real change-detector — it covers the WHOLE set (the old pgvector
// 0.95 check only "saw" the first ~256 tokens of the privacy section, excluding
// the ToS and supplementals entirely). It is normalized so that trivial edits
// (revision dates, whitespace/reflow, cache-busting supplemental URLs) do NOT
// flip it; a genuine wording change does.

// Strip volatile boilerplate and collapse formatting so cosmetic edits don't
// change the fingerprint.
function normalizeForFingerprint(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .toLowerCase()
    // Collapse the supplemental-notice URL (can carry session/cache-bust params)
    // down to the bare marker, so a changing URL alone doesn't flip the hash.
    .replace(/===\s*supplemental privacy notice:[^\n]*===/g, '=== supplemental privacy notice ===')
    // Revision/effective dates ("last updated: January 1, 2026", etc.)
    .replace(/\b(?:last\s+updated|last\s+modified|effective|revised|modified|as\s+of|updated)\b\s*:?\s*(?:on\s+)?[a-z0-9 ,\/\-]{0,24}/g, ' ')
    // Standalone dates: Month DD, YYYY / MM/DD/YYYY / YYYY-MM-DD
    .replace(/\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+\d{4}\b/g, ' ')
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    // Copyright years and page markers
    .replace(/(?:©|\(c\)|copyright)\s*\d{4}(?:\s*[-–]\s*\d{4})?/g, ' ')
    .replace(/\bpage\s+\d+\s+of\s+\d+\b/g, ' ')
    // Collapse all whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

// FNV-1a 32-bit hash → hex. Synchronous, dependency-free, deterministic.
function contentFingerprint(text) {
  const normalized = normalizeForFingerprint(text);
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts, kept in unsigned 32-bit range.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// The invisible stamp appended to a fresh summary so later reads can compare.
function contentFingerprintStamp(text) {
  return `<!--tg-fp:${contentFingerprint(text)}-->`;
}

// Extract the stamped fingerprint from a cached summary (null if absent/legacy).
function cachedContentFingerprint(summary) {
  const m = /<!--\s*tg-fp:([0-9a-f]+)\s*-->/i.exec(summary || '');
  return m ? m[1] : null;
}

// True only if the cached summary's stamped fingerprint matches the live docs.
// Absent stamp → false (forces a refresh that adds one).
function contentFingerprintMatches(summary, liveText) {
  const stamped = cachedContentFingerprint(summary);
  if (!stamped) return false;
  return stamped === contentFingerprint(liveText);
}

function normalizeAnalysisHeaders(summary) {
  const headerMap = [
    { pattern: /[🧭🔴📋🟡🟢]*\s*\*{0,2}\s*[🧭]*\s*\*{0,2}\s*BOTTOM LINE\s*\*{0,2}/gi, replacement: '🧭 BOTTOM LINE' },
    { pattern: /[🧭🔴📋🟡🟢]*\s*\*{0,2}\s*[🧭]*\s*\*{0,2}\s*RISK LEVEL\s*\*{0,2}/gi, replacement: '🧭 RISK LEVEL' },
    // Only the header-shaped phrasing ("WHAT THEY/WE [DATA] COLLECT") — deliberately
    // NOT the bare "information/data we collect", which appears constantly in body
    // prose and would be corrupted into a header.
    { pattern: /[🔴📋🟡🟢📥]*\s*\*{0,2}\s*[🔴📋🟡🟢📥]*\s*\*{0,2}\s*WHAT\s+(DATA\s+)?(THEY|WE)\s+COLLECT\s*\*{0,2}/gi, replacement: '📥 WHAT THEY COLLECT' },
    { pattern: /[🔴📋🟡🟢]*\s*\*{0,2}\s*[🔴📋🟡🟢]*\s*\*{0,2}\s*DATA\s+(SELLING|SHARING)\s*(?:&|and)\s*SHARING\s*\*{0,2}/gi, replacement: '🔴 DATA SELLING & SHARING' },
    { pattern: /[🔴📋🟡🟢]*\s*\*{0,2}\s*[🔴📋🟡🟢]*\s*\*{0,2}\s*OPT[- ]?OUT RIGHTS\s*\*{0,2}/gi, replacement: '🔴 OPT-OUT RIGHTS' },
    { pattern: /[🔴📋🟡🟢]*\s*\*{0,2}\s*[🔴📋🟡🟢]*\s*\*{0,2}\s*HOW TO OPT OUT RIGHT NOW\s*\*{0,2}/gi, replacement: '📋 HOW TO OPT OUT RIGHT NOW' },
    { pattern: /[🔴📋🟡🟢]*\s*\*{0,2}\s*[🔴📋🟡🟢]*\s*\*{0,2}\s*AUTO[- ]?RENEWAL\s*[&]\s*BILLING\s*\*{0,2}/gi, replacement: '🟡 AUTO-RENEWAL & BILLING' },
    { pattern: /[🔴📋🟡🟢]*\s*\*{0,2}\s*[🔴📋🟡🟢]*\s*\*{0,2}\s*DATA DELETION RIGHTS\s*\*{0,2}/gi, replacement: '🟢 DATA DELETION RIGHTS' }
  ];

  let normalized = summary;
  for (const { pattern, replacement } of headerMap) {
    normalized = normalized.replace(pattern, '\n' + replacement + '\n');
  }
  return normalized.trim();
}

// Central URL validation gate — ALL outbound document fetches pass through here (SECURITY-020)
// Used by: Fetcher (hidden tabs, proxy), Link Follower, homepage footer scan
function validateDocumentUrl(url) {
  try {
    const parsed = new URL(url);

    if (parsed.protocol !== "https:") {
      console.warn("[URLGate] Blocked non-HTTPS URL:", url);
      return false;
    }

    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");

    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") {
      console.warn("[URLGate] Blocked loopback URL:", url);
      return false;
    }

    const ipv6Host = hostname.replace(/^\[|\]$/g, "");
    if (
      ipv6Host === "::1" ||
      ipv6Host.startsWith("::ffff:127.") ||
      ipv6Host === "::ffff:7f00:1" ||
      /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/i.test(ipv6Host)
    ) {
      console.warn("[URLGate] Blocked IPv6 loopback URL:", url);
      return false;
    }

    const privateIp = /^(10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0)$/;
    if (privateIp.test(hostname)) {
      console.warn("[URLGate] Blocked private/link-local IP URL:", url);
      return false;
    }

    if (!hostname || hostname.length < 4) {
      console.warn("[URLGate] Blocked invalid hostname:", url);
      return false;
    }

    // Require a public-looking FQDN. Block single-label intranet names (no dot)
    // and special-use / private TLD suffixes (mDNS .local, ICANN private-use
    // .internal, plus common intranet conventions), plus dot-free bare IPv6
    // literals. None of these ever host a real legal document, and allowing them
    // would let an attacker-supplied link aim an outbound fetch at an internal
    // host the IP-literal checks above cannot catch. Do not loosen without
    // equivalent host validation. (SECURITY-020)
    if (!hostname.includes(".") || /\.(local|internal|localhost|intranet|lan|corp|home)$/.test(hostname)) {
      console.warn("[URLGate] Blocked non-public/internal hostname:", url);
      return false;
    }

    // Block suspicious schemes smuggled via URL constructor
    if (parsed.username || parsed.password) {
      console.warn("[URLGate] Blocked URL with credentials:", url);
      return false;
    }

    return true;
  } catch (e) {
    console.warn("[URLGate] Blocked malformed URL:", url);
    return false;
  }
}

// Legacy alias for backward compatibility
function validateLinkFollowerUrl(url) {
  return validateDocumentUrl(url);
}

// Upgrade an http:// URL to https://. Documents sometimes link useful pages
// insecurely — the canonical ad opt-out portals optout.aboutads.info and
// optout.networkadvertising.org are commonly written as http — and the
// https-only gate in validateDocumentUrl would otherwise drop them. Both those
// sites, and effectively every modern legal/opt-out destination, serve https;
// if a target genuinely doesn't, the later fetch simply fails and the link is
// dropped. Apply this BEFORE validation so the gate still does the real
// security work: it keeps rejecting localhost, private IPs, and credentials
// even after the scheme is upgraded. Non-http(s) schemes pass through unchanged
// so the gate can still reject them.
function upgradeInsecureUrl(url) {
  if (typeof url !== "string") return url;
  return url.replace(/^http:\/\//i, "https://");
}

// Remove <script> and <style> blocks (the tags AND everything inside them) from
// HTML. Shared by stripHtml (HTML → readable text) and sanitizeForPrompt (defang
// text before the LLM) so the security-relevant "drop runnable/style content"
// step has ONE definition both rely on and can never drift apart.
function stripScriptAndStyle(text) {
  if (!text) return "";
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
}

function sanitizeForPrompt(text) {
  if (!text || typeof text !== "string") return "";

  return stripScriptAndStyle(text)
    .replace(/<[^>]+>/g, " ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map(line => line.trim().length > 2000 ? line.trim().slice(0, 2000) : line.trim())
    .filter(line => line.length > 0)
    .join("\n")
    .trim();
}

function scanForInjection(text) {
  if (!text || typeof text !== 'string') return { clean: true, strippedText: text, pattern: null };

  const injectionPatterns = [
    /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
    /system\s*:\s*(override|prompt|message|instruction)/i,
    /system\s+override/i,
    /you\s+are\s+now\s+(a|an)\s+(ai|assistant|chatbot|language model|helpful)/i,
    /forget\s+(everything|all|your|prior)\s+(instructions?|rules?|context|training)/i,
    /new\s+instructions?\s*:/i,
    /\[INST\]/i,
    /<\|system\|>/i,
    /<\|im_start\|>/i,
    /###\s*instruction/i,
    /---\s*system\s*---/i,
    /act\s+as\s+if\s+you\s+(are|have|were)\s+(a|an)?\s*(different|new|unrestricted)/i,
    /disregard\s+(your|all|any|previous)\s+(instructions?|rules?|guidelines?|training)/i,
    /override\s+(your|all|previous|prior)\s+(instructions?|rules?|guidelines?)/i,
    /you\s+must\s+(now\s+)?(ignore|disregard|forget)\s+(all|your|previous|prior)/i
  ];

  let strippedText = text;
  let detectedPattern = null;
  let detectedCrossTextPattern = null;
  const normalizedText = text.replace(/\s+/g, " ");

  for (const pattern of injectionPatterns) {
    if (pattern.test(normalizedText)) {
      detectedPattern = normalizedText.match(pattern)?.[0]?.slice(0, 80) || "cross-line injection";
      detectedCrossTextPattern = pattern;
      console.warn('[Scanner] Injection pattern detected across text:', detectedPattern);
      break;
    }
  }

  const lines = text.split('\n');
  const cleanedLines = lines.filter(line => {
    for (const pattern of injectionPatterns) {
      if (pattern.test(line)) {
        if (!detectedPattern) detectedPattern = line.trim().slice(0, 80);
        console.warn('[Scanner] Injection pattern detected and stripped:', line.trim().slice(0, 80));
        return false;
      }
    }
    return true;
  });

  strippedText = cleanedLines.join('\n');
  if (detectedCrossTextPattern) {
    strippedText = strippedText.replace(detectedCrossTextPattern, "").trim();
  }
  const clean = detectedPattern === null;

  return { clean, strippedText, pattern: detectedPattern };
}
