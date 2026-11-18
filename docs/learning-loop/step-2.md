# Step 2 preparation: a fair test of six Analyzer lessons

Preparation is approved. Fresh site count, pass criteria, independent-judge coverage,
human-review coverage, and spending cap are not approved. The tools added here have
no provider execution, owner-signing, activation, promotion, or deployment command.
They accept synthetic preparation artifacts only. Changing a JSON flag does not
unlock a live evaluation.

## What the comparison will isolate

The control release contains no Analyzer lessons. The treatment contains exactly six
explicitly selected Analyzer lessons. Their complete release snapshots must otherwise
match, including Critic lessons, learned sites, model/prompt/rubric policy, and runtime
versions. This avoids the historical bundle-1 comparison's simultaneous Analyzer and
Critic changes. The exact six records must be reviewed and frozen before a real run;
matching lesson IDs alone does not excuse a changed scope, order, or release hash.

Historical results remain useful diagnostics. They cannot be relabeled as a fresh
final evaluation, and the existing work/validation split is unchanged.

## Offline preparation commands

From the ToS-Guardian folder in VS Code's terminal:

```powershell
node tools/final-evaluation.js --help
node tools/final-evaluation.js init reference/final/step2-prep
node tools/final-evaluation.js check reference/final/step2-prep
node tools/final-evaluation.js report reference/final/step2-prep
```

Choose a new directory for each preparation. Initialization refuses to overwrite an
existing directory. It inventories local `reference/manifest.json`, `sources/`, and
`runs/` before writing a draft protocol, history snapshot, null corpus/release inputs,
and empty artifact/grade/review arrays. It does not fetch new documents or contact a
proxy. Files under `reference/final/` are ignored by Git, like historical raw artifacts.

`check` and `report` deliberately exit **2**: this preparation workflow cannot report a
successful final evaluation. Invalid CLI or filesystem input exits 1. Reports distinguish
invalid evidence from unresolved approval decisions; even structurally complete mock
evidence stays `diagnosticOnly: true`, `promotionEligible: false`, `evaluationPassed: false`.
Reports use new filenames and preserve previous reports. Missing usage remains unknown,
not zero cost. Failed attempts remain in attempt history and cost/latency accounting.
Pipeline costs and independent-judge costs are reported separately, with explicit unknown
usage and latency counts. No missing judge charge is silently treated as free.

## Corpus and protocol integrity

`final-corpus-lib.js` defines a separate final-only corpus with learning disabled,
frozen exact source text/hashes, document type, domain, organization identity, capture
URL/time/method, and a fingerprint of the supplied historical inventory. It rejects
known domain, organization, and exact source-hash overlap and duplicate corpus members.
Historical input bytes are inventoried so their snapshot can be audited later.
Each check/report rescans the recorded local history location and refuses a stale
snapshot. Adding or changing historical files requires a new preparation and overlap review.

The inventory covers only the supplied local history. It does not discover organization
aliases, semantic duplicates, unseen external experiments, or all prior model exposure.
These limitations are explicit. Freshness, representative site selection, document
eligibility, and similar-policy screening still require a reviewed procedure before a
real evaluation. A local hash establishes integrity, not secrecy or access isolation.

The five unapproved protocol fields remain null. The draft's one repetition is only a
synthetic wiring default, not an approved live sample count. Runtime fingerprints, both release
hashes, corpus hash, exact selected lesson IDs, and planned independent judge identity
can be bound in a draft with the exported `createDraftProtocol`/`seal` APIs. Hand-editing
a bound record without resealing it is detected. There is no approval API in this step.

Preparation artifacts explicitly carry `split: final`, final-only purpose, and disabled
learning. Their analyzed source must exactly equal the frozen corpus text; a later live
runner will need an approved excerpt policy if it uses truncated or transformed input.
Final examples must not enter reflection, dream, candidate revision, or tuning. The
legacy tools retain their work/validation contracts and reject final corpus formats.
After looking at real final results, any tuning requires another untouched final set.

## Independent judging and human review

The offline evidence contract binds independent grades to exact artifact, protocol,
configuration, source, summary, and Critic hashes, plus the planned judge's provider,
model, prompt, and rubric. Its independence from the Analyzer is checked. It does not
execute a second provider; live acquisition requires a later approved implementation.
Human judgments remain qualitative rather than being converted into invented scores.

For synthetic preparation artifacts, the separate review tool creates a blinded package:

```powershell
node tools/final-review.js prepare reference/final/step2-prep/artifacts.json reference/final/step2-prep/review
node tools/final-review.js serve reference/final/step2-prep/review reference/final/step2-prep/artifacts.json
```

The empty initial artifact array must first be populated with valid synthetic fixtures;
the review tool rejects an empty package. The server listens only on 127.0.0.1 and shows
source and summary without arm/configuration or AI-verdict metadata. The source itself
may identify its site. Private mappings stay on disk; the workspace owner can inspect
them, so blindness depends on review procedure as well as the interface.
All attempts remain in the artifact file. Review selects only each slot's current
successful head; a failed current attempt cannot expose an older success for review.
All-failed inputs receive a clear error. Freeze the artifact set before preparing review;
changed outputs require a new preparation/review package rather than reusing old marks.

Claims and omissions are separate findings. Reviews quote exact source evidence; claim
findings also quote the summary. Unsupported and unsure judgments need an explanation.
Unsure remains unresolved. Attempts are appended, hash-linked, and bound to exact inputs;
stale or altered inputs are rejected. Browser rendering uses text content and does not
store private mappings in browser storage. Keep human calibration examples separate.
The report loads the validated log from the preparation's `review/` folder. A nonempty
`human-reviews.json` import must exactly match that log; standalone imported marks are rejected.

## Reports and next decision

The descriptive report separates accuracy, fabrication counts, completeness, failures,
cost and latency, with paired per-site effects. Repeat samples and retries do not become
additional independent sites. No confidence threshold, effect margin, reviewer coverage,
or statistical pass rule has been silently chosen. A small independent/human audit does
not establish the correctness of all automated judgments.

Before a live run, James must approve the fresh site count and strata, repetitions,
pass criteria, independent/human review coverage, adjudication procedure, judge/model
choices, retry policy, and spending cap. Provider execution and final eligibility then
need a separately reviewed implementation. Final evidence remains separate from owner
authorization; this preparation adds no signer and invokes no proxy activation route.

## Verification

`npm test` includes the new history, corpus, evidence, review, and CLI regressions.
The review-server tests use loopback HTTP with synthetic data. No provider responses
are bought and no live database is needed. There is no lint script; run `node --check`
on changed JavaScript plus Git working/staged whitespace checks. The proxy runtime,
migrations, historical artifacts, and existing diagnostic tests remain unchanged.
