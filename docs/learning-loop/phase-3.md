# Learning loop — Phase 3: the tier 1 fetcher loop

Status: complete, awaiting review (2026-09-10). Follows phase 2 (`phase-2.md`).

## Goal

Make the per-site facts the extension already learns (which documents a site has and
where) into a loop with the properties the design demands: proposals rather than writes,
verification by the proxy rather than trust in whoever wrote, an evidence floor, an expiry,
a halt boundary, and a ledger. Tier 1 is the only tier that promotes without a human, so
this is where the guard rails are proven first.

## What changed

**Before.** A `POST /site` from any anonymous client wrote the learned url set straight
into `site_database`, and the extension treated it as fact for fifteen days. One client,
one write, no check.

**After.** A `POST /site` is a proposal (`siteLearning.js` on the proxy):

1. **Cleaned.** Urls are https only, on the same registrable domain as the key, with query
   strings and fragments dropped so nothing user-specific can ride along; up to five
   supplemental notices; the discovery path as an enum. One row per domain, url set,
   source, and day. No identifier, no address, nothing finer than a day.
2. **Evidence floor.** The same url set on three distinct days (`SITE_AGREEMENT_DAYS`), or
   one proposal from the trainer. A client cannot claim to be the trainer: the source is
   forced to `extension` unless the proxy runs with `TRAINER_OPERATIONS=1`.
3. **Halt boundary.** Before any promotion the proxy checks three legs: `LEARNING_HALT=1`
   in the environment, a `learning.halt` file beside `index.js`, and the `learning_guard`
   row `halt` in the database. Any one halts promotion; proposals are still recorded.
   `GET /learning/status` reports which leg is set. The trainer proxy can set or clear
   the database leg with `POST /learning/halt`.
4. **Verification.** The proxy fetches each proposed url itself through the SSRF guard,
   strips it to text, and requires at least 500 characters that read as a legal document
   and do not look like an index of policies (many short lines, almost no sentences: the
   reddit.com case from phase 1). Verifications are cached for a day, so a rejected set
   cannot make the proxy re-fetch on every proposal.
5. **Promotion with expiry.** A verified set is written to `site_database` with the path,
   the url-set hash, the evidence, and `expires_at` (`SITE_TTL_DAYS`, default 30). The
   extension's `lookupSite` honours `expires_at` and falls back to the fifteen-day rule for
   rows that predate it. A proposal for a current entry after the verification cooldown
   re-verifies and extends the expiry; inside the cooldown it is a no-op. Static entries
   owned by the extension's code are never touched.
6. **Ledger.** Every promotion, refresh, rejection, and halt change appends to
   `learning_ledger`: `seq`, `prev_hash`, and `hash` = sha256 of the canonical JSON of the
   entry including `prev_hash`. `GET /learning/ledger` serves it; `tools/sites.js ledger`
   fetches and verifies the chain locally. Signing is phase 6.

**Extension.** `learnSite` sends supplemental urls and the discovery path, and logs the
proxy's outcome (recorded with days still needed, promoted until a date, rejected with
the reason, halted, static). `lookupSite` uses `expires_at` and returns supplemental urls
and the path. The four fetcher call sites pass their path.

**Tools.** `tools/sites.js propose` turns frozen manifest entries into trainer proposals
against the dev proxy; `status`, `ledger`, `halt`, and `resume` read and drive the loop.

**Store.** `SITE_LEARNING_STORE=memory` runs the whole loop in process memory for a local
proxy without a database, which is how it was verified below. The Supabase store uses the
tables in `migrations/0002_site_learning.sql`.

## Tests

- `siteLearning.test.js` (proxy): url cleaning, hashing, the index-page and legal checks,
  three-day promotion, same-day dedup, trainer promotion, halt, verification failure with
  ledger entry and cooldown, static protection, refresh after cooldown, expiry, status,
  ledger tamper detection, the halt legs, the verifier.
- `siteLearningRoute.test.js` (proxy): every route through the app with an in-memory
  store, including the trainer-flag downgrade and the halt route's absence without the flag.
- `tests/site-database.test.js` (extension): proposal shape, outcome messages, `learnSite`
  posting, `lookupSite` expiry and legacy rules.
- `tests/sites.test.js` (extension): ledger verification, manifest-to-proposal mapping,
  rendering.

## Live verification (2026-09-10)

Against a local proxy started with `SITE_LEARNING_STORE=memory` and `TRAINER_OPERATIONS=1`,
no provider key, no database:

- `sites.js propose` for acorns.com and chase.com: the proxy fetched each proposed url
  itself, passed the document checks, and promoted both with a thirty-day expiry; ledger
  entries 1 and 2, chain verified by `sites.js ledger`.
- `sites.js propose` for reddit.com: refused as `invalid_site_urls`, because reddit's
  documents live on redditinc.com. The same-registrable-domain rule that stops cache
  poisoning also means a cross-domain document set can never be learned at tier 1; only a
  static entry can carry it (see findings).
- `sites.js halt`: ledgered as `halt-set`; a trainer proposal for coursera.org then came
  back `halted`; touching `learning.halt` added the file leg to the status; `sites.js
  resume` ledgered `halt-cleared` and the same proposal was promoted.
- The extension's own path, through the batch runner with writes on: snapchat.com's
  proposal was refused because its privacy policy is on snap.com; nytimes.com's proposal
  was recorded as an anonymous extension report with "2 more day(s) of agreement needed",
  and `GET /site/nytimes.com` stayed 404 until the floor is met. A second run the same day
  produced a different url set (the homepage's links vary between loads), so it was
  recorded as its own proposal rather than counted as agreement, which is the intended
  meaning of agreement.

Final state: 3 learned sites, 5 proposals, 5 ledger entries, chain verified.

## Findings for later phases

1. **Cross-domain document sets are common and unlearnable at tier 1.** reddit.com
   (redditinc.com), snapchat.com (snap.com), and live.com (microsoft.com, from phase 0) all
   keep their policies on another registrable domain. The rule that refuses them is
   right for anonymous reports. A later phase can allow a cross-domain set when the proxy
   confirms the site's own homepage links to it, which is verification rather than trust.
2. **The verifier checks "is a legal document", not "is the privacy policy".** chase.com
   was promoted with a security page in the privacy slot because the page has enough
   legal vocabulary. A slot-specific check (privacy vocabulary density for the privacy url,
   terms vocabulary for the terms url) belongs in the next revision of the verifier.
3. **Variable discovery on dynamic homepages** means the same site can propose different
   url sets on different loads, each needing its own three days. That favours stable,
   canonical urls, which is the behaviour wanted, but it also means learning is slower for
   such sites than the raw report count suggests.

## Rules carried forward

- Zero user data: proposals carry a registrable domain, public document urls without query
  strings, a path enum, a source enum, and a day. Verification fetches are the proxy's own.
- Community data is data: a proposal is evidence to be verified, never an instruction.
- The halt boundary is checked at the moment of promotion, on every promotion.
- Static entries are code; changing them is a pull request (tier 3).

## Not in this phase

- Community run reports (phase 4) will add the `community` source; the floor and
  verification already treat it like the extension source.
- Rolling promoted facts from the dev proxy to production (the design's "roll out" stage)
  and signing the ledger are phase 6.
- Fixing reddit.com's static entry is a code change; it is a dream candidate from phase 2.
