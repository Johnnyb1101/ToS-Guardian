# Learning loop — Phase 1: reference set and jury

Status: checkpoint C complete, awaiting review (2026-09-06); D and E pending. Follows phase 0 (`phase-0.md`).

## Goal

Give every loop above tier 1 something to be scored against that is not its own gauge:

- a **reference set** of frozen legal-document sources, so replays are exact and cost only
  model calls, never fetches;
- a **stable split** into a working set the loop may learn from and a held-out set it is
  only ever scored on;
- a **document type** per source, so lessons can later be recalled by type and results
  read by type;
- a **jury**: a stronger model from a different tier than the analyzer, reading the full
  source and grading each summary claim against it on a fixed rubric, with a second model
  family as an optional second juror;
- a **baseline report**: per-site jury scores, which sections the analyzer gets wrong most,
  how often the critic agreed with the jury, and cost.

The owner's bullet-level spot-check is optional and measures the jury; it never gates a run.

## What is frozen, and where it lives

A frozen source is the combined document text exactly as the pipeline hands it to the
analyzer after fetching and link-following, plus the facts needed to replay it: document
URLs, discovery path, opt-out links, hash, size, legal-document check, document type.

Frozen text is third-party legal text. The manifest (domains, URLs, hashes, splits, types)
is committed; the text itself stays local under `reference/sources/` (ignored by git) and can
be re-fetched and confirmed by hash on another machine. Moving the text into a private
location later is a one-line change to the ignore file.

## Checkpoints

**C. Freeze and classify.** `tools/pipeline-host.js` extracts the extension-in-a-vm host
from the batch runner so the runner, the freezer, and later the trainer share it.
`tools/reference.js freeze` fetches each site's documents through the real fetcher and link
follower with no model calls, writes the frozen source, classifies its document type
(`tools/doctype.js`, keyword-based, overridable), assigns a deterministic split, and
updates `reference/manifest.json`. Episode schema gains `mode: replay`, `trigger.source:
replay`, `fetch.path: frozen`, and `relay.sample`. Tests for the pure parts.

**D. Replay and jury.** A `jury` operation on the proxy, server-owned rubric, enabled only
where `TRAINER_OPERATIONS=1` (the dev proxy), models chosen server-side: `claude-opus-5`
for the Anthropic juror, `gpt-4o` for the optional OpenAI juror. `tools/reference.js
replay` runs frozen sources through analyzer, critic, and evaluator against the dev proxy,
N samples each, writing episodes and local run artifacts (summaries, verdicts).
`tools/jury.js` grades each run artifact against its frozen source and writes the baseline
report: jury score per site and split, section error rates, critic-versus-jury agreement,
analyzer-versus-jury risk agreement, cost.

**E. Spot-check.** A local page that shows a summary beside its source with per-bullet
marks, exports the marks, and reports agreement with the jury.

## Rules carried forward

- Zero user data: frozen sources are public documents; run artifacts hold model output and
  document text and stay local (`reference/runs/`, ignored).
- The trainer key and the dev proxy only. Nothing in phase 1 touches the production key,
  budget, or community cache.
- Each checkpoint stops for review with evidence attached; the owner commits and merges.

## Checkpoint C as built (2026-09-06)

**Pipeline host.** `tools/pipeline-host.js` is now the one definition of "the extension
running headlessly": it loads the real extension files into a vm context with the browser
shims, replaces `fetchWithHiddenTab` with a direct fetch (PDFs and non-HTML fall through
to the proxy, as in the extension), captures episode events and console output per run
through `AsyncLocalStorage`, and switches cache reads, cache and learned-site writes, the
critic, and escalation on or off per host. `tools/batch-runner.js` was rebuilt on it with
identical behaviour and command line. `tests/pipeline-host.test.js` pins the overrides and
the per-run isolation without a network.

**Freeze.** `tools/reference.js freeze` mirrors the orchestrator's steps 1 to 3 (site
lookup, fetcher under the same retry wrapper, injection scan, link follower) so the frozen
text is byte-for-byte what the analyzer would have been handed. It writes
`reference/sources/<domain>.json` (local) and a text-free entry in
`reference/manifest.json` (committed): split, document type and override slot, sha256 and
sizes of the text, legal-document check, discovery path, document and opt-out URLs,
supplemental-notice count, whether an injection pattern was stripped. Sites the fetcher
could not read are recorded under `skipped` with the reason. A site already in the
manifest is skipped unless `--force` is passed, so the set cannot drift under an
experiment. The run needs a proxy only for document fetching; a keyless local proxy with
placeholder database values is enough and keeps the production fetch limiter out of it.

**Split.** `splitFor(domain)` hashes the domain (sha256 of a fixed prefix plus the
lowercased domain) and holds out the bottom thirty percent of the range. Adding or
removing sites never moves another site, and the validator rejects a frozen record whose
split disagrees with the hash.

**Document type.** `tools/doctype.js` scores weighted phrases (regulatory names and
notice titles weigh most, generic words least; each phrase counts at most five times so
repetition cannot outvote a regulatory notice) plus a domain hint for `.edu` and `.gov`,
and returns `other` below a floor. Ten types: financial, health, education, government,
social, media, commerce, gaming, technology, other. `reference/sites.txt` carries
`# type:` headers, and the freezer records that curated type beside the classifier's on
every entry. The type tools use is the human `docTypeOverride` if set, else the curated
type, else the classifier; `reference.js list` shows the classifier's answer wherever it
disagrees, so the classifier can be tuned against the curated list later without the set
moving. The first pass already showed why the curated type has to lead: the classifier
called American Express `media` and Reddit `technology`.

**Schema.** `relay.mode` accepts `replay`, `trigger.source` accepts `replay`, `fetch.path`
accepts `frozen`, and `relay.sample` (integer) identifies the sample within a replay.
`validateEpisode` accepts the new mode; the episode tests cover a replay episode through
`stripLocal` and the uploadable check.

**Verification.** Full extension suite green after the change (238, 87, 40, 25, 83, 35, 59,
25, 13, 30 assertions across the ten test files). A one-site freeze of discord.com
against the keyless local proxy produced a 100,415-character source (terms and privacy,
static site database, two hidden-tab fetches, no opt-out links, type social, split work),
and the full candidate list was then frozen; results are in the section below.

## Checkpoint C results (2026-09-06)

Freeze run against a keyless local proxy (placeholder database values, no provider key,
port 3100), 56 candidate sites, no model calls, about twelve minutes end to end. Counts
below are from `node tools/reference.js list` after the type-annotation pass and a forced
refreeze of the sites that had frozen as shells.

| | |
|---|---|
| Sites in the manifest | 56 of 56 candidates; `skipped` is empty after retries |
| With legal-document text | 50: work 31, holdout 19 |
| Shells kept with `looksLegal: false` | 6: etsy, facebook, instagram, rumble, usaa, zocdoc |
| Legal text by curated type | financial 13, technology 10, social 8, media 7, commerce 5, education 3, gaming 3, health 1 |
| Discovery path, legal sites | page-links 24, known-urls 22, candidates 3, link-text 1 |
| Text size, legal sites | min 6,384; median 91,197; max 338,924; total 4,977,773 characters |
| Supplemental privacy notices | 14 sites |
| Opt-out links displayed | 49 of 50 sites |
| Injection patterns stripped | none |
| Classifier against curated type | disagrees on 20 of 56; curated type in force, no overrides set |
| Frozen text on disk | 56 files, 11 MB, `reference/sources/` (ignored) |

Three passes were needed and each taught something. The first pass over the list froze 54
sites, skipped instagram (fetch limiter, see lessons) and left seven records that were
navigation shells or error pages of a few hundred characters. Comparing those with the
extension showed a fidelity gap in the host inherited from the batch runner: the hidden tab
never resolves with 500 characters or fewer, it returns null so the fetcher falls through
to the proxy, while the Node stand-in returned whatever it got. The host now applies the
same gate (tested), and the forced refreeze of the seven recovered pinterest.com as 80,030
characters of real terms through the candidate path. The other six still come back as
shells through the proxy path, which is the first lesson candidate below. The second pass,
over the list with `# type:` headers, recorded the curated types without a single fetch.

## Lesson candidates from the freeze (for the fetcher loop, phase 3)

Evidence, not fixes. Nothing below was changed in this checkpoint.

1. **The proxy fallback accepts navigation shells and error pages as documents.**
   `fetchNextJsDocument` (`background.js`) treats a proxy response as a document when the
   returned *HTML* is longer than 500 characters, while the hidden-tab path measures the
   *stripped text*. A JavaScript shell or an error page is thousands of characters of HTML
   and a few hundred of text, so it passes the proxy gate and fails the tab gate. Frozen
   evidence: usaa.com came back as "Enable Cookies … errorDescription errorDetails" (252
   characters, six proxy fetches, zero hidden-tab hits) and facebook.com as "Sorry,
   something went wrong" (322 characters) — both labelled as terms and privacy text. The
   evaluator's retrieval-failure check is the only thing standing between these and a
   verdict.
2. **Candidate guessing can exhaust the proxy's fetch limiter inside one site.** The
   limiter allows ten document fetches a minute per address. On instagram.com the first
   pass hit "Rate limited" on the second candidate and gave up with no documents; a live
   user on a site with no static entry and a blocked direct path would see the same.
3. **Six of fifty-six sites cannot be frozen from Node at all** (usaa, facebook,
   instagram, rumble, etsy, zocdoc): they need a rendering browser or block server
   fetches. Their frozen records carry `looksLegal: false` and are excluded from replay
   by default. A "freeze from the extension" path (observer mode posting document
   text to the local collector, dev-only, document text is not user data) would recover
   them and is the natural follow-up.
4. **The keyword classifier disagrees with the curated type on 20 of 56 sites**, mostly
   calling consumer services `media` or `social` on the strength of subscription and
   sharing language. The curated type leads; the disagreements are the tuning set for the
   classifier when document-type recall matters (phase 5).
5. **Static site-database entries can be stale in a way the fetcher does not notice.**
   facebook.com and etsy.com resolved through `known-urls` and still produced shells: the
   URL is right, the server answers, and the content is not the document.
