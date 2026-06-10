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

function isLikelyResourcePageUrl(url) {
  return /(?:^|[\/_-])(makingcents|blog|article|faq|tips|guide|learn|how-to|security-tips)(?:[\/_-]|$)/i.test(url || "");
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

function stripInjectionWarning(text) {
  if (!text) return "";
  return text
    .replace(/^[^\n]*Possible injection attempt detected[^\n]*$/gim, "")
    .replace(/^(?:Quick note|Note):\s*I (?:didn't|did not) (?:spot|find) any actual injection attempts?[^\n]*(?:\n|$)/gim, "")
    .trim();
}

function formatSummary(raw, optOutLinks = []) {
  if (!raw) return "";

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
  let evalBadge = "";

  // The trusted verdict is composed LAST by the orchestrator (warning prepended,
  // badge appended). An attacker-echoed badge would appear EARLIER in the blob, so
  // we deliberately select the FIRST warning and the LAST badge, then strip ALL
  // eval-chrome from the body so no forged badge can leak into the rendered output.
  // (SECURITY-022 — output-render verdict spoofing; see also SECURITY-021)
  const warningMatch = raw.match(/<div class="tg-eval-warning"[^>]*>(.*?)<\/div>/s);
  const badgeMatches = [...raw.matchAll(/<div class="tg-eval-badge\s+(tg-eval-\w+)"[^>]*>(.*?)<\/div>/gs)];
  const badgeMatch   = badgeMatches.length ? badgeMatches[badgeMatches.length - 1] : null;

  // Rebuild eval HTML from extracted text to prevent cache-poisoned markup (SECURITY-021)
  if (warningMatch) {
    evalWarning = `<div class="tg-eval-warning">${escapeHtml(warningMatch[1].replace(/<[^>]+>/g, '').trim())}</div>`;
  }
  if (badgeMatch) {
    const badgeClass = /^tg-eval-(strong|adequate|failed)$/.test(badgeMatch[1]) ? badgeMatch[1] : 'tg-eval-failed';
    evalBadge = `<div class="tg-eval-badge ${badgeClass}">${escapeHtml(badgeMatch[2].replace(/<[^>]+>/g, '').trim())}</div>`;
  }
  // Remove every eval-chrome div from the body (including any forged earlier badges)
  raw = stripEvalChrome(raw);

  const categoryMarkers = ["🔴", "📋", "🟡", "🟢"];
  const lines = raw.split("\n").map(l => l.trim()).filter(l => l !== "" && l !== "•");

  // Build opt-out links HTML once
  const validLinks = (optOutLinks || [])
    .map(url => url ? url.trim().replace(/\s+/g, '') : '')
    .filter(url => url && url.startsWith('http'));
  const optOutHtml = validLinks.length > 0 ? `
    <div class="tg-optout-links">
      <div class="tg-optout-title">Opt-Out Links Found</div>
      ${validLinks.map(url => `<a class="tg-optout-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`).join("")}
    </div>` : "";

  let html = injectionWarning + evalWarning;
  let currentTitle = "";
  let currentBody  = [];
  let optOutInserted = false;
  let renderedSections = 0;

  const flush = () => {
    if (currentTitle) {
      const bodyLines = currentBody
        .map(l => {
          let cleaned = l
            .replace(/^•\s*/, "")
            .replace(/\|[-\s|]+\|/g, '')
            .replace(/^\|\s*/g, '')
            .replace(/\s*\|$/g, '')
            .replace(/\s*\|\s*/g, ' — ')
            .trim();
          // Escape HTML entities BEFORE converting markdown bold (SECURITY-021)
          cleaned = escapeHtml(cleaned);
          // Now safe to convert **bold** to <strong> since content is escaped
          cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
          return cleaned;
        })
        .filter(l => l !== "" && l !== "---" && l !== "—"
          && !l.match(/^It.s your right to/i)
          && !l.match(/^[-\s|]+$/));

      const bodyHtml = bodyLines.map(l => `<p style="margin:0 0 6px 0;">${l}</p>`).join("");

      html += `
        <div class="tg-category">
          <span class="tg-category-title">${escapeHtml(currentTitle)}</span>
          <div class="tg-category-body">${bodyHtml}</div>
        </div>`;
      renderedSections++;

      if (!optOutInserted && currentTitle.includes("OPT-OUT RIGHTS") && optOutHtml) {
        html += optOutHtml;
        optOutInserted = true;
      }

      currentBody = [];
      currentTitle = "";
    }
  };

  const knownHeaders = [
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

  if (renderedSections === 0 && lines.length > 0) {
    const bodyHtml = lines
      .map(line => `<p style="margin:0 0 6px 0;">${escapeHtml(line)}</p>`)
      .join("");
    html += `
      <div class="tg-category">
        <span class="tg-category-title">TOS Guardian</span>
        <div class="tg-category-body">${bodyHtml}</div>
      </div>`;
  }

  if (!optOutInserted && optOutHtml) {
    html += optOutHtml;
  }

  html += evalBadge;

  // AI disclaimer — required on every result per ESCALATION-005
  html += `<div style="margin:12px 20px 14px; padding-top:10px; border-top:1px solid #f0f0f0;
              font-size:11px; color:#999; text-align:center;">
    AI analysis may not be 100% accurate. Always review documents yourself for important decisions.
  </div>`;

  return html;
}

function normalizeAnalysisHeaders(summary) {
  const headerMap = [
    { pattern: /[🔴📋🟡🟢]*\s*\*{0,2}\s*[🔴📋🟡🟢]*\s*\*{0,2}\s*DATA SELLING\s*[&]\s*SHARING\s*\*{0,2}/gi, replacement: '🔴 DATA SELLING & SHARING' },
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

function sanitizeForPrompt(text) {
  if (!text || typeof text !== "string") return "";

  return text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
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
