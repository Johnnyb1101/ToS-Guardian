# Learning loop — Phase 1: reference set and jury

Status: complete (2026-09-10). Reference set frozen, jury built, spot-check built, and the 50-site three-sample baseline recorded in `baseline-1.md`. Follows phase 0 (`phase-0.md`).

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

## Checkpoint D as built (2026-09-09)

**Jury operation (proxy).** `analysisOperations.js` gains `operation: "jury"`, accepted
only when the process runs with `TRAINER_OPERATIONS=1`; without the flag the route answers
exactly as for an unknown operation, so production cannot tell the operation exists. The
rubric is server-owned: six sections graded for accuracy (correct, minor, major,
fabricated, not-applicable) and completeness (complete, partial, missing,
not-applicable), a fairness call on the bottom line, the jury's own risk level under the
same rule the analyzer was given, quoted fabrications, and up to five omissions, returned
as JSON only. It carries the same anti-injection instruction as the analyzer. The relay
gains a `jury` model tier (`claude-opus-5`; `gpt-4o` for the OpenAI provider) that only
the server-built request can select; a client sending `tier` is rejected as
server-controlled. Jury calls cost five daily safety units, like an escalation, and carry
the same input caps as the critic. Tests cover the gate, the prompt ownership, the tier,
the units, the caps, and the route in both states.

**Replay (extension).** `tools/reference.js replay` (implemented in `tools/replay.js`)
runs frozen sources through the real orchestrator with site lookup, fetcher, and link
follower answered from the frozen record, so the analyzer receives byte-for-byte the text
it would have received live. The pipeline host now captures every analyzer and critic
result per run, and the orchestrator records `mode: replay` and the sample index on the
relay stage. Each replay writes one artifact per site and sample under
`reference/runs/<run>/artifacts/` (analysis source, summary, critic verdict, evaluator
result, usage, cost), plus `episodes.ndjson` in the live schema. Legal-document sources
only unless asked; work split by default; the production proxy is refused; rerunning a run
id resumes it.

**Grading and report.** `tools/jury.js grade` sends each artifact's summary and analysis
source to the jury and stores the verdict on the artifact; `tools/jury-lib.js` computes
the score deterministically (0.6 accuracy + 0.4 completeness per applicable section,
averaged to 100, minus ten per fabrication, floored at zero), critic-versus-jury
agreement on whether a section is acceptable, and risk-level distance, and renders the
baseline report by split, type, evaluator label, and section. Pure parts are covered by
`tests/jury.test.js` and `tests/replay.test.js`.

**Comment rule.** All phase 1 code was brought in line with the standing rule set on
2026-09-09: comments only where the code would otherwise mislead. Nine one-line comments
remain across the phase 1 tools; the rule is recorded in `CLAUDE.md` in both repos.

## Checkpoint D results: five-site dry run (2026-09-09)

Replay of the first five work-split sites (acorns, airbnb, apus.edu, chase, coursera)
against the dev proxy with the trainer key, one sample each, escalation off, then graded
by `claude-opus-5`. The run lives in `reference/runs/dry-run-1/` (local). Final numbers
from `report.anthropic.md`:

| | |
|---|---|
| Replay cost | $0.49 for 5 sites (analyzer + critic, about $0.10 a site) |
| Jury cost | $0.84 for 5 verdicts (about $0.17 each; 12k to 29k input tokens, about 2.3k output including thinking) |
| Full set estimate | about $13.50 for one pass of 50 sites with the jury, $5 without |
| Jury score | mean 70.8, median 78, min 42 (apus.edu), max 83 |
| Section accuracy | no major or fabricated verdict in any section |
| Section completeness | partial on 4 of 5 for collection and sharing, 5 of 5 for opt-out rights, 3 of 4 for deletion |
| Critic against jury | agree on 24 of 30 section verdicts (80%); weakest on auto-renewal (60%) |
| Risk level | displayed risk matched the jury on 3; the two Failed verdicts show Unknown; the summary's own stated risk matched on 4 of 5 |
| Bottom line | judged fair on 5 of 5 |
| Fabrications | 2, both on apus.edu, both in HOW TO OPT OUT: an opt-out URL and a Settings menu path the document does not contain |
| Omissions | 25 (the jury's cap of five per site was hit every time) |

| site | evaluator | jury | note |
|---|---|---|---|
| apus.edu | Strong 100 | 42 | two fabricated specifics; the critic called every section grounded |
| chase.com | Failed 60 | 68 | Unknown risk shown, jury says Moderate |
| acorns.com | Strong 100 | 78 | first grading gave 84, regrading the same summary gave 78 |
| airbnb.com | Failed 50 | 83 | Failed came from missing sections, not wrong ones: the analyzer saw 30,638 of 263,249 characters |
| coursera.org | Adequate 80 | 83 | |

**Three defects found and fixed on the way.** The pipeline host captured the analyzer's
result by reference, and the orchestrator rewrites that object in place (strips the
headline blocks, prepends the evaluator warning), so the first artifacts held the overlay
text instead of the raw summary; the host now snapshots results, with a test. The proxy's
response parser read the first content block, and `claude-opus-5` thinks by default, so
every jury call came back "no content"; the parser now takes the first text block and the
jury tier has its own 8,000-token completion ceiling, with tests. And the jury dropped one
closing brace in five of five verdicts with the one-line JSON template; the parser repairs a
missing brace and tolerates the resulting nesting, the template is now laid out with the
nesting visible, and a re-grade on the new template returned balanced JSON. Because
`jury-lib` re-derives every verdict from the stored raw text, the first five verdicts were
recovered without paying for them again.

## Lesson candidates from the dry run

Evidence for later phases, not fixes.

1. **Incompleteness, not inaccuracy, is the analyzer's main failure.** Accuracy was clean
   across all thirty section verdicts; completeness was partial on most. The bullet caps
   in the analyzer prompt (four or five bullets, under fifteen words) buy scannability at
   the cost of rights the document actually names. A phase 5 lesson can target opt-out
   rights specifically, where every site was partial.
2. **The critic does not catch invented specifics.** apus.edu's HOW TO OPT OUT named an
   ad-industry opt-out URL and a phone Settings path that the document does not contain;
   the critic marked the section grounded and the evaluator awarded Strong 100. Critic
   calibration (phase 5, OPP-115) should include fabricated URLs and menu paths.
3. **The evaluator's label and the jury's score disagree in both directions.** Strong 100
   sat over a jury 42, and Failed 50 over a jury 83. The evaluator measures structure and
   the critic's outcome, not truth; the Failed on airbnb.com came from an analysis excerpt
   that kept 30,638 of 263,249 characters, which is a fetcher and excerpt question, not an
   analyzer error.
4. **Same input, different verdict.** Two replays of the same five frozen sources gave
   evaluator scores of 80/45/80/90/100 and then 100/50/100/60/80; the jury gave the same
   acorns summary 84 and then 78. Any proof in phase 5 needs several samples per site
   (`--samples`), which the replay already supports, and the jury should be averaged too.
5. **The daily unit fuse needs raising for a full pass.** A 50-site pass with the jury
   spends 50 x (1 + 1 + 5) = 350 units; `.env.dev` sets 250. Set `LLM_DAILY_UNIT_LIMIT=1000`
   on the dev proxy before the full run.

## Checkpoint E as built (2026-09-09)

**Spot-check page.** `tools/spotcheck.js serve <run>` serves a local page (127.0.0.1
only) that shows, per site, the exact text the analyzer saw beside its summary parsed into
sections and lines. Each line takes one of three marks (supported, not supported, unsure),
each section a completeness call and an optional note, and each site a risk level and a
bottom-line fairness call. Keyboard driven for speed: 1, 2, 3 mark the focused line and
move on; arrows or j and k move; Alt with an arrow changes site. The jury's and critic's
verdicts for a section stay hidden until every line in it is marked, so they cannot lead
the reader; a per-site jury panel appears when the site is fully marked. Marks save to
`reference/runs/<run>/spotcheck/marks.json` as they are made, validated server-side
against a strict schema (known sections, known marks, known risk levels, site ids only).

**Agreement.** `tools/spotcheck.js agreement <run>` (also the page's Agreement button)
measures the jury and the critic against the human: whether a section is acceptable (no
unsupported line) against the jury's accuracy verdict and the critic's grounded verdict,
whether it is complete against the jury's completeness, the risk level, and the bottom
line, overall and per section, plus a per-site table. `tools/spotcheck-lib.js` holds the
summary parser (header variants such as "DATA SHARING & SELLING" included), the marks
schema, the page model, and the agreement math; `tests/spotcheck.test.js` covers them and
starts the server on an ephemeral port to exercise every route, including the rejection of
malformed marks.

**Verification.** Served the dry run, marked the first section of acorns.com by mouse and
keyboard, answered the bottom line and risk, and confirmed the marks file, the reveal of the
jury's notes, and the agreement report from the saved file. The test marks were then
removed so the run starts clean. Full suite green (thirteen test files). The marks are the
owner's judgments about model output on public documents; nothing about the owner is
recorded and nothing leaves the machine.

## Spot-check results: five-site dry run (2026-09-09)

The owner marked all five dry-run sites in one sitting: 94 lines, 7 marked not supported,
every site High risk, every bottom line fair. Agreement from `spotcheck/agreement.anthropic.md`:

| measure | compared | agreement |
|---|---|---|
| section acceptable, owner vs jury | 30 | 83% |
| section acceptable, owner vs critic | 30 | 70% |
| section complete, owner vs jury | 25 | 32% |
| risk level, owner vs jury | 5 | 80% (chase.com: owner High, jury Moderate) |
| bottom line fair, owner vs jury | 5 | 100% |

Two readings. The jury is closer to the owner than the critic is on whether a section is
acceptable, which is the reason the jury exists. And on completeness the owner and the jury
disagree most of the time: the owner accepted sections the jury called partial, with
opt-out rights at zero agreement, so the jury's completeness bar is stricter than a careful
reader's. Completeness weight in the score (0.4) should be read with that in mind until a
second juror or a larger sample settles whether the jury over-reports omissions.

The one site where the owner marked nothing unsupported and the jury scored lowest is
apus.edu, where the jury reported two fabricated opt-out specifics. A string search of the
analysis source settles it: neither "optout.aboutads.info" nor "Settings → Privacy →
Location Services" appears anywhere in the text the analyzer saw. The jury caught what the
critic, the evaluator (Strong 100), and a careful human reader all let through. Invented
URLs and menu paths are plausible precisely because they are the kind of thing such
documents usually contain; they are the first entry in the phase 5 critic calibration set.

**Follow-up fix.** The first sitting hit "not saved: Failed to fetch" because the page's
server had been stopped after verification. The page now keeps a copy of the marks in the
browser's local storage on every change, retries the save every ten seconds while it fails,
and restores the local copy on load when it is newer than the server's file, so a stopped
server can no longer lose a sitting.

## Phase 1 baseline: 50 sites, 3 samples (2026-09-10)

The full reference set replayed three times and graded by `claude-opus-5`. Run directory
`reference/runs/baseline-1/` (local); the text-free report is committed as
`docs/learning-loop/baseline-1.md` and is the number every later change is measured against.

| | |
|---|---|
| Replays | 150 of 150, no problems, $13.80 |
| Verdicts | 150 of 150, $24.29 (16 needed a parser repair for a trailing comma; none re-bought) |
| Total | $38.09 against the $50 cap; about 5.5 hours including a pause at the trainer workspace's monthly cap |
| Jury score | mean 70.5, median 74, min 22, max 100 (147 scored; reddit.com's three samples had no applicable section) |
| By split | work 70.2 (90), holdout 70.9 (57): the split is fair |
| By type | gaming 79.6, education 75.4, financial 74.9, health 74.7, commerce 69.3, technology 69.1, media 65.5, social 63.7 |
| Evaluator label against the jury | Strong 71, Adequate 69, Failed 59: the label barely separates good from bad |
| Sample spread | same source, three runs: median 14 points, mean 16.5, max 66 (discover.com); 16 of 49 sites spread 20 or more |
| Section accuracy | major or fabricated in 4 of 764 applicable section verdicts, all in data deletion |
| Section completeness | partial or missing on 81 to 95 percent of applicable sections, except how-to-opt-out at 41 percent |
| Fabrications | 107 across 71 of 150 verdicts and 35 of 50 sites; worst snapchat (10 across three samples), discord (9), netflix (6), linkedin (6) |
| Critic against jury | agree on whether a section is acceptable 93 percent of 888 verdicts |
| Risk level | displayed risk matched the jury on 92 of 127 comparable verdicts, one step off on 35, never two; 23 not comparable (Unknown shown) |
| Bottom line | judged fair on 134 of 150 |

Lowest sites by mean score: snapchat 44, netflix 46, discord 52, nytimes 55, microsoft 55,
discover 56, linkedin 58, walmart 58. Highest: wellsfargo 89, capitalone 87, tumblr 87,
steampowered 85, mozilla 84. Eighteen verdicts the evaluator called Strong scored under 60
with the jury; eight it called Failed scored 75 or more.

**What the baseline says.**

1. **The analyzer is accurate at the section level and incomplete almost everywhere.** With
   accuracy errors near zero and incompleteness above eighty percent in five of six
   sections, the loop's first analyzer lesson is about coverage, not truth.
2. **Fabricated specifics are the real accuracy problem, and they hide inside otherwise
   correct sections.** Nearly half the verdicts carry at least one invented detail, usually a
   URL, a menu path, or a named recipient, concentrated on consumer platforms. The critic
   agrees with the jury 93 percent of the time on section acceptability precisely because
   both mostly say acceptable; the critic is not catching these.
3. **The evaluator's label is not a quality signal.** Strong, Adequate, and Failed average
   71, 69, and 59 with the jury, and Strong-but-under-60 happens eighteen times. The
   evaluator measures structure and retrieval, which is useful, but it should not be read
   as accuracy.
4. **Run-to-run variance is large.** A third of the sites move twenty or more points between
   samples of identical input. Any phase 5 proof needs three samples on both arms and a
   paired comparison per site, which the replay and jury already support.
5. **The split is fair.** Work and holdout score within a point of each other, so gains on
   the work set that fail to appear on the holdout set will be real overfitting, not a
   harder holdout.
6. **The jury has its own habits.** It hits the five-omission cap on nearly every verdict
   and, in the dry-run spot-check, called complete sections partial more often than the
   owner did. Its completeness verdicts are a strict reading; its accuracy and fabrication
   verdicts held up against a source search.

**Fetcher lesson from the run.** reddit.com's frozen source is the policy index page in
many languages, not a policy: the site database URL resolves to the index, and the
legal-document check accepted 109,435 characters of policy titles and dates as a document.
The analyzer said so honestly in all three samples and the jury marked every section not
applicable. The site database entry needs the actual document URLs, and the legal-text check
needs to distrust a document that is mostly headings.

**Operational notes.** The trainer workspace's monthly cap was reached forty verdicts into
the jury stage (the provider returned "You have reached your specified API usage limits");
the owner raised it and the grader resumed on the remaining 110 without repeating any. The
run was driven from a second dev proxy instance started with the trainer key read from the
Windows user environment in-process, the jury enabled, and a 2,000-unit daily fuse, because
the owner's instance was not answering when the run began.
