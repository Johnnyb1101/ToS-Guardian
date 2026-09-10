# Jury baseline — baseline-1

Juror: anthropic (claude-opus-5). Analyzer: claude-sonnet-4-6.
Proxy: http://127.0.0.1:3001. Replayed: 2026-09-10T00:12:49.761Z.
Graded 150 of 150 replay artifact(s); 0 not graded.
Cost: replay $13.7999, jury $24.2945, total $38.0945.

## Scores

Overall: n 147, mean 70.5, median 74.0, min 22, max 100.

| split | sites | mean | median | min | max |
|---|---|---|---|---|---|
| holdout | 57 | 70.9 | 72.0 | 35 | 100 |
| work | 90 | 70.2 | 74.0 | 22 | 95 |

| type | sites | mean | median | min | max |
|---|---|---|---|---|---|
| financial | 39 | 74.9 | 80.0 | 22 | 95 |
| technology | 30 | 69.1 | 70.0 | 38 | 93 |
| media | 21 | 65.5 | 68.0 | 35 | 100 |
| social | 21 | 63.7 | 65.0 | 38 | 90 |
| commerce | 15 | 69.3 | 74.0 | 46 | 82 |
| education | 9 | 75.4 | 83.0 | 42 | 90 |
| gaming | 9 | 79.6 | 83.0 | 64 | 87 |
| health | 3 | 74.7 | 74.0 | 72 | 78 |

| evaluator label | sites | jury mean |
|---|---|---|
| Strong | 96 | 71.0 |
| Adequate | 36 | 68.9 |
| Failed | 15 | 71.1 |

Samples per site: 3.0; score spread across samples of the same site: mean 16.5, max 66.

## Sections

Error rate counts major and fabricated accuracy verdicts; incomplete counts partial and missing completeness verdicts. Both are over applicable sections.

| section | applicable | error rate | incomplete | correct | minor | major | fabricated | complete | partial | missing |
|---|---|---|---|---|---|---|---|---|---|---|
| dataCollection | 143 | 0% | 90% | 131 | 12 | 0 | 0 | 15 | 129 | 0 |
| dataSelling | 140 | 0% | 95% | 120 | 20 | 0 | 0 | 7 | 129 | 5 |
| optOutRights | 142 | 0% | 85% | 128 | 14 | 0 | 0 | 21 | 122 | 0 |
| howToOptOut | 147 | 0% | 41% | 81 | 66 | 0 | 0 | 86 | 61 | 0 |
| autoRenewal | 62 | 0% | 81% | 55 | 7 | 0 | 0 | 13 | 51 | 0 |
| dataDeletion | 130 | 3% | 85% | 97 | 29 | 4 | 0 | 19 | 111 | 1 |

## Critic against the jury

Agreement on whether a section is acceptable: 93% of 888 section verdicts. Critic failed or absent on 2 site(s).

| section | compared | agreement |
|---|---|---|
| dataCollection | 148 | 92% |
| dataSelling | 148 | 89% |
| optOutRights | 148 | 99% |
| howToOptOut | 148 | 90% |
| autoRenewal | 148 | 93% |
| dataDeletion | 148 | 96% |

## Risk and bottom line

Displayed risk against the jury's: exact 92, one step off 35, two steps off 0, not comparable 23. The summary's own stated risk matched the jury on 101 of 142.
Bottom line judged fair on 134 of 150.
Fabrications: 107 across 71 site(s); most: discover.com (4), linkedin.com (4), snapchat.com (4), discord.com (3), discord.com (3). Omissions: 729 across 148 site(s).

## Sites

| domain | sample | split | type | evaluator | jury | fabrications | omissions | risk shown/jury | critic agreement |
|---|---|---|---|---|---|---|---|---|---|
| reddit.com | 1 | work | social | Failed 0 | n/a | 0 | 1 | Unknown/Low | 100% |
| reddit.com | 2 | work | social | Failed 10 | n/a | 0 | 0 | Unknown/Moderate | 100% |
| reddit.com | 3 | work | social | Failed 0 | n/a | 0 | 0 | Unknown/Moderate | 100% |
| discover.com | 3 | work | financial | Adequate 80 | 22 | 4 | 5 | High/High | 83% |
| netflix.com | 3 | holdout | media | Strong 100 | 35 | 3 | 5 | High/High | 100% |
| linkedin.com | 3 | work | social | Adequate 80 | 38 | 4 | 5 | Moderate/Moderate | 83% |
| microsoft.com | 2 | holdout | technology | Strong 100 | 38 | 3 | 5 | High/High | 100% |
| snapchat.com | 2 | work | social | Strong 100 | 38 | 3 | 5 | High/High | 100% |
| cnn.com | 1 | holdout | media | Failed 0 | 40 | 1 | 3 | Unknown/Moderate | 83% |
| cnn.com | 2 | holdout | media | Failed 0 | 40 | 1 | 4 | Unknown/Moderate | 83% |
| apus.edu | 3 | work | education | Strong 100 | 42 | 2 | 5 | High/Moderate | 83% |
| nytimes.com | 3 | work | media | Strong 100 | 42 | 2 | 5 | High/Moderate | 100% |
| snapchat.com | 3 | work | social | Adequate 90 | 42 | 4 | 5 | High/High | critic failed |
| uber.com | 3 | work | commerce | Adequate 80 | 46 | 2 | 5 | High/High | 83% |
| lendingtree.com | 1 | work | financial | Failed 60 | 48 | 2 | 5 | Unknown/High | 67% |
| netflix.com | 2 | holdout | media | Strong 100 | 48 | 2 | 5 | High/High | 100% |
| nytimes.com | 2 | work | media | Strong 100 | 48 | 2 | 5 | High/Moderate | 100% |
| walmart.com | 1 | work | commerce | Failed 60 | 50 | 2 | 5 | Unknown/High | 67% |
| discord.com | 1 | work | social | Strong 100 | 52 | 3 | 5 | Moderate/High | 100% |
| discord.com | 2 | work | social | Adequate 90 | 52 | 3 | 5 | Moderate/High | 83% |
| discord.com | 3 | work | social | Strong 100 | 52 | 3 | 5 | Moderate/High | 100% |
| duckduckgo.com | 2 | holdout | technology | Adequate 90 | 52 | 1 | 5 | Low/Low | 83% |
| snapchat.com | 1 | work | social | Strong 100 | 52 | 3 | 5 | High/High | 100% |
| dropbox.com | 2 | work | technology | Strong 100 | 53 | 2 | 5 | Moderate/High | 100% |
| netflix.com | 1 | holdout | media | Strong 100 | 55 | 1 | 5 | High/High | 100% |
| walmart.com | 2 | work | commerce | Adequate 80 | 55 | 1 | 5 | High/High | 83% |
| chase.com | 1 | work | financial | Failed 70 | 57 | 1 | 5 | Unknown/High | 67% |
| acorns.com | 1 | work | financial | Strong 100 | 58 | 2 | 5 | High/High | 100% |
| apus.edu | 1 | work | education | Strong 100 | 58 | 1 | 5 | High/High | 100% |
| discover.com | 1 | work | financial | Strong 100 | 58 | 1 | 5 | High/High | 100% |
| linkedin.com | 1 | work | social | Strong 100 | 58 | 2 | 5 | Moderate/Moderate | 100% |
| spotify.com | 3 | holdout | media | Strong 100 | 58 | 1 | 5 | High/High | 83% |
| zoom.us | 2 | holdout | technology | Strong 100 | 58 | 2 | 5 | Moderate/High | 100% |
| chase.com | 2 | work | financial | Failed 40 | 60 | 1 | 5 | Unknown/Moderate | 67% |
| ebay.com | 1 | work | commerce | Strong 100 | 60 | 1 | 5 | Unknown/High | 100% |
| ebay.com | 2 | work | commerce | Strong 100 | 60 | 1 | 5 | High/High | 100% |
| paypal.com | 1 | work | financial | Strong 100 | 60 | 1 | 5 | High/High | 100% |
| paypal.com | 3 | work | financial | Adequate 80 | 60 | 0 | 5 | High/High | 83% |
| tiktok.com | 2 | work | social | Adequate 80 | 60 | 1 | 5 | High/Moderate | 83% |
| duckduckgo.com | 1 | holdout | technology | Adequate 90 | 62 | 0 | 5 | Low/Low | 83% |
| github.com | 3 | holdout | technology | Adequate 80 | 62 | 2 | 5 | Moderate/Moderate | 83% |
| google.com | 3 | work | technology | Strong 100 | 62 | 2 | 5 | Moderate/Moderate | 100% |
| notion.so | 1 | work | technology | Adequate 80 | 62 | 1 | 5 | Moderate/Moderate | 83% |
| notion.so | 3 | work | technology | Strong 100 | 62 | 1 | 5 | Moderate/Moderate | 100% |
| spotify.com | 1 | holdout | media | Strong 100 | 62 | 1 | 5 | High/High | 83% |
| acorns.com | 2 | work | financial | Strong 100 | 63 | 1 | 5 | High/High | 100% |
| spotify.com | 2 | holdout | media | Strong 100 | 63 | 1 | 5 | Moderate/High | 83% |
| acorns.com | 3 | work | financial | Adequate 80 | 64 | 1 | 5 | High/High | 83% |
| microsoft.com | 1 | holdout | technology | Strong 100 | 64 | 1 | 5 | High/High | 100% |
| microsoft.com | 3 | holdout | technology | Strong 100 | 64 | 1 | 5 | High/High | 100% |
| slack.com | 2 | holdout | technology | Strong 100 | 64 | 1 | 5 | Moderate/Moderate | 100% |
| slack.com | 3 | holdout | technology | Strong 100 | 64 | 1 | 5 | Moderate/Moderate | 100% |
| tiktok.com | 3 | work | social | Strong 100 | 64 | 1 | 5 | High/Moderate | 100% |
| twitch.tv | 3 | holdout | gaming | Strong 100 | 64 | 1 | 5 | High/Moderate | 100% |
| tiktok.com | 1 | work | social | Adequate 80 | 65 | 1 | 5 | High/Moderate | 83% |
| dropbox.com | 3 | work | technology | Adequate 75 | 66 | 1 | 5 | Moderate/Moderate | 100% |
| google.com | 1 | work | technology | Strong 100 | 68 | 1 | 5 | Moderate/Moderate | 100% |
| harvard.edu | 2 | work | education | Adequate 80 | 68 | 1 | 5 | Moderate/Low | 83% |
| pinterest.com | 2 | holdout | social | Strong 100 | 68 | 0 | 5 | High/High | 100% |
| substack.com | 3 | work | media | Strong 100 | 68 | 1 | 5 | Moderate/Moderate | 100% |
| twitch.tv | 1 | holdout | gaming | Strong 100 | 68 | 1 | 5 | High/Moderate | 100% |
| x.com | 2 | holdout | social | Strong 100 | 68 | 1 | 5 | High/Moderate | 100% |
| x.com | 3 | holdout | social | Strong 100 | 68 | 1 | 5 | High/Moderate | 100% |
| walmart.com | 3 | work | commerce | Failed 60 | 70 | 0 | 5 | Unknown/High | 67% |
| washingtonpost.com | 3 | holdout | media | Adequate 75 | 70 | 0 | 5 | Moderate/Moderate | 100% |
| americanexpress.com | 2 | holdout | financial | Strong 100 | 72 | 0 | 5 | Moderate/Moderate | 100% |
| coinbase.com | 2 | holdout | financial | Strong 100 | 72 | 1 | 5 | High/High | 100% |
| coinbase.com | 3 | holdout | financial | Strong 100 | 72 | 1 | 5 | High/High | 100% |
| dropbox.com | 1 | work | technology | Adequate 75 | 72 | 1 | 5 | Moderate/Moderate | 100% |
| google.com | 2 | work | technology | Strong 100 | 72 | 1 | 5 | High/Moderate | 100% |
| ollama.com | 3 | holdout | technology | Strong 100 | 72 | 1 | 5 | Moderate/High | 100% |
| pinterest.com | 3 | holdout | social | Strong 100 | 72 | 0 | 5 | Unknown/High | 100% |
| webmd.com | 3 | work | health | Strong 100 | 72 | 1 | 5 | High/High | 100% |
| x.com | 1 | holdout | social | Strong 100 | 72 | 1 | 5 | High/High | 100% |
| amazon.com | 2 | holdout | commerce | Strong 100 | 73 | 0 | 5 | High/High | 100% |
| zoom.us | 1 | holdout | technology | Strong 100 | 73 | 1 | 5 | Moderate/High | 100% |
| lendingclub.com | 3 | work | financial | Strong 100 | 74 | 0 | 5 | High/High | 100% |
| nytimes.com | 1 | work | media | Strong 100 | 74 | 0 | 5 | High/Moderate | 100% |
| slack.com | 1 | holdout | technology | Strong 100 | 74 | 0 | 5 | Moderate/Moderate | 100% |
| uber.com | 1 | work | commerce | Adequate 80 | 74 | 0 | 5 | High/High | 83% |
| webmd.com | 1 | work | health | Strong 100 | 74 | 0 | 5 | High/High | 100% |
| amazon.com | 3 | holdout | commerce | Strong 100 | 75 | 1 | 5 | High/High | 100% |
| coursera.org | 2 | work | education | Adequate 80 | 75 | 0 | 5 | High/High | 83% |
| duckduckgo.com | 3 | holdout | technology | Adequate 90 | 75 | 0 | 5 | Low/Low | 83% |
| ebay.com | 3 | work | commerce | Strong 100 | 75 | 0 | 5 | Unknown/High | 100% |
| github.com | 2 | holdout | technology | Adequate 90 | 75 | 0 | 5 | Moderate/Moderate | 83% |
| paypal.com | 2 | work | financial | Strong 100 | 75 | 0 | 5 | High/High | 100% |
| americanexpress.com | 1 | holdout | financial | Strong 100 | 76 | 1 | 5 | High/Moderate | 100% |
| lendingtree.com | 2 | work | financial | Strong 100 | 76 | 1 | 5 | High/High | 100% |
| lendingtree.com | 3 | work | financial | Strong 100 | 76 | 1 | 5 | High/High | 100% |
| airbnb.com | 2 | work | commerce | Failed 50 | 78 | 1 | 5 | Unknown/High | 50% |
| amazon.com | 1 | holdout | commerce | Strong 100 | 78 | 1 | 5 | High/High | 100% |
| epicgames.com | 3 | holdout | gaming | Strong 100 | 78 | 0 | 5 | Moderate/High | 100% |
| foxnews.com | 1 | work | media | Strong 100 | 78 | 0 | 5 | High/High | 100% |
| lendingclub.com | 2 | work | financial | Strong 100 | 78 | 0 | 5 | High/High | 100% |
| linkedin.com | 2 | work | social | Strong 100 | 78 | 0 | 5 | Moderate/Moderate | 100% |
| ollama.com | 1 | holdout | technology | Strong 100 | 78 | 0 | 5 | Moderate/High | 100% |
| pinterest.com | 1 | holdout | social | Strong 100 | 78 | 0 | 5 | High/High | 100% |
| washingtonpost.com | 1 | holdout | media | Adequate 75 | 78 | 0 | 5 | Moderate/Moderate | 100% |
| washingtonpost.com | 2 | holdout | media | Adequate 80 | 78 | 0 | 5 | Moderate/Moderate | 83% |
| webmd.com | 2 | work | health | Strong 100 | 78 | 0 | 5 | High/Moderate | 100% |
| zoom.us | 3 | holdout | technology | Adequate 80 | 78 | 0 | 5 | Moderate/High | 83% |
| lendingclub.com | 1 | work | financial | Strong 100 | 80 | 0 | 5 | High/High | 100% |
| mozilla.org | 1 | holdout | technology | Strong 100 | 80 | 0 | 5 | Low/Low | 100% |
| mozilla.org | 2 | holdout | technology | Adequate 75 | 80 | 0 | 5 | Low/Low | 100% |
| notion.so | 2 | work | technology | Adequate 90 | 80 | 0 | 5 | Moderate/Moderate | critic failed |
| robinhood.com | 1 | work | financial | Strong 100 | 80 | 0 | 5 | Moderate/Moderate | 100% |
| robinhood.com | 2 | work | financial | Strong 100 | 80 | 0 | 5 | Moderate/Moderate | 100% |
| robinhood.com | 3 | work | financial | Strong 100 | 80 | 0 | 5 | Moderate/Moderate | 100% |
| sofi.com | 1 | work | financial | Adequate 80 | 80 | 0 | 5 | Moderate/High | 83% |
| airbnb.com | 1 | work | commerce | Failed 70 | 82 | 0 | 5 | Unknown/High | 67% |
| airbnb.com | 3 | work | commerce | Adequate 90 | 82 | 0 | 5 | Moderate/High | 83% |
| steampowered.com | 2 | work | gaming | Strong 100 | 82 | 0 | 5 | Low/Low | 100% |
| uber.com | 2 | work | commerce | Strong 100 | 82 | 0 | 5 | High/High | 100% |
| chase.com | 3 | work | financial | Strong 100 | 83 | 0 | 5 | Moderate/High | 100% |
| coursera.org | 1 | work | education | Failed 60 | 83 | 0 | 5 | Unknown/High | 67% |
| epicgames.com | 1 | holdout | gaming | Strong 100 | 83 | 0 | 5 | Moderate/High | 100% |
| epicgames.com | 2 | holdout | gaming | Strong 100 | 83 | 0 | 5 | Moderate/High | 100% |
| foxnews.com | 2 | work | media | Strong 100 | 83 | 0 | 5 | High/High | 100% |
| ollama.com | 2 | holdout | technology | Strong 100 | 83 | 0 | 5 | Moderate/High | 100% |
| tumblr.com | 2 | work | social | Failed 15 | 83 | 0 | 5 | Unknown/Moderate | 50% |
| wellsfargo.com | 1 | work | financial | Adequate 80 | 83 | 0 | 5 | High/Moderate | 83% |
| capitalone.com | 2 | holdout | financial | Adequate 80 | 84 | 0 | 5 | Moderate/Moderate | 83% |
| navyfederal.org | 1 | work | financial | Strong 100 | 84 | 0 | 5 | Moderate/Moderate | 100% |
| navyfederal.org | 2 | work | financial | Strong 100 | 84 | 0 | 5 | Moderate/Moderate | 100% |
| navyfederal.org | 3 | work | financial | Strong 100 | 84 | 0 | 5 | Moderate/Moderate | 100% |
| sofi.com | 3 | work | financial | Strong 100 | 84 | 0 | 5 | Moderate/Moderate | 100% |
| substack.com | 1 | work | media | Strong 100 | 84 | 0 | 5 | Moderate/Moderate | 100% |
| substack.com | 2 | work | media | Strong 100 | 84 | 0 | 5 | Moderate/Moderate | 100% |
| twitch.tv | 2 | holdout | gaming | Strong 100 | 84 | 0 | 5 | Unknown/Moderate | 100% |
| harvard.edu | 3 | work | education | Adequate 80 | 85 | 0 | 5 | Low/Low | 83% |
| foxnews.com | 3 | work | media | Strong 100 | 87 | 0 | 5 | High/High | 100% |
| github.com | 1 | holdout | technology | Strong 100 | 87 | 0 | 5 | Moderate/Moderate | 100% |
| steampowered.com | 1 | work | gaming | Strong 100 | 87 | 0 | 5 | Low/Low | 100% |
| steampowered.com | 3 | work | gaming | Strong 100 | 87 | 0 | 5 | Low/Low | 100% |
| tumblr.com | 3 | work | social | Failed 60 | 87 | 0 | 5 | Unknown/Moderate | 67% |
| americanexpress.com | 3 | holdout | financial | Strong 100 | 88 | 0 | 5 | Moderate/Moderate | 100% |
| apus.edu | 2 | work | education | Strong 100 | 88 | 0 | 5 | High/Moderate | 100% |
| capitalone.com | 1 | holdout | financial | Adequate 80 | 88 | 0 | 5 | Moderate/Moderate | 83% |
| capitalone.com | 3 | holdout | financial | Adequate 80 | 88 | 0 | 5 | High/Moderate | 83% |
| coinbase.com | 1 | holdout | financial | Strong 100 | 88 | 0 | 5 | Unknown/High | 100% |
| discover.com | 2 | work | financial | Strong 100 | 88 | 0 | 5 | High/High | 100% |
| sofi.com | 2 | work | financial | Strong 100 | 88 | 0 | 5 | Moderate/Moderate | 100% |
| coursera.org | 3 | work | education | Strong 100 | 90 | 0 | 5 | High/High | 100% |
| harvard.edu | 1 | work | education | Strong 100 | 90 | 0 | 5 | Low/Low | 100% |
| tumblr.com | 1 | work | social | Adequate 80 | 90 | 0 | 5 | Moderate/Moderate | 83% |
| wellsfargo.com | 2 | work | financial | Adequate 80 | 90 | 0 | 5 | Moderate/Moderate | 83% |
| mozilla.org | 3 | holdout | technology | Failed 55 | 93 | 0 | 3 | Unknown/Low | 83% |
| wellsfargo.com | 3 | work | financial | Failed 55 | 95 | 0 | 5 | Unknown/Moderate | 83% |
| cnn.com | 3 | holdout | media | Failed 0 | 100 | 0 | 3 | Unknown/Low | 83% |
