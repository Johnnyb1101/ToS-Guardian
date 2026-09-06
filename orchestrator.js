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

// --- OBSERVER (learning loop, phase 0) ---
// Observer mode is a developer setting (tosGuardianObserver in storage), off by
// default. When off, the recorder below is inert: no event is created and no
// sink is called, so the relay behaves exactly as it always has. When on, each
// stage records the facts episode.js allows for it, and background.js posts
// them to a collector on this machine. The recorder never throws. The setting
// is read through episode.js so the message boundary reads it the same way.

// Provider usage as episode.js expects it, or undefined when absent/malformed.
function usageForEpisode(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const out = {};
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    const n = Number(usage[key]);
    out[key] = Number.isInteger(n) && n >= 0 ? n : 0;
  }
  return out;
}

// Classify an analyzer return for the episode log. `status` is set explicitly
// by analyzeWithModel on its error paths; the text checks are the fallback for
// providers that only return a summary.
function analyzeStatusFor(result) {
  if (!result) return 'error';
  if (typeof result.status === 'string') return result.status;
  if (!result.summary) return 'empty';
  if (isConfigurationMessage(result.summary)) return 'config';
  if (/^Error:/.test(result.summary)) return 'error';
  return 'ok';
}

function analyzeFactsFor(result, sourceText, escalated, retried) {
  return {
    provider: result && ['anthropic', 'openai', 'ollama'].includes(result.provider) ? result.provider : 'unknown',
    model: result && typeof result.model === 'string' ? result.model : '',
    escalated,
    inputChars: result && typeof result.analysisSource === 'string' ? result.analysisSource.length : (sourceText || '').length,
    stopReason: result && typeof result.stopReason === 'string' ? result.stopReason : '',
    usage: usageForEpisode(result && result.usage),
    status: analyzeStatusFor(result),
    receipt: !!(result && result.analysisReceipt),
    summaryHash: result && typeof result.summary === 'string' && result.summary ? contentFingerprint(result.summary) : undefined,
    retried
  };
}

function criticFactsFor(criticResult) {
  if (!criticResult) return { data: { ran: false, failed: false } };
  if (criticResult.failed) {
    return { data: { ran: true, failed: true, reason: typeof criticResult._reason === 'string' ? criticResult._reason : 'unknown' } };
  }
  const verdicts = {};
  for (const field of ['dataCollection', 'dataSelling', 'optOutRights', 'howToOptOut', 'autoRenewal', 'dataDeletion']) {
    if (['grounded', 'unsupported', 'vague', 'skipped'].includes(criticResult[field])) verdicts[field] = criticResult[field];
  }
  const flags = Array.isArray(criticResult.flags) ? criticResult.flags : [];
  return {
    data: {
      ran: true, failed: false, verdicts,
      flagCount: flags.length,
      adjustmentCount: Array.isArray(criticResult.adjustments) ? criticResult.adjustments.length : 0,
      receipt: !!criticResult._writeReceipt,
      model: typeof criticResult._model === 'string' ? criticResult._model : '',
      stopReason: typeof criticResult._stopReason === 'string' ? criticResult._stopReason : '',
      usage: usageForEpisode(criticResult._usage)
    },
    local: flags.length ? { flagsText: flags.slice(0, 20).map(f => String(f).slice(0, 400)) } : undefined
  };
}

async function runOrchestrator(pageUrl, pageText, pageHtml, options = {}) {
  console.log("[Orchestrator] Starting relay for:", pageUrl);
  const relayStartedAt = Date.now();
  let stageStartedAt = relayStartedAt;
  const logStage = (stage) => {
    const now = Date.now();
    console.log(`[Timing] ${stage}: ${now - stageStartedAt}ms | total: ${now - relayStartedAt}ms`);
    stageStartedAt = now;
  };

  const observer = await readObserverConfig(browser.storage.local);
  if (observer.enabled) {
    console.log(`[Observer] Observer mode is on — posting episode events to 127.0.0.1:${observer.port}`);
  }
  const rec = createEpisodeRecorder({
    enabled: observer.enabled,
    episodeId: options && options.episodeId,
    sink: (event) => { if (typeof observerSink === 'function') observerSink(event, observer); },
    onInvalid: (stage, errors) => console.warn(`[Observer] Dropped invalid ${stage} event: ${errors.join('; ')}`)
  });
  const finishEpisode = (label) => {
    rec.record('end', { durationMs: Date.now() - relayStartedAt, ok: label !== 'Error' && label !== 'Configuration' });
  };

  // Cache key is the REGISTRABLE domain (eTLD+1), not the hostname, so sibling
  // subdomains (www / login / oak …) share one cache entry instead of each
  // re-analyzing and writing a duplicate row. (FIXPLAN #1)
  const domain = pageUrl ? (() => { try { return registrableDomain(new URL(pageUrl).hostname); } catch(e) { return null; } })() : null;

// --- STEP 1: FETCHER AGENT ---
const knownUrls = await lookupSite(pageUrl);
if (knownUrls) {
  console.log("[Orchestrator] Site database hit — passing confirmed URLs to Fetcher");
}
rec.record('relay', {
  domain: domain || undefined,
  siteLookup: knownUrls ? (knownUrls.source === 'learned' ? 'learned' : 'static') : 'none',
  deduped: false,
  mode: options && options.mode === 'batch' ? 'batch' : 'live'
});
let fetched = null;
let fetchAttempts = 0;
fetched = await runWithRetry(() => { fetchAttempts++; return fetcherAgent(pageUrl, pageHtml, knownUrls); }, "[Fetcher]");
logStage("fetcher");

const textToAnalyze = fetched ? fetched.text : pageText;
const source = fetched
  ? (fetched.privacyUrl
      ? `${fetched.sourceUrl} and ${fetched.privacyUrl}`
      : fetched.sourceUrl)
  : "current page";
console.log("[Orchestrator] Text source:", source);

// Facts about what the fetcher produced. Document URLs only, never the page
// the user was on: the page URL is user data and stays in the local layer.
{
  const legal = looksLikeLegalDocument(textToAnalyze || '');
  const text = fetched ? (fetched.text || '') : (legal ? (pageText || '') : '');
  const mech = fetched && fetched.mechanisms && typeof fetched.mechanisms === 'object' ? fetched.mechanisms : {};
  const docUrls = [...new Set([fetched?.sourceUrl, fetched?.privacyUrl, ...(fetched?.documentLinks || [])]
    .filter(Boolean).map(upgradeInsecureUrl))].filter(url => validateDocumentUrl(url)).slice(0, 20);
  rec.record('fetch', {
    path: fetched ? (typeof fetched.path === 'string' ? fetched.path : 'unknown') : (legal ? 'page-text' : 'none'),
    tosFound: !!(fetched && /=== TERMS OF SERVICE ===/.test(fetched.text || '')),
    privacyFound: !!(fetched && /=== PRIVACY POLICY ===/.test(fetched.text || '')),
    supplementalCount: ((fetched && fetched.text) || '').split('=== SUPPLEMENTAL PRIVACY NOTICE').length - 1,
    textChars: text.length,
    textHash: text ? contentFingerprint(text) : undefined,
    looksLegal: legal,
    unreadablePdfCount: (fetched?.unreadablePdfUrls || []).length,
    documentUrls: docUrls,
    hiddenTabHits: Number.isInteger(mech.hiddenTab) ? mech.hiddenTab : undefined,
    proxyHits: Number.isInteger(mech.proxy) ? mech.proxy : undefined,
    attempts: Number.isInteger(mech.attempts) ? mech.attempts : undefined,
    retried: fetchAttempts > 1
  }, { pageUrl: typeof pageUrl === 'string' ? pageUrl.slice(0, 2048) : undefined });
}

// SECURITY (#5 — private page text): when document discovery FAILED, `textToAnalyze`
// is `pageText` — the whole visible page (document.body.innerText). On a logged-in
// page that is the user's private content (dashboard, account, inbox), and analyzing
// it would send that content to the AI provider. Never do that. Only fall back to the
// page text when the page ITSELF is a legal document (e.g. the user clicked agree on
// the actual Terms page). Otherwise short-circuit to an honest "couldn't read it"
// overlay without analyzing anything.
if (!fetched && !looksLikeLegalDocument(textToAnalyze)) {
  console.warn("[Orchestrator] No legal document found and the page is not itself a legal document — not analyzing page text (privacy).");
  const bottomLine = "We couldn't find this site's terms or privacy policy to analyze. Open them yourself before agreeing.";
  const summary =
    `<div class="tg-eval-warning">⚠️ TOS Guardian couldn't locate the legal documents for this page, so there is nothing to analyze.</div>\n` +
    `<div class="tg-bottomline">${bottomLine}</div>\n` +
    `<div class="tg-risk tg-risk-unknown">Unknown</div>\n` +
    `<div class="tg-eval-badge tg-eval-failed">Analysis confidence: Failed (0/100)</div>`;
  await writeDebugResult({
    domain, url: pageUrl, score: 0, label: 'Failed',
    warning: bottomLine, issues: ['no legal document found; page text not analyzed (privacy)'],
    optOutLinks: [], cached: false
  });
  rec.record('verdict', { risk: 'Unknown', label: 'Failed', score: 0, retrievalFailure: true, cached: false, optOutLinks: 0, unreadableDocs: 0 });
  finishEpisode('Failed');
  logStage("no-document short-circuit");
  return { summary, optOutLinks: [] };
}

const cacheVerificationText = buildCacheVerificationText(textToAnalyze);

// --- STEP 2: MEMORY AGENT ---
// Cache reads happen only after fetching current text, so Supabase can verify similarity.
let cacheOutcome = 'skipped';
let cacheSimilarity;
if (domain && fetched) {
  const supabaseResult = await readFromSupabase(domain, cacheVerificationText);
  if (supabaseResult && typeof supabaseResult.similarity === 'number' && Number.isFinite(supabaseResult.similarity)) {
    cacheSimilarity = supabaseResult.similarity;
  }
  if (!supabaseResult) {
    cacheOutcome = 'miss';
  } else if (!isCurrentSchemaSummary(supabaseResult.summary)) {
    cacheOutcome = 'stale-schema';
    console.log("[Orchestrator] Cached summary predates the current overlay schema (missing risk verdict or 'What They Collect') — re-analyzing to refresh");
  } else if (looksLikeLegalDocument(textToAnalyze) && !contentFingerprintMatches(supabaseResult.summary, textToAnalyze)) {
    // Only re-analyze on a fingerprint mismatch when the FRESH fetch is itself a
    // credible legal document. A nav-shell re-fetch (e.g. candidate-guessing on an
    // auth subdomain that returns an empty SPA shell) must NOT invalidate a good
    // cache and force a worse "couldn't read" re-analysis — serve the cache. (FIXPLAN #1b)
    cacheOutcome = 'stale-fingerprint';
    console.log("[Orchestrator] Source documents changed since cached (fingerprint mismatch) — re-analyzing");
  } else {
    const cachedEvaluation = validateEvaluation(
      evaluateAnalysis(stripInjectionWarning(stripHeadlineChrome(stripEvalChrome(supabaseResult.summary))))
    );
    if (isCacheableEvaluation(cachedEvaluation)) {
      // Keep the stored trusted bottom line + risk badge (gated at write time) by
      // stripping only the confidence chrome, which is recomposed just below.
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
      rec.record('cache', { read: 'hit', similarity: cacheSimilarity });
      {
        const riskMatch = /tg-risk\s+tg-risk-(low|moderate|high|unknown)/i.exec(supabaseResult.summary || '');
        const risk = riskMatch ? riskMatch[1][0].toUpperCase() + riskMatch[1].slice(1).toLowerCase() : 'Unknown';
        rec.record('verdict', {
          risk, label: 'Cached', score: cachedEvaluation.score, retrievalFailure: false, cached: true,
          optOutLinks: (supabaseResult.optOutLinks || []).length, unreadableDocs: 0
        });
      }
      finishEpisode('Cached');
      logStage("cache hit");
      return { summary: cachedSummary, optOutLinks: supabaseResult.optOutLinks };
    }
    cacheOutcome = 'quality-reject';
    console.warn("[Orchestrator] Cached summary failed local quality gate — running full analysis");
  }
  console.log("[Orchestrator] No semantic match — running full analysis");
}
rec.record('cache', { read: cacheOutcome, similarity: cacheSimilarity });
logStage("cache");

// --- STEP 2.5: INJECTION SCANNER ---
const scanResult = scanForInjection(textToAnalyze);
const safeText = scanResult.strippedText;
if (!scanResult.clean) {
  console.warn('[Orchestrator] Injection attempt detected — pattern stripped before analysis:', scanResult.pattern);
}
rec.record('scan', { injection: !scanResult.clean });

// --- STEP 3: LINK FOLLOWER AGENT ---
const privacyHtml = fetched ? fetched.privacyHtml : null;
const privacyUrl = fetched ? fetched.privacyUrl : null;
const linkResult = await linkFollowerStub(safeText, source, privacyHtml, privacyUrl, fetched?.hasSupplementalPrivacy || false);
const { text: enrichedText, optOutLinks } = linkResult;
logStage("link follower");
const displayOptOutLinks = [
  ...new Set(
    [...(fetched?.documentLinks || []), ...optOutLinks].map(upgradeInsecureUrl)
  )
].filter(url => validateLinkFollowerUrl(url) && isRelevantPrivacyActionUrl(url));
rec.record('links', {
  candidates: Number.isInteger(linkResult.candidates) ? linkResult.candidates : optOutLinks.length,
  followed: Number.isInteger(linkResult.followed) ? linkResult.followed : 0,
  displayed: displayOptOutLinks.length
});

const cacheSourceUrls = [...new Set([
  pageUrl,
  fetched?.sourceUrl,
  fetched?.privacyUrl,
  ...(fetched?.documentLinks || [])
].filter(Boolean).map(upgradeInsecureUrl))].filter(url => validateDocumentUrl(url));

const buildCacheContext = (providerTag, analysisSource) => ({
  domain,
  sourceUrls: cacheSourceUrls,
  optOutLinks: displayOptOutLinks,
  sourceFingerprint: contentFingerprint(textToAnalyze),
  schemaVersion: CACHE_SCHEMA_VERSION,
  aiProvider: providerTag,
  // Derive semantic verification text from the exact bounded source signed by
  // the Analyzer receipt. Building it from the larger pre-budget document can
  // cross a section boundary that the Analyzer reassembles, making a legitimate
  // excerpt fail the proxy's source-membership check. Slice that source as-is:
  // it is already sanitized, and re-sanitizing could alter it (a long line cut
  // at the cap), which also fails the membership check. (Found by the first
  // observed live run: Capital One and Navy Federal critic chains rejected.)
  privacyText: verificationSliceOf(analysisSource)
});

// Documents the fetcher couldn't read because they were scanned/image-based PDFs.
// Surfaced honestly in the overlay so the user knows an important doc was skipped.
const unreadableDocs = [
  ...new Set((fetched?.unreadablePdfUrls || []).map(upgradeInsecureUrl))
].filter(url => validateLinkFollowerUrl(url));

  // --- STEP 4: ANALYZER AGENT ---
  let result = null;
  let analyzerAttempts = 0;
  result = await runWithRetry(() => { analyzerAttempts++; return analyzeWithModel(enrichedText, source); }, "[Analyzer]");
  logStage("analyzer");

  if (result && result.summary) {
    result.providerAnalysis = result.providerAnalysis || result.summary;
    console.log(`[Orchestrator] Raw Analyzer output (${result.summary.length} chars):`, result.summary.slice(0, 300));
    result.summary = stripInjectionWarning(normalizeAnalysisHeaders(result.summary));
    if (isConfigurationMessage(result.summary)) {
      console.log("[Orchestrator] Configuration message returned — skipping critic/evaluator/escalation");
      await writeDebugResult({
        domain, url: pageUrl, score: null, label: 'Configuration',
        warning: result.summary, issues: ['configuration required'],
        optOutLinks: displayOptOutLinks, cached: false
      });
      rec.record('analyze', analyzeFactsFor(result, enrichedText, false, analyzerAttempts > 1));
      rec.record('verdict', { risk: 'Unknown', label: 'Configuration', score: 0, retrievalFailure: false, cached: false, optOutLinks: displayOptOutLinks.length, unreadableDocs: unreadableDocs.length });
      finishEpisode('Configuration');
      return result;
    }
  } else {
    console.warn('[Orchestrator] Analyzer returned:', JSON.stringify(result).slice(0, 300));
  }
  rec.record('analyze', analyzeFactsFor(result, enrichedText, false, analyzerAttempts > 1));

  // --- STEP 4.5: CRITIC/JUDGE AGENT ---
  let criticVerdict = null;
  let criticFailed = false;
  let cacheWriteReceipt = null;
  let activeCacheContext = result?.providerTag
    ? buildCacheContext(result.providerTag, result.analysisSource || enrichedText)
    : null;
  if (result) {
    const criticResult = await runCritic(
      result.summary,
      result.analysisSource || enrichedText,
      activeCacheContext ? {
        analysisReceipt: result.analysisReceipt,
        providerAnalysis: result.providerAnalysis,
        cacheContext: activeCacheContext
      } : null
    );
    if (criticResult && criticResult.failed) {
      // The critic was attempted but couldn't return a verdict — the quality gate did
      // not actually run. Fail-safe: don't feed a sentinel to the evaluator, and cap
      // confidence below so this can never be presented as a verified Strong.
      criticFailed = true;
      console.warn(`[Orchestrator] Critic could not verify the analysis — capping confidence (fail-safe)`);
    } else if (criticResult) {
      criticVerdict = criticResult;
      cacheWriteReceipt = criticResult._writeReceipt || null;
      console.log(`[Orchestrator] Critic verdict received — concern-flags: ${criticVerdict.flags?.length || 0}`);
    } else {
      console.log(`[Orchestrator] Critic not run (not configured) — continuing without`);
    }
    {
      const facts = criticFactsFor(criticResult);
      rec.record('critic', facts.data, facts.local);
    }
  }
  logStage("critic");

  // --- STEP 5: EVALUATOR AGENT + ESCALATION ---
  const rawEvaluation = evaluateAnalysis(result ? result.summary : null, criticVerdict);

  let evaluation = capForUnverifiedCritic(validateEvaluation(rawEvaluation), criticFailed);
  const criticCapApplied = criticFailed && !!rawEvaluation && rawEvaluation.label === 'Strong';

  console.log(`[Orchestrator] Evaluator — Label: ${evaluation.label}, Score: ${evaluation.score}`);

  // --- STEP 5b: THIN-SOURCE HONESTY GATE (FIXPLAN #7) ---
  // If the SOURCE we analyzed isn't a credible legal document (e.g. the real policy was
  // a scanned PDF that 400'd and we fell back to a thin nav shell), the analysis can't be
  // trusted no matter how confident the summary reads. Cap it to Failed with an honest
  // warning and DON'T escalate — a stronger model can't fix bad source text.
  let thinSourceCapApplied = false;
  if (result && evaluation.label !== 'Failed' && textToAnalyze && !looksLikeLegalDocument(textToAnalyze)) {
    console.log("[Orchestrator] Source is not a credible legal document — capping confidence (thin/unreadable source, no escalation)");
    thinSourceCapApplied = true;
    evaluation = validateEvaluation({
      score: Math.min(evaluation.score, 50),
      label: 'Failed',
      warning: '⚠️ The full policy could not be read — the page may be a scanned PDF or an unrendered document. This summary is likely incomplete; open the document yourself before agreeing.',
      passed: false,
      escalate: false,
      contradictions: Array.isArray(evaluation.contradictions) ? evaluation.contradictions : [],
      criticVerdict: evaluation.criticVerdict || criticVerdict || null
    });
  }
  rec.record('evaluate', {
    score: Number.isInteger(evaluation.score) ? evaluation.score : Math.round(evaluation.score),
    label: evaluation.label,
    issues: (Array.isArray(evaluation.issues) ? evaluation.issues : (rawEvaluation && Array.isArray(rawEvaluation.issues) ? rawEvaluation.issues : []))
      .slice(0, 40).map(i => String(i).slice(0, 200)),
    contradictions: Array.isArray(evaluation.contradictions) ? evaluation.contradictions.length : 0,
    thinSourceCap: thinSourceCapApplied,
    criticCap: criticCapApplied,
    escalate: !!evaluation.escalate
  });

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
      console.log(`[Orchestrator] Escalating to Opus — first-pass score: ${evaluation.score}, count: ${escalationCount + 1}/${CAP} (resets ${new Date(stored.resetAt).toLocaleTimeString()})`);
      let escalatedAttempts = 0;
      const escalatedResult = await runWithRetry(
        () => { escalatedAttempts++; return analyzeWithModel(enrichedText, source, true); },
        "[Analyzer-Opus]"
      );

      if (escalatedResult) {
        if (escalatedResult.summary) {
          escalatedResult.providerAnalysis = escalatedResult.providerAnalysis || escalatedResult.summary;
          escalatedResult.summary = stripInjectionWarning(normalizeAnalysisHeaders(escalatedResult.summary));
        }
        // Re-run Critic on escalated result
        const escalatedCacheContext = escalatedResult.providerTag
          ? buildCacheContext(escalatedResult.providerTag, escalatedResult.analysisSource || enrichedText)
          : null;
        const escalatedCriticResult = await runCritic(
          escalatedResult.summary,
          escalatedResult.analysisSource || enrichedText,
          escalatedCacheContext ? {
            analysisReceipt: escalatedResult.analysisReceipt,
            providerAnalysis: escalatedResult.providerAnalysis,
            cacheContext: escalatedCacheContext
          } : null
        );
        const escalatedCriticFailed = !!(escalatedCriticResult && escalatedCriticResult.failed);
        const escalatedCritic = escalatedCriticFailed ? null : escalatedCriticResult;
        const escalatedEvaluation = capForUnverifiedCritic(
          validateEvaluation(evaluateAnalysis(escalatedResult.summary, escalatedCritic)),
          escalatedCriticFailed
        );
        console.log(`[Orchestrator] Opus score: ${escalatedEvaluation.score} | Label: ${escalatedEvaluation.label}`);

        // FIXPLAN #2b — escalation is a QUALITY GATE, not a score-maximizer. The
        // stronger model may be MORE skeptical: if it finds the core privacy/
        // consumer-rights claims less grounded than the first pass did, or detects a
        // retrieval failure the first pass missed, that downgrade must be honored —
        // not discarded for the rosier first pass (which would overstate confidence
        // on a document we couldn't actually read).
        const escalatedWorseGrounding =
          (mentionsRetrievalFailure(escalatedResult.summary) && !mentionsRetrievalFailure(result.summary)) ||
          coreCriticConcernCount(escalatedCritic) > coreCriticConcernCount(criticVerdict);

        let escalationReason = 'not-better';
        if (escalatedEvaluation.score > evaluation.score) {
          result = escalatedResult;
          evaluation = escalatedEvaluation;
          criticVerdict = escalatedCritic;
          cacheWriteReceipt = escalatedCriticResult?._writeReceipt || null;
          activeCacheContext = escalatedCacheContext;
          escalatedAccepted = true;
          escalationReason = 'higher-score';
          console.log(`[Orchestrator] Opus result accepted — higher quality score`);
        } else if (escalatedWorseGrounding) {
          result = escalatedResult;
          evaluation = escalatedEvaluation;
          criticVerdict = escalatedCritic;
          cacheWriteReceipt = escalatedCriticResult?._writeReceipt || null;
          activeCacheContext = escalatedCacheContext;
          escalatedAccepted = true;
          escalationReason = 'conservative-grounding';
          console.log(`[Orchestrator] Opus downgraded core grounding — adopting the more conservative result`);
        } else {
          console.log(`[Orchestrator] Opus result not better — keeping first-pass result`);
        }
        {
          const facts = analyzeFactsFor(escalatedResult, enrichedText, true, escalatedAttempts > 1);
          rec.record('escalate', {
            attempted: true, capReached: false,
            model: facts.model, stopReason: facts.stopReason, usage: facts.usage, status: facts.status,
            score: Number.isInteger(escalatedEvaluation.score) ? escalatedEvaluation.score : Math.round(escalatedEvaluation.score),
            label: escalatedEvaluation.label,
            accepted: escalatedAccepted, reason: escalationReason,
            criticRan: !!escalatedCriticResult, criticFailed: escalatedCriticFailed,
            criticConcerns: coreCriticConcernCount(escalatedCritic)
          });
        }

        stored.count = escalationCount + 1;
        await browser.storage.local.set({ [capKey]: stored });
        // The Supabase write happens once, in Step 6 below, after the trusted
        // verdict badge is composed. Writing here too would race that write
        // (both fire-and-forget on the same domain) and persist a pre-badge
        // duplicate tagged 'anthropic-escalated' even when the Haiku result
        // was kept.
      } else {
        rec.record('escalate', { attempted: true, capReached: false, status: 'error', accepted: false, reason: 'failed' });
      }
    } else {
      console.log(`[Orchestrator] Opus cap reached (${escalationCount}/${CAP}) — using first-pass result. Resets ${new Date(stored.resetAt).toLocaleTimeString()}`);
      rec.record('escalate', { attempted: false, capReached: true, accepted: false, reason: 'cap' });
    }
  }

  let trustedRisk = 'Unknown';
  let trustedBottomLine = '';
  let genuineRetrievalFailure = false;
  if (result) {
    // The analyzer PROPOSES a one-line bottom line + risk word. Extract them
    // BEFORE stripping, then decide the trusted verdict ourselves.
    result.summaryBeforeTrustedChrome = result.summary;
    const headline = extractAnalyzerHeadline(result.summary);

    // Trusted risk verdict, gated by analysis confidence: if we couldn't
    // reliably read the document, never show a reassuring risk — say so. A
    // poisoned document therefore can't force a green verdict. (extends SECURITY-022)
    if (isGenuineRetrievalFailure(result.summary, criticVerdict)) {
      // We genuinely couldn't read the document (nav shell / placeholder) — say so.
      genuineRetrievalFailure = true;
      trustedRisk = 'Unknown';
      trustedBottomLine = "We couldn't reliably read this document. Open it yourself before agreeing.";
    } else if (evaluation.label === 'Failed') {
      // We read it, but the analysis couldn't be verified as reliable. Don't show a
      // reassuring risk — but don't falsely claim we couldn't read it either.
      trustedRisk = 'Unknown';
      trustedBottomLine = "We couldn't fully verify this analysis. Review the document yourself before agreeing.";
    } else {
      trustedRisk = RISK_LEVELS.includes(headline.risk) ? headline.risk : 'Unknown';
      trustedBottomLine = headline.bottomLine;
    }
    const cleanBottomLine = (trustedBottomLine || '').replace(/<[^>]+>/g, '').trim();

    // Strip any verdict/warning/risk markup the analyzer may have echoed from
    // attacker-controlled document text, so only the trusted chrome composed
    // below can ever render as UI. (SECURITY-022 + risk verdict)
    result.summary = stripHeadlineChrome(stripEvalChrome(result.summary));
    if (!scanResult.clean) {
      result.summary = `⚠️ Possible injection attempt detected in document\n${result.summary}`;
    }
    if (evaluation.warning) {
      result.summary = `<div class="tg-eval-warning">${evaluation.warning}</div>\n` + result.summary;
    }
    // Trusted chrome appended last, so the renderer's anti-spoof "take the last
    // one" rule selects these and never an echoed copy.
    if (cleanBottomLine) {
      result.summary += `\n<div class="tg-bottomline">${cleanBottomLine}</div>`;
    }
    result.summary += `\n<div class="tg-risk tg-risk-${trustedRisk.toLowerCase()}">${trustedRisk}</div>`;
    result.summary += `\n<div class="tg-eval-badge tg-eval-${evaluation.label.toLowerCase()}">Analysis confidence: ${evaluation.label} (${evaluation.score}/100)</div>`;
    // Stamp the current cache-schema version so this entry is recognized as fresh
    // on later reads (and so a future version bump retires it). (See tosUtils.)
    result.summary += `\n${cacheSchemaStamp()}`;
    // Stamp a fingerprint of the full source doc set so a later read can detect
    // when the underlying documents have materially changed and re-analyze.
    result.summary += `\n${contentFingerprintStamp(textToAnalyze)}`;
  }

  if (!result) {
    console.error("[Orchestrator] Analyzer failed after retry — returning fallback");
    const fallbackSummary = "TOS Guardian was unable to analyze this document. Please try again.";
    await writeDebugResult({
      domain, url: pageUrl, score: null, label: 'Error',
      warning: fallbackSummary, issues: ['analyzer failed after retry'],
      optOutLinks: displayOptOutLinks, cached: false
    });
    rec.record('verdict', { risk: 'Unknown', label: 'Error', score: 0, retrievalFailure: false, cached: false, optOutLinks: displayOptOutLinks.length, unreadableDocs: unreadableDocs.length });
    finishEpisode('Error');
    return { summary: fallbackSummary };
  }

  rec.record('verdict', {
    risk: trustedRisk,
    label: evaluation.label,
    score: Number.isInteger(evaluation.score) ? evaluation.score : Math.round(evaluation.score),
    retrievalFailure: genuineRetrievalFailure,
    cached: false,
    optOutLinks: displayOptOutLinks.length,
    unreadableDocs: unreadableDocs.length
  }, trustedBottomLine ? { bottomLine: String(trustedBottomLine).slice(0, 400) } : undefined);

  // --- STEP 6: SAVE TO MEMORY ---
  if (domain && isCacheableEvaluation(evaluation)) {
    saveAnalysis(domain, result.summary, activeCacheContext?.privacyText || cacheVerificationText, displayOptOutLinks,
      activeCacheContext?.aiProvider || result.providerTag || 'anthropic',
      cacheWriteReceipt && activeCacheContext ? {
        writeReceipt: cacheWriteReceipt,
        analysisSummary: result.summaryBeforeTrustedChrome || result.summary,
        cacheContext: activeCacheContext
      } : null,
      (outcome) => { if (outcome && typeof outcome === 'object') rec.record('write', outcome); });
    console.log("[Orchestrator] Analysis saved to memory for:", domain);
  } else if (domain) {
    console.log("[Orchestrator] Analysis not saved — quality gate did not pass:", evaluation.label);
    rec.record('write', { attempted: false, result: 'skipped-quality' });
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
  finishEpisode(evaluation.label);
  return { summary: result.summary, optOutLinks: displayOptOutLinks, unreadableDocs };
}

// FAIL-SAFE for an unverified analysis: when the critic was ATTEMPTED but couldn't
// return a verdict, the quality gate didn't actually run — so the result must never
// be presented as a verified Strong. Cap it to Adequate with an honest "couldn't
// fully verify" note. It still passes/caches (the content may well be fine), but
// confidence is never overstated on an unchecked analysis. Only Strong is capped;
// Adequate/Failed already carry appropriately hedged framing.
function capForUnverifiedCritic(evaluation, criticFailed) {
  if (!criticFailed || !evaluation || evaluation.label !== 'Strong') return evaluation;
  return validateEvaluation({
    score: Math.min(evaluation.score, 90),
    label: 'Adequate',
    warning: '⚠️ We could not fully verify this analysis with our quality checker, so confidence is capped. Treat it as a starting point and review the source documents before relying on it.',
    passed: true,
    escalate: false,
    contradictions: Array.isArray(evaluation.contradictions) ? evaluation.contradictions : [],
    criticVerdict: null
  });
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
  return verificationSliceOf(sanitized);
}

// The verification slice of an ALREADY-sanitized source: from the privacy
// policy marker (or the start) to the same 10,000-char bound the proxy accepts.
// Never re-sanitizes, so the result is always a substring of its input, which
// the proxy's receipt chain requires.
function verificationSliceOf(sanitizedText) {
  const text = typeof sanitizedText === 'string' ? sanitizedText : '';
  const privacyStart = text.indexOf("=== PRIVACY POLICY");
  return (privacyStart > -1 ? text.slice(privacyStart) : text).slice(0, 10000);
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
    return { text, optOutLinks: [], candidates: 0, followed: 0 };
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
          const r = await proxyFetch(`${PROXY_URL}/fetch-document`, {
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
    return { text, optOutLinks: uniqueLinks, candidates: uniqueLinks.length, followed: 0 };
  }

  console.log(`[LinkFollower] Appending ${appendSections.length} opt-out sections to document`);
  return {
    text: text + "\n\n" + appendSections.join("\n\n"),
    optOutLinks: followedLinks,
    candidates: uniqueLinks.length,
    followed: followedLinks.length
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
