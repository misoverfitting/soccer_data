# Pitch Model Lab

An interactive viewer that plays back SkillCorner tracking and compares three versions of the defensive-shape models
from `notebooks/defensive_shape_integrity.ipynb`, frame by frame:

| Layer | v0 | v2 | v3 |
|---|---|---|---|
| **Pitch control** (P_att or P_succ) | literature settings (0.5 s reaction, 15 m/s ball, σ 0.45, …) | 10 settings fitted on 15 matches (`notebooks/fitted/pitch_control_settings.json`) | same as v2 |
| **EPV** | location only (`V_loc`) | location × defensive-context multiplier (`notebooks/fitted/value_model.json`) | same as v2 |
| **Carries** (P_keep) | none: passes only | none: passes only | survival model fitted on carries from 15 training matches (`notebooks/fitted/carry_model.json`) |
| **Gain** | passing: v0 P_succ × v0 value | passing: v2 P_succ × v2 value | the better of passing or carrying |
| **Integrity** (protection) | 1 − P_succ, weighted by `V_loc` | 1 − P_succ, weighted by `V_loc` | 1 − max(P_succ, P_keep), weighted by `V_loc` |

**Integrity** is the notebook's protection score (Section 5, definition chosen in Section 8b): how well the defence
denies passes (v3: passes or carries) into the space from 5 m behind the ball to goal,
I = Σ V_loc·(1 − P) / Σ V_loc over that zone. The layer shows 1 − P in the zone (faded where the space is worth
little), each pitch shows the frame's I, and a timeline under the player plots I for all three versions across the
clip (click it to jump). On Perth's goal the viewer reproduces the notebook's v2 values exactly: 0.861 → 0.561 → 0.575 → 0.620.

**Carries** (v3 only): the player on the ball, ringed in gold, can carry it instead of passing. Pitch control → P<sub>keep</sub>
shows the chance they keep it on a straight run to each spot (notebook Section 4c: 81% of top speed, a survival model
in which the risk of losing the ball grows with every defender who can reach the carrier within about a second).
Grey = no carry there: nobody on the ball (e.g. the ball in flight), v0/v2, or further than the longest real carries
(6.4 s). In a sequence the carrier is the player in possession; otherwise the attacker within 1.5 m of the ball.
v3 shares v2's pitch control and value, so v3 − v2 isolates what carries change; v2 − v0 isolates what fitting changed.

**Danger** (notebook Section 8d) is the second frame score, reported beside integrity: how dangerous the most dangerous
attacker the defence has left free is. Each outfield attacker except the one nearest the ball is projected 1 s ahead;
each outfield defender is assigned one attacker (minimum total arrival time, as `scipy.optimize.linear_sum_assignment`);
an attacker is covered if their defender arrives within the ball's travel time + 1 s (halved if not goal-side), and
D = max over attackers of V × (1 − covered), with V the version's value (location value in v0, context value in v2/v3).
Integrity predicts the defence winning the ball back; danger predicts how dangerous the next two actions get if it
doesn't (held-out ρ 0.114 vs 0.001 for integrity). The Danger layer draws each attacker's 1 s-ahead spot sized by their
share, rings the most dangerous one and joins them to their assigned defender; every pitch badge shows I and D together,
the timeline plots D for all three versions, and the hover table has a D column. Danger is identical in v2 and v3: carries
change the ball carrier's options, not who is free. On Perth's goal the viewer reproduces the notebook: D 0.037 → 0.088 → 0.107 → 0.078.

Views: side by side (three pitches), single model, or the differences v2 − v0 and v3 − v2. Hover a pitch to read all
three models' values at one spot.

## How it works

- `server.mjs` (Node 22, no dependencies) serves the page and `/api/clip/<match>?start=&end=`. Tracking is not in the
  image: it is read from the repo's Git LFS media URL with HTTP range requests (binary search on byte offset, then only
  the clip is downloaded, ~1–2 s). If a real tracking file is present locally under `data/matches/`, it is read from disk.
- `public/model.js` is a line-for-line JavaScript port of the notebook's `pitch_control`, `time_to_reach`, `carry_options`, the protection score and
  `context_value`. Two web workers (one per version) compute every frame of the clip in the browser, starting at the
  playhead. `test/model.test.mjs` checks the port against the Python model (`scripts/make_fixtures.py`): worst
  difference 5e-7.
- `data/` is built by `scripts/build_data.py` from the match files, the physical aggregates and the fitted model files:
  each player's top speed / acceleration and every team-possession sequence (goals, shots, high-EPV chains).

Surfaces are always from the attacking team's point of view (the sequence's team; **Swap** flips it).
Run credit is not applied: on a free-playing frame there is no known receiver.

## Run locally

```bash
cd model_viewer
npm start            # http://localhost:3000
npm test             # model parity + clip API
```

After the fitted models or event data change: `python model_viewer/scripts/build_data.py` (and
`python model_viewer/scripts/make_fixtures.py` to refresh the parity fixtures; it reads the model code straight from the notebook), from the repo root.

## Deploy on Railway

Create a **new service** from this repository and set its **Root Directory** to `/model_viewer`. Railway picks up
`model_viewer/Dockerfile` and `model_viewer/railway.json` (health check `/health`). No variables are needed;
`TRACKING_REF` (default `main`) chooses the branch or commit tracking is read from. Then generate a domain.
The existing Pitch Tiles service is unaffected.
