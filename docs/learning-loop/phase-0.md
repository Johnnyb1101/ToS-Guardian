# Learning loop — Phase 0: foundations

Status: in progress (started 2026-09-06). Design page: see the "ToS Guardian Learning Loop"
artifact linked from the project memory. This note is the plan of record for phase 0 and is
updated as checkpoints land.

## Goal

Make the pipeline observable and replayable before anything learns. After phase 0:

- a live click-through in the browser and a headless batch run produce one structured
  **episode** record per site, in the same schema;
- the batch runner works against a **dev proxy** on localhost with its own provider key, so
  training runs never touch the production key, budget, or community cache;
- the proxy forwards **token usage** so every episode carries its real cost;
- the database schema exists as **migration files**, so a dev database can be created by
  running files instead of clicking.

Nothing in phase 0 changes what the extension shows users, and nothing learns yet.

## Checkpoint A — harness (this checkpoint)

Proxy repo:

1. `POST /v2/analyze` returns `usage` (normalized input / output / cache-read / cache-write
   tokens) alongside `text`, `stopReason`, `model`. Additive; older clients ignore it.
2. `.gitignore` excludes environment files. `npm run dev` starts the proxy with
   `node --env-file=.env.dev` (Node 22; no new dependency). `.env.example` documents every
   variable the code reads.
3. `migrations/` holds the reconstructed schema for `analyses`, `site_database`, and the
   `match_analysis` similarity function, with a checklist to verify against the production
   project before the dev project is created from it.
4. Tests: usage normalization for both providers (unit) and usage presence on the route
   (route test). Full proxy suite must stay green.

Extension repo:

5. `tools/batch-runner.js` no longer demands an API key (the pipeline has been keyless since
   the July proxy migration), accepts `--proxy <url>` (or `TOS_PROXY_URL`) to target a dev
   proxy, records cost from the proxy's forwarded usage keyed by the exact model id, and stops
   the run when `--budget <usd>` is crossed. Cost logic moves to `tools/batch-lib.js` so it
   can be unit tested.
6. Tests: `tests/batch-lib.test.js` (pricing by model id, budget stop, proxy override
   rewrite). Full extension suite must stay green.

## Checkpoint B — episodes (next)

Episode schema v1 (`docs/learning-loop/episode-schema.md` + validator), the batch runner
writing ndjson episodes, observer mode in the extension (dev-only flag, emits per-stage
facts to a localhost collector, never page text by default), `tools/observer.js` collector,
`tools/report.js` report generator.

## Rules carried from the design

- Zero user data in anything that leaves the machine. Observer mode is local-only in phase 0.
- Off by default at every layer. With every flag off, behavior is byte-for-byte today's.
- The user commits and merges. Each checkpoint stops for review with evidence attached.

## Checkpoint A — status (2026-09-06): landed, awaiting review and commit

Evidence:

- Proxy suite: every file green, including two new checks (usage normalization for both
  providers in `llmRelay.test.js`; `provider`, `model`, and `usage` forwarded by the route in
  `analysisRoute.test.js`).
- Extension suite: 68 passed in the existing files plus 35 in the new `tests/batch-lib.test.js`.
  One of those loads the real `background.js` and asserts the proxy override still applies, so
  a refactor of the constant fails the suite instead of silently sending a run to production.
- No-cost smoke run: a local proxy started with placeholder database values and no provider
  key; `node tools/batch-runner.js discord.com --proxy http://127.0.0.1:3999` matched the
  static site list, fetched both documents (62k chars), reached the local proxy's analyze
  route (its log shows the keyless refusal), and recorded a `Configuration` row at $0.

Two corrections found on the way, both included:

- `tests/` had been added to the extension `.gitignore` by accident in the domain-isolation
  commit. The six existing tests were tracked only because they predate it; any new test
  would have been dropped from commits and broken CI. The line is removed.
- The README still told users to enter their own API key, which has not been true since the
  July proxy migration. Installation, provider table (now naming the proxy's real default
  model), and the security bullet are corrected.

Not verified yet, needs the owner: the reconstructed migration against the production
project (queries in `migrations/README.md`), and the first real run against a dev proxy once
the dev database exists and `.env.dev` holds the trainer key.
