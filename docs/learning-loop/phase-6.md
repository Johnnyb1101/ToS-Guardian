# Learning loop — Phase 6: the outer ring

Status: built and verified live 2026-10-10; the first campaign (bundle 2b) is running. Follows
phase 5 (`phase-5.md`).

## Goal

Close the ring around the inner loops: every learning event is signed as well as chained,
what the dev proxy has proven can be rolled to production without anyone retyping it, a
campaign runs from "go" to a written report without a hand on the keyboard, and the owner
still makes every promotion. Nothing in this phase changes what the extension sends or
stores: the ledger, the bundle, and the report hold rules, hashes, counts, and dates.

## Signed ledger

The learning ledger was a hash chain: each row's hash covers the previous row, so a row
cannot be altered or removed without breaking every row after it. A chain alone cannot say
who wrote a row, since anyone with database access could append a well-formed one. With
`LEDGER_SIGNING_KEY` set (an Ed25519 private key in PEM form, `ledgerSigning.js`) the proxy
signs each row's hash and stores the signature beside it (`sig`, migration
`0005_ledger_signatures.sql`); `GET /learning/status` publishes the public key under
`signing`. A verifier that holds the public key checks both the chain and the signatures;
rows written before the key existed are reported as unsigned, not as broken. The key never
leaves the proxy's environment and is not in the database.

`tools/sites.js ledger` fetches the chain and the published key and verifies both;
`--public-key <file>` pins a key the owner saved earlier, so a proxy cannot substitute a
new key unnoticed. `tools/sites.js status` shows whether signing is on and the key's
fingerprint.

## Roll-out, dev to production

Lessons are proven and promoted on the dev proxy; production never runs a proof and never
sets the trainer flag. The dev proxy exports what production should recall:
`GET /learning/export` returns a bundle of promoted lessons (with proofs and provenance)
and live learned sites, hashed and signed with the dev ledger key, and ledgers the export
(`rollout-exported`). Production is started with `ROLLOUT_PUBLIC_KEY` set to the dev
proxy's public key and accepts the bundle at `POST /learning/import`, which exists only
when that key is set. The import (`rollout.js`):

- verifies the hash and the signature before reading any field, and is exempt from the
  generic input scanner because a signature is the stricter gate;
- refuses the whole bundle while production's halt boundary is set;
- imports each lesson as promoted only when its id matches its target and text and it
  carries a proof with `proven: true`; a lesson already promoted is left alone;
- imports each site with the exported expiry, never over a static entry, never with a past
  expiry, and leaves an identical or longer-lived entry alone;
- ledgers `lesson-imported`, `site-imported`, and one `rollout-applied` row with the bundle
  hash, the source head, the signer's fingerprint, and counts, each signed with
  production's own key;
- applies a bundle once; the same bundle hash is reported as already applied.

`tools/rollout.js export --proxy <dev> --out <file>` saves the bundle after checking it
against the key the dev proxy publishes; `show <file>` prints what it holds; `import
<file> --proxy <url> | --production` sends it. The owner runs the import deliberately,
and production's `ROLLOUT_PUBLIC_KEY` is the only trust anchor.

## Campaign driver

`tools/campaign.js go <spec.json>` is the "go" button. A spec (see
`reference/campaigns/`) names the proxy, the control run, the lessons to carry (already
proven, pinned but not under test), to create from a dream run, to revise with new text
and the retiring proof in their provenance, or to pin by id; an optional screen (a few
sensitive sites, three samples, a fabrication-rise limit and a jury-drop limit); the proof
(jury kind: full replay, jury, `prove.js` against the control; critic kind: critic replay
over a graded run, `prove-critic.js`); and an optional notification url. The driver:

1. checks the proxy is up, not halted, and exposes the lessons routes, and that the control
   and source runs exist;
2. registers the lessons through `lessons.js`, pacing the proxy's write limiter, and refuses
   to pin a retired lesson;
3. runs the screen through the existing replay and jury tools and stops when fabrications
   per verdict rise by more than the limit or the jury mean falls by more than the limit,
   which is the shape bundle 2's failure had;
4. runs the proof through the same tools and `prove.js` or `prove-critic.js`;
5. writes `campaign.json` (state, resumable step by step) and `report.md` (text-free) into
   `reference/runs/<name>/`, with the proposal and the exact `lessons.js status` commands;
6. posts a short notification (name, outcome, cost) to the spec's url or
   `CAMPAIGN_NOTIFY_URL` when either is set; an ntfy topic works as is.

The driver never promotes or retires. It checks the halt boundary before every spending
step and stops when learning is halted. Replays and jury passes skip existing artifacts,
so the same command resumes a campaign after a crash or a cap. Each replay carries an
`X-Trainer-Run` header with its run id, which a trainer proxy prints on its `[Analyze]`
log line (`run=<id>`), so spend in the proxy log can be attributed to the campaign.

## Critic calibration

Critic lessons cannot move a jury score, so the critic has its own instrument:
`tools/critic-replay.js` re-runs only the critic over a graded run's analyses and
`tools/prove-critic.js` pairs the verdicts with the jury's (catch rate, notice rate, false
alarms, agreement, parse failures). The jury report's critic-agreement section and the
reflect output's blind-spot list remain the standing calibration read. Both are described
in `phase-5.md` under Tools.

## Halt

Unchanged from phase 3: the environment leg, the file leg, and the database row, cleared
with `tools/sites.js resume`. Phase 6 adds the campaign driver's check before each spending
step and the import route's refusal while halted.

## Tests

- Proxy `ledgerSigning.test.js`: sign and verify, wrong text or key, escaped PEM, signed
  chain verification, forged and unsigned rows, status publishes the key, unsigned proxy.
- Proxy `rollout.test.js`: export selection, bundle hash and signature, tampering, apply
  with idempotence, halted target, unproven or mismatched lessons refused, static sites
  kept, past expiry refused.
- Proxy `rolloutRoute.test.js`: signed ledger over the routes, export, import round trip,
  tampered and missing bundles, routes absent without their keys or flag.
- Extension `tests/sites.test.js`: roll-out kinds, signature verification and rendering,
  bundle checks and summary.
- Extension `tests/campaign.test.js`: spec validation, step plans, budget split, screen
  decision, resume order, report and notification text.
- Extension `tests/pipeline-host.test.js`: the run tag travels as the header.

## Live verification (2026-10-10)

Two memory-store proxies on one machine: a dev proxy on port 3001 with the trainer flag and
a freshly generated Ed25519 ledger key, and a production-like proxy on port 3002 with the
trainer flag off, its own ledger key, and `ROLLOUT_PUBLIC_KEY` set to the dev key.

- The dev proxy published its key on `/learning/status`; every entry it wrote (lesson
  creations, six promotions with the bundle 1 proof, the export) verified with
  `tools/sites.js ledger`, both against the published key and against the key saved to a
  file; against the wrong key all fifteen signatures were reported invalid and the ledger
  BROKEN.
- `tools/rollout.js export` saved a bundle of the six promoted lessons (no learned sites
  on this instance) after checking it against the published key; the export was ledgered
  as `rollout-exported`.
- `tools/rollout.js import` on the production-like proxy applied it: six lessons imported
  as promoted with their proofs, seven signed ledger rows (`lesson-imported` times six and
  one `rollout-applied` naming the bundle, the source head, and the dev key's
  fingerprint), status showing six promoted lessons and no trainer routes. A second import
  of the same bundle answered "already applied" and wrote nothing.
- A bundle with one lesson's text changed was refused for its hash; a bundle re-hashed and
  re-signed by a stranger's key was self-consistent to `rollout.js show` and refused by the
  production-like proxy because that key is not the trusted one. Its ledger stayed at
  seven rows.
- `tools/campaign.js go reference/campaigns/bundle-2b-billing-deletion.json` ran end to
  end: health, registration of the six carried lessons and the two revised ones (eight
  pinned, each replay carrying its run id in `X-Trainer-Run`, 60 of 60 calls tagged in
  the proxy log), the ten-site screen (passed), the full proof, `prove.js`, the report
  with its proposal, and the notification step (skipped, no url). It stopped once on a
  transient local fetch failure before the proof and resumed from `campaign.json` with
  the same command; proxy calls in the driver now retry. The workspace's monthly API cap
  closed during the proof jury, which the jury recorded per verdict and the proof reported
  as 128 of 150 graded. Outcome in `phase-5.md` under bundle 2b. Total $43.57.

## Operational notes

- Generate a signing pair once: `node -e "console.log(JSON.stringify(require('./ledgerSigning').generateKeyPair()))"` in the proxy repository. The private key goes into the dev proxy's `LEDGER_SIGNING_KEY`; production gets its own pair for its ledger and the dev public key in `ROLLOUT_PUBLIC_KEY`.
- Run migration `0005_ledger_signatures.sql` on both databases before shipping this proxy; it is additive.
- A campaign is started detached on Windows (`Start-Process node tools/campaign.js go <spec>` with redirected output) because a proof runs for hours.
