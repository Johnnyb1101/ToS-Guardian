# Campaign bundle-2b-billing-deletion

Not proven: work-split gain is inside the noise (mean 0.9, 95% interval -1.8 to 3.7); work-split mean gain 0.9 is below the 3-point floor; holdout may have regressed (95% interval -7.7 to 2.9).

Started 2026-10-10T22:05:00.266Z, finished 2026-10-11T01:06:27.084Z. Proxy http://127.0.0.1:3001. Control treat-bundle1. Proof kind jury.
Cost: screen $8.81, proof $34.76, total $43.57.

## Lessons

- L013 -> lsn_ba40ed07be36a4c4 (created, carried, not under test)
- L015 -> lsn_b9b9c7dbd6ca98f2 (created, carried, not under test)
- L017 -> lsn_ae1cebb06d47b67b (created, carried, not under test)
- L019 -> lsn_0c29b22aa2a03528 (created, carried, not under test)
- L021 -> lsn_6b4b017de19dc296 (created, carried, not under test)
- L023 -> lsn_1b1f7140d92cd1b5 (created, carried, not under test)
- L005b -> lsn_40dd29ae340ddf03 (created)
- L008b -> lsn_04caae43ae480e3a (created)

Pinned set: lsn_04caae43ae480e3a, lsn_0c29b22aa2a03528, lsn_1b1f7140d92cd1b5, lsn_40dd29ae340ddf03, lsn_6b4b017de19dc296, lsn_ae1cebb06d47b67b, lsn_b9b9c7dbd6ca98f2, lsn_ba40ed07be36a4c4

## Screen

10 site(s): passed.

| arm | verdicts | fabrications per verdict | jury mean |
|---|---|---|---|
| control | 30 | 0.10 | 80.1 |
| treatment | 30 | 0.27 | 78.2 |

## Proof

Not proven: work-split gain is inside the noise (mean 0.9, 95% interval -1.8 to 3.7); work-split mean gain 0.9 is below the 3-point floor; holdout may have regressed (95% interval -7.7 to 2.9).
Lesson set 6c75b12af2b6; details in reference/runs/bundle-2b-billing-deletion-proof/proof.md.

## Steps

- health: done (ledger 0 entries, signing on, lessons {"candidate":0,"canary":0,"promoted":0,"retired":0}) at 2026-10-10T22:05:00.306Z
- register: done (8 registered, 8 pinned) at 2026-10-10T22:05:01.138Z
- screen-replay: done at 2026-10-10T22:19:34.899Z
- screen-jury: done ($8.81) at 2026-10-10T22:38:22.761Z
- screen-decide: done (passed) at 2026-10-10T22:38:22.833Z
- proof-replay: done at 2026-10-10T23:46:54.989Z
- proof-jury: done ($34.76) at 2026-10-11T01:06:26.820Z
- prove: done (not proven) at 2026-10-11T01:06:27.072Z
- report: done (C:\Users\james\ToS-Guardian\reference\runs\bundle-2b-billing-deletion\report.md) at 2026-10-11T01:06:27.084Z
- notify: done (no notification url) at 2026-10-11T01:06:27.094Z

## Proposal

Retire the candidates with the proof attached.
node tools/lessons.js status lsn_40dd29ae340ddf03 retired --proxy http://127.0.0.1:3001 --proof reference/runs/bundle-2b-billing-deletion-proof
node tools/lessons.js status lsn_04caae43ae480e3a retired --proxy http://127.0.0.1:3001 --proof reference/runs/bundle-2b-billing-deletion-proof
