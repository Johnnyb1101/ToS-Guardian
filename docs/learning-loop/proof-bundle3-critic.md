# Critic proof — critic-b3-baseline against baseline-1

Not proven: work-split catch-rate gain is inside the noise (mean +13 pts, 95% interval -10 to 38 pts); false alarms may have risen by up to 24 pts (limit 10); critic failed to parse on 9% of treatment verdicts against 1% in control.

Critic lesson set 760551e67368 against control set(s) none recorded. Juror anthropic. 150 treatment verdicts, 150 control verdicts, 150 paired on identical analyses; treatment critic calls cost $6.79.
Catch rate counts a section labelled unsupported or vague on a verdict where the jury found a fabrication; notice rate also counts a flag with no section label changed, which the evaluator ignores.
Rule: proven when the paired work-split catch rate gains at least 10 points with a 95% bootstrap interval above zero, false alarms (a concern on a verdict the jury found clean) do not rise by more than 10 points, the critic's parse failures do not rise by more than 2 points, and the holdout catch rate does not fall by more than 10.
Parse failures: 1% control, 9% treatment.
Evaluator label changed on 62 of 150 verdicts (Adequate to Strong 12, Failed to Adequate 3, Failed to Strong 2, Strong to Adequate 38, Adequate to Failed 5, Strong to Failed 2).

| metric | split | sites | control | treatment | delta | 95% interval | better / worse |
|---|---|---|---|---|---|---|---|
| catchRate | work | 20 | 41% | 54% | +13 pts | -10 to 38 pts | 6 / 5 |
| catchRate | holdout | 13 | 23% | 45% | +22 pts | -8 to 50 pts | 5 / 1 |
| catchRate | all | 33 | 34% | 51% | +17 pts | -2 to 36 pts | 11 / 6 |
| noticeRate | work | 20 | 55% | 90% | +35 pts | 13 to 56 pts | 12 / 1 |
| noticeRate | holdout | 13 | 36% | 79% | +44 pts | 22 to 65 pts | 8 / 0 |
| noticeRate | all | 33 | 47% | 86% | +38 pts | 22 to 54 pts | 20 / 1 |
| falseAlarmRate | work | 23 | 28% | 36% | +8 pts | -2 to 20 pts | 2 / 4 |
| falseAlarmRate | holdout | 15 | 34% | 44% | +10 pts | -21 to 40 pts | 5 / 5 |
| falseAlarmRate | all | 38 | 31% | 39% | +9 pts | -5 to 24 pts | 7 / 9 |
| agreementRate | work | 31 | 92% | 91% | -1 pts | -4 to 2 pts | 10 / 9 |
| agreementRate | holdout | 19 | 95% | 92% | -3 pts | -7 to 1 pts | 5 / 7 |
| agreementRate | all | 50 | 93% | 92% | -2 pts | -4 to 1 pts | 15 / 16 |
| failedRate | work | 31 | 2% | 8% | +5 pts | 0 to 12 pts | 1 / 5 |
| failedRate | holdout | 19 | 0% | 12% | +12 pts | 4 to 25 pts | 0 / 4 |
| failedRate | all | 50 | 1% | 9% | +8 pts | 3 to 14 pts | 1 / 9 |
| concernRate | work | 31 | 0.46 | 0.51 | +0.05 | -0.12 to 0.23 | - / - |
| concernRate | holdout | 19 | 0.25 | 0.43 | +0.18 | -0.04 to 0.42 | - / - |
| concernRate | all | 50 | 0.38 | 0.48 | +0.10 | -0.04 to 0.25 | - / - |

## Sites (catch rate)

| site | split | type | control | treatment | delta |
|---|---|---|---|---|---|
| airbnb.com | work | commerce | 100% | 0% | -100 pts |
| duckduckgo.com | holdout | technology | 100% | 0% | -100 pts |
| discover.com | work | financial | 50% | 0% | -50 pts |
| linkedin.com | work | social | 50% | 0% | -50 pts |
| acorns.com | work | financial | 33% | 0% | -33 pts |
| tiktok.com | work | social | 67% | 50% | -17 pts |
| americanexpress.com | holdout | financial | 0% | 0% | +0 pts |
| apus.edu | work | education | 0% | 0% | +0 pts |
| chase.com | work | financial | 100% | 100% | +0 pts |
| cnn.com | holdout | media | 100% | 100% | +0 pts |
| ebay.com | work | commerce | 0% | 0% | +0 pts |
| github.com | holdout | technology | 100% | 100% | +0 pts |
| harvard.edu | work | education | 100% | 100% | +0 pts |
| lendingtree.com | work | financial | 33% | 33% | +0 pts |
| netflix.com | holdout | media | 0% | 0% | +0 pts |
| nytimes.com | work | media | 0% | 0% | +0 pts |
| slack.com | holdout | technology | 0% | 0% | +0 pts |
| spotify.com | holdout | media | 0% | 0% | +0 pts |
| substack.com | work | media | 0% | 0% | +0 pts |
| uber.com | work | commerce | 100% | 100% | +0 pts |
| walmart.com | work | commerce | 100% | 100% | +0 pts |
| zoom.us | holdout | technology | 0% | 0% | +0 pts |
| microsoft.com | holdout | technology | 0% | 33% | +33 pts |
| coinbase.com | holdout | financial | 0% | 50% | +50 pts |
| notion.so | work | technology | 50% | 100% | +50 pts |
| discord.com | work | social | 33% | 100% | +67 pts |
| amazon.com | holdout | commerce | 0% | 100% | +100 pts |
| dropbox.com | work | technology | 0% | 100% | +100 pts |
| google.com | work | technology | 0% | 100% | +100 pts |
| ollama.com | holdout | technology | 0% | 100% | +100 pts |
| paypal.com | work | financial | 0% | 100% | +100 pts |
| snapchat.com | work | social | 0% | 100% | +100 pts |
| x.com | holdout | social | 0% | 100% | +100 pts |

## Why not proven

- work-split catch-rate gain is inside the noise (mean +13 pts, 95% interval -10 to 38 pts)
- false alarms may have risen by up to 24 pts (limit 10)
- critic failed to parse on 9% of treatment verdicts against 1% in control
