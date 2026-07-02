// TOS Guardian — Critic/Judge Agent
// LLM-based quality gate between Analyzer and Evaluator.
// Checks whether the Analyzer's claims are grounded in the source document.

const CRITIC_SOURCE_BUDGET = 100000;
const CRITIC_MAX_TOKENS = 600;

const CRITIC_MODELS = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o-mini',
  ollama: 'llama3'
};

const CRITIC_SYSTEM = `You are a fact-checking judge. You receive an AI-generated privacy analysis and the original legal document it was based on. Your job is to check whether each section of the analysis is actually supported by the source document.

For each section, respond with exactly one verdict:
- "grounded" — every material claim in that section is clearly supported by the source text
- "unsupported" — any material claim in that section is not found in the source text, overstates the source, or is only partially supported
- "vague" — the section is supported but too generic to be useful (e.g., "check your settings" with no specifics when the document gives specifics)
- "skipped" — the section says "not covered" and the source text genuinely does not cover it

Accept faithful plain-English paraphrases of legal table labels. For example, if a financial privacy notice says users can "limit our affiliates from marketing to you", an analysis saying "You can limit affiliates from marketing to you" is grounded. Do not require exact wording, but do require the same recipient category, data category, and user action.

Do not invent other verdict labels. Do not use "partially_grounded", "partially supported", "mixed", or "unclear". If support is partial, use "unsupported". If a section is true but underspecified, use "vague".

Respond in ONLY this JSON format, no other text:
{"dataCollection":"verdict","dataSelling":"verdict","optOutRights":"verdict","howToOptOut":"verdict","autoRenewal":"verdict","dataDeletion":"verdict","flags":["short explanation of any unsupported or vague finding"]}`;

// Returns one of: a verdict object (success); `null` when the critic was NOT run
// (nothing to check, or no model/key configured); or `{ failed: true }` when it WAS
// attempted but couldn't produce a verdict (no response / unparseable / error). The
// orchestrator treats the last case as fail-safe — confidence is capped, never Strong.
async function runCritic(analysisSummary, sourceText) {
  if (!analysisSummary || !sourceText) return null;

  // Provider preference + local-Ollama URL only — API keys live on the proxy
  // (audit refactor #5); the /analyze relay attaches them server-side.
  const settings = await new Promise(resolve => {
    browser.storage.local.get(['selectedProvider', 'ollamaBaseUrl'], resolve);
  });

  const provider = settings.selectedProvider || 'anthropic';
  const model = CRITIC_MODELS[provider];
  if (!model) {
    console.log('[Critic] No critic model for provider:', provider);
    return null;
  }

  const trimmedSource = buildCriticSourceExcerpt(sourceText);

  const userMessage = `ANALYSIS TO CHECK:
${analysisSummary}

SOURCE DOCUMENT (excerpt):
${trimmedSource}`;

  console.log(`[Critic] Running quality check — provider: ${provider}, model: ${model}`);

  try {
    let responseText = null;
    let stopReason = null;

    if (provider === 'anthropic' || provider === 'openai') {
      // Relay through the proxy — no API key in the browser (audit refactor #5).
      // NOT escalated: the critic always runs on the provider's default (cheap)
      // model, which the proxy's llmRelay.js model map keeps in sync with
      // CRITIC_MODELS above.
      const response = await proxyFetch(`${PROXY_URL}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          system: CRITIC_SYSTEM,
          user: userMessage,
          maxTokens: CRITIC_MAX_TOKENS
        })
      });

      if (response.status === 503) {
        // No key configured on the server — same semantics as the old "no key
        // in storage" path: the critic was NOT run (null), not a failed run.
        console.log('[Critic] Provider key not configured on proxy — skipping critic');
        return null;
      }

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        console.warn(`[Critic] Relay error (${response.status}): ${data.reason || data.error || 'unknown'}`);
        return { failed: true };
      }
      responseText = data.text;
      stopReason = data.stopReason; // "end_turn" | "max_tokens" | "stop" | "length" | ...
    }

    if (provider === 'ollama') {
      const baseUrl = settings.ollamaBaseUrl || 'http://localhost:11434';

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          max_tokens: CRITIC_MAX_TOKENS,
          messages: [
            { role: "system", content: CRITIC_SYSTEM },
            { role: "user", content: userMessage }
          ]
        })
      });

      const data = await response.json();
      responseText = data.choices?.[0]?.message?.content;
      stopReason = data.choices?.[0]?.finish_reason;
    }

    if (!responseText) {
      console.warn(`[Critic] No response text (stop_reason: ${stopReason || 'unknown'})`);
      return { failed: true };
    }

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // Diagnostic (observability only): capture WHY extraction failed so the next
      // occurrence tells us truncation ("max_tokens"/"length" + no closing brace) vs a
      // malformed/prose response. Snippet is head+tail, trimmed, no behavior change.
      const txt = String(responseText);
      const hasOpenBrace = txt.includes('{');
      const snippet = txt.length > 280
        ? `${txt.slice(0, 200)} … ${txt.slice(-80)}`
        : txt;
      console.warn(
        `[Critic] Could not extract JSON — len: ${txt.length}, stop_reason: ${stopReason || 'unknown'}, ` +
        `hasOpenBrace: ${hasOpenBrace} (likely ${stopReason === 'max_tokens' || stopReason === 'length' || (hasOpenBrace && !txt.includes('}')) ? 'TRUNCATED' : 'malformed/non-JSON'}). ` +
        `Response: ${JSON.stringify(snippet)}`
      );
      return { failed: true };
    }

    const verdict = JSON.parse(jsonMatch[0]);

    const validVerdicts = ['grounded', 'unsupported', 'vague', 'skipped'];
    const fields = ['dataCollection', 'dataSelling', 'optOutRights', 'howToOptOut', 'autoRenewal', 'dataDeletion'];
    for (const field of fields) {
      const rawVerdict = verdict[field];
      // A field the model omitted entirely can't be judged — treat as 'skipped'
      // (no penalty) rather than 'unsupported', so a malformed/partial response
      // doesn't wrongly tank the score (matters most for newer fields).
      if (rawVerdict === undefined || rawVerdict === null || rawVerdict === '') {
        verdict[field] = 'skipped';
        continue;
      }
      const normalized = normalizeCriticVerdict(rawVerdict);
      if (!validVerdicts.includes(normalized)) {
        console.warn(`[Critic] Invalid verdict for ${field}: ${rawVerdict} — treating as unsupported`);
        verdict[field] = 'unsupported';
        verdict.flags = Array.isArray(verdict.flags) ? verdict.flags : [];
        verdict.flags.push(`${field}: invalid critic verdict "${rawVerdict}" treated as unsupported`);
      } else {
        verdict[field] = normalized;
      }
    }

    if (!Array.isArray(verdict.flags)) {
      verdict.flags = [];
    }
    // `flags` = genuine concern explanations (unsupported/vague findings, invalid
    // verdicts). `adjustments` = informational notes for deterministic grounding
    // flips (unsupported→grounded) — these are NOT concerns and were inflating the
    // logged flags count (e.g. all-grounded but "flags: 4"). (FIXPLAN #11)
    verdict.adjustments = [];

    applyDeterministicGrounding(verdict, analysisSummary, sourceText);

    const unsupported = fields.filter(f => verdict[f] === 'unsupported').length;
    const vague = fields.filter(f => verdict[f] === 'vague').length;

    const adj = verdict.adjustments.length ? `, grounding-adjustments: ${verdict.adjustments.length}` : '';
    console.log(`[Critic] Verdicts — unsupported: ${unsupported}, vague: ${vague}, concern-flags: ${verdict.flags.length}${adj}`);
    for (const field of fields) {
      console.log(`[Critic]   ${field}: ${verdict[field]}`);
    }

    return verdict;

  } catch (e) {
    console.warn('[Critic] Failed — pipeline continues without critic:', e.message);
    return { failed: true };
  }
}

function normalizeCriticVerdict(value) {
  const verdict = String(value || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  if (
    verdict === 'partially_grounded' ||
    verdict === 'partially_supported' ||
    verdict === 'mixed' ||
    verdict === 'unclear'
  ) {
    return 'unsupported';
  }
  return verdict;
}

function applyDeterministicGrounding(verdict, analysisSummary, sourceText) {
  const analysis = String(analysisSummary || '').toLowerCase();
  const source = String(sourceText || '').toLowerCase();

  // Grounding flips are informational adjustments, not concerns — keep them out of
  // `flags` so the logged concern count matches the per-section verdicts. (FIXPLAN #11)
  if (!Array.isArray(verdict.adjustments)) verdict.adjustments = [];

  if (verdict.dataSelling === 'unsupported' && hasFinancialSharingGrounding(analysis, source)) {
    verdict.dataSelling = 'grounded';
    verdict.adjustments.push('dataSelling: deterministic grounding matched financial privacy notice categories');
  }

  if (verdict.optOutRights === 'unsupported' && hasFinancialOptOutGrounding(analysis, source)) {
    verdict.optOutRights = 'grounded';
    verdict.adjustments.push('optOutRights: deterministic grounding matched financial privacy notice limit/opt-out categories');
  }

  if (verdict.howToOptOut === 'unsupported' && hasFinancialHowToGrounding(analysis, source)) {
    verdict.howToOptOut = 'grounded';
    verdict.adjustments.push('howToOptOut: deterministic grounding matched financial privacy notice contact instructions');
  }

  if (verdict.dataDeletion === 'unsupported' && hasDeletionGrounding(analysis, source)) {
    verdict.dataDeletion = 'grounded';
    verdict.adjustments.push('dataDeletion: deterministic grounding matched manage/delete data instructions');
  }
}

function hasFinancialSharingGrounding(analysis, source) {
  const sourceHasCategories = [
    'affiliates',
    'nonaffiliates',
    'joint marketing',
    'service providers'
  ].filter(term => source.includes(term)).length >= 3;

  const analysisUsesCategories = [
    'affiliates',
    'nonaffiliates',
    'joint marketing',
    'service providers'
  ].filter(term => analysis.includes(term)).length >= 3;

  const sourceHasDataTypes = /transaction|experience|creditworthiness|marketing|financial product|service offering/.test(source);
  return sourceHasCategories && analysisUsesCategories && sourceHasDataTypes;
}

function hasFinancialOptOutGrounding(analysis, source) {
  const sourceHasLimits = /limit (our )?sharing|limit (our )?affiliates|limit (our )?nonaffiliates|opt out|unsubscribe|global privacy control|cross[- ]context behavioral advertising/i.test(source);
  const analysisHasActions = /you can (limit|opt out|unsubscribe)|global privacy control|cross[- ]context behavioral advertising/i.test(analysis);
  return sourceHasLimits && analysisHasActions;
}

function hasFinancialHowToGrounding(analysis, source) {
  const sourceHasContact = /1[-–—\s]?888[-–—\s]?817[-–—\s]?2970|1[-–—\s]?888[-–—\s]?480[-–—\s]?3282|manage your data|global privacy control|unsubscribe/i.test(source);
  const analysisHasContact = /1[-–—\s]?888[-–—\s]?817[-–—\s]?2970|1[-–—\s]?888[-–—\s]?480[-–—\s]?3282|manage your data|global privacy control|unsubscribe/i.test(analysis);
  return sourceHasContact && analysisHasContact;
}

function hasDeletionGrounding(analysis, source) {
  const sourceHasDeletion = /delete|deletion|manage your data|request.*personal information|access.*or.*delete/i.test(source);
  const analysisHasDeletion = /delete|deletion|manage your data|request.*personal information/i.test(analysis);
  return sourceHasDeletion && analysisHasDeletion;
}

function buildCriticSourceExcerpt(sourceText) {
  if (sourceText.length <= CRITIC_SOURCE_BUDGET) {
    return sourceText;
  }

  const supplementalMatch = sourceText.search(/=== (SUPPLEMENTAL PRIVACY NOTICE|OPT-OUT \/ PRIVACY PAGE):/);
  const baseText = supplementalMatch > -1 ? sourceText.slice(0, supplementalMatch) : sourceText;
  const supplementalText = supplementalMatch > -1 ? sourceText.slice(supplementalMatch) : '';

  const privacyIndex = baseText.indexOf('=== PRIVACY POLICY');
  const privacySection = privacyIndex > -1 ? baseText.slice(privacyIndex) : '';
  const otherSection = privacyIndex > -1 ? baseText.slice(0, privacyIndex) : baseText;

  if (supplementalText) {
    return [
      otherSection.slice(0, Math.floor(CRITIC_SOURCE_BUDGET * 0.15)),
      privacySection.slice(0, Math.floor(CRITIC_SOURCE_BUDGET * 0.35)),
      supplementalText.slice(0, Math.floor(CRITIC_SOURCE_BUDGET * 0.50))
    ].filter(Boolean).join('\n\n');
  }

  return [
    otherSection.slice(0, Math.floor(CRITIC_SOURCE_BUDGET * 0.3)),
    privacySection.slice(0, Math.floor(CRITIC_SOURCE_BUDGET * 0.7))
  ].filter(Boolean).join('\n\n');
}
