# Step 1A: diagnostic evaluation integrity

Step 1A separates learning from evaluation and checks whether a comparison has complete, compatible evidence. It does not authorize promotion or rollout. Step 1B must bind a complete tested configuration to activation before any new evaluation can support production use.

## Learning inputs

`node tools/reflect.js <runDir>` reads only work artifacts. An artifact's split must agree with the current manifest and the original deterministic domain split. Work document hashes must match the manifest. If a replay declares an evaluation set, each artifact must agree with that declaration too. Unknown splits and conflicting metadata are rejected. The historical `holdout` split is validation: it is excluded from every learning aggregate, example, and candidate.

Reflection records the work artifact identities and hashes, manifest fingerprint, optional evaluation-set fingerprint, and excluded validation identities. `node tools/dream.js <runDir>` rejects legacy, stale, or wrong-juror findings caches and recomputes aggregates from the work artifacts before generating lessons. Candidate creation and revision also regenerate work-only dream output before registering candidates.

New outputs go under `<runDir>/step1a/reflect/` and `<runDir>/step1a/dream/`. Historical `reflect/` and `dream/` files are preserved. A previously learned lesson is not retroactively made independent of validation simply by regenerating its evidence. Fresh final evaluation and independent judging remain later work.

## Declared comparisons

New replay `run.json` files contain an `evaluationSet` array. Each entry pins `domain`, `split`, `docType`, `textHash`, and an explicit array of sample IDs. Historical `holdout` is written as `validation` in this declaration. Resume requires an identical declaration, proxy, and replay options. A historical run without a declaration must use a new run ID rather than receiving invented metadata.

The frozen loader checks the actual fetched text against the stored document hash. Each replay artifact records the Analyzer model, prompt hash and lesson hash, and the Critic model, prompt hash and lesson hash. The proxy fingerprints the base system prompt and the rendered user template with fixed placeholder content, excluding lesson appendices and actual source content; prompts remain on the server. Jury grading records its model, prompt hash, rubric hash, and hashes of the exact source and summary sent for grading. The entire Jury system prompt currently defines its rubric, so its separate rubric fingerprint hashes that system prompt alone.

Control and treatment must declare identical site/sample sets. Every declared record must exist exactly once and produce valid Analyzer, Critic and Jury results. Invalid, missing, duplicate, extra, and incompatible records fail the evaluation rather than disappearing from an average. Repaired or coerced Jury verdicts remain useful in historical reports but cannot satisfy the strict evaluation schema.

Analyzer and Jury models and prompts, Jury rubric, and the complete Critic identity must remain fixed across both arms. Analyzer lesson hashes may differ between arms, with exactly one lesson hash in each arm. Paired analyzed source hashes must match, and each Jury grade must match its artifact's source and summary. This is evidence compatibility checking; complete configuration fingerprints and identical tested/live lesson selection remain Step 1B.

## Gates and reports

Run locally without provider calls:

```powershell
node tools/prove.js <treatmentRunDir> --control <controlRunDir>
```

The default gates require:

- At least five paired work sites and three paired validation sites, with at least three paired samples at each site.
- Work mean score gain of at least three points and a 95% bootstrap interval above zero.
- Validation mean score change at least zero and a 95% bootstrap interval floor at least minus five points.
- No increase in fabrication counts at any individual site or in either split.

These site counts are coverage floors, not strong evidence of generalization. The bootstrap operates on paired per-site means with a deterministic seed. Arguments may tighten the score gates but cannot weaken the default floors. Missing metadata is a failure, never a reason to backfill historical evidence.

Outputs are `<treatmentRunDir>/step1a/evaluation/evaluation.json` and `evaluation.md`. Exit `0` means the diagnostic gates passed; exit `2` means they failed. Both outcomes have `proven: false`, `diagnosticOnly: true`, and `promotionEligible: false`. `evaluationPassed` carries the statistical result. Historical `proof.json` and `proof.md` remain untouched.

Campaign reports consume the separate diagnostic output and keep evaluated candidates pending instead of printing promotion commands. Legacy critic comparisons also write separate diagnostic reports under `step1a/critic-evaluation/`; their existing statistical method is not upgraded to the Step 1A evidence contract. They report `legacyCriteriaPassed` separately, keep `evaluationPassed: false`, and exit `2`. The lesson status CLI rejects explicitly diagnostic evidence and refuses to fall back to an old proof when the same run has a new diagnostic report. Existing activation and rollout implementations are unchanged and still require Step 1B review.

## Verification

`npm test` runs the standalone Node regression scripts in each repository. HTTP fixture tests require loopback connections, which may be restricted by the sandbox; report that failure separately from the result of a permitted local test run. Neither repository currently defines a lint script. Use `node --check` for changed JavaScript files and `git diff --check` / `git diff --cached --check` for whitespace validation. Tests and saved-artifact comparisons require no experimental provider spend.
