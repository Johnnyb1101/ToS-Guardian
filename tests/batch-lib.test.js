// TOS Guardian — batch runner helper tests (tools/batch-lib.js)
// Run: node tests/batch-lib.test.js
//
// Pins the pieces of the batch runner that decide what a run costs and where
// it sends its calls: pricing by exact model id, cache accounting, the
// unpriced-call rule, usage records from the proxy response, proxy target
// resolution (a dev proxy or an explicit --production, never a silent default),
// the source rewrite that points background.js at the chosen proxy, and the
// budget stop.

const fs = require('fs');
const path = require('path');
const lib = require('../tools/batch-lib');

const repoRoot = path.resolve(__dirname, '..');
let passed = 0;
let failed = 0;

function ok(label, condition, detail = '') {
  if (condition) { console.log(`  ok    ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

function near(a, b, eps = 1e-9) { return Math.abs(a - b) < eps; }

console.log('Batch runner helpers');

// --- pricing ---------------------------------------------------------------
ok('known model is priced', lib.priceFor('claude-sonnet-4-6') !== null);
ok('unknown model is not priced', lib.priceFor('claude-imaginary-9') === null);
ok('empty model is not priced', lib.priceFor('') === null && lib.priceFor(undefined) === null);
ok('pricing table carries its as-of date', /^\d{4}-\d{2}-\d{2}$/.test(lib.PRICING_AS_OF));

{
  // 1M input at $3 + 1M output at $15 = $18 exactly.
  const cost = lib.callCost({ model: 'claude-sonnet-4-6', input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 });
  ok('call cost uses the exact model id price', near(cost, 18), `got ${cost}`);
}
{
  // 1M cache-read tokens bill at a tenth of the $3 input rate = $0.30.
  const cost = lib.callCost({ model: 'claude-sonnet-4-6', input: 0, output: 0, cacheRead: 1e6, cacheWrite: 0 });
  ok('cache reads bill at the read multiplier', near(cost, 0.30), `got ${cost}`);
}
{
  // 1M cache-write tokens bill at 1.25x the $3 input rate = $3.75.
  const cost = lib.callCost({ model: 'claude-sonnet-4-6', input: 0, output: 0, cacheRead: 0, cacheWrite: 1e6 });
  ok('cache writes bill at the write multiplier', near(cost, 3.75), `got ${cost}`);
}
ok('unpriced model call cost is null, not zero',
  lib.callCost({ model: 'gpt-4o-mini', input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 }) === null);

{
  const { cost, unpriced } = lib.estimateCost([
    { model: 'claude-opus-4-8', input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 },   // $5
    { model: 'gpt-4o-mini', input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 },       // unpriced
    { model: 'claude-haiku-4-5', input: 0, output: 1e6, cacheRead: 0, cacheWrite: 0 }   // $5
  ]);
  ok('run cost sums priced calls only', near(cost, 10), `got ${cost}`);
  ok('run cost reports the unpriced call count', unpriced === 1, `got ${unpriced}`);
  ok('empty run costs nothing', lib.estimateCost([]).cost === 0 && lib.estimateCost(undefined).cost === 0);
}

// --- usage records from the proxy -------------------------------------------
{
  const record = lib.usageRecordFromProxyResponse({
    text: '...', stopReason: 'end_turn', model: 'claude-sonnet-4-6', provider: 'anthropic',
    usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 40, cacheWriteTokens: 5 }
  });
  ok('proxy response yields a usage record', record && record.model === 'claude-sonnet-4-6' && record.provider === 'anthropic');
  ok('usage record carries all four token counts',
    record && record.input === 1200 && record.output === 300 && record.cacheRead === 40 && record.cacheWrite === 5);
}
{
  const record = lib.usageRecordFromProxyResponse({ text: '...', model: 'claude-sonnet-4-6' });
  ok('older proxy without usage still yields a zero-token record',
    record && record.input === 0 && record.output === 0 && record.cacheRead === 0 && record.cacheWrite === 0);
}
ok('response without a model yields no record', lib.usageRecordFromProxyResponse({ text: '...' }) === null);
ok('non-object response yields no record', lib.usageRecordFromProxyResponse(null) === null && lib.usageRecordFromProxyResponse('x') === null);
{
  const record = lib.usageRecordFromProxyResponse({ model: 'm', usage: { inputTokens: 'lots', outputTokens: -4 } });
  ok('malformed token counts become zero', record.input === 0 && record.output === 0);
}

// --- proxy target -------------------------------------------------------------
{
  const t = lib.resolveProxyTarget({ proxy: 'http://localhost:3000', env: {} });
  ok('--proxy selects a dev proxy', t.url === 'http://localhost:3000' && t.isProduction === false, JSON.stringify(t));
}
{
  const t = lib.resolveProxyTarget({ proxy: 'http://localhost:3000/v2/analyze?x=1', env: {} });
  ok('proxy URL is reduced to its origin', t.url === 'http://localhost:3000', JSON.stringify(t));
}
{
  const t = lib.resolveProxyTarget({ env: { TOS_PROXY_URL: 'http://127.0.0.1:4000' } });
  ok('TOS_PROXY_URL selects a dev proxy when --proxy is absent', t.url === 'http://127.0.0.1:4000', JSON.stringify(t));
}
{
  const t = lib.resolveProxyTarget({ proxy: 'http://localhost:3000', env: { TOS_PROXY_URL: 'http://127.0.0.1:4000' } });
  ok('--proxy wins over TOS_PROXY_URL', t.url === 'http://localhost:3000', JSON.stringify(t));
}
{
  const t = lib.resolveProxyTarget({ production: true, env: {} });
  ok('--production selects the production proxy and says so', t.url === lib.PRODUCTION_PROXY_URL && t.isProduction === true, JSON.stringify(t));
}
{
  const t = lib.resolveProxyTarget({ proxy: lib.PRODUCTION_PROXY_URL, env: {} });
  ok('an explicit --proxy pointing at production is flagged as production', t.isProduction === true, JSON.stringify(t));
}
{
  const t = lib.resolveProxyTarget({ env: {} });
  ok('no target is an error, never a silent default', typeof t.error === 'string' && !t.url, JSON.stringify(t));
}
{
  const t = lib.resolveProxyTarget({ proxy: 'not a url', env: {} });
  ok('invalid proxy URL is an error', typeof t.error === 'string', JSON.stringify(t));
}
{
  const t = lib.resolveProxyTarget({ proxy: 'ftp://localhost:3000', env: {} });
  ok('non-http proxy URL is an error', typeof t.error === 'string', JSON.stringify(t));
}

// --- proxy override rewrite ------------------------------------------------------
{
  const sample = 'const browser = globalThis.browser || chrome;\nconst PROXY_URL = "https://example.invalid";\nfunction proxyFetch() {}\n';
  const rewritten = lib.applyProxyOverride(sample, 'http://localhost:3000');
  ok('override rewrites the declaration', /^const PROXY_URL = "http:\/\/localhost:3000";$/m.test(rewritten), rewritten);
  ok('override touches nothing else', rewritten.split('\n').length === sample.split('\n').length && rewritten.includes('function proxyFetch() {}'));
}
{
  let threw = false;
  try { lib.applyProxyOverride('const SOMETHING_ELSE = "x";', 'http://localhost:3000'); }
  catch (e) { threw = /PROXY_URL/.test(e.message); }
  ok('override refuses a source without the declaration', threw);
}
{
  // The real file: if background.js changes how it declares the proxy, this
  // goes red instead of the runner silently hitting production.
  const real = fs.readFileSync(path.join(repoRoot, 'background.js'), 'utf8');
  const rewritten = lib.applyProxyOverride(real, 'http://localhost:3000');
  ok('override applies to the real background.js', rewritten.includes('const PROXY_URL = "http://localhost:3000";'));
  ok('real background.js no longer names production after the override', !rewritten.includes(lib.PRODUCTION_PROXY_URL));
}

// --- budget ---------------------------------------------------------------------
ok('no budget never stops a run', lib.budgetExceeded(999, null) === false && lib.budgetExceeded(999, undefined) === false);
ok('zero or negative budget never stops a run', lib.budgetExceeded(1, 0) === false && lib.budgetExceeded(1, -5) === false);
ok('run stops once cost reaches the budget', lib.budgetExceeded(5, 5) === true && lib.budgetExceeded(5.01, 5) === true);
ok('run continues below the budget', lib.budgetExceeded(4.99, 5) === false);

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
