# Proof — bundle-2b-billing-deletion-proof against treat-bundle1

Not proven: work-split gain is inside the noise (mean 0.9, 95% interval -1.8 to 3.7); work-split mean gain 0.9 is below the 3-point floor; holdout may have regressed (95% interval -7.7 to 2.9).

Lesson set 6c75b12af2b6 against control set(s) d93555f3f157. Juror anthropic. 128 treatment verdicts, 150 control verdicts; treatment cost $34.76.
Rule: proven when the paired work-split jury gain is at least 3 points with a 95% bootstrap interval above zero, and the holdout interval does not fall below -5.

| metric | split | sites | control | treatment | delta | 95% interval | better / worse |
|---|---|---|---|---|---|---|---|
| score | work | 26 | 76.5 | 77.4 | +0.9 | -1.8 to 3.7 | 15 / 11 |
| score | holdout | 16 | 78.4 | 76.1 | -2.2 | -7.7 to 2.9 | 7 / 8 |
| score | all | 42 | 77.2 | 76.9 | -0.3 | -3.2 to 2.3 | 22 / 19 |
| fabricationRate | work | 26 | 0.29 | 0.23 | -0.06 | -0.22 to 0.08 | 7 / 6 |
| fabricationRate | holdout | 16 | 0.10 | 0.38 | +0.27 | 0.06 to 0.52 | 1 / 7 |
| fabricationRate | all | 42 | 0.22 | 0.29 | +0.06 | -0.06 to 0.21 | 8 / 13 |
| incompleteRate | work | 26 | 74% | 69% | -5 pts | -9 to 0 pts | 15 / 6 |
| incompleteRate | holdout | 16 | 73% | 59% | -14 pts | -28 to -3 pts | 10 / 3 |
| incompleteRate | all | 42 | 73% | 65% | -8 pts | -14 to -3 pts | 25 / 9 |
| critic | work | 22 | 91% | 92% | +1 pts | -4 to 5 pts | 8 / 6 |
| critic | holdout | 15 | 96% | 96% | +1 pts | -2 to 4 pts | 3 / 4 |
| critic | all | 37 | 93% | 94% | +1 pts | -2 to 3 pts | 11 / 10 |

## Sites (jury score)

| site | split | type | control | treatment | delta |
|---|---|---|---|---|---|
| coinbase.com | holdout | financial | 85.3 | 57.3 | -28.0 |
| github.com | holdout | technology | 86.7 | 65.7 | -21.0 |
| notion.so | work | technology | 81.3 | 68.7 | -12.7 |
| slack.com | holdout | technology | 77.3 | 64.7 | -12.7 |
| foxnews.com | work | media | 86.7 | 75.0 | -11.7 |
| linkedin.com | work | social | 78.7 | 68.7 | -10.0 |
| lendingtree.com | work | financial | 83.3 | 75.3 | -8.0 |
| nytimes.com | work | media | 74.0 | 66.7 | -7.3 |
| acorns.com | work | financial | 81.3 | 75.3 | -6.0 |
| amazon.com | holdout | commerce | 86.3 | 80.3 | -6.0 |
| epicgames.com | holdout | gaming | 83.0 | 78.0 | -5.0 |
| apus.edu | work | education | 68.0 | 64.7 | -3.3 |
| microsoft.com | holdout | technology | 77.3 | 74.0 | -3.3 |
| navyfederal.org | work | financial | 81.3 | 78.0 | -3.3 |
| sofi.com | work | financial | 88.0 | 84.7 | -3.3 |
| coursera.org | work | education | 81.7 | 78.7 | -3.0 |
| duckduckgo.com | holdout | technology | 66.0 | 64.0 | -2.0 |
| discover.com | work | financial | 74.7 | 73.3 | -1.3 |
| spotify.com | holdout | media | 84.3 | 84.0 | -0.3 |
| capitalone.com | holdout | financial | 76.7 | 76.7 | +0.0 |
| discord.com | work | social | 77.0 | 77.3 | +0.3 |
| pinterest.com | holdout | social | 75.3 | 76.0 | +0.7 |
| netflix.com | holdout | media | 61.7 | 63.7 | +2.0 |
| dropbox.com | work | technology | 80.7 | 83.3 | +2.7 |
| google.com | work | technology | 84.0 | 86.7 | +2.7 |
| chase.com | work | financial | 71.3 | 74.3 | +3.0 |
| robinhood.com | work | financial | 84.7 | 88.0 | +3.3 |
| mozilla.org | holdout | technology | 81.3 | 84.7 | +3.3 |
| americanexpress.com | holdout | financial | 68.7 | 72.7 | +4.0 |
| harvard.edu | work | education | 67.0 | 71.0 | +4.0 |
| substack.com | work | media | 81.3 | 85.3 | +4.0 |
| lendingclub.com | work | financial | 81.7 | 86.0 | +4.3 |
| ollama.com | holdout | technology | 83.0 | 87.7 | +4.7 |
| tumblr.com | work | social | 82.3 | 87.3 | +5.0 |
| paypal.com | work | financial | 53.3 | 61.0 | +7.7 |
| twitch.tv | holdout | gaming | 81.3 | 89.0 | +7.7 |
| snapchat.com | work | social | 80.0 | 88.0 | +8.0 |
| ebay.com | work | commerce | 70.0 | 81.0 | +11.0 |
| airbnb.com | work | commerce | 68.0 | 79.7 | +11.7 |
| steampowered.com | work | gaming | 62.3 | 75.3 | +13.0 |
| tiktok.com | work | social | 66.0 | 79.7 | +13.7 |
| cnn.com | holdout | media | 80.0 | 100.0 | +20.0 |

## Why not proven

- work-split gain is inside the noise (mean 0.9, 95% interval -1.8 to 3.7)
- work-split mean gain 0.9 is below the 3-point floor
- holdout may have regressed (95% interval -7.7 to 2.9)
