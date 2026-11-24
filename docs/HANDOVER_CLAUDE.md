# Taking over with Claude Code (and oh-my-claudecode)

This page is for whoever continues this project with an AI coding agent. It covers:
- what state the project is in,
- what the agent reads automatically,
- how the first two milestones were run with oh-my-claudecode (OMC),
- how to check the agent's work before trusting it.

## 1. Where the project stands (v0.7.0)

| Milestone | Status | Where to read about it |
|---|---|---|
| 1. Three.js volumetric viewer (rotate/zoom, editable track, top/mid/exit animation, 16×16 ROI) | Done, reviewed | `README.md`, `docs/PROJECT_SPEC.md` |
| 2. pixelAV simulated events (Parquet → sparse files, one event per HTTP Range request) | Done, reviewed | `docs/PIXELAV_DATA.md` |
| 3. Illustrative Gaussian removed; 2D pixel map with surface/midplane/exit markers (v0.4.0) | Done | `README.md` ("2D pixel map") |
| 4. 2D map is the default view (full 48 × 192 array, µm / pixel axes); controls regrouped by view (v0.5.0) | Done | `README.md` ("Layout") |
| 5. View renamed 2D; central x = 0 / y = 0 axes highlighted; pixel axis counted from the centre (v0.6.0) | Done | `README.md` ("2D view") |
| 6. One-screen layout: map, colour bar and playback always visible; controls ordered by use; keyboard zoom and pan (v0.7.0) | Done | `README.md` ("Layout") |

**Open decisions (need a human, ideally the dataset's author).** Details and evidence are in `.omc/autopilot/decisions-pending.md` and `docs/PIXELAV_DATA.md`.
1. pixelAV `(x, y) = (0, 0)` is assumed to be the centre of pixel (23, 95). This is `PIXELAV_ORIGIN` in `src/pixelav.js`.
2. Readout pixels are assumed to sit on the track's entry face (pixelAV z = 100, viewer z = 0).
3. A constant ≈ −16 µm y residual (probably Lorentz drift) is shown, not corrected.

Candidate next tasks are listed under "Suggested future improvements" in `README.md`.

## 2. What you need

| Tool | Needed for |
|---|---|
| Node ≥ 20 | Everything: `npm test`, `npm run dev`. There are no npm packages; Three.js is vendored. |
| Python ≥ 3.9 with `pyarrow` and `numpy` (e.g. a conda env) | Only for converting Parquet: `npm run convert:pixelav` |
| `google-chrome` | Only for headless UI checks: `scripts/qa-browser.mjs` |
| Claude Code | The agent. Run `claude` in this folder. |
| oh-my-claudecode | Optional. Adds a multi-agent workflow on top of Claude Code (§4). |

The converted data (`data/pixelav/`, about 1.5 GB) is **not** part of the project folder handed over; it is git-ignored. Regenerate it from the source Parquet files, about 8 min with `--jobs 4` (see `docs/PIXELAV_DATA.md`). Without it, the viewer says no data is available and shows no track. `npm test` still passes, because it uses the small real-data fixture in `tests/fixtures/pixelav/`.

## 3. What Claude reads automatically

| File | Role | Edit it? |
|---|---|---|
| `CLAUDE.md` | **Project rules**: geometry constants, axis and pixel conventions, the "no made-up pixel response" rule, code organisation. This is the most important file for keeping the agent honest. | Yes, whenever conventions or layout change. Keep it short and checkable. |
| `.claude/CLAUDE.md` | OMC's orchestration instructions, between `<!-- OMC:START -->` markers. OMC installed it project-locally. | No. `omc-setup` regenerates it. |
| `.claude/skills/wiki/` | OMC's project-local wiki skill | Leave as is |

If you use plain Claude Code without OMC, `.claude/CLAUDE.md` still loads. Its references to OMC agents and skills (`executor`, `/oh-my-claudecode:…`) then do nothing. That is harmless. Delete that file if it confuses the agent.

`docs/CLAUDE_START_PROMPT.md` is the **original** milestone-1 prompt and is kept for history. Don't paste it again.

## 4. oh-my-claudecode (OMC)

OMC is a Claude Code plugin. It adds workflow skills such as `autopilot`, `plan`, `review` and `verify`, plus specialist subagents: planner, architect, executor, code reviewer and security reviewer. Both milestones were built with **`autopilot`**, which runs:
1. a spec,
2. a plan,
3. implementation,
4. a test/QA loop,
5. three independent reviews (architect, security, code),
6. a closeout.

Install it by following the OMC project's README (plugin marketplace + `/oh-my-claudecode:omc-setup`). The setup used here was version 5.8.x.

### Recommended: keep OMC opt-in

On the original machine, OMC is disabled globally and enabled only for one launcher, so plain `claude` stays vanilla:

```bash
# ~/.claude/settings.json contains: "enabledPlugins": {"oh-my-claudecode@omc": false}
# ~/.bashrc:
claude-omc() {
  command claude --settings '{"enabledPlugins":{"oh-my-claudecode@omc":true},
    "statusLine":{"type":"command","command":"node $HOME/.claude/hud/omc-hud.mjs"},
    "env":{"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS":"1"}}' "$@"
}
```

With this setup, the OMC setup check reports "plugin not found". That's expected, because the global setting is off. Install project-locally (`--local`). Don't use the global overwrite mode, because it would replace your `~/.claude/CLAUDE.md`.

### Workflows that fit this project

| You want | Use |
|---|---|
| A whole feature, end to end, with reviews | `autopilot <description>`. Give concrete anchors: files, constants, the expected UI. |
| A plan to approve before any code | `/oh-my-claudecode:plan` or `ralplan` (consensus planning) |
| A review of finished work | `/oh-my-claudecode:review`, or Claude Code's `/code-review` |
| Proof that something works | `/oh-my-claudecode:verify` |
| To stop a running mode | `/oh-my-claudecode:cancel` (or say "cancelomc") |

### Files OMC writes to `.omc/`

| Path | Contents | Keep? |
|---|---|---|
| `.omc/autopilot/spec.md` | Spec and assumptions from the last autopilot run | Useful history |
| `.omc/autopilot/decisions-pending.md` | Choices the agent could not settle alone (§1) | **Yes. Resolve these, then delete them.** |
| `.omc/notepads/autopilot/problems.md` | Append-only lessons from each run (what broke, what dragged) | Yes. Read it before a new run. |
| `.omc/state/` | Runtime state for the current session | No (git-ignored) |

When autopilot cannot get a human answer, it records each guess as an assumption. A guess that would be hard to reverse goes to `decisions-pending.md` instead, and only the reversible version is built. Check that file after every unattended run.

## 5. Prompting: what worked

- **Name the constraint, not just the feature.** For example: "keep `src/geometry.js` the source of truth", "only pixelAV data may colour pixels", "don't transpose pixels".
- **Ask for evidence when the data's conventions are unknown.** Milestone 2 derived the pixel column order, the coordinate frame and the origin from the data itself, using correlations and residuals, and wrote the evidence down. Insist on that rather than plausible guesses.
- **Ask for browser QA, not only unit tests.** The rapid-click race in event stepping was found only by driving the real UI.
- Example opening prompt for a new session:

  > Read CLAUDE.md, README.md, docs/PIXELAV_DATA.md and docs/HANDOVER_CLAUDE.md. Run `npm test`.
  > Then add event filtering by cotα/cotβ/pT using the truth columns already in each file's index (no new downloads).
  > Keep pixelAV as the only charge source, add tests, verify in the browser with scripts/qa-browser.mjs, update the docs.

## 6. How to check the agent's work

Run all of these before accepting a change:

```bash
npm test                         # JS tests: geometry, ROI, 2D map, decoder, loader, dev server, colours
conda activate <env-with-pyarrow>
npm run test:converter           # synthetic converter round trip
PIXELAV_SOURCE=/path/to/dataset_2su_-9_9_48x192_50x12P5_parquets npm run test:converter
                                 # + float32-exact check against real Parquet (refreshes the fixture)
npm run dev                      # then, in another shell:
npm run qa:browser -- http://127.0.0.1:5173/ /tmp/qa-out    # screenshots + console errors
```

`scripts/qa-browser.mjs` drives headless Chrome with software WebGL, so no GPU is needed. Steps come from the `STEPS` env var (the format is at the top of the script); `click` takes an id or a CSS selector such as `#axisUnits [data-value=px]`. Screenshots cover the viewport panel (`SHOT_SELECTOR=body` for the whole page). The page opens on the 2D map; add `?view=3d` to check the 3D scene. `window.pixelSensorDebug` exposes the state to inspect, for example `pixelSensorDebug.event`, `.charge` and `.dataStats`. The script exits with code 1 if the page throws an exception.

Then compare against the guardrails in `CLAUDE.md`:
- 48 × 192 pixels at 50 × 12.5 µm;
- z = 0 / −50 / −100;
- the slope formulas;
- zero-based pixel indices, no transpose;
- Z stretch is display-only;
- only pixelAV simulated charge colours pixels.

A change that only alters screenshots does not prove the geometry is correct.

## 7. Known pitfalls

- `pkill -f foo` (or `pgrep -f`) run in a shell whose own command line contains `foo` kills that shell. Use a separate command with a bracketed pattern: `pkill -f "dev-serve[r].mjs"`.
- Opening one source Parquet file costs about 0.7 GB of RAM: it has about 184k columns and a 100 MB footer. Never let an agent "just read the parquet in the browser" or load several files in one process. The converter uses one process per file for this reason.
- The dev server's Range support is what keeps browsing cheap. A static server that ignores Range still works but downloads whole files; `pixelSensorDebug.dataStats.fullFileFallbacks` counts this, and files over 64 MB are refused.
- The project is a git repository on branch `main`. Commit, or branch, before handing an agent a large refactor, so you can review its changes as a diff. `data/`, `.omc/state/` and Python bytecode are git-ignored.
