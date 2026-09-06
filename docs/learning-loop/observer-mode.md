# Observer mode

A developer setting that makes the extension report, stage by stage, what it
did on each site you visit: which detection branch fired, what was fetched and
how, what the cache did, what the models said, how it was scored, and what the
overlay rendered. Off by default. Nothing leaves your machine.

It exists so a click-through produces records instead of notes. The same
record format (`episode.js`) is written by the headless batch runner, so live
and headless runs feed the same report.

## Use it

1. Start the collector in a terminal in the extension repo. It binds to
   127.0.0.1 only and appends one JSON line per event to `observer/events.ndjson`
   (ignored by git).

   ```bash
   node tools/observer.js
   ```

2. Open the extension's Options page, tick **Observer mode** under Developer,
   leave the port at 3123 unless you started the collector elsewhere, and save.
3. Reload any tab you want observed. The content script reads the flag once at
   load.
4. Click through sites as usual. The collector prints one line per event.
5. Render the report whenever you like, from the events file, from a batch
   runner episode file, or both together:

   ```bash
   node tools/report.js observer/events.ndjson
   ```

6. Turn Observer mode off in Options when you are done. With it off, no event
   is created anywhere, and the analysis request is sent exactly as before.

## What is recorded

`episode.js` is the single source of truth: every stage has an allowlist of
fields, and anything else is rejected before it is written. In short:

| Stage | Facts |
|---|---|
| trigger | source (click, submit, enter, re-show, popup, batch), detection branch, control tag, auth form and password field present, known domain, frame |
| relay | registrable domain, static or learned site hit, deduped |
| fetch | discovery path, terms and privacy found, supplemental count, text size and hash, legal-document check, unreadable PDFs, public document URLs, hidden-tab versus proxy hits |
| cache | hit, miss, stale schema, stale fingerprint, quality reject; similarity |
| scan | injection pattern stripped |
| links | opt-out link candidates, followed, displayed |
| analyze | provider, model, tokens, stop reason, status, receipt issued, summary hash |
| critic | ran, failed and why, per-section verdicts, flag count, model, tokens |
| evaluate | score, label, issue codes, contradictions, caps applied |
| escalate | attempted or blocked by the cap, result, accepted and why |
| verdict | trusted risk, label, score, retrieval failure, cached |
| write | cache write outcome and block category |
| render | overlay shown, sections, links, risk pill, confidence badge, error |
| end | duration, ok |

## The local layer

A few things are useful to you on your own machine but are user data, so they
live in a separate `local` layer on the event: the page URL, the button's text,
whether you accepted or went back, the critic's flag text, the bottom line.

`stripLocal()` in `episode.js` produces the uploadable form of an episode: no
local layer, no timestamps finer than a day, document URLs without query
strings, and a recursive check that refuses any forbidden key. Nothing in phase
0 uploads anything. When the community path is built, this transform is the
boundary, and its tests are the contract.

## Headless runs

The batch runner writes the same records without a collector:

```bash
node tools/batch-runner.js tools/sites-sample.txt --proxy http://localhost:3000 --episodes run.ndjson
node tools/report.js run.ndjson
```
