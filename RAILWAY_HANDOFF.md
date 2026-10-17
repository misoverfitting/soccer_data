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

- Real demo: 300 frames (30 seconds) from match 1886347, source frames 10–309, bundled with metadata. The rest of the 20-match catalogue is read from repository metadata and phase CSVs.
- Tracking media is pinned to the reviewed base commit, rather than silently changing upstream. Git LFS checkout is not required to run the app: all extra tracking is fetched server-side.
- Coordinates and triangulation stay in physical metres, with actual match dimensions and raw stadium orientation. No synthetic pitch-corner vertices are added. Triangle areas refer to full geometric triangles; graphics are clipped to the pitch, so off-pitch triangles can have larger measured areas than their visible portion.
- Extrapolated vertices have amber dashed outlines; triangles touching them have dashed edges. Detected-only changes the geometry rather than filling missing players. The ball is one neutral geometry seed; a coincident ball/player position preserves both identities at a single site.
- Voronoi is proximity territory, not a predictive pitch-control model. Ball inclusion applies to both geometry modes. Team-only meshes are separate views, not additive territory shares.
- The inspector tracks a triangle by its member identities while scrubbing. Delaunay edge changes can remove a selected triangle. Geometry measurements do not assert pass feasibility or possession value.
- Clip requests are bounded to 600 frames and 90 seconds upstream timeout. An eight-clip in-memory cache resets when the service restarts. This is a small-team research app, without authentication or durable storage. Public services permit public access; use Railway/private-network or an external access gateway if you need restricted access.
- Event-specific selections and EPV overlays are future work; this version supports phase selection and custom start frames. No body-pose processing is required.
- Library: vendored d3-delaunay 6.0.4, ISC license in `app/public/D3-LICENSE.txt`. Tracking data: SkillCorner Open Data / PySport, repository MIT license. Credit SkillCorner in shared results.

## Troubleshooting

- No public URL: generate a Railway domain after the service passes `/health`.
- Build tries Python: ensure repository root and Dockerfile builder are selected; do not use the tutorial `requirements.txt` for this app.
- Additional clip fails: use the bundled demo, check outbound GitHub availability and retry a shorter/earlier clip. No SkillCorner API account is needed.
- Railway connection permissions: ensure its GitHub integration can access this repository and branch.
