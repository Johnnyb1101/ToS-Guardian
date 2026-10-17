const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('../tools/reference-lib');
const { createPipelineHost } = require('../tools/pipeline-host');
const { parseArgs, selectSites, loadFrozen, stubPipeline, evaluationSet, replayMeta } = require('../tools/replay');
const { releaseConfigHash } = require('../tools/sites-lib');

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
  ok('options parse', parsed.proxy === 'http://localhost:3000' && JSON.stringify(parsed.sites) === JSON.stringify(['a.com', 'b.com']) && parsed.samples === 2 && parsed.split === 'all' && parsed.run === 'r1' && parsed.configHash === null);
  const refusesLessonSubset = () => { try { parseArgs(['--lessons', 'lsn_0123456789abcdef']); return false; } catch (error) { return /Per-lesson replay selection/.test(error.message); } };
  ok('per-lesson selection is rejected', refusesLessonSubset());

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

  const selected = selectSites(manifest, parseArgs(['--split', 'all']));
  const declaration = evaluationSet(selected, 3);
  ok('declaration pins each site, document, type, split and sample', declaration.length === 3 && declaration.find(e => e.domain === 'h.com').split === 'validation' && declaration.every(e => e.textHash === 'h' && e.docType && e.samples.join(',') === '1,2,3'));
  const config = { lessons: [], sites: [], policy: { models: { anthropic: { default: 'a', escalated: 'b', jury: 'c' }, openai: { default: 'd', escalated: 'e', jury: 'f' } }, promptHashes: { analyzer: 'a'.repeat(64), critic: 'b'.repeat(64), jury: 'c'.repeat(64) }, rubricHash: 'e'.repeat(64), versions: Object.fromEntries(['resolver', 'classifier', 'excerpt', 'escalation', 'evaluator', 'siteLookup', 'pipeline'].map(k => [k, 'd'.repeat(64)])), limits: { maxLessonsPerTarget: 12 }, selection: { order: 'explicit' } } };
  const release = { v: 2, configHash: releaseConfigHash(config), config };
  const replayOptions = parseArgs(['--split', 'all', '--samples', '3', '--config-hash', release.configHash]);
  const recorded = replayMeta(null, selected, replayOptions, 'r', 'http://localhost:3000', 'date', release);
  ok('an identical replay can resume its pinned declaration', replayMeta(recorded, selected, replayOptions, 'r', 'http://localhost:3000', 'later', release) === recorded && recorded.release === release && recorded.configHash === release.configHash);
  const refuses = fn => { try { fn(); return false; } catch (e) { return /new run id/.test(e.message); } };
  ok('resuming rejects changed sites, samples, lessons and historical metadata',
    refuses(() => replayMeta(recorded, selected.slice(1), replayOptions, 'r', recorded.proxy, 'date', release)) &&
    refuses(() => replayMeta(recorded, selected, { ...replayOptions, samples: 4 }, 'r', recorded.proxy, 'date', release)) &&
    refuses(() => replayMeta({ ...recorded, evaluationSet: undefined }, selected, replayOptions, 'r', recorded.proxy, 'date', release)));
  ok('a changed complete release cannot resume under a stored run id', (() => { const changedConfig = { ...config, policy: { ...config.policy, selection: { order: 'changed' } } }; try { replayMeta(recorded, selected, replayOptions, 'r', recorded.proxy, 'date', { v: 2, configHash: releaseConfigHash(changedConfig), config: changedConfig }); return false; } catch (error) { return /configHash/.test(error.message); } })());

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
  fs.writeFileSync(sourcePath, JSON.stringify({ ...frozen, fetched: { ...frozen.fetched, text: 'changed source' } }), 'utf8');
  ok('a stored hash cannot conceal changed frozen source text', /does not match/.test(loadFrozen({ sourceFile: relative, textHash: frozen.textHash }).error));
  fs.writeFileSync(sourcePath, JSON.stringify(frozen), 'utf8');
  ok('a frozen source for another domain is rejected', /domain/.test(loadFrozen({ domain: 'other.com', sourceFile: relative, textHash: frozen.textHash }).error));

  const configHash = 'c'.repeat(64);
  const host = createPipelineHost({ proxyUrl: 'http://127.0.0.1:9', critic: false, configHash });
  stubPipeline(host);
  const ctx = host.context;
  const state = host.newRunState();
  state.frozen = frozen;
  let inside = null;
  await host.run(state, async () => {
    inside = {
      lookup: await ctx.lookupSite('https://a.com/'),
      releaseSession: await ctx.beginReleaseSession(),
      fetched: await ctx.fetcherAgent('https://a.com/', '', null),
      links: await ctx.linkFollowerStub('ignored', 'https://a.com/terms', null, null, false)
    };
  });
  ok('site lookup answers from the frozen record', inside.lookup.source === 'static' && inside.lookup.privacy === 'https://a.com/privacy' && inside.lookup !== frozen.lookup);
  ok('frozen replay starts an offline session pinned to the declared release', inside.releaseSession.configHash === configHash && inside.releaseSession.releaseToken === null);
  ok('fetcher answers from the frozen record with the frozen path', inside.fetched.path === 'frozen' && inside.fetched.text === text && inside.fetched.privacyHtml === null && inside.fetched.mechanisms === null);
  ok('supplemental document links are kept, main documents are not repeated', JSON.stringify(inside.fetched.documentLinks) === JSON.stringify(['https://a.com/glba']));
  ok('link follower answers with the frozen enriched text and links', inside.links.text === frozen.enriched.text && inside.links.optOutLinks[0] === 'https://a.com/choices' && inside.links.followed === 1);
  ok('outside a run the stubs are inert', (await ctx.fetcherAgent('https://a.com/')) === null && (await ctx.lookupSite('https://a.com/')) === null && (await ctx.linkFollowerStub('t')).text === 't');
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\nSummary: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
