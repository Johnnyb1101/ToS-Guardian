// TOS Guardian — batch runner helpers.
//
// Pure functions used by tools/batch-runner.js, split out so they can be unit
// tested without network, a vm context, or a proxy (tests/batch-lib.test.js).
// Nothing here is loaded by the extension.

'use strict';

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------
// List prices in US dollars per million tokens, keyed by the EXACT model id the
// proxy reports on every /v2/analyze response. Prices are the Anthropic first-
// party list as of PRICING_AS_OF; update the table and the date together.
//
// A model with no entry is never guessed at: its calls are counted as
// "unpriced" and reported separately, so a model change on the proxy shows up
// as a visible gap in the cost column instead of a silently wrong number.
const PRICING_AS_OF = '2026-06-24';
const PRICING_PER_MTOK = Object.freeze({
  'claude-opus-5':     Object.freeze({ input: 5.00, output: 25.00 }),
  'claude-opus-4-8':   Object.freeze({ input: 5.00, output: 25.00 }),
  'claude-opus-4-7':   Object.freeze({ input: 5.00, output: 25.00 }),
  'claude-opus-4-6':   Object.freeze({ input: 5.00, output: 25.00 }),
  'claude-sonnet-5':   Object.freeze({ input: 2.00, output: 10.00 }),
  'claude-sonnet-4-6': Object.freeze({ input: 3.00, output: 15.00 }),
  'claude-haiku-4-5':  Object.freeze({ input: 1.00, output: 5.00 })
});
// Prompt-cache accounting: reads bill at a tenth of the input rate, writes at a
// quarter over it.
const CACHE_READ_MULTIPLIER = 0.10;
const CACHE_WRITE_MULTIPLIER = 1.25;

function priceFor(model) {
  return PRICING_PER_MTOK[String(model || '')] || null;
}

// A usage record is { model, provider, input, output, cacheRead, cacheWrite }
// with token counts as non-negative integers. Returns the call's cost in
// dollars, or null when the model is unpriced.
function callCost(record) {
  const price = priceFor(record && record.model);
  if (!price) return null;
  return (
    record.input * price.input +
    record.output * price.output +
    record.cacheRead * price.input * CACHE_READ_MULTIPLIER +
    record.cacheWrite * price.input * CACHE_WRITE_MULTIPLIER
  ) / 1e6;
}

// Sum a run's usage records. `unpriced` counts calls whose model had no entry.
function estimateCost(records) {
  let cost = 0;
  let unpriced = 0;
  for (const record of records || []) {
    const c = callCost(record);
    if (c === null) unpriced++;
    else cost += c;
  }
  return { cost, unpriced };
}

// ---------------------------------------------------------------------------
// Usage records from the proxy
// ---------------------------------------------------------------------------
// The proxy's /v2/analyze response carries { model, provider, usage } where
// usage is already normalized to { inputTokens, outputTokens, cacheReadTokens,
// cacheWriteTokens }. Older proxies omit usage; that still yields a record with
// zero tokens so the call is counted even when it cannot be priced.
function usageRecordFromProxyResponse(data) {
  if (!data || typeof data !== 'object' || typeof data.model !== 'string' || data.model.length === 0) {
    return null;
  }
  const usage = data.usage && typeof data.usage === 'object' ? data.usage : {};
  const count = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  return {
    model: data.model,
    provider: typeof data.provider === 'string' ? data.provider : '',
    input: count(usage.inputTokens),
    output: count(usage.outputTokens),
    cacheRead: count(usage.cacheReadTokens),
    cacheWrite: count(usage.cacheWriteTokens)
  };
}

// ---------------------------------------------------------------------------
// Proxy target
// ---------------------------------------------------------------------------
const PRODUCTION_PROXY_URL = 'https://tos-guardian-proxy-production.up.railway.app';

// The runner refuses to pick a proxy silently. A dev proxy is chosen with
// --proxy <url> or TOS_PROXY_URL; spending the production key takes an explicit
// --production. An explicit --proxy pointing at production is honored but
// reported as production so the runner can print its warning.
function resolveProxyTarget({ proxy, production, env } = {}) {
  const candidate = proxy || (env && env.TOS_PROXY_URL) || null;
  if (candidate) {
    let parsed;
    try { parsed = new URL(candidate); }
    catch (e) { return { error: `proxy URL is not valid: ${candidate}` }; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { error: 'proxy URL must use http or https' };
    }
    const url = parsed.origin;
    return { url, isProduction: url === PRODUCTION_PROXY_URL };
  }
  if (production) return { url: PRODUCTION_PROXY_URL, isProduction: true };
  return {
    error: 'no proxy target: pass --proxy <url> (or set TOS_PROXY_URL) to use a dev proxy, ' +
           'or --production to spend the production key deliberately'
  };
}

// background.js declares its proxy as a top-level const, which a vm context
// cannot reassign after the fact. The runner rewrites that one declaration in
// the source text before running it. Throws if the declaration moved, so a
// refactor cannot make the override silently stop applying.
const PROXY_DECLARATION = /^const PROXY_URL = "[^"]+";/m;

function applyProxyOverride(source, url) {
  if (!PROXY_DECLARATION.test(source)) {
    throw new Error('background.js no longer declares `const PROXY_URL = "..."` at the top level; update tools/batch-lib.js');
  }
  return source.replace(PROXY_DECLARATION, `const PROXY_URL = ${JSON.stringify(url)};`);
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------
// A run stops before starting the next site once its priced cost reaches the
// budget. Unpriced calls cannot count toward it, which is one more reason the
// pricing table must be kept current.
function budgetExceeded(totalCost, budget) {
  return Number.isFinite(budget) && budget > 0 && totalCost >= budget;
}

module.exports = {
  PRICING_AS_OF,
  PRICING_PER_MTOK,
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  PRODUCTION_PROXY_URL,
  priceFor,
  callCost,
  estimateCost,
  usageRecordFromProxyResponse,
  resolveProxyTarget,
  applyProxyOverride,
  budgetExceeded
};
