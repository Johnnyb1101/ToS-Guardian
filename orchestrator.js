// --- ORCHESTRATOR AGENT ---
// Coordinates the full agent relay:
// Memory → Fetcher → Link Follower → Analyzer → Evaluator → UI
// On any agent failure: retry once, then fall back gracefully

// --- TEST/DEBUG HOOK (no-op in normal use) ---
// When `tosGuardianDebug` is true in chrome.storage.local, the manual dev test
// recorder mirrors each completed analysis to `tosGuardianLastResult` so tests
// can read exact score/label/issues instead of scraping overlay HTML. This never
// affects scoring or the rendered overlay; it only mirrors the verdict.
async function writeDebugResult(partial) {
  try {
    const flag = await browser.storage.local.get('tosGuardianDebug');
    if (!flag.tosGuardianDebug) return;
    await browser.storage.local.set({
      tosGuardianLastResult: { timestamp: Date.now(), ...partial }
    });
  } catch (e) {
    console.warn('[Orchestrator] Debug result write skipped:', e.message);
  }
}

async function runOrchestrator(pageUrl, pageText, pageHtml) {
  console.log("[Orchestrator] Starting relay for:", pageUrl);
  const relayStartedAt = Date.now();
  let stageStartedAt = relayStartedAt;
  const logStage = (stage) => {
    const now = Date.now();
    console.log(`[Timing] ${stage}: ${now - stageStartedAt}ms | total: ${now - relayStartedAt}ms`);
    stageStartedAt = now;
  };

  const domain = pageUrl ? (() => { try { return new URL(pageUrl).hostname; } catch(e) { return null; } })() : null;

// --- STEP 1: FETCHER AGENT ---
const knownUrls = await lookupSite(pageUrl);
if (knownUrls) {
  console.log("[Orchestrator] Site database hit — passing confirmed URLs to Fetcher");
}
let fetched = null;
fetched = await runWithRetry(() => fetcherAgent(pageUrl, pageHtml, knownUrls), "[Fetcher]");
logStage("fetcher");

const textToAnalyze = fetched ? fetched.text : pageText;
const source = fetched
  ? (fetched.privacyUrl
      ? `${fetched.sourceUrl} and ${fetched.privacyUrl}`
      : fetched.sourceUrl)
  : "current page";
console.log("[Orchestrator] Text source:", source);
const cacheVerificationText = buildCacheVerificationText(textToAnalyze);

// --- STEP 2: MEMORY AGENT ---
// Cache reads happen only after fetching current text, so Supabase can verify similarity.
if (domain && fetched) {
  const supabaseResult = await readFromSupabase(domain, cacheVerificationText);
  if (supabaseResult) {
    const cachedEvaluation = validateEvaluation(
      evaluateAnalysis(stripInjectionWarning(stripEvalChrome(supabaseResult.summary)))
    );
    if (isCacheableEvaluation(cachedEvaluation)) {
      let cachedSummary = stripInjectionWarning(stripEvalChrome(supabaseResult.summary));
      if (cachedEvaluation.warning) {
        cachedSummary = `<div class="tg-eval-warning">${cachedEvaluation.warning}</div>\n` + cachedSummary;
      }
      cachedSummary += `\n<div class="tg-eval-badge tg-eval-${cachedEvaluation.label.toLowerCase()}">Analysis confidence: ${cachedEvaluation.label} (${cachedEvaluation.score}/100)</div>`;
      console.log("[Orchestrator] Semantic cache hit — skipping analysis");
      await writeDebugResult({
        domain, url: pageUrl, score: cachedEvaluation.score, label: 'Cached',
        warning: cachedEvaluation.warning, issues: cachedEvaluation.issues || [],
        optOutLinks: supabaseResult.optOutLinks || [], cached: true
      });
      logStage("cache hit");
      return { summary: cachedSummary, optOutLinks: supabaseResult.optOutLinks };
    }
    console.warn("[Orchestrator] Cached summary failed local quality gate — running full analysis");
  }
  console.log("[Orchestrator] No semantic match — running full analysis");
}
logStage("cache");

// --- STEP 2.5: INJECTION SCANNER ---
const scanResult = scanForInjection(textToAnalyze);
const safeText = scanResult.strippedText;
if (!scanResult.clean) {
  console.warn('[Orchestrator] Injection attempt detected — pattern stripped before analysis:', scanResult.pattern);
}

// --- STEP 3: LINK FOLLOWER AGENT ---
const privacyHtml = fetched ? fetched.privacyHtml : null;
const privacyUrl = fetched ? fetched.privacyUrl : null;
const { text: enrichedText, optOutLinks } = await linkFollowerStub(safeText, source, privacyHtml, privacyUrl, fetched?.hasSupplementalPrivacy || false);
logStage("link follower");
const displayOptOutLinks = [
  ...new Set(
    [...(fetched?.documentLinks || []), ...optOutLinks].map(upgradeInsecureUrl)
  )
].filter(url => validateLinkFollowerUrl(url) && isRelevantPrivacyActionUrl(url));

  // --- STEP 4: ANALYZER AGENT ---
  let result = null;
  result = await runWithRetry(() => analyzeWithModel(enrichedText, source), "[Analyzer]");
  logStage("analyzer");

  if (result && result.summary) {
    console.log(`[Orchestrator] Raw Analyzer output (${result.summary.length} chars):`, result.summary.slice(0, 300));
    result.summary = stripInjectionWarning(normalizeAnalysisHeaders(result.summary));
    if (isConfigurationMessage(result.summary)) {
      console.log("[Orchestrator] Configuration message returned — skipping critic/evaluator/escalation");
      await writeDebugResult({
        domain, url: pageUrl, score: null, label: 'Configuration',
        warning: result.summary, issues: ['configuration required'],
        optOutLinks: displayOptOutLinks, cached: false
      });
      return result;
    }
  } else {
    console.warn('[Orchestrator] Analyzer returned:', JSON.stringify(result).slice(0, 300));
  }

  // --- STEP 4.5: CRITIC/JUDGE AGENT ---
  let criticVerdict = null;
  if (result) {
    criticVerdict = await runCritic(result.summary, enrichedText);
    if (criticVerdict) {
      console.log(`[Orchestrator] Critic verdict received — flags: ${criticVerdict.flags?.length || 0}`);
    } else {
      console.log(`[Orchestrator] Critic skipped or failed — continuing without`);
    }
  }
  logStage("critic");

  // --- STEP 5: EVALUATOR AGENT + ESCALATION ---
  const rawEvaluation = evaluateAnalysis(result ? result.summary : null, criticVerdict);

  let evaluation = validateEvaluation(rawEvaluation);

  console.log(`[Orchestrator] Evaluator — Label: ${evaluation.label}, Score: ${evaluation.score}`);

  // --- ESCALATION (ESCALATION-002, ESCALATION-003, ESCALATION-006) ---
  let escalatedAccepted = false;
  if (evaluation.escalate) {
    const capKey = 'opusEscalationData';
    const capData = await browser.storage.local.get(capKey);
    const stored = capData[capKey] || { count: 0, resetAt: 0 };

    const now = Date.now();
    if (now > stored.resetAt) {
      stored.count = 0;
      stored.resetAt = now + 24 * 60 * 60 * 1000;
    }
    const escalationCount = stored.count;
    const CAP = 5;

    const shouldEscalate = escalationCount < CAP;

    if (shouldEscalate) {
      console.log(`[Orchestrator] Escalating to Opus — Haiku score: ${evaluation.score}, count: ${escalationCount + 1}/${CAP} (resets ${new Date(stored.resetAt).toLocaleTimeString()})`);
      const escalatedResult = await runWithRetry(
        () => analyzeWithModel(enrichedText, source, true),
        "[Analyzer-Opus]"
      );

      if (escalatedResult) {
        if (escalatedResult.summary) {
          escalatedResult.summary = stripInjectionWarning(normalizeAnalysisHeaders(escalatedResult.summary));
        }
        // Re-run Critic on escalated result
        const escalatedCritic = await runCritic(escalatedResult.summary, enrichedText);
        const escalatedEvaluation = validateEvaluation(evaluateAnalysis(escalatedResult.summary, escalatedCritic));
        console.log(`[Orchestrator] Opus score: ${escalatedEvaluation.score} | Label: ${escalatedEvaluation.label}`);

        if (escalatedEvaluation.score > evaluation.score) {
          result = escalatedResult;
          evaluation = escalatedEvaluation;
          criticVerdict = escalatedCritic;
          escalatedAccepted = true;
          console.log(`[Orchestrator] Opus result accepted`);
        } else {
          console.log(`[Orchestrator] Opus result not better — keeping Haiku result`);
        }

        stored.count = escalationCount + 1;
        await browser.storage.local.set({ [capKey]: stored });
        // The Supabase write happens once, in Step 6 below, after the trusted
        // verdict badge is composed. Writing here too would race that write
        // (both fire-and-forget on the same domain) and persist a pre-badge
        // duplicate tagged 'anthropic-escalated' even when the Haiku result
        // was kept.
      }
    } else {
      console.log(`[Orchestrator] Opus cap reached (${escalationCount}/${CAP}) — using Haiku result. Resets ${new Date(stored.resetAt).toLocaleTimeString()}`);
    }
  }

  if (result) {
    // Strip any verdict/warning markup the analyzer may have echoed from
    // attacker-controlled document text, so only the trusted evaluator verdict
    // composed below can ever render as UI chrome. (SECURITY-022)
    result.summary = stripEvalChrome(result.summary);
    if (!scanResult.clean) {
      result.summary = `⚠️ Possible injection attempt detected in document\n${result.summary}`;
    }
  }
  if (result && evaluation.warning) {
    result.summary = `<div class="tg-eval-warning">${evaluation.warning}</div>\n` + result.summary;
  }
  if (result) {
    result.summary += `\n<div class="tg-eval-badge tg-eval-${evaluation.label.toLowerCase()}">Analysis confidence: ${evaluation.label} (${evaluation.score}/100)</div>`;
  }

  if (!result) {
    console.error("[Orchestrator] Analyzer failed after retry — returning fallback");
    const fallbackSummary = "TOS Guardian was unable to analyze this document. Please try again.";
    await writeDebugResult({
      domain, url: pageUrl, score: null, label: 'Error',
      warning: fallbackSummary, issues: ['analyzer failed after retry'],
      optOutLinks: displayOptOutLinks, cached: false
    });
    return { summary: fallbackSummary };
  }

  // --- STEP 6: SAVE TO MEMORY ---
  if (domain && isCacheableEvaluation(evaluation)) {
    saveAnalysis(domain, result.summary, cacheVerificationText, displayOptOutLinks,
      escalatedAccepted ? 'anthropic-escalated' : 'anthropic');
    console.log("[Orchestrator] Analysis saved to memory for:", domain);
  } else if (domain) {
    console.log("[Orchestrator] Analysis not saved — quality gate did not pass:", evaluation.label);
  }

  console.log("[Orchestrator] Relay complete");
  logStage("complete");
  console.log('[Orchestrator] optOutLinks being returned:', displayOptOutLinks);
  await writeDebugResult({
    domain, url: pageUrl,
    score: evaluation.score, label: evaluation.label,
    warning: evaluation.warning, issues: evaluation.issues || [],
    optOutLinks: displayOptOutLinks, cached: false
  });
  return { ...result, optOutLinks: displayOptOutLinks };
}

function isConfigurationMessage(summary) {
  return /No (Anthropic|OpenAI) API key set|Unknown provider selected/i.test(summary || "");
}

function validateEvaluation(rawEvaluation) {
  const validLabels = ['Strong', 'Adequate', 'Failed'];
  return (
    rawEvaluation &&
    typeof rawEvaluation.score === 'number' &&
    rawEvaluation.score >= 0 &&
    rawEvaluation.score <= 100 &&
    validLabels.includes(rawEvaluation.label)
  ) ? rawEvaluation : {
    score: 0,
    label: 'Failed',
    warning: '⚠️ Evaluator returned an unexpected result. Analysis could not be verified.',
    passed: false,
    escalate: true
  };
}

function isCacheableEvaluation(evaluation) {
  return !!(
    evaluation &&
    evaluation.passed &&
    Array.isArray(evaluation.contradictions) &&
    evaluation.contradictions.length === 0
  );
}

function buildCacheVerificationText(text) {
  const sanitized = sanitizeForPrompt(text || "");
  const privacyStart = sanitized.indexOf("=== PRIVACY POLICY");
  const verificationSource = privacyStart > -1 ? sanitized.slice(privacyStart) : sanitized;
  return verificationSource.slice(0, 10000);
}

// Retry wrapper — attempts once, retries once on failure, then returns null
async function runWithRetry(fn, label) {
  try {
    const result = await fn();
    if (result) return result;
    throw new Error("Empty result");
  } catch (e) {
    console.warn(`${label} failed on first attempt — retrying once:`, e.message);
    try {
      const retry = await fn();
      if (retry) return retry;
      console.warn(`${label} retry returned empty — falling back`);
      return null;
    } catch (e2) {
      console.warn(`${label} retry threw error — falling back:`, e2.message);
      return null;
    }
  }
}

// --- LINK FOLLOWER AGENT ---
// Scans fetched documents for opt-out and privacy links
// Follows top 3 matches and appends their content to the main document
async function linkFollowerStub(text, source, privacyHtml = null, privacyUrl = null, hasSupplementalPrivacy = false) {
  console.log("[LinkFollower] Scanning for opt-out and privacy links...");

  // Keywords that indicate an opt-out or privacy action page
  const priorityKeywords = [
    "opt-out", "optout", "opt_out",
    "do-not-sell", "donotsell", "do_not_sell",
    "data-deletion", "delete-my-data", "deletemydata",
    "privacy-choices", "privacychoices", "privacy-settings",
    "data-rights", "your-privacy-choices", "account/privacy",
    "consumer-privacy", "consumer_privacy", "ccpa-disclosure",
    "manage-your-data"
  ];

// Scan plain text for full URLs
  const linkMatches = [...text.matchAll(/https?:\/\/[^\s"'<>)]+/g)]
    .map(m => m[0])
    .filter(url => priorityKeywords.some(keyword => url.toLowerCase().includes(keyword)))
    .map(upgradeInsecureUrl);

  // Scan privacy policy HTML for opt-out hrefs — this is where they actually live
  const htmlToScan = privacyHtml || text;
  const baseUrl = privacyUrl || source;
  const relativeMatches = [...htmlToScan.matchAll(/href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/g)]
    .filter(m => {
      const href = m[1].toLowerCase();
      const label = m[2].replace(/<[^>]+>/g, ' ').toLowerCase();
      return priorityKeywords.some(keyword => href.includes(keyword) || label.includes(keyword));
    })
    .map(m => m[1])
    .map(href => {
      try {
        return href.startsWith("http") ? href : new URL(href, baseUrl).href;
      } catch(e) { return null; }
    })
    .filter(Boolean)
    .map(upgradeInsecureUrl)
    .filter(url => validateLinkFollowerUrl(url));

  const allLinks = [...new Set([...linkMatches, ...relativeMatches])]
    .filter(url => isRelevantPrivacyActionUrl(url, { hasSupplementalPrivacy }));

  // Deduplicate
const uniqueLinks = allLinks;

  if (uniqueLinks.length === 0) {
    console.log("[LinkFollower] No opt-out links found — passing text through unchanged");
    return { text, optOutLinks: [] };
  }

  const toFollow = uniqueLinks.slice(0, hasSupplementalPrivacy ? 1 : 3);
  console.log(`[LinkFollower] Found ${uniqueLinks.length} relevant candidate links — following top ${toFollow.length}`);

  // Follow top links only
  const appendSections = [];
  const followedLinks = [];

  for (const url of toFollow) {
    if (!validateLinkFollowerUrl(url)) {
      console.warn("[LinkFollower] Skipping blocked URL:", url);
      continue;
    }
    console.log(`[LinkFollower] Fetching: ${url}`);
    try {
      let fetched = await fetchWithHiddenTab(url);
      if (!fetched || !fetched.text || fetched.text.length <= 200) {
        try {
          const r = await fetch(`${PROXY_URL}/fetch-document`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
          });
          if (r.status === 403) {
            console.warn(`[LinkFollower] Proxy blocked document for ${url} — potential injection detected`);
          } else if (r.status === 429) {
            console.warn(`[LinkFollower] Rate limited for ${url}`);
          } else if (r.ok) {
            const d = await r.json();
            if (d.text && d.text.length > 200) {
              fetched = { text: stripHtml(d.text), html: d.text };
              console.log(`[LinkFollower] Proxy fallback successful for: ${url}`);
            }
          } else {
            console.warn(`[LinkFollower] Proxy returned ${r.status} for ${url}`);
          }
        } catch (e) {
          console.warn(`[LinkFollower] Proxy fallback failed for ${url}:`, e.message);
        }
      }
      if (fetched && fetched.text && fetched.text.length > 200) {
        console.log(`[LinkFollower] Retrieved content from: ${url}`);
        appendSections.push(`=== OPT-OUT / PRIVACY PAGE: ${url} ===\n${fetched.text}`);
        followedLinks.push(url);
      } else {
        console.log(`[LinkFollower] No usable content at: ${url}`);
      }
    } catch (e) {
      console.warn(`[LinkFollower] Failed to fetch ${url}:`, e.message);
    }
  }

  if (appendSections.length === 0) {
    console.log("[LinkFollower] No content retrieved from links — passing text through unchanged");
    return { text, optOutLinks: uniqueLinks };
  }

  console.log(`[LinkFollower] Appending ${appendSections.length} opt-out sections to document`);
  return {
    text: text + "\n\n" + appendSections.join("\n\n"),
    optOutLinks: followedLinks
  };
}

function isRelevantPrivacyActionUrl(url, { hasSupplementalPrivacy = false } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return false;
  }

  const normalized = `${parsed.hostname}${parsed.pathname}${parsed.hash}`.toLowerCase();
  const irrelevantPatterns = [
    /\/assets\//,
    /favicon\.(ico|png|svg)$/,
    /\.(ico|png|jpe?g|gif|svg|webp|css|js)([#?].*)?$/,
    /\.(woff2?|ttf|otf|eot)([#?].*)?$/,
    /workforce/,
    /workplace/,
    /employee/,
    /applicant/,
    /associate/,
    /job[-_]?candidate/,
    /non[-_]?us/,
    /international/,
    /privacy\/notice\/(?!en-us\b)[^/#?]+/i
  ];

  if (irrelevantPatterns.some(pattern => pattern.test(normalized))) {
    console.log("[LinkFollower] Ignoring non-consumer/privacy-resource link:", url);
    return false;
  }

  if (hasSupplementalPrivacy && /\/privacy\/(notice|online-privacy-policy|ccpa-disclosure)\/?$/i.test(parsed.pathname)) {
    return false;
  }

  return true;
}
