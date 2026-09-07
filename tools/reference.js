// TOS Guardian — reference set tool (learning loop, phase 1)
//
// freeze: fetch each site's legal documents once through the REAL fetcher and
//         link follower (no model calls), classify the document type, assign the
//         deterministic split, write the frozen source under reference/sources/
//         (local, ignored by git) and its text-free entry to reference/manifest.json
//         (committed). Sites whose documents could not be found are recorded in
//         the manifest's `skipped` map with the reason, so discovery failures
//         stay visible instead of silently thinning the set.
// list:   print the manifest.
//
// Usage:
//   node tools/reference.js freeze <sites.txt | domain ...> --proxy <url> [--delay ms] [--timeout ms] [--limit n] [--force] [--verbose]
//   node tools/reference.js list
//
// The proxy is needed only for document fetching (PDF extraction, CORS and
// Next.js pages); a local proxy started with placeholder database values and no
// provider key is enough. Nothing here spends a model call. The default delay
// between sites is generous because the proxy's fetch limiter is 10 a minute.

const fs = require('fs');
const path = require('path');
const { resolveProxyTarget } = require('./batch-lib');
const { createPipelineHost, withTimeout, sitesFromInputs } = require('./pipeline-host');
const { classifyDocumentType } = require('./doctype');
const lib = require('./reference-lib');

const args = process.argv.slice(2);
const command = args.shift();

function usage(code) {
  console.log('Usage:');
  console.log('  node tools/reference.js freeze <sites.txt | domain ...> --proxy <url> [--delay ms] [--timeout ms] [--limit n] [--force] [--verbose]');
  console.log('  node tools/reference.js list');
  process.exit(code);
}

if (!command || command === '--help' || command === '-h') usage(0);

if (command === 'list') {
  const manifest = lib.loadManifest();
  const summary = lib.summarizeManifest(manifest);
  console.log(`Reference set: ${summary.total} site(s), ${summary.legal} with legal-document text`);
  console.log(`  split: ${Object.entries(summary.bySplit).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
  console.log(`  types: ${Object.entries(summary.byType).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
  console.log('');
  for (const domain of Object.keys(manifest.sites).sort()) {
    const s = manifest.sites[domain];
    const type = lib.effectiveType(s);
    const typeNote = type !== s.docType ? ` (classifier: ${s.docType})` : '';
    console.log(`  ${domain.padEnd(24)} ${s.split.padEnd(8)} ${type.padEnd(11)} ${String(s.textChars).padStart(7)} chars  legal=${s.looksLegal ? 'yes' : 'no '}  ${s.path}${typeNote}`);
  }
  if (summary.typeDisagreements.length) {
    console.log('');
    console.log(`Classifier disagrees with the curated type on ${summary.typeDisagreements.length} site(s): ${summary.typeDisagreements.join(', ')}. The curated type is used; set docTypeOverride to settle one.`);
  }
  const skipped = Object.keys(manifest.skipped || {}).sort();
  if (skipped.length) {
    console.log('');
    console.log(`Skipped (${skipped.length}):`);
    for (const domain of skipped) console.log(`  ${domain.padEnd(24)} ${manifest.skipped[domain].at}  ${manifest.skipped[domain].reason}`);
  }
  process.exit(0);
}

if (command !== 'freeze') usage(1);

const opts = { proxy: null, delay: 6000, timeout: 120000, limit: Infinity, force: false, verbose: false };
const inputs = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--proxy') opts.proxy = args[++i];
  else if (a === '--delay') opts.delay = Number(args[++i]);
  else if (a === '--timeout') opts.timeout = Number(args[++i]);
  else if (a === '--limit') opts.limit = Number(args[++i]);
  else if (a === '--force') opts.force = true;
  else if (a === '--verbose') opts.verbose = true;
  else if (a.startsWith('--')) { console.error(`Unknown option: ${a}`); process.exit(1); }
  else inputs.push(a);
}
if (inputs.length === 0) usage(1);

// Freezing never spends a model call, so the production proxy is acceptable
// here, but a local proxy is still preferred to stay off its fetch rate limit.
const target = resolveProxyTarget({ proxy: opts.proxy, env: process.env });
if (target.error) { console.error(target.error); process.exit(1); }

const sites = sitesFromInputs(inputs, msg => console.warn(msg)).slice(0, opts.limit);
if (sites.length === 0) { console.error('No valid domains to freeze.'); process.exit(1); }

const host = createPipelineHost({
  proxyUrl: target.url,
  cache: false,
  write: false,
  critic: false,
  escalate: false,
  onLog: opts.verbose ? (line) => console.log('  ' + line) : null
});
const ctx = host.context;

fs.mkdirSync(lib.SOURCES_DIR, { recursive: true });
const manifest = lib.loadManifest();

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Mirrors the orchestrator's steps 1 through 3 (site lookup, fetcher with the
// same retry wrapper, injection scan, link follower) so the frozen text is
// exactly what the analyzer would have been handed on a live run.
async function freezeSite(site, state) {
  return host.run(state, async () => {
    const hostname = site.domain;
    const pageUrl = `https://${hostname}/`;
    const registrable = ctx.registrableDomain(hostname) || hostname;
    const existing = manifest.sites[registrable];
    if (existing && !opts.force) {
      // The frozen text stays as it is; only the curated type from the list is
      // brought up to date, so re-running over an edited list is cheap.
      if (site.type && existing.curatedType !== site.type) {
        existing.curatedType = site.type;
        lib.saveManifest(manifest);
        return { domain: registrable, skipped: true, reason: `already frozen; curated type set to ${site.type} (use --force to refreeze)`, keep: true };
      }
      return { domain: registrable, skipped: true, reason: 'already frozen (use --force to refreeze)', keep: true };
    }
    const home = await host.directFetch(pageUrl);
    const pageHtml = home ? home.html : '';
    const pageText = home ? ctx.stripHtml(home.html).slice(0, 20000) : '';

    const knownUrls = await ctx.lookupSite(pageUrl);
    const fetched = await ctx.runWithRetry(() => ctx.fetcherAgent(pageUrl, pageHtml, knownUrls), '[Fetcher]');
    if (!fetched || !fetched.text) {
      const legalPage = ctx.looksLikeLegalDocument(pageText);
      const reason = home ? (legalPage ? 'no documents found; the homepage itself reads as legal text' : 'no documents found') : 'homepage unreachable and no documents found';
      if (existing && !existing.looksLegal) {
        // A forced refreeze found nothing where an earlier pass had frozen a
        // shell. Drop the shell so the set holds only real documents; the
        // failure is recorded under `skipped` by the caller.
        delete manifest.sites[registrable];
        try { fs.unlinkSync(path.join(lib.SOURCES_DIR, `${registrable}.json`)); } catch (e) { /* already gone */ }
        lib.saveManifest(manifest);
        return { domain: registrable, skipped: true, reason: `${reason}; removed the earlier non-legal source` };
      }
      if (existing) return { domain: registrable, skipped: true, reason: `${reason}; kept the earlier frozen source`, keep: true };
      return { domain: registrable, skipped: true, reason };
    }

    const scan = ctx.scanForInjection(fetched.text);
    const source = fetched.privacyUrl ? `${fetched.sourceUrl} and ${fetched.privacyUrl}` : fetched.sourceUrl;
    const linkResult = await ctx.linkFollowerStub(scan.strippedText, source, fetched.privacyHtml || null, fetched.privacyUrl || null, !!fetched.hasSupplementalPrivacy);

    const documentUrls = [...new Set([fetched.sourceUrl, fetched.privacyUrl, ...(fetched.documentLinks || [])]
      .filter(Boolean).map(ctx.upgradeInsecureUrl))].filter(u => ctx.validateDocumentUrl(u));
    const optOutLinks = [...new Set([...(fetched.documentLinks || []), ...(linkResult.optOutLinks || [])].map(ctx.upgradeInsecureUrl))]
      .filter(u => ctx.validateLinkFollowerUrl(u) && ctx.isRelevantPrivacyActionUrl(u));

    const classified = classifyDocumentType(fetched.text, registrable);
    const frozen = {
      v: lib.FROZEN_SOURCE_VERSION,
      domain: registrable,
      frozenAt: new Date().toISOString(),
      pageUrl,
      lookup: knownUrls ? { source: knownUrls.source || 'static', tos: knownUrls.tos || null, privacy: knownUrls.privacy || null, supplemental: knownUrls.supplemental || [] } : null,
      fetched: {
        path: typeof fetched.path === 'string' ? fetched.path : 'unknown',
        sourceUrl: fetched.sourceUrl || null,
        privacyUrl: fetched.privacyUrl || null,
        documentUrls,
        hasSupplementalPrivacy: !!fetched.hasSupplementalPrivacy,
        unreadablePdfUrls: fetched.unreadablePdfUrls || [],
        mechanisms: fetched.mechanisms || null,
        text: fetched.text
      },
      enriched: {
        text: linkResult.text,
        optOutLinks,
        candidates: Number.isInteger(linkResult.candidates) ? linkResult.candidates : 0,
        followed: Number.isInteger(linkResult.followed) ? linkResult.followed : 0
      },
      injectionStripped: !scan.clean,
      textHash: lib.sha256Hex(fetched.text),
      fingerprint: ctx.contentFingerprint(fetched.text),
      looksLegal: ctx.looksLikeLegalDocument(fetched.text),
      docType: classified.type,
      docTypeScores: classified.scores,
      curatedType: site.type || (existing && existing.curatedType) || null,
      docTypeOverride: (existing && existing.docTypeOverride) || null,
      split: lib.splitFor(registrable)
    };

    const check = lib.validateFrozenSource(frozen);
    if (!check.valid) return { domain: registrable, skipped: true, reason: `frozen record invalid: ${check.errors.join('; ')}` };

    fs.writeFileSync(path.join(lib.SOURCES_DIR, `${registrable}.json`), JSON.stringify(frozen, null, 2) + '\n', 'utf8');
    manifest.sites[registrable] = lib.manifestEntryFrom(frozen);
    delete manifest.skipped[registrable];
    lib.saveManifest(manifest);
    return { domain: registrable, frozen };
  });
}

(async () => {
  console.log(`TOS Guardian reference freeze — ${sites.length} site(s), proxy ${target.url}${target.isProduction ? ' (production; fetches only, no model calls)' : ''}`);
  console.log(`  sources: ${lib.SOURCES_DIR} (local) | manifest: ${lib.MANIFEST_PATH} (committed)`);
  console.log('');
  let frozen = 0, skipped = 0, failed = 0;
  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    process.stdout.write(`[${i + 1}/${sites.length}] ${site.domain} ... `);
    const state = host.newRunState();
    let result;
    try {
      result = await withTimeout(freezeSite(site, state), opts.timeout, state.controller);
    } catch (e) {
      result = { domain: ctx.registrableDomain(site.domain) || site.domain, skipped: true, reason: e.message, failed: true };
    }
    if (result.frozen) {
      frozen++;
      const f = result.frozen;
      console.log(`frozen  ${f.docType.padEnd(10)} ${String(f.fetched.text.length).padStart(7)} chars  legal=${f.looksLegal ? 'yes' : 'no '}  ${f.fetched.path}  split=${f.split}`);
    } else {
      if (result.failed) failed++; else skipped++;
      console.log(`skipped — ${result.reason}`);
      if (!result.keep && !manifest.sites[result.domain]) {
        manifest.skipped[result.domain] = { at: today(), reason: result.reason };
        lib.saveManifest(manifest);
      }
      if (opts.verbose === false && !result.keep) {
        for (const line of state.logs.filter(l => /\[Fetcher\]|\[SiteDB\]|\[Proxy\]/.test(l)).slice(-4)) console.log('    ' + line);
      }
    }
    if (i < sites.length - 1 && !result.keep && opts.delay > 0) await new Promise(r => setTimeout(r, opts.delay));
  }
  const summary = lib.summarizeManifest(lib.loadManifest());
  console.log('');
  console.log(`Frozen ${frozen}, skipped ${skipped}, failed ${failed}. Manifest now holds ${summary.total} site(s), ${summary.legal} with legal-document text: ` +
    `${Object.entries(summary.bySplit).map(([k, n]) => `${k} ${n}`).join(', ')}; ` +
    `${Object.entries(summary.byType).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}.`);
  if (summary.typeDisagreements.length) {
    console.log(`Classifier disagrees with the curated type on ${summary.typeDisagreements.length} site(s): ${summary.typeDisagreements.join(', ')}. The curated type is used; \`node tools/reference.js list\` shows both.`);
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
