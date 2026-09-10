# Learning loop — Phase 2: reflect and dream

Status: complete, awaiting review (2026-09-10). Follows phase 1 (`phase-1.md`).

## Goal

Turn what the loop now produces (replay artifacts, jury verdicts, spot-check marks) into
findings a person can read and lesson candidates a later phase can prove. Two scripts, no
model calls, everything local to the run directory.

## Reflect

`tools/reflect.js <run>` reads the run's artifacts, the reference manifest, and the
spot-check marks if any, and writes `reflect/findings.json` and `findings.md`:

- **Snapshot.** The code commit, the manifest's freeze time, the analyzer and jury models,
  site and sample counts, and cost, so a finding is always tied to the state that produced
  it.
- **Score** by split and type, and run-to-run variance per site.
- **Sections.** Error and incompleteness rates per section over applicable verdicts, broken
  down by document type, with the jury's notes on the inaccurate ones.
- **Fabricated specifics**, classified by pattern: email, URL, phone, wrong mechanism (a real
  tool named for the wrong purpose), generic advice, menu path, timeframe or amount, data
  category, recipient scope, invented right, jurisdiction. Counts, sites, examples.
- **Omissions by theme.** Thirty-odd keyword themes (dispute resolution, tracking signals,
  business transfer, AI training, retention, deletion limits, and so on), each mapped to the
  section that should have carried it, or to none, which is itself a finding about the
  summary's shape.
- **Evaluator against the jury**: mean jury score per label, Strong-but-low and
  Failed-but-high lists, the most frequent evaluator issues.
- **Critic against the jury**: agreement on acceptability, and the blind spots where the
  critic said grounded and the jury found a fabrication or major error.
- **Risk level**: agreement and the direction of disagreement.
- **Coverage**: sites analysed from under sixty percent of their frozen text; sites the
  jury could not grade because the source was not a document.
- **Spot-check** agreement when marks exist.

The classifiers are keyword rules, deliberately: cheap, explainable, testable, and
tunable against the jury's own wording. On the baseline they leave about a fifth of
omissions unthemed.

## Dream

`tools/dream.js <run>` reads the findings and writes `dream/lessons.json` and
`lessons.md`. Every candidate carries its kind, target, scope, section, the text that
would be recalled or the change that would be made, a one-sentence reason with the numbers,
evidence (counts, sites, up to three quoted examples), and a priority. Rules:

| rule | trigger | candidate |
|---|---|---|
| completeness | a section incomplete in sixty percent or more of ten or more verdicts | analyzer lesson for that section, naming the omission themes that map to it; a scoped copy for any document type at least ten points worse than overall |
| fabrication pattern | five or more fabrications of one pattern | an analyzer lesson and a matching critic lesson for that pattern |
| critic blind spots | three or more | a calibration seed listing them |
| evaluator | five or more Strong verdicts under sixty with the jury | a code candidate on the evaluator label |
| prompt fallback | three or more generic-advice fabrications | a code candidate replacing the analyzer prompt's own fallback phrase |
| index page | any site the jury found nothing to grade in | a site fact for that site and a code candidate on the legal-text check |
| coverage | three or more sites analysed from under sixty percent of their text | a code candidate on the analysis excerpt |
| schema gap | an omission theme with no section, fifteen or more times | a code candidate on the summary's shape |
| risk | seventy percent of risk disagreements in one direction | an analyzer lesson on the risk rule |
| variance | a fifth of sites moving twenty points or more between samples | a note for the proof design |

Priority is impact weight times normalized support. Nothing is promoted here: a candidate
stays `candidate` until phase 5 proves it on the reference set and the owner promotes it.

No model-assisted drafting was added. The jury's own notes turned out to be specific enough
that template text plus quoted evidence reads as a lesson; a drafting step can be added
behind a flag if a later phase wants smoother wording.

## What the baseline dreamed (2026-09-10)

34 candidates from `baseline-1`, in `reference/runs/baseline-1/dream/lessons.md` (local).
The top of the prompt-lesson list, in priority order:

1. Analyzer: give a settings location only in the document's words, never a menu path.
   35 fabricated menu paths on 14 sites.
2. Critic: treat a menu path absent from the source as unsupported.
3. Analyzer, DATA SELLING & SHARING: name every recipient category and any "we do not
   sell" statement. Partial in 95% of verdicts; omissions cluster in business transfers,
   no-sale statements, public visibility.
4. Analyzer, WHAT THEY COLLECT: cover every listed category and where data comes from.
   Partial in 90%; omissions cluster in AI training, tracking technology, biometrics.
5. Analyzer, DATA DELETION RIGHTS: state retention, what survives deletion, and residency
   limits. Partial in 85%.
6. Analyzer, OPT-OUT RIGHTS: list every right including regional ones and browser signals,
   and what cannot be limited. Partial in 85%.
7. Analyzer, AUTO-RENEWAL & BILLING: mention charges the document authorizes beyond a
   subscription. Partial in 81%.
8. Analyzer: never write a web address the document does not print. 16 on 9 sites.

Further down: a data-category lesson (14 fabrications), a generic-advice lesson (12),
scoped deletion lessons for technology, social, gaming, and education documents (100%
incomplete), the critic calibration seed (55 blind spots), the prompt's own fallback
phrase as a code change, the analysis excerpt for large documents (14 sites under 60% of
their text, six under 30%), the evaluator label as a code change (18 Strong verdicts under
60), reddit.com as a site fact plus a code change to the legal-text check, three schema
gaps (dispute resolution, 87 omissions on 29 sites; content license, 28 on 13; account
termination, 17 on 8), and the proof-design note on variance.

## Rules carried forward

- Zero user data: reflect and dream read model output about public documents; nothing
  about the owner or any user enters the findings.
- No model calls in this phase. The trainer key is untouched.
- Candidates are proposals. Promotion is the owner's, after proof.
