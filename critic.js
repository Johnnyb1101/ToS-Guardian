// TOS Guardian — Critic/Judge Agent
// LLM-based quality gate between Analyzer and Evaluator.
// Checks whether the Analyzer's claims are grounded in the source document.

const CRITIC_SOURCE_BUDGET = 60000;
const CRITIC_MAX_TOKENS = 600;

const CRITIC_MODELS = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
  ollama: 'llama3'
};

const CRITIC_SYSTEM = `You are a fact-checking judge. You receive an AI-generated privacy analysis and the original legal document it was based on. Your job is to check whether each section of the analysis is actually supported by the source document.

For each section, respond with exactly one verdict:
- "grounded" — the claims are supported by the source text
- "unsupported" — the claims contain information not found in the source text
- "vague" — the section exists but is too generic to be useful (e.g., "check your settings" with no specifics when the document gives specifics)
- "skipped" — the section says "not covered" and the source text genuinely does not cover it

Respond in ONLY this JSON format, no other text:
{"dataSelling":"verdict","optOutRights":"verdict","howToOptOut":"verdict","autoRenewal":"verdict","dataDeletion":"verdict","flags":["short explanation of any unsupported or vague finding"]}`;

async function runCritic(analysisSummary, sourceText) {
  if (!analysisSummary || !sourceText) return null;

  const settings = await new Promise(resolve => {
    browser.storage.local.get(
      ['selectedProvider', 'apiKey_anthropic', 'apiKey_openai', 'ollamaBaseUrl'],
      resolve
    );
  });

  const provider = settings.selectedProvider || 'anthropic';
  const model = CRITIC_MODELS[provider];
  if (!model) {
    console.log('[Critic] No critic model for provider:', provider);
    return null;
  }

  const privacyIndex = sourceText.indexOf('=== PRIVACY POLICY');
  const privacySection = privacyIndex > -1 ? sourceText.slice(privacyIndex) : '';
  const otherSection = privacyIndex > -1 ? sourceText.slice(0, privacyIndex) : sourceText;
  const trimmedSource = [
    otherSection.slice(0, Math.floor(CRITIC_SOURCE_BUDGET * 0.3)),
    privacySection.slice(0, Math.floor(CRITIC_SOURCE_BUDGET * 0.7))
  ].filter(Boolean).join('\n\n');

  const userMessage = `ANALYSIS TO CHECK:
${analysisSummary}

SOURCE DOCUMENT (excerpt):
${trimmedSource}`;

  console.log(`[Critic] Running quality check — provider: ${provider}, model: ${model}`);

  try {
    let responseText = null;

    if (provider === 'anthropic') {
      const apiKey = settings.apiKey_anthropic || '';
      if (!apiKey) return null;

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify({
          model,
          max_tokens: CRITIC_MAX_TOKENS,
          system: CRITIC_SYSTEM,
          messages: [{ role: "user", content: userMessage }]
        })
      });

      const data = await response.json();
      responseText = data.content?.[0]?.text;
    }

    if (provider === 'openai') {
      const apiKey = settings.apiKey_openai || '';
      if (!apiKey) return null;

      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
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
    }

    if (!responseText) {
      console.warn('[Critic] No response text');
      return null;
    }

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[Critic] Could not extract JSON from response');
      return null;
    }

    const verdict = JSON.parse(jsonMatch[0]);

    const validVerdicts = ['grounded', 'unsupported', 'vague', 'skipped'];
    const fields = ['dataSelling', 'optOutRights', 'howToOptOut', 'autoRenewal', 'dataDeletion'];
    for (const field of fields) {
      if (!validVerdicts.includes(verdict[field])) {
        console.warn(`[Critic] Invalid verdict for ${field}: ${verdict[field]}`);
        return null;
      }
    }

    if (!Array.isArray(verdict.flags)) {
      verdict.flags = [];
    }

    const unsupported = fields.filter(f => verdict[f] === 'unsupported').length;
    const vague = fields.filter(f => verdict[f] === 'vague').length;

    console.log(`[Critic] Verdicts — unsupported: ${unsupported}, vague: ${vague}, flags: ${verdict.flags.length}`);
    for (const field of fields) {
      console.log(`[Critic]   ${field}: ${verdict[field]}`);
    }

    return verdict;

  } catch (e) {
    console.warn('[Critic] Failed — pipeline continues without critic:', e.message);
    return null;
  }
}
