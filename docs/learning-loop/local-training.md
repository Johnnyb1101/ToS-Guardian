# Prepare trustworthy local training examples

This checkpoint prepares reviewed examples. It does **not** train a model, install Ollama, download a model, call a paid AI API, write to Supabase, promote a release, or deploy anything. The extension and proxy runtime are unchanged.

The specialist's job is to extract six popup fields: data collection, data selling, opt-out rights, how to opt out, automatic renewal, and data deletion. Risk ratings and the bottom line are outside this first training target.

## What keeps mistakes out

Historical AI answers start as **unverified drafts**, even when three runs agree. Three drafts for one policy become one review case, not three training examples. A reviewer edits the answers against the full saved policy capture.

For each field, choose:

- **Supported by source:** write a clear answer and paste exact supporting quotations. Keep regional restrictions, conditions, exceptions, and instructions.
- **Not found in captured document:** use the fixed answer `Not found in the captured document.` and explain what you checked. This does not mean the company offers no such right.
- **Uncertain:** save for correction; it cannot be approved for training.

Approval also requires confirming that the capture is complete enough, all six fields were reviewed, and conditions and exceptions were checked. Exclude incomplete or ambiguous captures. Exact quotation matching only proves that the words occur in the capture; a person must still judge whether they support the answer. The tool cannot establish truth automatically, prove that a capture contains every relevant policy, or verify a reviewer's identity.

Only the latest valid **Approved** revision can export. A later **Needs correction** or **Excluded** revision withdraws that approval. Reviews append to a local history instead of overwriting old decisions. File hashes detect stale or accidentally changed inputs; these are local integrity checks, not protection against an owner deliberately rewriting the entire workspace.

## Keep evaluation material separate

The scanner checks the manifest and frozen captures, every JSON file under the local runs folder, and known final-evaluation JSON files. It independently recomputes the work/holdout split. Holdout captures stay protected even if unreadable or unsuitable. Exact source hashes from older holdout analyzer inputs also block overlap. The inventory's `finalSourceHashes` is a combined deny list for final and historical holdout hashes.

Only eligible work captures supply cases. Final domains and known source hashes cannot train. Exact duplicate policy captures collapse. This does not detect every related-company alias, paraphrased duplicate, supplemental document shared between two different captures, or experiment stored outside the supplied reference folder. Review these overlaps before any future training or evaluation claim. Selecting work cases is not a fresh-site evaluation.

The saved enriched policy capture is the review authority. Historical analyzer inputs may have been normalized or shortened; their old answers therefore remain drafts rather than verified labels. Large captures will also need a separately approved chunking strategy before an actual model can consume them.

## Use from the VS Code terminal

These commands assume your terminal is already in `ToS-Guardian`. The prepared pilot is local and Git-ignored:

```powershell
node tools/training-preparation.js check reference/training/pilot-2
node tools/training-review.js serve reference/training/pilot-2 --port 3126
```

Open `http://127.0.0.1:3126/` in your browser. Read the source beside the six editable fields, save drafts as needed, then choose a decision and append a review revision. Stop the local server with Ctrl+C. Unsaved edits are not retained when changing cases. Use one reviewer server for a preparation at a time; conflicting saves are rejected, but this is not a multi-process database.

The six-case pilot begins with **zero approved examples**. Its inventory contains 56 saved domains: 36 work and 20 holdout. Of the work captures, 31 meet the existing basic suitability flag. These flags do not replace human completeness review. The pilot includes 18 old draft outputs across six policies, with variety by the existing document-type labels. This is a small calibration sample, not the full training dataset or a balanced industry sample.

To create another preparation without overwriting the first:

```powershell
node tools/training-preparation.js prepare reference/training/pilot-3 --limit 6
```

Optional `--reference <folder>` and `--run <folder>` select other existing local inputs. Paths and file hashes are pinned. Changing any inventoried source, run, final material, stored case, or rubric makes a preparation stale; create a new preparation and review it again. The tool does not silently carry old approvals onto changed documents.

After actual human approval, export to a new folder:

```powershell
node tools/training-preparation.js export reference/training/pilot-2 reference/training/export-1
node tools/training-preparation.js verify-export reference/training/pilot-2 reference/training/export-1
```

Export refuses zero approved examples. `examples.jsonl` contains the full source and exactly six reviewed answer strings. `review-evidence.json` retains review decisions and quotations; `manifest.json` binds the export to the inputs and review log. Export files are snapshots. A later correction does not delete a snapshot, but **verify-export rejects it as stale**. Any future trainer must run that verification immediately before use and enforce its failure. No trainer exists in this checkpoint.

All preparation, source, and review data stays local. Nothing is uploaded. Review captured documents for unexpected personal information before any future sharing or training. The proposed private Supabase archive, automatic candidate queue, replacement-policy retention, X: model storage, model fine-tuning, and quality gates for deploying a trained model remain separate future work requiring a plan.

## Verification

`npm test` includes contract, review-server, and filesystem integration tests. They use synthetic fixtures to exercise blocked drafts, unsupported evidence, incomplete capture, missing-information wording, protected material, approval withdrawal, changed source files, and stale exports. They do not certify the correctness of real policy answers or the quality of a future trained model.
