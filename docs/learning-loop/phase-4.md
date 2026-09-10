# Learning loop — Phase 4: community run reports

Status: complete, awaiting review (2026-09-10). Follows phase 3 (`phase-3.md`).

## Goal

Let people who choose to help feed the site-learning loop with the same facts the owner's
own runs produce, and nothing more. Off by default, explained once, never a condition of
using the extension, and built on the one record format that has already been proven to
carry zero user data.

## What a report is

A report is the episode the extension already keeps in observer mode, passed through
`stripLocal` and validated as uploadable: stage facts about the site and the documents
(which documents were found and where, whether they read as legal text, sizes and hashes,
what the analyzer, critic, and evaluator concluded, whether it rendered), the registrable
domain, and the day. It never carries the page the person was on, what they clicked, any
text from the page or document, an identifier, or a timestamp finer than a day. Batch and
replay runs are never reported; only a live run in a browser is. A report may carry the
analysis receipt the proxy issued for that run, so the proxy can tell a report that
corresponds to an analysis it actually performed from one that does not.

## Extension

- `community.js` holds the setting (`tosGuardianCommunity`, off and undecided by
  default), the one-time prompt rule, the report builder, and the outcome messages.
- The orchestrator keeps the episode record whenever community reports are on for a live
  run, sends the stripped record after the `end` stage, and attaches the analysis receipt
  when the run analyzed. Observer mode and community reports are independent: the local
  collector only receives events when observer mode is on.
- The overlay offers the prompt once, after the first successful summary, in the card's
  footer: what a report is, what it never contains, that it is off unless turned on, and
  that it can be changed in Options. Two buttons, "Turn on" and "No thanks"; either answer
  records the decision and the prompt never returns. Options has the same switch with the
  same explanation.
- `background.js` handles the decision message (a boolean and nothing else) and posts
  reports fire-and-forget; a failed send is logged and never affects the overlay.

## Proxy

- `POST /report` (6 a minute) validates the body with `episodeSchema.js`, a copy of the
  extension's `episode.js`: version 1, uploadable, live mode, dated within two days, at most
  64 KB, no field outside the allowlist, a domain present. It is exempt from the generic
  input scanner for the same reason the analysis route is: the allowlist is the stricter
  gate, and the scanner trips on hashes and receipt tokens.
- The receipt is verified with the proxy's own signing key and must name the model the
  report names. A verified report is receipt-bound; an unverified or absent receipt makes it
  unbound. Both are stored in `run_reports` (day and received day, never a timestamp).
- A receipt-bound report whose fetch stage found legal documents by a discovery path other
  than candidate guessing becomes a `community` proposal in the phase 3 loop, subject to
  the same verification, three-day floor, halt, expiry, and ledger. Unbound reports feed
  nothing; they are kept for reflection.
- `GET /learning/reports/:domain` (trainer only) lists a domain's report summaries; the
  status route counts reports.

## Tests

- `tests/community.test.js`: defaults, decision, prompt rule, report building (strips the
  page url, button label, bottom line, and fine timestamps; drops query strings; refuses
  batch and replay; keeps a string receipt only).
- `tests/system.test.js`: a live run with reports on sends one uploadable report carrying
  the receipt and no page url; batch runs never report; off by default; a failed discovery
  is still reported without a receipt; observer stays silent while reports are on.
- `tests/proxy-contract.test.js`: the decision message turns reports on or declines them,
  and rejects non-booleans and extra fields.
- Proxy `runReports.test.js`: validation (page url, batch, stale day, unknown field, version,
  size, bad receipt), proposal derivation, receipt verification, intake with bound,
  unbound, forged, and model-mismatched receipts, summaries without identifiers.
- Proxy `reportRoute.test.js`: the route through the app with an in-memory store,
  including the trainer-only listing and that one community day does not promote a site.

## Live verification (2026-09-10)

Against a dev proxy on port 3001 with the trainer key, in-memory learning, and the trainer
flag: one real analyzer call produced a receipt; a report built with the extension's own
`buildCommunityReport` from a live-mode event list (page url and button label in the local
layer, a query string on a document url) came out with none of them and was accepted as
receipt-bound, and its acorns.com documents became a `community` proposal recorded for the
day. The same report without the receipt was accepted as unbound and fed nothing. A copy
with a page url smuggled into the fetch stage was refused with the field named. Status
counted two reports and one proposal, the trainer listing showed both summaries with
their binding, and `GET /site/acorns.com` stayed 404, because one community day is not
agreement. Total model spend for the check: one tiny analyzer call, under a cent.

## Rules carried forward

- Zero user data, now enforced at three points: the extension strips and validates before
  sending, the proxy validates the same allowlist on arrival, and the store keeps days,
  not timestamps.
- Community data is data. A report is evidence for the site loop only when the proxy can
  bind it to an analysis it performed, and even then it is one day of agreement, verified
  by the proxy's own fetch before anything is learned.
- Off by default. The prompt is shown once and records either answer.

## Not in this phase

- Community reports do not yet feed reflection (phase 2 reads replay runs). Once reports
  accumulate, `reflect` can take `run_reports` as a second input for fetch-path and
  discovery findings; the summaries stored for that purpose already exclude the episode.
- The `community` source is treated exactly like the extension source in the evidence
  floor. Weighting bound community reports differently from the owner's own runs is a
  decision for when there are enough of them to matter.
