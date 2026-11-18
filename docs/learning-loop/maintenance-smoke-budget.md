# Four-call diagnostic budget checkpoint

This is an OFFLINE implementation and synthetic test, not permission to spend.
`tools/maintenance-smoke-budget.js` cannot transmit requests. Its `dispatch()`
always throws, including when given an enable flag. There are no credentials,
HTTP clients, retry/redirect implementations, deployment operations or signing.
All outputs remain noneligible for evaluation and release promotion.

## Fixed scope and budget

One document, historical baseline and current candidate, Analyzer then Critic
for each arm. Exactly four calls, no judge. The independent task ceiling remains
$20 USD; James's account-level $50 setting does not expand it. Four complete
1,000,000-input-token reservations at Sonnet 4.6 standard global input $3/M and
output $15/M, with 1,200 Analyzer/1,000 Critic output ceilings, total $12.066 before
tax/fees. This is a conservative reservation, not predicted consumption.

The complete four-call amount plus declared hosting/fees, with tax applied to the
entire subtotal and rounded UP to a microdollar, must fit before initialization.
Tax, fee and hosting values cannot be null/missing. Provider/model metadata,
pricing and billing evidence hashes and account scope must be supplied. They
are BYTE BINDINGS TO SUPPLIED ASSERTIONS, not independently authenticated facts.
No real billing evidence or final paid-plan approval has been supplied here.
The code requires the documented 1M window, exact price schedule and API version;
changed metadata/rates must fail and receive review, never silently adapt.

Source: https://platform.claude.com/docs/en/models/sonnet-4-6/overview
https://platform.claude.com/docs/en/api/messages/create

## Local approval-wide registry boundary

The module has one immutable task identity and one fixed per-OS-user directory
under AppData/Local/ToSGuardian. There is no public root, alternate task/run ID,
recovery, reset or limit override. Both runs cannot evade the same budget by
selecting different output directories. Initialization uses exclusive creation,
and subsequent opens must match the original whole plan. The header commits the
entire four-call envelope; settled/failed calls never free capacity. Calls follow
the one exact order; fifth calls and retries fail even after a clean restart.

An OS-exclusive file lock excludes other processes. Every hash-chained record is
fully written and fsynced before reservation returns. A failed write/fsync poisons
the instance. Crashes retain the lock. Partial journals, malformed events,
unknown usage and unresolved attempts fail closed, requiring manual reconciliation.
There is deliberately no automatic stale-lock removal. Diagnostic test fixtures
remain clearly labeled synthetic and do not constitute provider usage records.

This is a trusted-local-process WORKFLOW GUARD, not hostile-user-proof storage,
provider-account-wide control, hardware durability guarantee or credential broker.
Someone deleting/rolling back files, changing OS users, editing this code or using
a key elsewhere can bypass it. A production sole-credential broker/authoritative
approval registry remains necessary before making stronger claims.

## Request and artifact binding limitations

The plan binds and rehashes exact baseline/candidate artifact and release files,
the document and harness before every reservation. Request shape permits only
the official Anthropic endpoint, fixed model/cap, one plain-text user message and
system text. Unknown features, tools, caching directives and transport options
are rejected. The 150KB text limit is only a sanity check, NOT a tokenizer bound.
Full model-window reservation is used instead. Critic reservations bind the
preceding recorded Analyzer output hash; each actual request hash is durable.

However, the module does NOT yet prove that a caller's supplied request was
constructed by those bound build bytes from the bound document or preceding
output. It does not parse or independently authenticate provider responses,
metadata, account identity, billing statements or supplied release provenance.
The stub has no network behavior to test; it is not proof that a future HTTP
adapter disables retry/redirect/fallback. These are explicit live integration
blockers, not hidden behind a valid hash or successful offline test.

## Before any paid request

1. Bind current candidate and historical baseline accurately; never call the
   reconstruction an authenticated old production image.
2. Verify actual account/model/pricing, tax and incremental fee/hosting bounds.
3. Integrate trusted request construction and authentic provider response parsing
   with the durable reservation boundary. Test disabled retries/redirects,
   transport timeouts and unknown charges with a fake transport, not paid calls.
4. Independently review the complete boundary and show James the exact four-call
   plan and all-in bound for final approval. Approval of this offline work or his
   $50 account setting is not that approval.
5. Stop before $20. If more is foreseeably needed, notify James; never raise the
   task cap automatically. A failed/partial smoke is not permission to retry.

Even a successful live smoke would not establish maintenance-release acceptance,
calibration, full corpus quality, production health or authority to deploy.

## Tests

Run `node tests/maintenance-smoke-budget.test.js`. Test-only VM loading substitutes
the OS home and local-path adapter to use disposable directories, with actual
filesystem writes and a separate real Node process for lock exclusion. The
production module exports no test path override. Existing path tests cover the
Windows fixed-drive/junction validation separately. Test assertions and receipts
are synthetic; no API calls are made.

## Trusted builder/fixture-parser integration

`tools/maintenance-smoke-session.js` adds an offline-only session around the guard.
For this adapter the two artifact files must be JSON captures produced by
`captureRuntime`, NOT ZIP files or arbitrary image archives. Exact capture and
release bytes are loaded and checked, then the actual `executeBound` implementation
checks the release against its captured runtime policy and builds the request.
The document binding is JSON with `domain`, `text`, `sourceUrl`, `capturedAt`.
Its metadata is supplied provenance, not proof of a real or fresh website fetch.
The harness binding must be the actual local `maintenance-bound-runtime.js` file.
All local tooling is trusted; this is not a hostile-code sandbox or authenticated
complete toolchain provenance.

The wrapper accepts no caller-supplied requests. Each Critic request is built from
the same bound document and the preceding parsed Analyzer fixture text. Exact
constructed request bytes are hashed and reserved before being returned. Returned
objects are only diagnostics; changing them cannot change the stored request hash.
There is no HTTP adapter, credential access or transport injection in the session.

The strict Anthropic fixture parser permits one nonempty text block, the exact
model, `end_turn`, null stop sequence and bounded integer input/output usage with
zero cache usage. Unknown fields/features, truncation, refusal and tools fail
closed. This deliberately narrow schema may reject legitimate newer provider
response fields; update only after review, never silently ignore billing fields.
Any rejected response leaves the full reservation and halts. Duplicate response
IDs fail. Restart of a partially/completely used session requires manual evidence
reconciliation; it cannot invent prior Analyzer output or replay calls.

Run `node tests/maintenance-smoke-session.test.js <historical-root> <current-root>`.
This explicit suite pins the historical baseline config `2afe5ea9...` and the
reconciled current candidate config `1fad3448...` / runtime `df752255...`. It uses
real captured modules but synthetic document/response/billing fixtures. The
candidate is a local reconciliation of deployed commit `109b189`, not proof of a
fresh current production snapshot. It must be refreshed before a later paid run.

This closes the caller-request construction gap INSIDE this offline session, not
the lower-level raw Registry API. Fixture responses remain unauthenticated and
are explicitly labeled synthetic. Real response/transport authentication,
verified account/billing facts and final exact paid-plan approval remain gates.

## Disabled transport implementation rehearsal

`maintenance-smoke-transport.js` contains a PRIVATE one-shot HTTPS implementation.
Its only export is `dispatch`, which always rejects before opening a socket or
accessing credentials. No enabling option exists. The private function is not yet
wired into the session or a final-approval boundary and cannot be called through
the production module API. The session now retains canonical request bytes in
private pending state; mutating a returned diagnostic object cannot rewrite that
reservation or its receipt.

The private implementation pins the official hostname, port and Messages path,
certificate validation, TLS minimum, API version and identity encoding; it uses
no SDK, redirects, retries, fallback, custom agent or environment proxy adapter.
It permits one request only, imposes a 60-second total deadline and 1MiB response
ceiling, checks complete UTF-8 JSON plus the strict stage parser and requires a
provider request ID. Errors are sanitized; all failures are labeled unknown cost,
never retryable/refundable. Each actual future invocation must already have its
complete durable reservation and must record failure in that ledger.

`node tests/maintenance-smoke-transport.test.js` uses ONLY a fake `node:https`
module and synthetic timers. Test-only module instrumentation exposes the private
function; the distributed public export remains disabled. Tests prove option and
state-machine behavior, NOT a real TLS handshake, provider/account authentication,
real response compatibility, proxy bypass behavior in an actual network or billing.
The current module cannot execute a live evaluation, even with a credential or
an enable flag. No credential lookup or storage is implemented.
