# Reference set

The frozen legal-document sources the learning loop is scored against, with a
stable work/holdout split and a document type per site. See
`docs/learning-loop/phase-1.md` for the design.

## What is here

- `sites.txt` — candidate sites, grouped by type only to keep the set stratified
  while it is curated. Committed.
- `manifest.json` — one entry per frozen site: domain, when it was frozen, split,
  document type (and any human override), text hash and size, the legal-document
  check, discovery path, document and opt-out URLs. No document text. Committed.
- `sources/<domain>.json` — the frozen source itself: the combined document text
  exactly as the pipeline hands it to the analyzer, before and after
  link-following, plus the facts a replay needs. Third-party legal text, so it is
  ignored by git and stays on this machine. Re-freezing on another machine
  reproduces it, and the manifest hash confirms it is the same text.
- `runs/` — replay and jury artifacts (model output beside document text). Local,
  ignored by git.

## Freeze

Freezing fetches documents only; it never spends a model call. A local proxy
started with placeholder database values and no provider key is enough, and
keeps the production fetch limiter out of the way:

```bash
node tools/reference.js freeze reference/sites.txt --proxy http://localhost:3000
```

A site already in the manifest is skipped unless `--force` is given, because
the point of freezing is that the text does not change under a running
experiment. `node tools/reference.js list` prints the manifest.

## Split

`work` sites may be learned from. `holdout` sites are only ever scored. The
assignment is a hash of the domain, so it never moves as sites are added, and
nobody can move a site by re-running. About thirty percent are held out.

## Document type

Assigned by `tools/doctype.js` from the text and the domain. To override one,
set `docTypeOverride` on the manifest entry; tools prefer the override.

## Skipped sites

A candidate whose documents the fetcher could not find is recorded under `skipped` in
the manifest with the date and reason, and cleared if a later freeze succeeds. These
are findings about discovery, not noise: a site that ships terms the extension cannot
locate is exactly the kind of case the fetcher loop should learn from.

## Curated type versus classifier

`sites.txt` carries `# type: <name>` headers, and the freezer records that curated type
on each entry beside the classifier's. Tools use the human override if one is set,
otherwise the curated type, otherwise the classifier. `node tools/reference.js list`
shows the classifier's answer where it disagrees, so the classifier can be tuned
against the curated list over time without the set changing underneath it.

## Replay

A replay runs frozen sources through the real analyzer, critic, and evaluator against
the dev proxy with no fetches: site lookup, fetcher, and link follower are answered from
the frozen record, so the only cost is model calls and the only variable is the model.

```bash
node tools/reference.js replay --proxy http://localhost:3000 --split work --limit 5
```

Each run writes `runs/<run id>/artifacts/<domain>.<sample>.json` (the text the analyzer
saw, its summary, the critic's verdict, the evaluator's result, usage and cost),
`episodes.ndjson` in the same schema as live episodes, and `run.json`. Legal-document
sources only unless `--include-shells`; `--samples n` repeats each site; `--budget`
stops before the next site once priced cost reaches the amount; rerunning the same
`--run` id skips finished artifacts. The production proxy is refused.

## Jury

The jury is a stronger model, chosen on the proxy, that reads the exact text the analyzer
saw and grades the summary section by section: accuracy (correct, minor, major,
fabricated) and completeness (complete, partial, missing), plus the bottom line, its own
risk level, quoted fabrications, and omissions. The score is computed here, not by the
model: each applicable section is 0.6 x accuracy + 0.4 x completeness, averaged to 100,
minus 10 per fabrication, floored at 0.

```bash
node tools/jury.js grade reference/runs/<run id> --proxy http://localhost:3000
node tools/jury.js report reference/runs/<run id>
```

`grade` stores the verdict on each artifact and writes `report.anthropic.md` and
`report.anthropic.json` in the run directory: scores by split, type, and evaluator label;
per-section error and incompleteness rates; how often the critic agreed with the jury on
whether a section was acceptable; risk-level agreement; fabrications; cost. Needs
`TRAINER_OPERATIONS=1` on the dev proxy. `--juror openai` asks the second model family.

## Spot-check

The spot-check is the human's read of a replay: a local page that shows the exact text
the analyzer saw beside its summary, one line at a time, with a mark for each line
(supported, not supported, unsure), a completeness call per section, the risk level, and
the bottom line. The jury's and critic's verdicts stay hidden until a section is fully
marked, so they cannot lead the reader. Marks save to `runs/<run id>/spotcheck/marks.json`
as they are made; the agreement report measures the jury and the critic against the human.

```bash
node tools/spotcheck.js serve reference/runs/<run id>
node tools/spotcheck.js agreement reference/runs/<run id>
```

The page is served on 127.0.0.1 only and nothing leaves the machine. Keyboard: 1, 2, 3
mark the focused line, arrows or j and k move, Alt with an arrow changes site.

## Reflect and dream

Reflect reads a graded run and writes the findings the loop learns from: score by split and
type, per-section error and incompleteness rates by document type, fabricated specifics
classified by pattern (menu path, URL, phone, invented right, and so on), omissions grouped
by theme and mapped to the section that should have carried them, evaluator and critic
disagreements with the jury, risk-level direction, run-to-run variance, sites analysed from
a fraction of their text, and the spot-check agreement when marks exist. Pure computation
over local files; no model calls.

Dream turns findings into lesson candidates: prompt lessons for the analyzer or critic
(tier 2), site facts (tier 1), code changes and critic calibration seeds (tier 3), and
notes for the proof design. Each carries the text that would be recalled, the evidence
count, examples, and a priority. Everything is a proposal until proven and promoted.

```bash
node tools/reflect.js reference/runs/<run id>
node tools/dream.js reference/runs/<run id>
```

Output lands in `runs/<run id>/reflect/findings.{json,md}` and `runs/<run id>/dream/lessons.{json,md}`.

## Site learning (tier 1)

The proxy owns learned site facts. A learned url set is a proposal until the proxy has
verified the documents itself and either the trainer proposed it or the same set was
proposed on three different days; promoted sets expire after thirty days unless
re-verified. `tools/sites.js` drives the loop from this machine:

```bash
node tools/sites.js propose --proxy http://localhost:3000 --sites acorns.com,chase.com
node tools/sites.js status --proxy http://localhost:3000
node tools/sites.js ledger --proxy http://localhost:3000
node tools/sites.js halt --proxy http://localhost:3000 --reason "owner review"
```

`propose` needs `TRAINER_OPERATIONS=1` on the proxy to count as the trainer; anywhere
else it is one more anonymous report. `ledger` verifies the hash chain locally and exits
non-zero if it is broken.

## Lessons and proofs (tier 2)

A dream candidate becomes a lesson on the dev proxy, is proven by replaying the frozen set
with it pinned, and is promoted only by the owner with the proof attached:

```bash
node tools/lessons.js create reference/runs/baseline-1 --proxy http://localhost:3000 --ids L013,L015
node tools/reference.js replay --proxy http://localhost:3000 --split all --samples 3 --run treat-1 --lessons lsn_...,lsn_... --budget 45
node tools/jury.js grade reference/runs/treat-1 --proxy http://localhost:3000 --budget 45
node tools/prove.js reference/runs/treat-1 --control reference/runs/baseline-1
node tools/lessons.js status lsn_... promoted --proxy http://localhost:3000 --proof reference/runs/treat-1
```

`prove` pairs the two runs per site and reports the bootstrapped mean jury-score delta on
the work split and the holdout. Proven means at least five paired work sites, a work gain
of three or more points with the interval above zero, no holdout fall below minus five,
and one lesson set across the whole treatment. `--lessons none` replays without any
lessons; `promoted` and `canary` replay the proxy's current sets.

Critic lessons change no analyzer text, so they are proven on the critic alone: re-run
only the critic over a graded run's analyses and compare its verdicts with the jury
verdicts that run already holds.

```bash
node tools/critic-replay.js reference/runs/baseline-1 --proxy http://localhost:3000 --run critic-1 --lessons lsn_...,lsn_... --budget 8
node tools/prove-critic.js reference/runs/critic-1 --control reference/runs/baseline-1
node tools/lessons.js revise reference/runs/baseline-1 L005 --proxy http://localhost:3000 --text "..." --id L005b --after proof-bundle2
```

`prove-critic` pairs the two runs per site on identical analyses and bootstraps the catch
rate (a concern raised where the jury found a fabrication), the false-alarm rate (a concern
raised where the jury found the summary clean), agreement, and parse failures. `revise`
registers a reworded candidate with its parent and the retiring proof in its provenance.

## Campaigns, roll-out, and the signed ledger (phase 6)

A campaign runs a whole bundle from a spec file (`campaigns/`) to a text-free report with
the proposed decision, and never promotes:

```bash
node tools/campaign.js go reference/campaigns/bundle-2b-billing-deletion.json
node tools/campaign.js status bundle-2b-billing-deletion
```

The spec names the proxy, the control run, the lessons to carry, create, revise or pin, an
optional screen (a few sensitive sites with a fabrication-rise limit), the proof (jury or
critic kind), and an optional notification url (`CAMPAIGN_NOTIFY_URL` also works). State
lives in `runs/<name>/campaign.json`; the same command resumes a stopped campaign. On
Windows start it detached, since a proof runs for hours.

Promoted lessons and live learned sites move from the dev proxy to production as one
signed bundle:

```bash
node tools/rollout.js export --proxy http://localhost:3000 --out rollout.json
node tools/rollout.js show rollout.json
node tools/rollout.js import rollout.json --production
```

Production accepts a bundle only when its `ROLLOUT_PUBLIC_KEY` is the dev proxy's ledger
key. `tools/sites.js ledger` verifies the chain and, when the proxy signs its ledger, every
row's signature against the published key or one saved with `--public-key`.
