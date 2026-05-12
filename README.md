# Riftbound Scanner

Riftbound Scanner is an independent Windows desktop card scanning and collection
tool for Riftbound TCG. It uses local ONNX detector files, local card artwork
fingerprints, Tauri WebView storage, and Tauri desktop packaging.

This project is maintained by Teme1999. It is not affiliated with, endorsed by,
sponsored by, or connected to Riot Games or the upstream project maintainer.
Required legal and trademark notices are in [NOTICE.md](NOTICE.md).

## Features

- Camera scanning with manual and auto-scan workflows.
- Image upload scanning for single cards or larger photos.
- Local pending queue, collection management, and CSV export.
- Local card matching from generated `card-hashes.json` fingerprints.
- Optional price cache import from the community Riftbound prices CSV.
- Windows desktop app and installers through Tauri.

## Runtime Behavior

The production app is the Windows Tauri desktop build. Card detection, card
matching, collection data, and price cache storage run on the user's device.

The desktop app performs network requests for these update paths:

- Price update fetches `cards.csv` from `cristian-bravo/riftbound-prices`.
- Price update fetches current exchange rates from the European Central Bank.
- App update checks read the signed GitHub Release updater feed and download the
  selected signed Windows updater artifact when the user installs an update.
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
- Rust 1.77.2 or newer for Tauri builds.
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

Run the Vite browser build for frontend debugging:

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

Build the frontend assets for Tauri and browser smoke testing:

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
- builds the Windows MSI and NSIS setup executable
- signs Tauri updater artifacts with the configured updater private key
- renames installers and updater artifacts to use the `releaseVersion` label
- creates `latest.json` for the in-app updater endpoint
- creates a GitHub Release tagged `v<releaseVersion>` and uploads the
  installers, updater artifacts, signatures, and `latest.json`

### One-time updater signing setup

The updater public key is committed in `src-tauri/tauri.conf.json`. The matching
private key must stay outside git and be stored as a GitHub Actions secret.

The local private key should be kept outside the repository, for example:

```text
%USERPROFILE%\.tauri\riftbound-scanner-updater.key
```

Keep the matching password outside the repository too, for example:

```text
%USERPROFILE%\.tauri\riftbound-scanner-updater.key.password.txt
```

Add the full contents of those files to the repository secrets
`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

For local signed builds, load both values before building:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$env:USERPROFILE\.tauri\riftbound-scanner-updater.key" -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content "$env:USERPROFILE\.tauri\riftbound-scanner-updater.key.password.txt" -Raw).Trim()
npm run desktop:build
```

Do not rotate the updater key casually. Existing installed apps can only trust
updates signed by the private key that matches the public key embedded in their
current build.

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
4. Set `src-tauri/tauri.conf.json.bundle.windows.wix.version` to the MSI-safe numeric form, for example `26.5.10.1`.
5. Commit and push to `main`.
6. Wait for the `Release` workflow to finish.
7. Download the generated installer from the GitHub Release page.

Installed desktop builds also use:

```text
https://github.com/Teme1999/Riftbound-Card-Scanner/releases/latest/download/latest.json
```

for in-app update checks.

The intended release numbering scheme is:

- first release on a date: `YYYY.MM.DD.1`
- second release on the same date: `YYYY.MM.DD.2`

The Tauri, npm, and Windows MSI build still use a constrained semver internally, so those same examples map to:

- `YY.M.D-1`
- `YY.M.D-2`

The WiX MSI version must stay numeric, so those examples also map to:

- `YY.M.D.1`
- `YY.M.D.2`

## Production Notes

- The Windows Tauri desktop app is the production target; the browser build is
  kept for development and debugging.
- `npm run build` and `npm run desktop:build` fail early if runtime assets are
  missing.
- Release builds produce both a standard `.msi` and a friendlier NSIS setup
  `.exe`.
- The desktop shell disables the global Tauri object and uses explicit Tauri v2
  API imports.
- The Tauri CSP allows local app assets, the GitHub updater endpoint, and the
  two explicit price update endpoints.
- The in-app retraining placeholder has been removed. Run the model scripts
  directly, then rebuild/reload the app.
- `src-tauri/target/`, `dist/`, `public/cards/`, `public/models/`, and
  `public/card-hashes.json` are generated outputs.
- Training helper images under `model/textures/` and `model/distractors/` are
  source-tree aids for synthetic training only. They are not bundled into the
  installer/runtime asset set, and their provenance should be verified before
  redistributing those helper assets.
- Unsigned Windows builds can still trigger SmartScreen or "unknown publisher"
  warnings. That is only fixed by code signing the release artifacts.

## License

This project is distributed under the MIT License. See [LICENSE](LICENSE).
Upstream attribution and Riot/trademark notices are preserved in
[NOTICE.md](NOTICE.md).
