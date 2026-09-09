const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('../tools/reference-lib');
const { createPipelineHost } = require('../tools/pipeline-host');
const { parseArgs, selectSites, loadFrozen, stubPipeline } = require('../tools/replay');

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (condition) { console.log(`  ok    ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

(async () => {
  console.log('Replay');

  const defaults = parseArgs([]);
  ok('defaults replay the work split once with no escalation', defaults.split === 'work' && defaults.samples === 1 && defaults.escalate === false && defaults.includeShells === false);
  const parsed = parseArgs(['--proxy', 'http://localhost:3000', '--sites', 'a.com, b.com', '--samples', '2', '--split', 'all', '--run', 'r1']);
  ok('options parse', parsed.proxy === 'http://localhost:3000' && JSON.stringify(parsed.sites) === JSON.stringify(['a.com', 'b.com']) && parsed.samples === 2 && parsed.split === 'all' && parsed.run === 'r1');

  const entry = (domain, split, looksLegal, docType, curatedType) => ({ domain, split, looksLegal, docType, curatedType: curatedType || null, docTypeOverride: null, textHash: 'h', sourceFile: `sources/${domain}.json` });
  const manifest = {
    sites: {
      'z.com': entry('z.com', 'work', true, 'media', 'social'),
      'a.com': entry('a.com', 'work', true, 'financial'),
      'h.com': entry('h.com', 'holdout', true, 'financial'),
      's.com': entry('s.com', 'work', false, 'other', 'commerce')
    }
  };
  const names = list => list.map(e => e.domain).join(',');
  ok('work split, legal only, sorted', names(selectSites(manifest, parseArgs([]))) === 'a.com,z.com');
  ok('holdout split', names(selectSites(manifest, parseArgs(['--split', 'holdout']))) === 'h.com');
  ok('all splits with shells', names(selectSites(manifest, parseArgs(['--split', 'all', '--include-shells']))) === 'a.com,h.com,s.com,z.com');
  ok('type filter uses the effective type', names(selectSites(manifest, parseArgs(['--type', 'social']))) === 'z.com');
  ok('explicit sites bypass the split and shell filters', names(selectSites(manifest, parseArgs(['--sites', 's.com,h.com']))) === 'h.com,s.com');
  ok('limit applies after filtering', names(selectSites(manifest, parseArgs(['--split', 'all', '--limit', '2']))) === 'a.com,h.com');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-replay-'));
  const text = '=== PRIVACY POLICY ===\nWe share with affiliates.';
  const frozen = {
    v: 1, domain: 'a.com', pageUrl: 'https://a.com/', lookup: { source: 'static', tos: 'https://a.com/terms', privacy: 'https://a.com/privacy', supplemental: [] },
    fetched: { path: 'known-urls', sourceUrl: 'https://a.com/terms', privacyUrl: 'https://a.com/privacy', documentUrls: ['https://a.com/terms', 'https://a.com/privacy', 'https://a.com/glba'], hasSupplementalPrivacy: true, unreadablePdfUrls: [], mechanisms: { hiddenTab: 2, proxy: 0, attempts: 2 }, text },
    enriched: { text: text + '\n\n=== OPT-OUT / PRIVACY PAGE: https://a.com/choices ===\nOpt out here.', optOutLinks: ['https://a.com/choices'], candidates: 1, followed: 1 },
    textHash: lib.sha256Hex(text)
  };
  const sourcePath = path.join(dir, 'a.com.json');
  fs.writeFileSync(sourcePath, JSON.stringify(frozen), 'utf8');
  const relative = path.relative(lib.REFERENCE_DIR, sourcePath).split(path.sep).join('/');
  ok('a frozen source that matches the manifest hash loads', !!loadFrozen({ sourceFile: relative, textHash: frozen.textHash }).frozen);
  ok('a frozen source with a different hash is refused', /does not match/.test(loadFrozen({ sourceFile: relative, textHash: 'x'.repeat(64) }).error));
  ok('a missing frozen source is reported', /missing/.test(loadFrozen({ sourceFile: 'sources/nope.example.json', textHash: 'h' }).error));

  const host = createPipelineHost({ proxyUrl: 'http://127.0.0.1:9', critic: false });
  stubPipeline(host);
  const ctx = host.context;
  const state = host.newRunState();
  state.frozen = frozen;
  let inside = null;
  await host.run(state, async () => {
    inside = {
      lookup: await ctx.lookupSite('https://a.com/'),
      fetched: await ctx.fetcherAgent('https://a.com/', '', null),
      links: await ctx.linkFollowerStub('ignored', 'https://a.com/terms', null, null, false)
    };
  });
  ok('site lookup answers from the frozen record', inside.lookup.source === 'static' && inside.lookup.privacy === 'https://a.com/privacy' && inside.lookup !== frozen.lookup);
  ok('fetcher answers from the frozen record with the frozen path', inside.fetched.path === 'frozen' && inside.fetched.text === text && inside.fetched.privacyHtml === null && inside.fetched.mechanisms === null);
  ok('supplemental document links are kept, main documents are not repeated', JSON.stringify(inside.fetched.documentLinks) === JSON.stringify(['https://a.com/glba']));
  ok('link follower answers with the frozen enriched text and links', inside.links.text === frozen.enriched.text && inside.links.optOutLinks[0] === 'https://a.com/choices' && inside.links.followed === 1);
  ok('outside a run the stubs are inert', (await ctx.fetcherAgent('https://a.com/')) === null && (await ctx.lookupSite('https://a.com/')) === null && (await ctx.linkFollowerStub('t')).text === 't');
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\nSummary: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
