# Learning loop — Phase 5: the analyzer loop

Status: bundle 1 proven; bundle 2 not proven and retired (2026-10-04); bundle 3, the critic
re-try, not proven and retired (2026-10-10) with a follow-up queued; bundle 2b, the first
campaign of phase 6 (`phase-6.md`), not proven and retired (2026-10-11). Follows phase 4
(`phase-4.md`).

## Goal

Turn lesson candidates from phase 2 into rules the analyzer and critic actually follow,
without trusting anyone's intuition about whether they help: a lesson is recalled into the
prompt only after it has been proven on the frozen reference set, every analysis carries a
hash of the lessons it ran under, a canary share lets a lesson run on a fraction of live
analyses before it is promoted, and the owner is the only one who promotes.

## Lessons on the proxy

`lessons.js` holds the store and the rules:

- A lesson is `{ id, target, scope, section, text, status, provenance, proof }`. The id is a
  hash of target and text, so the same rule registered twice is one lesson. Text is at most
  600 characters, no angle brackets. `target` is `analyzer` or `critic`; `scope` is `all` or
  a document type; `section` names the summary section it is about, or none.
- Status moves `candidate` to `canary` or `promoted` to `retired`, and canary can fall
  back to candidate. Promotion requires a proof object with `proven: true`; the halt
  boundary (same three legs as site learning) blocks promotion and canary, never
  retirement. Every change appends to the learning ledger (`lesson-created`,
  `lesson-canary`, `lesson-promoted`, `lesson-retired`, `lesson-candidate`), chained with
  the site events.
- Recall: for each analyzer or critic call the proxy classifies the document type with the
  server-side copy of the phase 1 classifier (`docType.js`; the extension sends the
  document's registrable domain as a hint when it has one), selects the promoted lessons
  whose scope is `all` or that type (at most twelve, in id order), composes them into a
  `LEARNED RULES` block, and places it in the system prompt: appended for the analyzer,
  before the output-format instruction for the critic. The document stays in user content.
- Arms: `none` (no lessons), `promoted`, `canary` (promoted plus canary lessons, applied to
  `LESSONS_CANARY_SHARE` of live calls, default 0), and `pinned` (an explicit id list). Only
  a trainer proxy honours a client's `lessonSet`; an anonymous client sending one is refused
  as server-controlled, like `tier`.
- Every analysis response carries `lessonsHash` (sha256 of the sorted lesson ids, the
  empty-set hash when none), `lessonsArm`, and `docType`; the analysis receipt carries the
  same `lessonsHash`, so a cache write and a community report both say which rules
  produced the summary.

Routes (`TRAINER_OPERATIONS=1` only): `GET /lessons`, `POST /lessons`,
`POST /lessons/:id/status`. `GET /learning/status` counts lessons by state and reports the
canary share. Schema: `migrations/0004_lessons.sql`.

## Extension

The episode's analyze stage records `lessonsHash`, `lessonsArm`, and `docType`; the critic
stage records `lessonsHash`. The analyzer sends the document's registrable domain as the
type hint. Nothing else changes for users: lessons are server-side, and a run with no
promoted lessons is byte-for-byte the run it was before.

## Tools

- `tools/lessons.js create <run> --ids L013,L015` registers dream candidates as lesson
  candidates with their provenance; `list` and `status <id> <state> [--proof <run>]`
  drive the rest.
- `tools/reference.js replay ... --lessons none|promoted|canary|<ids>` pins the arm for a
  treatment run through the pipeline host, which adds `lessonSet` to every analyzer and
  critic request. Artifacts record the hash, arm, and type the proxy reported.
- `tools/prove.js <treatment> --control <control>` pairs the two runs per site and
  bootstraps the mean jury-score delta on the work split and the holdout. **Proven** means:
  at least five paired work sites, work-split mean gain at least three points with the 95%
  bootstrap interval above zero, holdout interval not below minus five, and the treatment
  ran under exactly one lesson set. It also reports fabrication rate, incompleteness rate,
  and critic agreement deltas, writes `proof.json` and `proof.md` into the treatment run,
  and exits non-zero when not proven. `baseline-1` (no lessons) is the control for
  first-round proofs.
- `tools/critic-replay.js <graded run> --run <id> --lessons none|<ids>` re-runs only the
  critic over the analyses stored in a graded run, through the same proxy route and the
  same parser the extension uses. The new run's artifacts keep the analysis and the jury
  verdict and replace the critic verdict; the earlier critic's labels and evaluator label
  are kept under `criticOf`. Critic lessons change no analyzer text, so a jury score
  cannot measure them; this pairs each new critic verdict with the jury verdict the run
  already paid for, at the price of the critic calls alone.
- `tools/prove-critic.js <treatment> --control <control> [--out <dir>]` pairs two critic
  runs per site on identical analyses. **Proven** means: the work-split catch rate (a
  section labelled unsupported or vague on a verdict where the jury found a fabrication)
  gains at least ten points with the 95% interval above zero; false alarms (a concern on
  a verdict the jury found clean) rise by no more than ten points; parse failures rise by
  no more than two points; the holdout catch rate does not fall by more than ten; the
  analyses are identical in both arms; and the treatment critic ran under one lesson set.
  It also reports a notice rate (a flag raised with no section label changed, which the
  evaluator ignores) and how many evaluator labels would change.
- `tools/lessons.js revise <run> <candidateId> --text "..." [--id L005b] [--after
  proof-bundle2]` registers a reworded candidate whose provenance names the parent and
  the proof that retired it.

## Proof plan (agreed, not yet run)

Cap $125; each proof under a $45 stop; three bundles in order, each a treatment replay of
the full set with three samples (about $38 and 3.5 hours) graded by the jury:

1. No invented specifics: L013 (menu paths), L015 (URLs), L017 (data categories), L019
   (generic advice), L021 (recipients), L023 (email), plus critic L014 and L016.
2. Completeness: L001, L003, L004, L005, L008.
3. Scoped deletion and type lessons, if the first two prove.

A bundle that proves is promoted as a set; one that does not is retired with its proof
attached, which is a legitimate and equally informative outcome.

## Tests

- Proxy `lessons.test.js`: input cleaning and ids, hash, prompt composition and placement,
  trainer-only pinning, status transitions with proof and ledger, scope by type, the three
  arms, canary draw, halt.
- Proxy `lessonsRoute.test.js`: routes hidden without the flag, anonymous pinning refused,
  arm and hash and type on the response, receipt binding, promoted lesson applied to a
  matching live analysis and not to another type, status counts, shared ledger.
- Extension `tests/prove.test.js`: deterministic bootstrap, proven, inside-the-noise,
  holdout regression, mixed lesson sets, too few sites, unpaired sites, candidate mapping.
- Episode, system, pipeline-host, and sites tests extended for the new fields and kinds.

## Live verification (2026-10-03)

Against a dev proxy on port 3001 with the trainer key, in-memory stores, and the trainer
flag:

- `lessons.js create` registered the eight bundle-1 candidates from `baseline-1`'s dream
  output as lesson candidates (six analyzer, two critic), each ledgered with its
  provenance; `lessons.js list` and the status route showed eight candidates, none
  promoted.
- A one-site replay of acorns.com with the six analyzer lessons pinned ran under arm
  `pinned` and recorded the set's hash and the document type `financial` on the artifact;
  the critic call carried its own hash. The HOW TO OPT OUT section came back with the
  menu-path fabrication the baseline reported on this very site replaced by the document's
  words: "Go to your mobile device's settings (the document says 'your mobile device's
  settings' but gives no specific menu path)". The jury scored it 78 with no fabrications,
  against 84 and 78 with one and two fabrications in the baseline's three samples.
- `prove.js` against `baseline-1` paired the one site and answered "not proven: only 1
  paired work site(s); need at least 5", with the lesson-set hash and both costs reported,
  which is the correct answer for a smoke test and the behaviour wanted when a real proof
  is too thin.
- Cost of the check: one replay and one verdict, $0.34.

The eight lessons stay candidates on a proxy that was then stopped; nothing is promoted,
and the proof runs have not been started.

## Rules carried forward

- Zero user data: a lesson is a rule about documents; the hash, arm, and type are facts
  about the run. The document's registrable domain is already site data.
- Prompts stay server-owned. Clients cannot choose lessons; the trainer can only pin
  lessons that exist on the server.
- Nothing is promoted without a proof on the frozen set and the owner's hand on the route.

## Bundle 1 proof: no invented specifics (2026-10-04)

Run `treat-bundle1`: the full reference set, three samples, the six analyzer lessons
(L013 menu paths, L015 URLs, L017 data categories, L019 generic advice, L021 email
addresses, L023 recipient scope) and the two critic lessons (L014, L016) pinned; graded by
`claude-opus-5`; compared with `baseline-1` by `tools/prove.js`. The text-free proof is
committed as `proof-bundle1.md`.

**Proven.** Jury score +5.2 on the 30 paired work sites (95% interval 0.6 to 10.0) and
+7.3 on the 19 holdout sites (3.1 to 11.4); 36 of 49 sites improved. Fabricated specifics
fell from 107 to 38 across the run (0.73 to 0.26 per verdict), with every holdout site
improving or holding on that measure. Section accuracy stayed clean. Cost $38.65 of the
$45 stop.

| | baseline-1 | treat-bundle1 |
|---|---|---|
| Jury score, mean / median | 70.5 / 74 | 76.5 / 80 |
| Fabrications, total / verdicts with any / sites | 107 / 71 / 35 | 38 / 28 / 17 |
| Menu-path fabrications | 35 | 3 |
| URL fabrications | 16 | 4 |
| Generic-advice fabrications | 12 | 1 |
| Incomplete sections (all) | 68% | 72% |
| Bottom line judged fair | 134 of 150 | 128 of 150 |
| Displayed risk matched the jury | 92 | 98 |

**What it cost elsewhere.** Completeness did not improve and may have slipped a little
(holdout +9 points incomplete, interval touching zero), which is the expected shape: the
lessons tell the analyzer to say less when the document says less. Bundle 2 is about
completeness and is the right place to win that back. Five work sites fell by 11 points or
more (steampowered, harvard, airbnb, webmd, paypal); the biggest gains were the sites the
baseline found worst (snapchat +36, discord +25, spotify +23, microsoft +22).

**Decision.** The six analyzer lessons were promoted with the proof attached (ledger seq
9 to 14). The two critic lessons were retired with the same proof attached (seq 15 and
16): with them in the prompt the critic wrapped its JSON in a markdown code fence on 34 of
150 calls, which the extension's parser does not accept, so the critic failed and the
evaluator capped those runs to Adequate. That is a parser robustness gap, not a bad rule;
once the parser tolerates fences the critic lessons can be re-tried as their own bundle.
Critic-versus-jury agreement was unchanged (93%) on the calls that parsed.

**Where the promotion lives.** The lessons store on the proof proxy was in memory, so the
promotion exists in this write-up, in `proof-bundle1.md`, and in the run directory; it is
re-applied with two commands (`lessons.js create` and `lessons.js status --proof`) on the
persistent dev proxy once the dev database exists, and rolled to production in phase 6.

**Operational note.** The proxy instance behind the run was first started through the
session's background facility, which has a one-hour limit; it stopped at replay 63 and the
next eleven replays failed without a model call. The proxy was restarted as a detached
process, the failed artifacts removed, and the run resumed under the same lesson set. The
proof's single-set check confirms every treatment verdict ran under hash `d93555f3f157`.

**Follow-up fix, same day.** The critic failures traced to the model wrapping its JSON in
a markdown code fence once the learned rules were present; both parsers took the text
from the first brace to the last, so prose or a second brace after the fence broke them.
`critic.js` and the proxy's `parseCriticVerdict` now take the first balanced object,
preferring fence contents, and repair a trailing comma; a truncated answer is reported as
unparseable rather than as an exception. Tests on both sides cover fenced, prose-wrapped,
trailing-comma, truncated, and invented-label answers. With this in place the two critic
lessons can be re-tried as a small bundle of their own.

## Bundle 2 proof: completeness (2026-10-04)

Run `treat-bundle2`: the full set, three samples, the five completeness lessons (L001
collection, L003 sharing, L004 opt-out rights, L005 billing, L008 deletion) pinned
together with the six proven lessons; control `treat-bundle1`, so the proof measures what
the five add to the current best. Cost $39.37. Text-free proof committed as
`proof-bundle2.md`. The run paused once at replay 119 when the trainer workspace reached
its monthly cap; the owner raised it and the run resumed under the same lesson set.

**Not proven.** Jury score -4.1 on the 30 paired work sites (95% interval -7.8 to -0.4)
and -4.6 on the holdout (-10.1 to 0.6); 28 of 49 sites fell. The lessons did what they
said: incompleteness fell from 72% to 59% of applicable sections, improving on 40 of 49
sites, with billing (85% to 54%) and deletion (75% to 58%) moving most. But fabricated
specifics came back in the same breath: 38 to 107 across the run, 28 to 74 verdicts with
at least one, concentrated in recipient scope (32) and jurisdiction (11), the exact things
the completeness lessons ask the analyzer to say more about. Section accuracy stayed near
zero errors; the jury scored the invented scope claims as fabrications, and ten points
each outweighed the completeness gain.

| | baseline-1 | bundle 1 | bundle 1 + 2 |
|---|---|---|---|
| Jury score, mean | 70.5 | 76.5 | 72.3 |
| Fabrications, total | 107 | 38 | 107 |
| Incomplete sections (all) | 68% | 72% | 59% |
| Billing incomplete | 81% | 85% | 54% |
| Deletion incomplete | 85% | 75% | 58% |

**Decision.** The five completeness lessons are retired with the proof attached; the six
bundle-1 lessons stay promoted. The result is informative rather than a dead end: asking
for more coverage without restating the grounding rule in the same breath trades
fabrications for completeness one for one. A revised bundle (2b) should carry the guard
inside each completeness lesson ("list every recipient category the document names, and
only those; say the document does not specify a scope when it does not") and be proven one
section at a time, starting with billing and deletion where the completeness gain was
largest and the fabrication cost smallest.

**Next after 2b.** The two critic lessons retired in bundle 1 for the parser's sake are
owed a re-try now that both parsers accept fenced JSON.

## Bundle 3 proof: critic lessons (2026-10-10)

Run `critic-b3-baseline`: the critic alone, re-run by `tools/critic-replay.js` over the 150
graded `baseline-1` analyses with the two critic lessons (L014 menu paths, L016 URLs)
pinned, and compared by `tools/prove-critic.js` with the critic verdicts `baseline-1`
already holds, against the jury verdicts it already paid for. The baseline analyses were
chosen because they carry 107 jury fabrications, 51 of them menu paths and URLs, so the
critic has something to catch. Cost $6.79, critic calls only. Text-free proof committed
as `proof-bundle3-critic.md`.

**Not proven.** The critic now sees the invented specifics: on verdicts where the jury
found a fabrication it raised a concern or a flag on 86% instead of 47% (95% interval
+22 to +54 points). But it mostly says so in `flags`, which the evaluator ignores; the
section label moved to unsupported or vague on 51% instead of 34%, a gain inside the
noise (−10 to +38 on the work split). False alarms on verdicts the jury found clean may
have risen by up to 24 points. And the longer answers hit the critic's 600-token
completion ceiling on 14 of 150 calls, every one of them cut off mid-JSON, against 2 in
the control; the fence fix from bundle 1 held, no fenced answer failed.

| | baseline critic | with critic lessons |
|---|---|---|
| Noticed a jury fabrication (label or flag) | 47% | 86% |
| Caught it in the section label | 34% | 51% |
| False alarms on clean verdicts | 31% | 39% |
| Agreement with the jury on acceptability | 93% | 92% |
| Unparseable answers | 2 of 150 | 14 of 150, all at the token ceiling |
| Evaluator label would change | | 62 of 150 (38 Strong to Adequate, 12 Adequate to Strong) |

**Decision.** Both critic lessons are retired with the proof attached (ledger seq 3 and 4
on the proof proxy). Two follow-ups come out of it, one free and one cheap. The proxy's
critic ceiling is raised from 600 to 1,000 tokens (`CRITIC_MAX_TOKENS` in
`analysisOperations.js`), since the ceiling, not the rule, caused every parse failure. And
the rule is reworded to say where the verdict belongs: label the section unsupported, not
only a flag, and keep the flag to twenty words. That re-try is queued as the campaign
spec `reference/campaigns/critic-3b.json` (critic kind, about $7) for the next budget
round. The notice-rate result says the lesson is understood; the label result says the
wording has to point at the field the evaluator reads.

## Bundle 2b proof: guarded billing and deletion lessons (2026-10-10)

The first campaign run by `tools/campaign.js` (`reference/campaigns/bundle-2b-billing-deletion.json`):
the six proven lessons carried, L005 and L008 reworded with the grounding guard in the
same sentence (L005b billing, L008b deletion), a ten-site screen, then the full proof
against `treat-bundle1`. Text-free proof committed as `proof-bundle2b.md`, the campaign
report as `campaign-bundle2b.md`.

**Screen passed.** On the ten most sensitive sites fabrications per verdict went from 0.10
to 0.27 (stop at +0.25) and the jury mean from 80.1 to 78.2 (stop at 5 points), so the
proof ran. Cost $8.81.

**Not proven.** Jury score +0.9 on 26 paired work sites (95% interval −1.8 to 3.7), −2.2
on 16 holdout sites (−7.7 to 2.9); 22 sites better, 19 worse. The lessons did their job on
completeness: incomplete sections fell from 73% to 65% across the set (−14 to −3) and from
73% to 59% on the holdout. Fabrications held on the work split (0.29 to 0.23 per verdict)
but rose on the holdout from 0.10 to 0.38 (0.06 to 0.52): coinbase −28, github −21, slack
−13. Cost $34.76; the trainer workspace's monthly cap closed during the jury, so 22 of 150
verdicts are ungraded until November and 42 of 49 sites are paired.

| | bundle 1 (control) | bundle 1 + 2b |
|---|---|---|
| Jury score, work / holdout | 76.5 / 78.4 | 77.4 / 76.1 |
| Incomplete sections, all / holdout | 73% / 73% | 65% / 59% |
| Fabrications per verdict, work / holdout | 0.29 / 0.10 | 0.23 / 0.38 |
| Fabrications that assert an absence | 14 of 38 | 23 of 36 |

**What the fabrications were.** Of the 36 jury fabrications under 2b, 23 are claims of
absence that the document contradicts: "the document does not limit this right to certain
residents" (7, from L008b), "gives no web address for these pages" (10, the promoted L015
and L019 habit amplified), "does not name data that survives deletion" (2). On the
holdout 12 of 18 fabrications are of this kind, against 1 of 7 in the control. The guard
"where the document is silent, say it does not say" turned silence into a factual claim,
and the model made that claim where the document was not silent. Ten points each.

**Decision.** L005b and L008b are retired with the proof attached. The lesson for 2c is
about wording, not about completeness: instruct omission, never asserted absence ("leave
it out" instead of "say the document does not say"). The same flaw sits in the promoted
L015 and L019, which also tell the analyzer to "say so" when an address or step is
missing; they earned their proof on fabricated specifics, but a revision that drops the
asserted-absence clause is a candidate for a later round, proven against `treat-bundle1`
like any other change.

**Operational.** The campaign stopped once between the screen and the proof on a transient
local fetch failure and resumed from its state file with one command; the driver's proxy
calls now retry. Replays carried the run id into the proxy log on every call.
