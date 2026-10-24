# Railway handoff: Pitch Tiles

Branch: `codex/pitch-tiling-railway`, based on `master` at `4340d274572876239c154c90bc507a9b3250a656`. The repository has no `main` branch.

## Deploy

1. In Railway, create a project/service from GitHub and select `misoverfitting/soccer_data`.
2. In the service source settings, select **codex/pitch-tiling-railway** as the deployment branch. Keep the root directory at `/` (repository root).
3. Railway should detect the root `Dockerfile` and `railway.json`. Build with Dockerfile; start command is `node app/server.mjs`; health check is `/health`.
4. No credentials, database, volume or environment variables are required. Railway supplies `PORT`; the app binds it on `0.0.0.0`. Node 22 is included in the image.
5. After deployment succeeds, use Settings → Networking → Generate Domain and open the public HTTPS URL.
6. The bundled Auckland–Newcastle clip should immediately appear. Press Play, scrub the timeline, pause and click a triangle. Toggle ball inclusion, detected-only and Voronoi modes.
7. Select a match and phase, then **Load tracking clip**. This reads up to 60 seconds from public GitHub LFS media; later-match positions require scanning more of the remote stream. The status message reports loading/error states. Outbound HTTPS access to `media.githubusercontent.com` is needed for additional clips, not for the demo.

## Local operation

Requires Node 22+: `npm start`, then open http://localhost:3000. No npm install is needed. Run `npm test` for geometry and HTTP checks. Optional `PORT` overrides 3000.

## Behaviour and limits

### Dynamic danger overlay

The ball radius is 4.6 CSS pixels (15% larger than the original 4). Ball fill shows current signed danger; select **Potential danger** to colour tiles by their centroid's prospective danger (Voronoi mode samples at each site).

Negative/blue is the team defending the left goal and attacking right; positive/red is the opposite team. This mapping comes from match metadata for the current period and switches at halftime; it is not a permanent home/away mapping. The raw score scale is fixed [-1, 1], with neutral white and unavailable grey. Ball and tile colours use fixed logarithmic contrast, log(1 + 10000 × abs(score)) / log(10001), so low but nonzero threats remain visible. This changes colour intensity only, not the raw scores. Danger tile opacity is 72%. Player markers and teammate edges use the same blue/red endpoints as the scale and switch with the period directions. The ball stays visible when excluded as a mesh vertex. There is no per-frame min/max colour normalization.

This is an **uncalibrated spatial EPV proxy**, calculated every frame, not the provider's event-level EPV or an empirically validated probability of scoring. Spatial value combines exponential goal-distance decay (24 m), visible goal angle and opposing-player pressure (3 m decay). Known possession selects the attacking team; otherwise relative arrival times provide soft possession weights. Arrival estimates use reaction time 0.7 s, movement speed 5 m/s and previous-frame velocity capped at 9 m/s. Potential value further weights prospective passes by ball travel at 15 m/s, receiver readiness and interception margins at four samples along the pass. Constants are transparent research defaults, not fitted parameters. Typical values are much closer to zero than to the endpoints. A high value is relative model danger, not a calibrated chance percentage. Missing ball/direction/team data makes the score unavailable.

All available players contribute to the danger model, independently of mesh team/detection filters. Estimated positions are included and flagged. Changing mesh filters therefore does not change the underlying ball danger. Physical ball height, acceleration, body orientation, deliberate pass choice and goalkeeper-specific shot stopping are not modelled. Use larger labelled outcome data to calibrate or replace this baseline before interpreting values as scoring probabilities.

Thick solid mint/blue edges join teammates; amber dashed edges join different teams or the ball. Vertex outlines still flag estimated positions. The tile fill remains independent of the edge encoding.

- Real demo: 300 frames (30 seconds) from match 1886347, source frames 10–309, bundled with metadata. The rest of the 20-match catalogue is read from repository metadata and phase CSVs.
- Tracking media is pinned to the reviewed base commit, rather than silently changing upstream. Git LFS checkout is not required to run the app: all extra tracking is fetched server-side.
- Coordinates and triangulation stay in physical metres, with actual match dimensions and raw stadium orientation. No synthetic pitch-corner vertices are added. Triangle areas refer to full geometric triangles; graphics are clipped to the pitch, so off-pitch triangles can have larger measured areas than their visible portion.
- Extrapolated vertices have amber dashed outlines; triangles touching them have dashed edges. Detected-only changes the geometry rather than filling missing players. The ball is one neutral geometry seed; a coincident ball/player position preserves both identities at a single site.
- Voronoi is proximity territory, not a predictive pitch-control model. Ball inclusion applies to both geometry modes. Team-only meshes are separate views, not additive territory shares.
- The inspector tracks a triangle by its member identities while scrubbing. Delaunay edge changes can remove a selected triangle. Geometry measurements do not assert pass feasibility or possession value.
- Clip requests are bounded to 600 frames and 90 seconds upstream timeout. An eight-clip in-memory cache resets when the service restarts. This is a small-team research app, without authentication or durable storage. Public services permit public access; use Railway/private-network or an external access gateway if you need restricted access.
- Pre-identified shot/goal selections, phase selection and custom start frames are supported. No body-pose processing is required.
- Library: vendored d3-delaunay 6.0.4, ISC license in `app/public/D3-LICENSE.txt`. Tracking data: SkillCorner Open Data / PySport, repository MIT license. Credit SkillCorner in shared results.

## Troubleshooting

- No public URL: generate a Railway domain after the service passes `/health`.
- Build tries Python: ensure repository root and Dockerfile builder are selected; do not use the tutorial `requirements.txt` for this app.
- Additional clip fails: use the bundled demo, check outbound GitHub availability and retry a shorter/earlier clip. No SkillCorner API account is needed.
- Railway connection permissions: ensure its GitHub integration can access this repository and branch.


## Pre-identified danger chances

Choose a match, then select **Danger chances**. Selection automatically loads the build-up and outcome; no frame entry is necessary. Use **Chance filter** to show high-EPV chances plus goals (default), confirmed goals only, or all recorded shots/goals. Press Play to watch from the build-up, or **Jump to shot / goal marker** to inspect the anchor. The marker countdown beneath playback uses frame time and updates during scrubbing.

The checked-in `app/chance-catalogue.json` contains 528 clips across all 20 matches, including 264 high-EPV/goal clips and 64 confirmed goals. Each clip is bounded to the current period and spans up to 20 seconds before and 8 seconds after the anchor. Manual frame and phase loading remain available. A missing tracking interval cannot be reconstructed; the app reports if the exact outcome frame or its coverage is missing.

Selection is retrospective: actual `player_possession.end_type == shot` anchors shots. Explicit `goal_for`/`goal_against` interruption markers confirm goals and are combined with the corresponding shot where possible. Earlier `lead_to_goal` actions are not counted as separate goals. A shot without a confirmed goal marker is labelled SHOT, not saved/missed, because the data does not specify a full shot result taxonomy. Separate close shots, including rebounds, remain separate entries, so their build-up windows can overlap.

Ranking uses the maximum available provider attacking EPV at possession start/end or pass reception for that team in the 20-second window ending at the anchor. High-EPV means >= 0.10; explicitly recorded goals are always included. This is a selection threshold, not an xG threshold or a guarantee of a high probability of scoring. Missing EPV is displayed as unavailable and remains discoverable under All recorded shots/goals. The live danger overlay remains the separate spatial proxy documented above.

The event annotations are incomplete in places: match 1886347's metadata reports 2–0 but its events explicitly confirm only one goal. The selector cannot recover an unannotated goal from the final score alone. No new goal labels are inferred from the spatial danger model.

To rebuild after changing source event data, run `node app/scripts/build-chances.mjs`, review the resulting JSON and commit it. Railway reads the precomputed catalogue at startup; it does not scan 100 MB of CSVs to discover chances on each request. Existing Dockerfile and Railway settings continue to work. The clip API now accepts optional `end` and `period` bounds to avoid bleeding through gaps into another half.

Validation: automated catalogue checks cover all 20 matches and all recorded shot anchors; client harness covers selection, exact API parameters, countdown and jump-to-shot; HTTP tests cover phase bounds and gaps. A real goal clip for match 1886347 was retrieved successfully at frames 50399–50679 including goal marker 50599. Interactive browser visual verification was unavailable in this session.


## Mobile layout

At widths up to 900 px the pitch appears before the controls. **Choose chance** and **Mesh settings** shortcuts open and scroll to their native disclosure panels beneath the viewer. Custom frame/phase entry is nested under **Custom frames & phases**. Desktop keeps its sidebar with the primary panels expanded. Loading a chance still returns to the pitch; initial mobile mesh centering remains enabled. A mirrored status message next to the viewer reports loading/errors even when the control panels are closed.

**Expand pitch** fills the available browser viewport with the pitch and playback controls, including on iOS browsers without the fullscreen API. Use **Exit expanded view** or Escape to return. Rotating the phone redraws the pitch. The layout uses safe-area insets and dynamic viewport height, 44 px touch targets, 16 px form text to avoid iOS input zoom, and a compact three-column playback row. The canvas permits vertical page scrolling and pinch zoom. Render pixel density is capped at 2x and the canvas backing store is resized only when dimensions change.

Validation covers mobile and desktop client initialization, control shortcuts, expand/escape behaviour, chance selection, shot jumping and pixel-density bounds in the client harness. HTML structure and unique IDs were checked. Browser/device visual testing was unavailable during this update; check portrait/landscape on a real phone after deployment. Railway configuration is unchanged.
