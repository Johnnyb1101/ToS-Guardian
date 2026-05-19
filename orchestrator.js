// --- ORCHESTRATOR AGENT ---
// Coordinates the full agent relay:
// Memory → Fetcher → Link Follower → Analyzer → Evaluator → UI
// On any agent failure: retry once, then fall back gracefully

async function runOrchestrator(pageUrl, pageText, pageHtml) {
  console.log("[Orchestrator] Starting relay for:", pageUrl);

  const domain = pageUrl ? (() => { try { return new URL(pageUrl).hostname; } catch(e) { return null; } })() : null;

// --- STEP 1: MEMORY AGENT ---
if (domain) {
  const cached = await new Promise(resolve => {
    loadAnalysis(domain, (summary, optOutLinks) => {
      if (summary) {
        resolve({ summary, optOutLinks });
      } else {
        resolve(null);
      }
    });
  });
  if (cached) {
    console.log("[Orchestrator] Cache hit — skipping fetch and analysis");
    return cached;
  }
}

// --- STEP 2: FETCHER AGENT ---
const knownUrls = await lookupSite(pageUrl);
if (knownUrls) {
  console.log("[Orchestrator] Site database hit — passing confirmed URLs to Fetcher");
}
let fetched = null;
fetched = await runWithRetry(() => fetcherAgent(pageUrl, pageHtml, knownUrls), "[Fetcher]");

const textToAnalyze = fetched ? fetched.text : pageText;
const source = fetched
  ? (fetched.privacyUrl
      ? `${fetched.sourceUrl} and ${fetched.privacyUrl}`
      : fetched.sourceUrl)
  : "current page";
console.log("[Orchestrator] Text source:", source);

// --- STEP 2.5: SEMANTIC SIMILARITY CHECK ---
// Now we have fetched privacy text — check Supabase for a semantically similar cached result
if (domain && fetched) {
  const privacyText = sanitizeForPrompt(
    fetched.text.split(/={3,}/).find(s => s.includes('PRIVACY POLICY')) || fetched.text
  ).slice(0, 10000);

  const supabaseResult = await readFromSupabase(domain, privacyText);
  if (supabaseResult) {
    console.log("[Orchestrator] Semantic cache hit — skipping analysis");
    saveAnalysis(domain, supabaseResult.summary, fetched.text, supabaseResult.optOutLinks);
    return { summary: supabaseResult.summary, optOutLinks: supabaseResult.optOutLinks };
  }
  console.log("[Orchestrator] No semantic match — running full analysis");
}

// --- STEP 2.8: INJECTION SCANNER ---
const scanResult = scanForInjection(textToAnalyze);
const safeText = scanResult.strippedText;
if (!scanResult.clean) {
  console.warn('[Orchestrator] Injection attempt detected — pattern stripped before analysis:', scanResult.pattern);
}

// --- STEP 3: LINK FOLLOWER AGENT ---
const privacyHtml = fetched ? fetched.privacyHtml : null;
const privacyUrl = fetched ? fetched.privacyUrl : null;
const { text: enrichedText, optOutLinks } = await linkFollowerStub(safeText, source, privacyHtml, privacyUrl);

  // --- STEP 4: ANALYZER AGENT ---
  let result = null;
  result = await runWithRetry(() => analyzeWithModel(enrichedText, source), "[Analyzer]");

  // --- STEP 5: EVALUATOR AGENT + ESCALATION ---
  const rawEvaluation = evaluateAnalysis(result ? result.summary : null);

  // Schema validation — fail closed if Evaluator returns unexpected format (SECURITY-010)
  const validLabels = ['Strong', 'Adequate', 'Failed'];
  let evaluation = (
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

  console.log(`[Orchestrator] Evaluator — Label: ${evaluation.label}, Score: ${evaluation.score}`);

  // --- ESCALATION (ESCALATION-002, ESCALATION-003, ESCALATION-006) ---
  if (evaluation.escalate) {
    // Check session cap for Adequate results (Failed always escalates)
    const capKey = 'opusEscalationCount';
    const capData = await browser.storage.local.get(capKey);
    const escalationCount = capData[capKey] || 0;
    const CAP = 3;

    const shouldEscalate = evaluation.label === 'Failed' || escalationCount < CAP;

    if (shouldEscalate) {
      console.log(`[Orchestrator] Escalating to Opus — Haiku score: ${evaluation.score}, count: ${escalationCount + 1}/${CAP}`);
      const escalatedResult = await runWithRetry(
        () => analyzeWithModel(enrichedText, source, true), // true = use escalation model
        "[Analyzer-Opus]"
      );

      if (escalatedResult) {
        const escalatedEvaluation = evaluateAnalysis(escalatedResult.summary);
        console.log(`[Orchestrator] Opus score: ${escalatedEvaluation.score} | Label: ${escalatedEvaluation.label}`);

        // Use Opus result if it's better
        if (escalatedEvaluation.score > evaluation.score) {
          result = escalatedResult;
          evaluation = escalatedEvaluation;
          console.log(`[Orchestrator] Opus result accepted`);
        } else {
          console.log(`[Orchestrator] Opus result not better — keeping Haiku result`);
        }

        // Increment session cap regardless of which result was kept
        await browser.storage.local.set({ [capKey]: escalationCount + 1 });

        // Log escalation to Supabase (ESCALATION-004)
        writeToSupabase(domain, result.summary, 'anthropic-escalated', optOutLinks, textToAnalyze);
      }
    } else {
      console.log(`[Orchestrator] Opus cap reached (${escalationCount}/${CAP}) — using Haiku result`);
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
    return { summary: "TOS Guardian was unable to analyze this document. Please try again." };
  }

  // --- STEP 6: SAVE TO MEMORY ---
  if (domain && (evaluation.passed || evaluation.label === 'Adequate')) {
    saveAnalysis(domain, result.summary, textToAnalyze, optOutLinks);
    console.log("[Orchestrator] Analysis saved to memory for:", domain);
  }

  console.log("[Orchestrator] Relay complete");
  console.log('[Orchestrator] optOutLinks being returned:', optOutLinks);
  return { ...result, optOutLinks };
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
async function linkFollowerStub(text, source, privacyHtml = null, privacyUrl = null) {
  console.log("[LinkFollower] Scanning for opt-out and privacy links...");

  // Keywords that indicate an opt-out or privacy action page
  const priorityKeywords = [
    "opt-out", "optout", "opt_out",
    "do-not-sell", "donotsell", "do_not_sell",
    "data-deletion", "delete-my-data", "deletemydata",
    "privacy-choices", "privacychoices", "privacy-settings",
    "data-rights", "your-privacy", "yourprivacy",
    "safetyandprivacy", "learn-more-about-privacy", "account/privacy"
  ];

// Scan plain text for full URLs
  const linkMatches = [...text.matchAll(/https?:\/\/[^\s"'<>)]+/g)]
    .map(m => m[0])
    .filter(url => priorityKeywords.some(keyword => url.toLowerCase().includes(keyword)));

  // Scan privacy policy HTML for opt-out hrefs — this is where they actually live
  const htmlToScan = privacyHtml || text;
  const baseUrl = privacyUrl || source;
  const relativeMatches = [...htmlToScan.matchAll(/href=["']([^"']+)["']/g)]
    .map(m => m[1])
    .filter(href => priorityKeywords.some(keyword => href.toLowerCase().includes(keyword)))
    .map(href => {
      try {
        return href.startsWith("http") ? href : new URL(href, baseUrl).href;
      } catch(e) { return null; }
    })
    .filter(Boolean)
    .filter(url => validateLinkFollowerUrl(url));

  const allLinks = [...new Set([...linkMatches, ...relativeMatches])];

  // Deduplicate
const uniqueLinks = allLinks;

  if (uniqueLinks.length === 0) {
    console.log("[LinkFollower] No opt-out links found — passing text through unchanged");
    return { text, optOutLinks: [] };
  }

  console.log(`[LinkFollower] Found ${uniqueLinks.length} candidate links — following top 3`);

  // Follow top 3 links only
  const toFollow = uniqueLinks.slice(0, 3);
  const appendSections = [];

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
    optOutLinks: uniqueLinks
  };
}