# Contributing

Thanks for helping with SmartPixels Event Viewer. Bug reports, physics corrections, documentation and code are all welcome, whether you work by hand or with an AI coding agent.

## Get started

You need Node.js 20 or newer. There is nothing to install.

```bash
git clone https://github.com/<your-username>/smartpixels-event-viewer.git   # your fork
cd smartpixels-event-viewer
npm test
npm run sample    # http://127.0.0.1:5173/
```

[docs/SETUP.md](docs/SETUP.md) covers Python and the full dataset, which you only need for converter work.

## Making a change

1. For anything large, **open an issue first** so we can agree on the approach.
2. Create a branch from `main`.
3. Keep the change focused, and add tests for new geometry, hit logic or data handling.
4. Run the checks below.
5. Open a pull request that says what changed, why, and how you checked it. Include a screenshot for UI changes.

## Checks

```bash
npm test                  # required; CI runs this on Node 20 and 22
npm run test:converter    # if you touched the converter (needs requirements.txt)
npm run qa:browser -- http://127.0.0.1:5173/ /tmp/qa-out    # recommended for UI changes (Chrome, Node 22+)
```

A change that only alters screenshots does not validate the detector geometry.

## Project rules

These keep the viewer scientifically honest. The full list is in [CLAUDE.md](CLAUDE.md).

- **The geometry is fixed:** 48 × 192 pixels, 50 × 12.5 µm pitch, 100 µm thick, footprint `[-1200, 1200)²` µm, planes at z = 0, −50 and −100 µm.
- **Pixel addresses are zero-based** (x 0–47, y 0–191). Never transpose axes or pixels silently.
- **`src/geometry.js` is the source of truth.** Renderers draw what it returns.
- **Only PixelAV output may colour pixels.** Do not add a made-up pixel response.
- **Display settings stay display-only.** The Z stretch never affects a computed value.
- **Do not guess at physics conventions.** If the data doesn't settle one, record it in [docs/OPEN_DECISIONS.md](docs/OPEN_DECISIONS.md).
- **No new runtime dependencies** without discussion: the viewer runs with no `npm install`.
- **Keep the interface simple.** Show only what the data supports, keep one name per concept, and update [docs/USER_GUIDE.md](docs/USER_GUIDE.md) when controls change.

## Using AI coding agents

Agents are welcome, including Claude Code and [oh-my-claudecode](docs/HANDOVER_CLAUDE.md#4-oh-my-claudecode-omc-optional). OMC ([ohmyclaudecode.com](https://ohmyclaudecode.com/)) is optional and set up per person.

- `CLAUDE.md` holds the shared rules that agents read automatically.
- **Do not commit personal agent state** such as `.omc/` or a generated `.claude/CLAUDE.md`. These are git-ignored.
- **You own the result.** Read the whole diff, run the checks, and be able to explain the change.
- **List any assumptions the agent made** about physics or data in the pull request.

[docs/HANDOVER_CLAUDE.md](docs/HANDOVER_CLAUDE.md) has workflows and prompting tips.

## Data and secrets

Never commit datasets, converted data, credentials, tokens or machine-specific paths. Only the small example fixture in `tests/fixtures/pixelav/` belongs in the repository.

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
