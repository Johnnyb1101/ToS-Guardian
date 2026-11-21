# Local maintenance preparation and evidence verification

The diagnostic preparation commands remain backward compatible. The separate
`maintenance-final` contract below now verifies predeclared, independently signed
observations and their actual local bytes. Implementing this validator does not
mean an evaluation has happened: this checkpoint produces no observed evaluation
success, release signature, activation or deployment. Its regression tests use
ephemeral keys and synthetic bytes only.

This checkpoint prepares evidence for a runtime-only repair. It does not run paid
models, fetch documents, sign a release, alter a deployed release gate, write to a database,
deploy, or establish that the app is healthy. Existing Step 2 tooling remains an
unchanged synthetic six-Analyzer-lesson experiment.

## Frozen scope

For diagnostic preparation, both inputs are canonical complete version-2 releases. The only permitted release
configuration difference is `policy.versions.serverPipeline`. Lessons, sites,
prompts, models, rubric, limits, extension fingerprint and every other policy field
must match. Both releases must retain disabled shared caching. Broader changes need
a new approved plan, not an expanded JSON allowlist.

Each release is bound to the SHA-256 and byte count of a supplied build artifact
(for example, an immutable image archive) and declared Node/npm/platform/architecture.
The tool rehashes the artifact on every check. It does not build an image, inspect
an archive or prove that its bytes actually implement the supplied release. Runtime
labels and evidence outcomes are supplied attestations, not authenticated execution
records. Matching hashes prove byte integrity, not provenance or correctness.

## Commands

Create a local spec with `baseline` and `candidate` entries, each containing:

```json
{
  "releaseFile": "candidate-release.json",
  "artifactFile": "candidate-image.tar",
  "runtime": { "node": "EXACT_VERSION", "npm": "EXACT_VERSION", "platform": "linux", "arch": "x64" }
}
```

Paths are resolved relative to the spec. Supply actual build versions, not the
placeholders above. Keep artifacts and logs free of credentials and private user
data. The tool makes no provider or HTTP calls. Its filesystem boundary currently
supports only ordinary paths on the Windows system drive, verified as a fixed
drive using the built-in Windows PowerShell/.NET APIs. UNC/device/root-relative/
drive-relative paths, alternate streams, mapped/secondary drives and every
existing reparse-point ancestor (including junctions and cloud placeholders) are
rejected before reading or writing. Verification failure stops the operation.
Other operating systems fail closed for filesystem operations at this checkpoint.

Use storage outside sync folders. These checks do not disable background sync,
authenticate a supplied file's origin, or protect against a hostile local process
changing filesystem paths between validation and access. They are not an operating
system network sandbox. There is no claim that ambient software cannot upload files.

```powershell
node tools/maintenance-evaluation.js init reference/final/maintenance-prep spec.json
node tools/maintenance-evaluation.js check reference/final/maintenance-prep
node tools/maintenance-evaluation.js report reference/final/maintenance-prep
```

Initialization refuses an existing directory. Reports have unique names and never
overwrite prior reports. `init`/`--help` exit 0 for command success, not release
success. `check`/`report` always exit 2 for diagnostic preparation, including a
structurally complete package. Invalid arguments, changed files or unreadable input
exit 1. No execute, approve, sign or deployment command exists.

## Supplied evidence

`protocol.json` freezes releases, builds and required coverage. `evidence.json`
starts empty. Tests require `windows-tests`, `linux-tests`, `release-db`,
`baseline-db` and `native-modules`. Reviews require `maintenance-scope` and
`independent-code-review`. Each record binds the protocol, candidate configuration,
candidate artifact and a nonempty local attachment, with an author, explanation
and explicit `pass`, `fail`, `skipped` or `unresolved` outcome.

For offline tooling, `recordEvidence(protocol, {kind, id, outcome, author, summary,
attachmentFile})` creates a sealed record; save it in `evidence.json` and map its
hash to the absolute attachment path in `locations.json`'s `evidence` object.
Do not relabel logs from a different build. Missing, duplicate, stale, failed,
skipped, unresolved or malformed records block structural completeness. Local
attachment bytes are rechecked on every CLI check/report. Preserve a failed package
and create a new preparation for a new attempt; this checkpoint has no retry log
or evidence-edit command. A resealed manual record is still only an attestation.

Even all passing supplied records produce `diagnosticOnly: true`,
`evaluationPassed: false`, `promotionEligible: false`. `structurallyComplete`
means only that all required input records are present and internally consistent.
It is not a quality verdict, trusted test execution or signable final evidence.

## Still required before a real evaluation

Owner decisions must freeze a fresh corpus, coverage, repetitions, acceptance
criteria, independent judge, human reviewer/adjudication procedure, retry policy,
model choices and total spending limit. No sample count, paid budget, statistical
claim or live pass rule is approved by this tool. A separately reviewed live
runner must preserve original responses/provenance and every attempt/cost, use
isolated non-production storage and enforce a hard budget before provider calls.
Human-review and independent-judge execution are not implemented here.

The diagnostic preparation cannot mint final proof or replace release approval.
Ordinary owner signing and activation remain separate, later checkpoints using the
existing exact-config, destination, generation, expiry and signature protections.

## Maintenance-final contract

`tools/maintenance-final-evidence.js` is a deterministic offline verifier. It does
not execute tests, builds, inference, human reviews or database commands. It
accepts an explicit trusted clock and an externally pinned Ed25519 reviewer
registry. Keys embedded in evidence are rejected. A passing signed statement is
an authenticated attestation; it is not proof that a provider, reviewer or capture
operator was honest. Reviewer keys must be established outside the evidence
package through the owner's existing authority.

`createFinalProtocol(preparation, spec)` freezes the complete baseline/candidate
build pair, `mode` (`fixture` or `observed`), canonical `declaredAt`, sample count,
repetitions, coverage tags, sources and capture provenance, rubric bytes, independent
judge provider/model/prompt, exact pipeline provider/tier/model selections and
reviewer identities. Pipeline model selections must match both releases' existing
model policies. No production model change is introduced. Each distinct source
must have a different hash; repetitions are declared separately. The corpus is
held out for maintenance evaluation, with learning disabled. An independent
preregistration signature binds this entire declaration before any run or test.
Observed source captures must precede preregistration and declare official capture;
the preregistration reviewer must check their origin and held-out status.

Final build pairs use `createFinalPreparation(baselineBuild, candidateBuild)` and
their own `maintenance-final-build-pair` schema. They permit only the four reviewed
differences `policy.versions.serverPipeline`, `storageSchema`, `baselineSchema`
and `migrationManifest` (all under `policy.versions`). The candidate must bind a
complete migration manifest hash. All other configuration contents must match,
including lessons, sites, prompts, models and disabled shared cache. This additive
contract does not widen the original diagnostic preparation allowlist.

Acceptance criteria are explicit finite minimum accuracy/completeness scores,
zero fabrications and a maximum candidate mean regression. Both the human and
independent judge must grade every baseline and candidate sample/repetition.
Every grade binds its exact signed run, rubric and retained review bytes. Judge
grades also bind the approved model/prompt and original request/response bytes.
Human and judge identities and keys must differ from one another and from the
execution observer. Scope and code review must use a different key from execution.

Every run binds its complete build identity and source, retains original request,
response and output bytes for Analyzer, Critic and pipeline Judge, and retains its
execution log. Execution observations must be signed by the externally trusted
execution role. They must follow preregistration and precede the trusted clock.
There must be exactly one run for every arm/sample/repetition coordinate: no
duplicates, retries, omitted failures, skipped samples or replacement passes.
This contract supplies no retry or adjudication workflow; preserve a failed
package and obtain a newly reviewed declaration for a new attempt.

Both arms require full `windows-tests`, `linux-tests`, `release-db`, `baseline-db`
and `native-modules` evidence with actual retained logs, commands, a zero exit
status, positive pass counts and no failures or skipped checks. The candidate also
requires `final-controller-sql-denial-matrix`, bound to the final candidate build.
The legacy baseline is not required to pass protections introduced by that change.
Final scope and independent code reviews bind both builds and the exact set of
run/grade/test observations. Missing, duplicate, stale, skipped, unresolved,
malformed, altered or unsigned evidence fails closed.

`validateFinalEvidence(protocol, evidence, {attachments, trustedReviewers, now})`
rehashes actual byte buffers for both builds, every source, rubric, judge prompt,
request, response, output, test log and review. Descriptors alone never suffice.
Individual ordinary attachments are capped at 16 MiB, build artifacts at 256 MiB,
metadata at 16 MiB and retained attachments in total at 768 MiB. The returned
report is sealed and deeply frozen. `fixture` mode can satisfy the contract but
always remains diagnostic, `evaluationPassed: false`, and ineligible. Only complete
`observed` evidence can produce a passing final report. No such real evidence is
created or signed by this work.

The existing `step2-final` authorization branch is unchanged. The added local
`maintenance-final` branch in `sites-lib.js` requires the full package and external
trust registry, recomputes the report, compares its exact summary with the owner
signed authorization, and forbids the owner's approval key from also serving as a
quality or final-review key. The controller must separately match baseline/current
and candidate identities to the approved source/runtime/schema/migration plan.
A success-shaped JSON summary or an owner signature by itself cannot bypass the
maintenance evidence validator. This local implementation does not update a
deployed release gate or authorize using real signing credentials.

For local-file verification, put `final-protocol.json`, `final-evidence.json` and
`final-locations.json` in a new package directory. Locations must have exactly an
`attachments` object mapping SHA-256 hashes to absolute local file paths. Supply
a separately trusted JSON registry mapping reviewer IDs to `{publicKey, roles}`.
Do not accept a registry merely because it accompanies an untrusted package.

```powershell
node tools/maintenance-evaluation.js final-check <package-directory> <trusted-reviewers.json>
node tools/maintenance-evaluation.js final-report <package-directory> <trusted-reviewers.json>
```

These commands use the same verified Windows local-path boundary as preparation,
rehash file bytes and use the current verification clock. Final reports use unique
filenames and never overwrite prior work. They return 0 only for complete observed
evidence, 2 for noneligible evidence (including complete fixtures), and 1 for invalid
arguments or unreadable files. No command generates observation signatures or
owner authorizations. The existing diagnostic `check` and `report` still always
return 2.

## Offline rehearsal for both release transitions

`tools/maintenance-observed-runner.js` prepares one plan for the activation
and recovery pairs. It binds the budget and journal directory to the plan
hash, verifies both preregistrations and the archive and source bytes, and
exercises the pipeline with fake provider responses. Its image request
builder uses the release policy and request builders from a verified image.
The caller supplies the binding between the measured archive and the running
image. Run the image request builder in an isolated environment.

Store budgets, request and response files, backups, and signed rehearsal
inputs in a private local directory outside the checkout or in the ignored
`.tos-guardian-private/` directory. Limit access to the operator. The runner
names output files by hash, and those files may contain full document text
and responses.

Run the offline runner and budget tests with the command below. Live provider
dispatch remains disabled, and the rehearsal produces fixture evidence.

```powershell
node --test tests/maintenance-observed-runner.test.js tests/maintenance-observed-budget.test.js
```

## Verification

### Captured-source execution and provider preflight

`tools/maintenance-source-harness.js` captures the exact bytes of the reviewed
proxy's analysisOperations, llmRelay, siteValidation, installed tldts CJS entry,
package.json and lockfile. It executes those captured module bytes, not reopened
paths, and records actual Node version/platform/architecture with the input,
captured-file and shaped-request hashes. This verifies request construction by
those modules. It does NOT execute the whole server, database, HTTP routes, native
dependencies, container or extension, and does not authenticate a deployed build.
No historical rebuild may be labelled the original deployed image.
The harness calls operation validation with default options: it does not resolve
or inject a release's lessons, check release tokens or prove release-configuration
behavior. Capturing package/lockfile bytes is not proof of installing or executing
their complete dependency graph.

Only use trusted, reviewed project source. The Node vm harness is NOT a security
sandbox and the restricted require mapping is NOT a malicious-code containment
guarantee. The narrow captured module dependency closure and host bindings are
explicit; unexpected requires and timeouts fail. It supplies no provider key,
process environment, HTTP transport or credentials. A non-secret placeholder is
used solely to exercise the existing request shaper; authorization headers are
discarded from the returned record.

`tools/maintenance-provider-preflight.js` converts that exact text-only Anthropic
Messages request into the official count_tokens request. Unknown fields (including
tools/cache directives), providers, models and oversized inputs are rejected, not
silently dropped. Both preparation and count observation bind the original full
request including its output cap. The count result is explicitly unauthenticated
input, not a hard upper bound. Anthropic's docs describe counting as an estimate:
<https://platform.claude.com/docs/en/build-with-claude/token-counting>.

`dispatch()` always rejects before credentials or network access, even if given an
enable flag. No actual count/provider API calls are made. OpenAI Chat Completions
input counting is not implemented. Live transport activation still requires exact
count/bound semantics, approved all-in budget and approval-wide replay controls;
neither these adapters nor the synthetic journal claim to solve that boundary.

Run `node tests/maintenance-source-harness.test.js` for mutation/timeout/dependency,
capture-byte, count binding, unknown/oversize field and disabled-dispatch tests.

### Offline runner foundation

`tools/maintenance-runner-lib.js` adds a pure in-memory synthetic runner and a
separate evaluation-side Luna adapter. No HTTP client, credential access, transport
injection, live switch, filesystem output or new dependency exists. It does not
load or execute either build. Existing production models, prompts, cache and release
gates are untouched. Run `node tests/maintenance-runner.test.js` for its fixtures.

The plan binds the validated preparation protocol and supplied build hashes to
12 synthetic sources, two arms and three stages (72 attempts). The inputs and
outputs are fixtures, not captured website documents or real pipeline execution.
Source hashes establish byte consistency only, not official origin, freshness,
correct extraction, real execution or reviewer identity. No simulated result is
`step2-final` evidence: reports always retain diagnostic/noneligible/failed-final
flags regardless of synthetic completion. Stage fixtures do not demonstrate
Analyzer-to-Critic-to-Judge semantic integration.

The budget uses integer microdollars, reserves each entire worst-case call before
simulated dispatch, forbids duplicate attempts, and never frees a reservation.
Missing/invalid/excess usage or transport failure halts all further attempts with
the full amount still reserved. There are no retries or escalation. Private
in-memory state protects against accidental snapshot mutation, not a hostile
process. The default in-memory ledger is NOT restart-safe. The separate optional
`tools/maintenance-budget-journal.js` persists synthetic reservations with an
exclusive create-only lock, append-only hash-chained records, and fsync before a
reservation returns. Use `new Journal(existingLocalDirectory, plan.hash, limit)`
as the fifth `runSynthetic` argument; close it only after settlement. Its header
binds plan hash, budget and the model/rate/cap policy. It replays schema, sequence,
hash chain, uniqueness, transitions and budget checks. The runner refuses a used
journal rather than replaying calls. Clean reopen retains all reservations.

Any partial tail, tampering, budget/policy mismatch or pending attempt blocks
reopening. A crash leaves the lock in place. There is no stale-lock breaker or
automatic recovery; operator reconciliation is required. `abandon()` closes file
handles but deliberately retains the lock. Write/fsync failure poisons the session;
no subsequent dispatch is allowed. A clean close removes only its lock. This uses
the same verified Windows system-drive path boundary as preparation. Tests inject
write/fsync failure and process exit, and verify restart/exclusion behavior.

This is best-effort local filesystem durability, not a guarantee against hardware
failure, hostile local edits/replacement, sync, deleted/rolled-back journals or
multiple distinct directories for the same approval. Hash chains are not
authenticated signatures. A reviewed central approval/run registry and real
dispatch integration remain necessary for an enforceable account-wide live cap.
No concurrent dispatch or recovery/retry path is implemented.

The illustrative 2026-11-14 standard API-only schedule is Sonnet 4.6 input $3 and
output $15 per million tokens; Luna input reserves $0.125 (higher cache-write rate)
and output $0.50 per million. Each request reserves 40,000 input tokens; outputs
are 1,200 Analyzer, 1,000 Critic and 8,000 Judge, for $6.768 across 72 attempts.
The tests use a hypothetical $10 allowance, NOT owner spending authorization.
Calibration, retries, hosting, taxes, regional/priority premiums and account billing
are excluded. Prices must be reverified before any live request. Official sources:
<https://platform.claude.com/docs/en/models/sonnet-4-6/overview> and
<https://developers.openai.com/api/docs/models/gpt-6-luna>.

The fixed model schedule is illustrative and does not assert that supplied release
policies use those models; synthetic test releases deliberately use mock labels.
Live execution must verify every model against the approved release policy while
keeping the evaluation-side judge separately approved.

The 40,000 input limit is simulated, NOT measured on real requests. Character
limits reject oversize sources/prompts without truncation but are NOT tokenizer
bounds. Live transport must first obtain a trustworthy full-request token upper
bound (including system prompts, summaries, formatting and provider overhead),
refuse unknown/oversized inputs, pin supported pricing/model identity, and keep
unresolved charges reserved across crashes. No estimated chars-per-token ratio
may silently replace that requirement. `countSyntheticRequest` checks a certificate
binding the full canonical request hash, model, explicit synthetic counter identity,
input count and complete-overhead assertion. The synthetic runner validates this
certificate and planned model before reserving each call, and halts if reported
usage exceeds its bound. Unknown, changed or oversized certificates fail closed.
This is caller-supplied fixture data, not a real tokenizer;
the returned result always says `liveDispatchAllowed: false`.

The judge adapter builds Chat Completions messages with explicit medium reasoning
and `max_completion_tokens: 8000`. Its strict response parser rejects missing
usage, refusal, truncation, tools, unexpected model identity and malformed JSON.
Its tiny `verdict`/`reason` schema is ONLY a synthetic contract fixture, not the
project's calibrated jury rubric. It does not repair malformed JSON. Real model
snapshot IDs may differ from the alias and currently fail closed; approve and
freeze the exact response identity policy before live use. Both request/response
hashes and IDs remain unauthenticated caller-supplied data.

Still unresolved before live work: final source selection (NPR was inaccessible;
AP is a proposed replacement), complete corpus capture/token measurement, separate
calibration and human rubric, exact-build runtime harness, approval-wide accounting,
complete all-in spending approval, and a concrete independently reviewed
preregistration/evidence package for the maintenance-final validator. The synthetic
runner supplies none of these observations and cannot bypass the final contract.

`node tests/maintenance-evaluation.test.js` exercises synthetic fixtures only and
is included in `npm test`. Run `node --check` on both tools and the test, plus
`git diff --check`. Include `tools/maintenance-local-path.js` in syntax checks.
Path regressions reject unsafe syntax and actual local junctions without contacting
a share. No dependency or production-runtime changes are required.

## Captured runtime and release binding

`maintenance-bound-runtime.js` captures the server-policy file set, required schema files and installed tldts module. It executes the captured release-policy implementation, validates the supplied release and requires exact policy equality before resolving release lessons and constructing a request. No source file is reopened during execution. This adds configuration binding missing from the earlier default-options module smoke test.

The local reconstruction smoke exercised both baseline and candidate, and rejected the opposite arm's release. The active release has zero lessons/sites, so real smoke evidence covers that configuration only; nonempty lesson propagation is a synthetic regression. The client-policy hash is taken from the release, not verified against extension bytes. Cache mode is bound, not exercised. These are trusted-source Node module checks, not hostile-code containment, image provenance, a live HTTP server, database behavior or inference. Reports remain diagnostic and ineligible.

## Live-spend boundary

Provider token-count observations remain estimates or unverified observations, not hard input bounds. The 40,000-token fixture limit must not be presented as real enforcement. Transport remains unconditionally disabled. A future live design must reserve a demonstrable upper bound (for example a verified model input-window bound at verified prices, or a provider-supported strict bound), include all overhead/premiums, and use an approval-wide budget identity to prevent a second directory financing duplicate attempts. A full-window reserve could materially exceed the illustrative quote and requires a new total approval. Do not turn counts or dollar estimates into a success flag.

## Release evidence decision

The existing `step2-final` experiment tests lesson efficacy and keeps its original
meaning. Maintenance evidence uses its separate `maintenance-final` label and
validator; it must never be relabeled Step 2 proof. The local verifier extension
does not establish that real maintenance evidence exists or that a deployed gate
accepts it. Signature, exact configuration, environment, prior generation and
expiry protections remain required. Real evaluation, reviewer enrollment, owner
signing and production adoption remain separate later actions.

Run the artifact integration separately with `npm run test:maintenance-bound-integration -- <reconstruction-root>`. The root must contain the reviewed baseline/candidate trees and corresponding release JSON files. The suite pins their expected policy/configuration identities, uses real captured modules (no resolver/policy stubs), checks Analyzer/Critic request construction, rejects swapped release configurations, and exercises a separately labeled synthetic nonempty lesson. It does not write or activate that synthetic configuration. Missing artifacts are a failure, not a skipped test. This explicit suite is separate from portable `npm test` because the reconstructed proxy artifacts are not extension dependencies or committed fixtures.
