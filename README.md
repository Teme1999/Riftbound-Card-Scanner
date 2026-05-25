# Riftbound Scanner

Riftbound Scanner is an unofficial Windows desktop app for scanning Riftbound
cards, building a collection/export list, and keeping card data local on your
machine.

It started as a fork of the original Riftbound scanner project and has been
rebuilt into a local-first Tauri desktop app with bundled card matching,
detector assets, installer releases, and in-app update support.

This project is maintained by Teme1999. It is not affiliated with, endorsed by,
sponsored by, or connected to Riot Games or the upstream project maintainer.
Legal, trademark, and upstream notices are in [NOTICE.md](NOTICE.md).

## Download

Download the latest Windows installer from:

https://github.com/Teme1999/Riftbound-Card-Scanner/releases/latest

Use the `.msi` installer. The NSIS `.exe` installer target is currently disabled
because the MSI path is the verified production installer.

Windows may show SmartScreen or "unknown publisher" warnings because the app is
not code-signed with a commercial Windows signing certificate yet.

## What It Does

- Scan cards with a webcam.
- Scan uploaded card images or larger photos.
- Review detected cards in a pending queue before adding them.
- Build and edit a collection/export list.
- Export CSV files.
- Match cards locally from generated card fingerprints.
- Use bundled local ONNX detector files.
- Optionally import community price data.
- Refresh the card database from inside the desktop app.
- Check for app updates from inside the desktop app.

## Local-First Behavior

Card detection, card matching, collection data, and price cache storage run on
your device.

The desktop app uses network requests for these actions:

- Price update fetches `cards.csv` from `cristian-bravo/riftbound-prices`.
- Price update fetches current exchange rates from the European Central Bank.
- App update checks read the signed GitHub Release updater feed.
- App update install downloads the selected signed Windows updater artifact.

The model/card asset generation scripts can also fetch Riot card gallery data,
but only when run manually from `model/`.

## Project Status

This is an independent fan tool and still evolving. The Windows Tauri desktop
app is the only supported runtime. Development uses the same desktop shell via
`npm run desktop:dev`.

The app uses AI-assisted development in places, with human review and testing.
The maintainer has a CS background, but this project also includes some new
ground for the codebase, especially around local model packaging and desktop
release automation. Bug reports and code review are welcome.

## Contributing

Contributions are welcome, especially around:

- scanner accuracy and camera edge cases
- card data cleanup
- collection/export workflows
- UI polish
- Windows installer and updater reliability
- model training and generated asset pipeline
- documentation and testing

Open an issue or pull request here:

https://github.com/Teme1999/Riftbound-Card-Scanner

### Branching and Commits

Use this branch model for project work:

- `main` is the stable release branch. Releases are cut from `main`.
- `develop` is the integration branch for work that is ready to test together.
- `feature/<short-name>` is for new functionality.
- `fix/<short-name>` is for bug fixes.

Examples:

```text
feature/card-search-filters
feature/settings-update-panel
fix/msi-release-metadata
fix/camera-restart-loop
```

Recommended flow:

1. Create your branch from `develop`.
2. Keep the branch focused on one feature or fix.
3. Commit source changes only. Do not commit generated assets, build output,
   local signing keys, `.env` files, or private runtime data.
4. Run the relevant checks before opening a pull request:

```bash
npm run check
npm audit --omit=dev --audit-level=moderate
```

5. Open the pull request into `develop`.
6. Merge `develop` into `main` only when preparing a release.

Commit messages should be short and specific. Prefer messages like:

```text
Add update status panel
Fix camera device restart handling
Document release signing setup
```

## For Developers

### Repository Layout

```text
riftbound-scanner/
|-- src/                 # React UI, scanner hooks, matcher, runtime helpers
|-- public/              # App images plus ignored generated runtime assets
|-- model/               # Scraper, synthetic data generator, training scripts
|-- scripts/             # Build and release checks
`-- src-tauri/           # Tauri desktop shell
```

### Prerequisites

- Node.js 18 or newer.
- npm.
- Rust 1.77.2 or newer for Tauri builds.
- Python 3.10+ for card asset generation and detector retraining.
- Optional: CUDA-capable GPU for faster local training.

### Install Development Dependencies

```bash
npm install
cd model
python -m pip install -r requirements.txt
```

The Python environment is only needed for scraping, dataset generation, and
training. The desktop app itself is built with Node, Rust, and Tauri.

### Generated Runtime Assets

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

### Card and Model Workflow

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

### Development Commands

Run the desktop app in development mode:

```bash
npm run desktop:dev
```

This starts Tauri with the local Vite dev server behind it, so debugging still
uses a live frontend build inside the Windows app window.

Run release prechecks:

```bash
npm run check
npm audit --omit=dev --audit-level=moderate
```

Build the Windows desktop installer:

```bash
npm run desktop:build
```

## Release Maintenance

The repository includes a GitHub Actions workflow at
`.github/workflows/release.yml`.

When a commit lands on `main`, the workflow:

- reads the internal semver from `package.json`
- reads the human release label from `package.json.releaseVersion`
- verifies `src-tauri/tauri.conf.json` uses the same internal semver
- skips the run if release tag `v<releaseVersion>` already exists
- builds the Windows MSI installer
- signs Tauri updater artifacts with the configured updater private key
- renames the installer and updater artifact to use the `releaseVersion` label
- creates `latest.json` for the in-app updater endpoint
- creates a GitHub Release tagged `v<releaseVersion>` and uploads the MSI
  installer, updater signature, and `latest.json`

### One-Time Updater Signing Setup

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

### One-Time Runtime Asset Bootstrap

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

### Normal Release Flow

1. Set `package.json.version` to semver, for example `26.5.13-1`.
2. Set `package.json.releaseVersion` to the GitHub release label, for example `2026.05.13.1`.
3. Set `src-tauri/tauri.conf.json.version` to the same semver from step 1.
4. Set `src-tauri/tauri.conf.json.bundle.windows.wix.version` to the MSI-safe numeric form, for example `26.5.13.1`.
5. Commit and push to `main`.
6. Wait for the `Release` workflow to finish.
7. Download the generated MSI installer from the GitHub Release page.

Installed desktop builds also use:

```text
https://github.com/Teme1999/Riftbound-Card-Scanner/releases/latest/download/latest.json
```

for in-app update checks.

The intended release numbering scheme is:

- first release on a date: `YYYY.MM.DD.1`
- second release on the same date: `YYYY.MM.DD.2`

The Tauri, npm, and Windows MSI build still use a constrained semver internally,
so those same examples map to:

- `YY.M.D-1`
- `YY.M.D-2`

The WiX MSI version must stay numeric, so those examples also map to:

- `YY.M.D.1`
- `YY.M.D.2`

## Production Notes

- The Windows Tauri desktop app is the only supported runtime.
- `npm run desktop:build` fails early if runtime assets are missing.
- Release builds publish the Windows `.msi` installer.
- The NSIS `.exe` target is disabled because the MSI path is the verified
  production installer.
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
