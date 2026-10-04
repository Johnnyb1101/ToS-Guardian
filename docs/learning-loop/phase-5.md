# Learning loop — Phase 5: the analyzer loop

Status: built and verified, awaiting review; no proof run yet (2026-10-03). Follows
phase 4 (`phase-4.md`).

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
