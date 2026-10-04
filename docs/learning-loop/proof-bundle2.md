# Proof — treat-bundle2 against treat-bundle1

Not proven: work-split gain is inside the noise (mean -4.1, 95% interval -7.8 to -0.4); work-split mean gain -4.1 is below the 3-point floor; holdout may have regressed (95% interval -10.1 to 0.6).

Lesson set 9a26894bb363 against control set(s) d93555f3f157. Juror anthropic. 150 treatment verdicts, 150 control verdicts; treatment cost $39.37.
Rule: proven when the paired work-split jury gain is at least 3 points with a 95% bootstrap interval above zero, and the holdout interval does not fall below -5.

| metric | split | sites | control | treatment | delta | 95% interval | better / worse |
|---|---|---|---|---|---|---|---|
| score | work | 30 | 75.4 | 71.3 | -4.1 | -7.8 to -0.4 | 12 / 17 |
| score | holdout | 19 | 78.3 | 73.7 | -4.6 | -10.1 to 0.6 | 8 / 11 |
| score | all | 49 | 76.5 | 72.3 | -4.3 | -7.5 to -1.2 | 20 / 28 |
| fabricationRate | work | 30 | 0.34 | 0.72 | +0.38 | 0.18 to 0.58 | 3 / 20 |
| fabricationRate | holdout | 19 | 0.12 | 0.63 | +0.51 | 0.25 to 0.81 | 1 / 11 |
| fabricationRate | all | 49 | 0.26 | 0.69 | +0.43 | 0.27 to 0.60 | 4 / 31 |
| incompleteRate | work | 30 | 71% | 59% | -13 pts | -19 to -6 pts | 26 / 4 |
| incompleteRate | holdout | 19 | 73% | 60% | -13 pts | -25 to -3 pts | 14 / 3 |
| incompleteRate | all | 49 | 72% | 59% | -13 pts | -19 to -7 pts | 40 / 7 |
| critic | work | 26 | 90% | 92% | +1 pts | -4 to 6 pts | 9 / 9 |
| critic | holdout | 18 | 96% | 96% | -1 pts | -4 to 2 pts | 4 / 7 |
| critic | all | 44 | 93% | 93% | +0 pts | -3 to 3 pts | 13 / 16 |

## Sites (jury score)

| site | split | type | control | treatment | delta |
|---|---|---|---|---|---|
| github.com | holdout | technology | 86.7 | 54.0 | -32.7 |
| discover.com | work | financial | 74.7 | 46.7 | -28.0 |
| zoom.us | holdout | technology | 81.3 | 53.7 | -27.7 |
| foxnews.com | work | media | 86.7 | 61.0 | -25.7 |
| coursera.org | work | education | 81.7 | 62.3 | -19.3 |
| spotify.com | holdout | media | 84.3 | 66.0 | -18.3 |
| ebay.com | work | commerce | 70.0 | 55.0 | -15.0 |
| substack.com | work | media | 81.3 | 66.7 | -14.7 |
| nytimes.com | work | media | 74.0 | 60.3 | -13.7 |
| netflix.com | holdout | media | 61.7 | 49.3 | -12.3 |
| google.com | work | technology | 84.0 | 72.0 | -12.0 |
| discord.com | work | social | 77.0 | 66.3 | -10.7 |
| coinbase.com | holdout | financial | 85.3 | 75.3 | -10.0 |
| linkedin.com | work | social | 78.7 | 68.7 | -10.0 |
| microsoft.com | holdout | technology | 77.3 | 67.3 | -10.0 |
| sofi.com | work | financial | 88.0 | 78.0 | -10.0 |
| harvard.edu | work | education | 67.0 | 57.3 | -9.7 |
| pinterest.com | holdout | social | 75.3 | 66.0 | -9.3 |
| notion.so | work | technology | 81.3 | 72.7 | -8.7 |
| walmart.com | work | commerce | 66.7 | 60.0 | -6.7 |
| amazon.com | holdout | commerce | 86.3 | 80.0 | -6.3 |
| epicgames.com | holdout | gaming | 83.0 | 80.0 | -3.0 |
| lendingtree.com | work | financial | 83.3 | 80.7 | -2.7 |
| wellsfargo.com | work | financial | 80.3 | 77.7 | -2.7 |
| capitalone.com | holdout | financial | 76.7 | 74.7 | -2.0 |
| dropbox.com | work | technology | 80.7 | 80.0 | -0.7 |
| uber.com | work | commerce | 64.0 | 63.3 | -0.7 |
| washingtonpost.com | holdout | media | 77.7 | 77.3 | -0.3 |
| robinhood.com | work | financial | 84.7 | 84.7 | +0.0 |
| tiktok.com | work | social | 66.0 | 66.3 | +0.3 |
| twitch.tv | holdout | gaming | 81.3 | 82.0 | +0.7 |
| webmd.com | work | health | 62.7 | 63.3 | +0.7 |
| navyfederal.org | work | financial | 81.3 | 82.3 | +1.0 |
| tumblr.com | work | social | 82.3 | 83.3 | +1.0 |
| apus.edu | work | education | 68.0 | 69.3 | +1.3 |
| duckduckgo.com | holdout | technology | 66.0 | 67.3 | +1.3 |
| lendingclub.com | work | financial | 81.7 | 83.0 | +1.3 |
| x.com | holdout | social | 73.7 | 76.3 | +2.7 |
| acorns.com | work | financial | 81.3 | 85.0 | +3.7 |
| americanexpress.com | holdout | financial | 68.7 | 72.7 | +4.0 |
| ollama.com | holdout | technology | 83.0 | 87.7 | +4.7 |
| mozilla.org | holdout | technology | 81.3 | 86.7 | +5.3 |
| slack.com | holdout | technology | 77.3 | 84.0 | +6.7 |
| snapchat.com | work | social | 80.0 | 88.0 | +8.0 |
| chase.com | work | financial | 71.3 | 82.3 | +11.0 |
| paypal.com | work | financial | 53.3 | 66.3 | +13.0 |
| steampowered.com | work | gaming | 62.3 | 75.3 | +13.0 |
| airbnb.com | work | commerce | 68.0 | 82.3 | +14.3 |
| cnn.com | holdout | media | 80.0 | 100.0 | +20.0 |

## Why not proven

- work-split gain is inside the noise (mean -4.1, 95% interval -7.8 to -0.4)
- work-split mean gain -4.1 is below the 3-point floor
- holdout may have regressed (95% interval -10.1 to 0.6)
