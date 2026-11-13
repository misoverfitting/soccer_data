"""Reference outputs from the notebook's Python model, used by test/model.test.mjs to check the JavaScript port.

Run from the repository root (needs match 1925299's real tracking file, not the Git LFS pointer, and
notebooks/fitted/*.json from defensive_shape_fitting.ipynb):
    python model_viewer/scripts/make_fixtures.py

The model code is read straight from notebooks/defensive_shape_integrity.ipynb (Sections 1–4c), so the fixtures
always follow the notebook.
"""
import json, os
from pathlib import Path
import numpy as np
import nbformat
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
plt.show = lambda *a, **k: plt.close("all")

ROOT = Path(__file__).resolve().parents[2]
nb = nbformat.read(ROOT / "notebooks" / "defensive_shape_integrity.ipynb", 4)
code = []
for c in nb.cells:
    if c.cell_type == "markdown" and c.source.startswith("## 5."):
        break
    if c.cell_type == "code":
        code.append("\n".join(l for l in c.source.splitlines() if not l.lstrip().startswith(("%", "!"))))
os.chdir(ROOT / "notebooks")
g = {}
exec(compile("\n\n".join(code), "defensive_shape_integrity.ipynb", "exec"), g)

FITTED, DEFAULT, VM, CARRY = dict(g["SETTINGS"]), dict(g["DEFAULT_SETTINGS"]), g["VALUE_MODEL"], g["CARRY"]

def use(settings, value_model, carry):
    for k, v in settings.items():
        g[k] = v
    g["K_LOGIT"] = np.pi / (np.sqrt(3) * settings["SIGMA"])
    g["VALUE_MODEL"] = value_model
    g["CARRY"] = carry          # v0 has no carry model

ev = g["events"]
pp = ev[ev.event_type == "player_possession"].sort_values("frame_start")
V_flat, CELLS = g["V_flat"], g["CELLS"]
cases = []
# 44209: Williams on the ball (carrier given) · 44245: Carluccio mid-carry · 44283: Risdon's one-touch cross
# (carrier found by the 1.5 m rule, or none) · 12345: an ordinary frame
for frame in [44209, 44245, 44283, 12345]:
    row = pp[(pp.frame_start <= frame)].iloc[-1]
    on_ball = int(row.player_id) if row.frame_end >= frame and frame != 44283 else None
    st, ball = g["frame_state"](frame, row.team_id, row.attacking_side)
    if ball is None:
        continue
    phys = g["PHYS"].loc[st.player_id]
    case = {"frame": frame, "team_id": int(row.team_id), "attacking_side": row.attacking_side, "ball": ball.round(6).tolist(),
            "carrier_id": on_ball,
            "players": [{"id": int(r.player_id), "x": r.x, "y": r.y, "vx": r.vx, "vy": r.vy, "att": bool(r.attacking),
                         "vmax": float(phys.loc[r.player_id, "vmax"]), "amax": float(phys.loc[r.player_id, "amax"])}
                        for r in st.itertuples()]}
    keep = np.arange(0, 7140, 7)
    for name, settings, value_model, carry in [("v0", DEFAULT, None, None), ("v2", FITTED, VM, CARRY)]:
        use(settings, value_model, carry)
        pc = g["pitch_control"](st, ball, carrier_id=on_ball)
        zone = CELLS[:, 0] >= ball[0] - 5
        integ = float((V_flat[zone] * (1 - pc["p_any"].ravel()[zone])).sum() / V_flat[zone].sum())
        case[name] = {"cells": keep.tolist(), "p_att": pc["p_att"].ravel()[keep].round(6).tolist(),
                      "p_succ": pc["p_succ"].ravel()[keep].round(6).tolist(),
                      "p_keep": pc["p_keep"].ravel()[keep].round(6).tolist(),
                      "value": pc["v_ctx"].ravel()[keep].round(7).tolist(),
                      "gain": pc["gain"].ravel()[keep].round(7).tolist(),
                      "gain_pass": pc["gain_pass"].ravel()[keep].round(7).tolist(),
                      "v_ball": round(pc["v_ball"], 7), "integrity": round(integ, 7),
                      "carrier_id": None if pc["carrier"] is None else int(st.player_id.iloc[pc["carrier"]])}
    cases.append(case)
    print(frame, row.player_name, "| carrier", case["v2"]["carrier_id"], "| v2 max gain", round(max(case["v2"]["gain"]), 4),
          "| max P_keep", round(max(case["v2"]["p_keep"]), 3), "| I v0", round(case["v0"]["integrity"], 3), "v2", round(case["v2"]["integrity"], 3))
use(FITTED, VM, CARRY)
out = ROOT / "model_viewer" / "test" / "fixtures.json"
out.parent.mkdir(exist_ok=True)
json.dump(cases, open(out, "w"), separators=(",", ":"))
print("wrote", out)
