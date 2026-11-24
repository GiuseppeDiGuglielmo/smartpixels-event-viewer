# Setup

How to get the viewer running on your machine, first with the example events and then with the full dataset.

## 1. Requirements

| Needed for | Tool | Check |
|---|---|---|
| Running the viewer | **Node.js 20 or newer** (22 recommended) | `node --version` |
| Getting the code | **git** | `git --version` |
| Viewing | A browser with **WebGL 2** (current Chrome, Firefox, Edge or Safari) | |
| Converting the dataset only | **Python 3.9 or newer** with `pyarrow` and `numpy` | `python3 --version` |
| Headless UI checks only | **Google Chrome** and **Node 22 or newer** | `google-chrome --version` |

There are no npm packages to install and no build step. Three.js is included in `vendor/three/`.

If your system Node is older than 20, which is common on Linux distributions, install a current one with [nvm](https://github.com/nvm-sh/nvm). The repository's `.nvmrc` selects the version:

```bash
nvm install    # run inside the repository
nvm use
node --version
```

## 2. Get the code and check it

```bash
git clone https://github.com/GiuseppeDiGuglielmo/smartpixels-event-viewer.git
cd smartpixels-event-viewer
npm test
```

All tests should pass. They need neither the dataset nor Python.

## 3. Run with the example events

```bash
npm run sample
```

Open **http://127.0.0.1:5173/**. You should see the sensor with the charge of event 0, and be able to step through 6 real PixelAV events. Stop the server with `Ctrl+C`.

## 4. Use the full dataset

The 48 × 192 dataset is not in the repository. Ask the project maintainers for access. The published [Smartpixels co-design datasets](https://zenodo.org/records/17180303) are related but use 21 × 13 arrays and a different file layout, so the converter cannot read them yet (see [PIXELAV_DATA.md](PIXELAV_DATA.md#published-datasets-and-references)). The dataset should look like this:

```text
dataset_2su_-9_9_48x192_50x12P5_parquets/
├── test/part.N.parquet
└── train/part.N.parquet
```

### Create the Python environment

With `venv`:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Or with conda:

```bash
conda create -n smartpixels-viewer python=3.11
conda activate smartpixels-viewer
pip install -r requirements.txt
```

### Convert the data

Start with two files to check that everything works (about 15 s and 1 GB of RAM per file):

```bash
npm run convert:pixelav -- /path/to/dataset_2su_-9_9_48x192_50x12P5_parquets --split test --limit 2
```

Then convert everything:

```bash
npm run convert:pixelav -- /path/to/dataset_2su_-9_9_48x192_50x12P5_parquets --jobs 4
```

| | Full dataset |
|---|---|
| Input | 100 files, 14 GB |
| Output | About 1.5 GB in `data/pixelav/` (git-ignored) |
| Time with `--jobs 4` | About 8 minutes |
| Memory | About 1.1 GB per worker, so choose `--jobs` to fit your RAM |

Conversion is incremental: running it again skips files that are already up to date. Use `--out DIR` to write somewhere else.

### Start the viewer

```bash
npm run dev
```

Open **http://127.0.0.1:5173/**. The Python environment is not needed for this step.

## 5. Server options

Set these as environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `5173` | Port to listen on |
| `HOST` | `127.0.0.1` | Address to listen on |
| `PIXELAV_DATA` | `data/pixelav` | Folder of converted data |

```bash
PORT=8080 npm run dev
PIXELAV_DATA=/scratch/pixelav npm run dev
```

The server has no authentication, so keep it on `127.0.0.1` unless you trust your network.

## 6. Run on a remote machine

Keep the server on the remote machine's loopback address and forward the port over SSH. On your laptop:

```bash
ssh -L 5173:127.0.0.1:5173 user@remote-host
```

Then, in that SSH session:

```bash
cd smartpixels-event-viewer
npm run dev
```

Open **http://127.0.0.1:5173/** in your laptop's browser. Events are fetched one at a time, so this works well over slow links.

## 7. Update

```bash
git pull
npm test
```

Converted data only needs regenerating if `docs/PIXELAV_DATA.md` reports a format change.

## 8. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The viewer says **No converted PixelAV data** | You ran `npm run dev` without converted data. Use `npm run sample`, or convert the dataset (section 4). |
| `EADDRINUSE` when starting | The port is taken, often by a viewer already running. Stop it, or use `PORT=5174 npm run sample`. |
| `node: command not found`, or errors on an old Node | Install Node 20 or newer (section 1). |
| `python3: command not found` | Install Python 3.9 or newer. |
| `ModuleNotFoundError: No module named 'pyarrow'` | Activate your environment and run `pip install -r requirements.txt`. |
| The converter is killed, or the machine runs out of memory | Lower `--jobs`. Each worker needs about 1.1 GB. |
| Page is blank when opening `index.html` directly | The viewer must be served: use `npm run sample` or `npm run dev`. |
| **About this view** shows "2D canvas fallback" in 3D | WebGL 2 is unavailable. Enable hardware acceleration in your browser. The 2D view is unaffected. |
| `qa-browser needs Node 22 or newer` | Run that script with Node 22 (`nvm use`). The viewer itself works on Node 20. |
| Old layout after updating | Reload without the cache (`Ctrl+Shift+R`). |
