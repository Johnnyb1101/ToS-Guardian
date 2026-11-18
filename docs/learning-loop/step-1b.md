# Step 1B: complete release integrity

A release is one immutable snapshot of lessons, learned sites, and runtime policy. Its `configHash` fingerprints the canonical `{v:2,config}` envelope. Lesson text, scope, section, and explicit order are included. Runtime policy binds model choices, prompts, Jury rubric, selection rules, limits, proxy sources, and extension pipeline sources. Changing any bound input requires another release and evaluation.

## Runtime and replay

The extension starts a release session before site lookup or cache lookup. The proxy selects the active release and returns a signed, environment-bound token. Analyzer, Critic, escalation, learned-site lookup, and cache reads retain that release. After Analyzer, the token also binds the source document. Tokens expire after at most one hour; a continuation cannot extend their original expiry. Missing or incompatible policy, storage, or tokens fail closed.

Replay and Critic replay require `--config-hash <hash>` rather than a list of lesson IDs. Trainer requests require `TRAINER_ACCESS_TOKEN`; the proxy also requires `TRAINER_OPERATIONS=1`. Replay loads the complete prepared release and checks its fingerprint and the actual extension source fingerprint. The proxy and replay use the same lesson resolver: all-scope lessons plus the classified document type, in explicit order, with overflow rejected rather than silently truncated.

Each arm declares one complete release, but its selected lesson hash can vary by document type. Evidence checks recompute the exact selection and verify captured models, prompts, and rubric against policy. Control and treatment may use different release hashes; their fixed evaluation policy must agree. Step 1A evaluations remain diagnostic and cannot authorize activation.

The client fingerprint can be obtained locally without a provider call:

```powershell
node -e "require('./tools/pipeline-host').createPipelineHost({proxyUrl:'http://127.0.0.1:3000'}).clientPolicyHash.then(console.log)"
```

Set the reviewed fingerprint as `RELEASE_CLIENT_POLICY_HASH` on a separately authorized proxy deployment. Do not copy an old fingerprint after changing pipeline sources.

## Activation and rollout

Preparing a release stores a candidate without activating it. Activation requires a separately signed owner authorization covering the complete release hash, destination environment, expected generation and audit head, expiry, unique authorization ID, action, and final evaluation evidence. The owner's private approval key is not available to the proxy. The proxy trusts `RELEASE_APPROVAL_PUBLIC_KEY`; routine ledger or transport signatures cannot substitute for owner approval.

Activation commits the pointer, learned-site snapshot, consumed authorization, and signed audit event in one database transaction. Concurrent requests use compare-and-swap: only the request matching the current generation and head can win. An exact retry is idempotent. Rollback requires fresh authorization against the current state and creates a new generation. The halt guard is checked inside the transaction.

Rollout transports a signed v2 whole-release bundle. Its transport key (`ROLLOUT_PUBLIC_KEY`) and owner approval key are independently checked. A destination-specific authorization is required; source activation approval cannot authorize a different environment. Legacy per-lesson promotion and legacy bundle activation are rejected. Catalog creation and retirement remain available without mutating an active release.

Cache receipts and stored analyses carry `configHash`. Reads are partitioned by the pinned release and reject legacy or mismatched rows. Writes require a valid receipt for the currently active release. An analysis already in progress can finish on its pinned immutable snapshot after another release activates.

## Verification and current limits

Both repositories run mocked regressions with `npm test`. There is no lint script; use `node --check` for changed JavaScript and `git diff --check` for whitespace. The mocked cross-repository smoke check exercises the actual extension session, Analyzer, and Critic through the local proxy without paid provider calls.

The proxy's `npm run test:release-db` is a separate real PostgreSQL integration check. It requires an empty disposable local database, `psql`, `RELEASE_DB_TEST=1`, and `DATABASE_URL`. It refuses remote databases and ordinary database names. It covers concurrent activation, retries, rollback after a late transaction failure, halt, static-site protection, and restricted grants. A skip is not a pass; atomic database behavior remains unverified until this check runs successfully.

This implementation does not supply final independent evaluation evidence or issue production owner approvals. No real release activation, deployment, or cloud migration is part of the current work. Historical runs remain preserved; incompatible historical evidence is not upgraded by inventing metadata.
