# Riftbound Scanner

<div align="center">
  <img src="public/images/riftboundscanner.png" alt="Riftbound Scanner logo" width="180" />

  <h2>Scan your cards. Build your collection.</h2>

  <p>
    A local-first Windows desktop app for recognizing Riftbound cards,
    reviewing your pulls, tracking prices, and exporting a collection you can actually use.
  </p>

  <p>
    <a href="https://github.com/Teme1999/Riftbound-Card-Scanner/releases/latest"><strong>Download the latest Windows release</strong></a>
    -
    <a href="https://github.com/Teme1999/Riftbound-Card-Scanner/issues">Report an issue</a>
  </p>
</div>

![Riftbound Scanner product preview](docs/images/app-showcase.svg)

## Turn a pile of cards into a collection

Riftbound Scanner is built for the moment after opening packs: point a camera at a card, confirm the match, and keep moving. Recognition, matching, collection data, and the local price cache stay on your machine.

It is designed to feel less like a spreadsheet and more like a dedicated collection companion:

- Scan cards from a webcam or upload a photo of a whole spread.
- Review detections in a pending queue before they enter your collection.
- See confidence, set information, card details, variants, and cached prices together.
- Edit quantity, condition, language, foil, and promo status.
- Export a clean CSV for the workflow or marketplace of your choice.
- Refresh card data from inside the app when a new set arrives.

## How it works

![Riftbound Scanner workflow](docs/images/workflow.svg)

### 1. Capture

Use the camera for rapid scanning, or drop in a larger photo when you are sorting a stack.

### 2. Identify

The bundled detector finds card-shaped regions, then the local matcher compares the artwork against the card database.

### 3. Review

Every result can be checked in the pending queue before it affects your collection. Adjust duplicates and variants as you go.

### 4. Export

Move confirmed cards into your collection and export them as CSV when you are ready.

## Why collectors keep it open

| Feature | What it feels like |
| --- | --- |
| Camera scanning | Scan cards continuously without typing names |
| Photo import | Process a table spread or binder page in one pass |
| Pending review | Keep uncertain matches out of the final collection |
| Local matching | Recognition works on-device after the app is installed |
| Collection tools | Quantities, foil, promo, condition, and language in one place |
| Price snapshots | Optional community price data with selectable display currency |
| Set updates | Add missing sets without rebuilding every card you already have |
| CSV export | Take your collection into the rest of your workflow |

## Made to stay local

The desktop app runs card detection, card matching, collection storage, and price-cache storage locally. There is no account or cloud collection required.

Network access is limited to explicit update actions:

- Card database updates fetch the Riot card gallery when you request them.
- Price updates fetch the community <code>cards.csv</code> snapshot and ECB exchange rates.
- App update checks and downloads use the signed GitHub Release updater feed.

Price data is a useful snapshot, not a promise of a live sale price. Always verify important trades independently.

## Download

The supported runtime is the Windows desktop app. Download the latest <code>.msi</code> installer from the [GitHub Releases page](https://github.com/Teme1999/Riftbound-Card-Scanner/releases/latest).

Windows may show a SmartScreen or "unknown publisher" warning because releases are not currently signed with a commercial Windows certificate.

## Keep it current

After installing:

1. Open **Settings**.
2. Use **Update Card Database** when a new set is available.
3. Use **Update Price Data** when you want a fresh community price snapshot.
4. Pick your display currency and continue scanning.

The updater now checks which set data is already present and focuses work on missing sets, so routine set updates stay lightweight.

## Independent fan project

Riftbound Scanner is maintained by Teme1999. It is unofficial and is not affiliated with, endorsed by, sponsored by, or connected to Riot Games or the upstream project maintainer.

Riftbound, League of Legends, and related marks belong to their respective owners. See [NOTICE.md](NOTICE.md) for legal, trademark, and upstream attribution details.

## For developers

<details>
<summary>Build, run, contribute, and release the app</summary>

### Repository layout

~~~text
riftbound-scanner/
|-- src/                 # React UI, scanner hooks, matcher, runtime helpers
|-- public/              # App images plus generated runtime assets
|-- model/               # Scraper, synthetic data generator, training scripts
|-- scripts/             # Build and release checks
+-- src-tauri/           # Tauri desktop shell
~~~

### Prerequisites

- Node.js 18 or newer
- npm
- Rust 1.77.2 or newer
- Python 3.10+ for asset generation and detector retraining
- Optional: CUDA-capable GPU for faster training

### Install and run

~~~bash
npm install
npm run desktop:dev
~~~

Python dependencies are only needed for scraping, dataset generation, and training:

~~~bash
cd model
python -m pip install -r requirements.txt
~~~

### Build checks

~~~bash
npm run check
npm audit --omit=dev --audit-level=moderate
npm run desktop:build
~~~

Production builds require these generated assets:

- <code>public/card-hashes.json</code>
- <code>public/cards/*.webp</code>
- <code>public/models/yolo11n-obb-riftbound.onnx</code>
- <code>public/models/yolo11n-obb-riftbound-q8.onnx</code>

Run <code>npm run check:assets</code> to verify them. Generate card metadata and matcher assets with:

~~~bash
cd model
python cards_scraper.py
~~~

### Contributing

Contributions are welcome around scanner accuracy, card data cleanup, collection/export workflows, UI polish, Windows reliability, model training, documentation, and testing.

Use focused branches such as <code>feature/card-search-filters</code> or <code>fix/camera-restart-loop</code>. Open pull requests into <code>develop</code>; releases are cut from <code>main</code>.

### Releases

The release workflow at <code>.github/workflows/release.yml</code> builds the Windows MSI, signs updater artifacts, publishes <code>latest.json</code>, and creates the GitHub Release. Runtime assets are distributed separately because generated card images, models, and hashes are not tracked in git.

The updater signing private key must remain outside the repository. See the workflow and release configuration before preparing a signed build.

</details>

## License

This project is distributed under the MIT License. See [LICENSE](LICENSE).
