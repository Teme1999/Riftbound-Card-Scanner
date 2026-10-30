# Release notes: 2026.10.30.1

Application and Windows MSI version: `26.10.3001`.

## Scanner changes

- Automatic recognition can use a strong, unique illustration match from two fresh camera frames without waiting for text recognition. Ambiguous printings still require text evidence.
- Alternate-art runes compare their full illustration against all known family printings, including sets hidden by the current filter. Shared artwork requires independent name and set readings; ambiguous same-set printings require the full collector code.
- A guarded fallback supports borderless cards missed by the normal detector threshold. Coarse color similarity alone cannot authorize those proposals.
- Perspective correction and English text verification are enabled by default. OCR workers and language data are bundled for offline use.
- Normal settings show scanning guidance instead of a similarity slider or experimental feature switches. The auto-scan button displays its state.
- A separate Scan overlay control shows the tracked card outline, thumbnail, name and verification status. It defaults to ON, remembers the preference and clears stale previews without enabling debug capture or changing auto-scan.
- Debug overlays, image exports, session recording and model-comparison controls are development-only. Production ignores stored debug preferences and excludes native diagnostic commands.

## Updating and stored data

The application identifier, MSI upgrade code, updater public key and feed endpoint remain unchanged. Collection, pending cards, settings and downloaded card data stay in the existing Windows user profile. No database migration is required.

Release packaging requires signed installer artifacts matching the current application version. Older signed installers in the build folder cannot be relabeled as a newer release. The release workflow supplies the signing secret and generates the updater manifest.

## Pre-release checks

Run `npm run check` and the Python card-pipeline tests documented in the README. The public tests use synthetic inputs and generated images; private camera material and local replay tools are excluded from Git and are not required by CI.

Before publishing, also check physical-camera recognition in different lighting and angles, installed-app startup without network access, and an upgrade with an existing collection. Automated checks and synthetic images do not establish camera accuracy or locking speed.
