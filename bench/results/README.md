# Bench results

One row per run of `node bench/run.mjs`. Tokens include cache reads and writes; $ is the claude CLI's own figure.

| date       | rivetari | card    | outcome                                                                                    | verdict       | stops | build rounds | judge rounds | turns | tokens  | $    | wall s | committed | result                                  |
| ---------- | -------- | ------- | ------------------------------------------------------------------------------------------ | ------------- | ----- | ------------ | ------------ | ----- | ------- | ---- | ------ | --------- | --------------------------------------- |
| 2026-11-24 | 6dd1342  | oneline | reached ship (not run)                                                                     | passed        | 0     | 1            | 1            | 9     | 342116  | 0.47 | 114    | true      | [json](2026-11-24-6dd1342-oneline.json) |
| 2026-11-24 | 6dd1342  | t0028   | stopped: unverified_acceptance: A3 (Both tests exist with the required assertions: coach … | needs a human | 4     | 1            | 1            | 39    | 1577985 | 1.66 | 264    | true      | [json](2026-11-24-6dd1342-t0028.json)   |
| 2026-11-24 | 6dd1342  | t0019   | reached ship (not run)                                                                     | passed        | 0     | 1            | 1            | 24    | 1343795 | 1.64 | 224    | true      | [json](2026-11-24-6dd1342-t0019.json)   |
