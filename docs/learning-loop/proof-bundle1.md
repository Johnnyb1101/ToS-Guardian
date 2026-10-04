# Proof — treat-bundle1 against baseline-1

Proven: jury score +5.2 on 30 work sites (95% 0.6 to 10.0), holdout +7.3 on 19.

Lesson set d93555f3f157 against control set(s) none recorded. Juror anthropic. 150 treatment verdicts, 150 control verdicts; treatment cost $38.65.
Rule: proven when the paired work-split jury gain is at least 3 points with a 95% bootstrap interval above zero, and the holdout interval does not fall below -5.

| metric | split | sites | control | treatment | delta | 95% interval | better / worse |
|---|---|---|---|---|---|---|---|
| score | work | 30 | 70.2 | 75.4 | +5.2 | 0.6 to 10.0 | 20 / 10 |
| score | holdout | 19 | 70.9 | 78.3 | +7.3 | 3.1 to 11.4 | 16 / 3 |
| score | all | 49 | 70.5 | 76.5 | +6.0 | 2.7 to 9.3 | 36 / 13 |
| fabricationRate | work | 30 | 0.80 | 0.34 | -0.46 | -0.86 to -0.09 | 16 / 7 |
| fabricationRate | holdout | 19 | 0.61 | 0.12 | -0.49 | -0.68 to -0.30 | 13 / 0 |
| fabricationRate | all | 49 | 0.73 | 0.26 | -0.47 | -0.72 to -0.23 | 29 / 7 |
| incompleteRate | work | 30 | 71% | 71% | +0 pts | -6 to 6 pts | 12 / 17 |
| incompleteRate | holdout | 19 | 64% | 73% | +9 pts | -0 to 21 pts | 5 / 9 |
| incompleteRate | all | 49 | 68% | 72% | +4 pts | -2 to 10 pts | 17 / 26 |
| critic | work | 26 | 91% | 90% | -1 pts | -4 to 3 pts | 7 / 9 |
| critic | holdout | 18 | 95% | 96% | +2 pts | -1 to 5 pts | 4 / 2 |
| critic | all | 44 | 93% | 93% | +0 pts | -2 to 3 pts | 11 / 11 |

## Sites (jury score)

| site | split | type | control | treatment | delta |
|---|---|---|---|---|---|
| steampowered.com | work | gaming | 85.3 | 62.3 | -23.0 |
| harvard.edu | work | education | 81.0 | 67.0 | -14.0 |
| airbnb.com | work | commerce | 80.7 | 68.0 | -12.7 |
| webmd.com | work | health | 74.7 | 62.7 | -12.0 |
| paypal.com | work | financial | 65.0 | 53.3 | -11.7 |
| americanexpress.com | holdout | financial | 78.7 | 68.7 | -10.0 |
| capitalone.com | holdout | financial | 86.7 | 76.7 | -10.0 |
| wellsfargo.com | work | financial | 89.3 | 80.3 | -9.0 |
| tumblr.com | work | social | 86.7 | 82.3 | -4.3 |
| uber.com | work | commerce | 67.3 | 64.0 | -3.3 |
| mozilla.org | holdout | technology | 84.3 | 81.3 | -3.0 |
| navyfederal.org | work | financial | 84.0 | 81.3 | -2.7 |
| coursera.org | work | education | 82.7 | 81.7 | -1.0 |
| epicgames.com | holdout | gaming | 81.3 | 83.0 | +1.7 |
| washingtonpost.com | holdout | media | 75.3 | 77.7 | +2.3 |
| pinterest.com | holdout | social | 72.7 | 75.3 | +2.7 |
| substack.com | work | media | 78.7 | 81.3 | +2.7 |
| duckduckgo.com | holdout | technology | 63.0 | 66.0 | +3.0 |
| tiktok.com | work | social | 63.0 | 66.0 | +3.0 |
| foxnews.com | work | media | 82.7 | 86.7 | +4.0 |
| sofi.com | work | financial | 84.0 | 88.0 | +4.0 |
| lendingclub.com | work | financial | 77.3 | 81.7 | +4.3 |
| x.com | holdout | social | 69.3 | 73.7 | +4.3 |
| chase.com | work | financial | 66.7 | 71.3 | +4.7 |
| robinhood.com | work | financial | 80.0 | 84.7 | +4.7 |
| ebay.com | work | commerce | 65.0 | 70.0 | +5.0 |
| ollama.com | holdout | technology | 77.7 | 83.0 | +5.3 |
| apus.edu | work | education | 62.7 | 68.0 | +5.3 |
| coinbase.com | holdout | financial | 77.3 | 85.3 | +8.0 |
| walmart.com | work | commerce | 58.3 | 66.7 | +8.3 |
| twitch.tv | holdout | gaming | 72.0 | 81.3 | +9.3 |
| slack.com | holdout | technology | 67.3 | 77.3 | +10.0 |
| amazon.com | holdout | commerce | 75.3 | 86.3 | +11.0 |
| zoom.us | holdout | technology | 69.7 | 81.3 | +11.7 |
| github.com | holdout | technology | 74.7 | 86.7 | +12.0 |
| notion.so | work | technology | 68.0 | 81.3 | +13.3 |
| netflix.com | holdout | media | 46.0 | 61.7 | +15.7 |
| lendingtree.com | work | financial | 66.7 | 83.3 | +16.7 |
| google.com | work | technology | 67.3 | 84.0 | +16.7 |
| dropbox.com | work | technology | 63.7 | 80.7 | +17.0 |
| discover.com | work | financial | 56.0 | 74.7 | +18.7 |
| nytimes.com | work | media | 54.7 | 74.0 | +19.3 |
| acorns.com | work | financial | 61.7 | 81.3 | +19.7 |
| cnn.com | holdout | media | 60.0 | 80.0 | +20.0 |
| linkedin.com | work | social | 58.0 | 78.7 | +20.7 |
| microsoft.com | holdout | technology | 55.3 | 77.3 | +22.0 |
| spotify.com | holdout | media | 61.0 | 84.3 | +23.3 |
| discord.com | work | social | 52.0 | 77.0 | +25.0 |
| snapchat.com | work | social | 44.0 | 80.0 | +36.0 |
