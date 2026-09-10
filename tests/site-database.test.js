const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (condition) { console.log(`  ok    ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

const repoRoot = path.resolve(__dirname, '..');
const logs = [];
const requests = [];
let nextResponse = { status: 404, body: { result: null } };
const context = {
  console: { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) },
  URL,
  Date,
  PROXY_URL: 'https://proxy.test',
  proxyFetch: async (url, options) => {
    requests.push({ url, options });
    const response = nextResponse;
    return { ok: response.status >= 200 && response.status < 300, status: response.status, json: async () => response.body };
  }
};
vm.createContext(context);
for (const file of ['vendor/tldts-7.4.8.umd.min.js', 'tosUtils.js', 'siteDatabase.js']) {
  vm.runInContext(fs.readFileSync(path.join(repoRoot, file), 'utf8'), context, { filename: file });
}
const staticDomain = Object.keys(vm.runInContext('STATIC_SITES', context))[0];

(async () => {
  console.log('Site database');

  const proposal = context.buildSiteProposal('https://login.acmeprivacy.com/signup?x=1', 'https://acmeprivacy.com/terms', 'https://acmeprivacy.com/privacy', ['https://acmeprivacy.com/glba', 7, 'a', 'b', 'c', 'd', 'e'], 'page-links');
  ok('a proposal is keyed by the registrable domain with capped supplemental urls and the path',
    proposal && proposal.domain === 'acmeprivacy.com' && proposal.tos_url === 'https://acmeprivacy.com/terms' && proposal.supplemental_urls.length === 5 && !proposal.supplemental_urls.includes(7) && proposal.path === 'page-links', JSON.stringify(proposal));
  ok('a proposal without a path omits it', context.buildSiteProposal('https://acmeprivacy.com/', 'https://acmeprivacy.com/t', 'https://acmeprivacy.com/p').path === undefined);
  ok('static sites are never proposed', context.buildSiteProposal(`https://${staticDomain}/`, 'https://x/t', 'https://x/p') === null);
  ok('a proposal with a missing url is not built', context.buildSiteProposal('https://acmeprivacy.com/', null, 'https://acmeprivacy.com/p') === null);

  const messages = ['promoted', 'refreshed', 'recorded', 'current', 'halted', 'rejected', 'static'].map(status => context.describeSiteProposalOutcome('acmeprivacy.com', { status, expiresAt: '2026-10-10T00:00:00.000Z', needed: 2, reason: 'privacy: index page' }));
  ok('every outcome has a distinct message', new Set(messages).size === 7 && messages[0].includes('promoted') && messages[2].includes('2 more day') && messages[5].includes('index page'));
  ok('an empty answer is described, not thrown', /No answer/.test(context.describeSiteProposalOutcome('acmeprivacy.com', null)));

  logs.length = 0; requests.length = 0;
  nextResponse = { status: 200, body: { status: 'recorded', needed: 2 } };
  await context.learnSite('https://acmeprivacy.com/signup', 'https://acmeprivacy.com/terms', 'https://acmeprivacy.com/privacy', ['https://acmeprivacy.com/glba'], 'known-urls');
  await new Promise(r => setTimeout(r, 10));
  const sent = requests[0] && JSON.parse(requests[0].options.body);
  ok('learnSite posts the proposal to the site route', requests[0] && requests[0].url === 'https://proxy.test/site' && requests[0].options.method === 'POST' && sent.domain === 'acmeprivacy.com' && sent.supplemental_urls[0] === 'https://acmeprivacy.com/glba' && sent.path === 'known-urls', JSON.stringify(sent));
  ok('learnSite logs the proxy outcome', logs.some(l => /Proposed: acmeprivacy\.com recorded \(2 more day/.test(l)), logs.join(' | '));

  requests.length = 0;
  nextResponse = { status: 200, body: { tos: 'https://acmeprivacy.com/terms', privacy: 'https://acmeprivacy.com/privacy', supplemental: ['https://acmeprivacy.com/glba'], path: 'page-links', is_static: false, updated_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString() } };
  const learned = await context.lookupSite('https://www.acmeprivacy.com/x');
  ok('a learned entry with a future expiry is served with its supplemental urls and path', learned && learned.source === 'learned' && learned.supplemental[0] === 'https://acmeprivacy.com/glba' && learned.path === 'page-links', JSON.stringify(learned));

  nextResponse = { status: 200, body: { ...nextResponse.body, expires_at: new Date(Date.now() - 1000).toISOString() } };
  ok('an entry past its expiry is not used', (await context.lookupSite('https://acmeprivacy.com/')) === null);

  nextResponse = { status: 200, body: { tos: 'https://acmeprivacy.com/terms', privacy: 'https://acmeprivacy.com/privacy', is_static: false, updated_at: new Date(Date.now() - 20 * 86400000).toISOString() } };
  ok('a legacy entry without an expiry falls back to the fifteen-day rule', (await context.lookupSite('https://acmeprivacy.com/')) === null);

  nextResponse = { status: 200, body: { tos: 'https://acmeprivacy.com/terms', privacy: 'https://acmeprivacy.com/privacy', is_static: true, updated_at: '2020-01-01T00:00:00.000Z' } };
  ok('a static server entry never expires', (await context.lookupSite('https://acmeprivacy.com/')) !== null);

  nextResponse = { status: 404, body: { result: null } };
  ok('an unknown site returns null', (await context.lookupSite('https://acmeprivacy.com/')) === null);

  console.log(`\nSummary: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
