# Riftbound Scanner

Riftbound Scanner is an independent, desktop-first card scanning and collection
tool for Riftbound TCG. It uses local ONNX detector files, local card artwork
fingerprints, browser storage, and optional Tauri desktop packaging.

This fork is maintained by Teme1999. It is not affiliated with, endorsed by,
sponsored by, or connected to Riot Games or the upstream project maintainer.
Required legal notices are in [NOTICE.md](NOTICE.md).

## Features

- Camera scanning with manual and auto-scan workflows.
- Image upload scanning for single cards or larger photos.
- Local pending queue, collection management, and CSV export.
- Local card matching from generated `card-hashes.json` fingerprints.
- Optional price cache import from the community Riftbound prices CSV.
- Windows desktop packaging through Tauri.

## Runtime Behavior

The scanner is local-first. Card detection, card matching, collection data, and
price cache storage run on the user's device.

The app only performs network requests for explicit update actions:

- Price update fetches `cards.csv` from `cristian-bravo/riftbound-prices`.
- Price update fetches current exchange rates from the European Central Bank.
- Model/card asset generation scripts can fetch Riot card gallery data when run
  manually from `model/`.

## Repository Layout

```text
riftbound-scanner/
|-- src/                 # React UI, scanner hooks, matcher, runtime helpers
|-- public/              # App images plus ignored generated runtime assets
|-- model/               # Scraper, synthetic data generator, training scripts
|-- scripts/             # Build and release checks
`-- src-tauri/           # Tauri desktop shell
```

## Prerequisites

- Node.js 18 or newer.
- npm.
- Rust 1.77 or newer for Tauri builds.
- Python 3.10+ for card asset generation and detector retraining.
- Optional: CUDA-capable GPU for faster local training.

## Install

```bash
npm install
cd model
python -m pip install -r requirements.txt
```

The Python environment is only needed for scraping, dataset generation, and
training. The app itself is built with Node and Rust.

## Generated Runtime Assets

Production builds require generated runtime assets, but those assets are not
tracked in git:

- `public/card-hashes.json`
- `public/cards/*.webp`
- `public/models/yolo11n-obb-riftbound.onnx`
- `public/models/yolo11n-obb-riftbound-q8.onnx`

The build preflight checks these files:

```bash
npm run check:assets
```

If the check fails, regenerate or restore the generated assets before building.

## Card and Model Workflow

Generate card metadata, card images, and matcher fingerprints:

```bash
cd model
python cards_scraper.py
```

Generate the synthetic detection dataset:

```bash
python data_creator.py
```

Train and publish ONNX detector exports:

```bash
python train.py --preset accuracy --device auto
```

Export again from an existing local checkpoint:

```bash
python train.py --export-only
```

## Development

Run the browser build:

```bash
npm run dev
```

Run the desktop shell:

```bash
npm run desktop:dev
```

Run release prechecks:

```bash
npm run check
npm audit --omit=dev --audit-level=moderate
```

Build the frontend:

```bash
npm run build
```

Build the Windows desktop installer:

```bash
npm run desktop:build
```

## Automatic Releases

The repository now includes a GitHub Actions workflow at
`.github/workflows/release.yml`.

When a commit lands on `main`, the workflow:

- reads the internal semver from `package.json`
- reads the human release label from `package.json.releaseVersion`
- verifies `src-tauri/tauri.conf.json` uses the same internal semver
- skips the run if release tag `v<releaseVersion>` already exists
- builds the Windows MSI
- renames the uploaded MSI to use the `releaseVersion` label
- creates a GitHub Release tagged `v<releaseVersion>` and uploads the MSI

### One-time runtime asset bootstrap

The release build still needs the ignored runtime assets:

- `public/card-hashes.json`
- `public/cards/*.webp`
- `public/models/yolo11n-obb-riftbound.onnx`
- `public/models/yolo11n-obb-riftbound-q8.onnx`

GitHub-hosted runners do not get those files from git, so the workflow looks
for a GitHub Release tagged `runtime-assets` and downloads an asset named
`runtime-assets.zip` when the files are missing.

Create that release once from a machine that already has the generated assets:

```powershell
Compress-Archive -Path public/card-hashes.json, public/cards, public/models -DestinationPath runtime-assets.zip -Force
```

Then create a GitHub Release with:

- tag: `runtime-assets`
- asset: `runtime-assets.zip`

After that, the normal release flow is:

1. Set `package.json.version` to semver, for example `26.5.10-1`.
2. Set `package.json.releaseVersion` to the GitHub release label, for example `2026.05.10.1`.
3. Set `src-tauri/tauri.conf.json.version` to the same semver from step 1.
4. Commit and push to `main`.
5. Wait for the `Release` workflow to finish.
6. Download the generated MSI from the GitHub Release page.

The intended release numbering scheme is:

- first release on a date: `YYYY.MM.DD.1`
- second release on the same date: `YYYY.MM.DD.2`

The Tauri, npm, and Windows MSI build still use a constrained semver internally, so those same examples map to:

- `YY.M.D-1`
- `YY.M.D-2`

## Production Notes

- `npm run build` and `npm run desktop:build` fail early if runtime assets are
  missing.
- The desktop shell disables the global Tauri object and uses explicit Tauri v2
  API imports.
- The Tauri CSP allows local app assets plus the two explicit price update
  endpoints.
- The in-app retraining placeholder has been removed. Run the model scripts
  directly, then rebuild/reload the app.
- `src-tauri/target/`, `dist/`, `public/cards/`, `public/models/`, and
  `public/card-hashes.json` are generated outputs.

## License

This fork is distributed under a source-available non-commercial license. See
[LICENSE](LICENSE). Upstream MIT and third-party notices are preserved in
[NOTICE.md](NOTICE.md).
