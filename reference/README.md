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
