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
