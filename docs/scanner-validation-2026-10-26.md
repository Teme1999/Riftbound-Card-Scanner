# Card data and scanner regression snapshot, 2026-10-26

The reference data was refreshed from the [official Riftbound gallery](https://playriftbound.com/en-us/card-gallery/). These are the cards present in that gallery at the time of the update; this is not a claim that every future reveal is available.

| Set | Cards |
| --- | ---: |
| Origins (OGN) | 352 |
| Proving Grounds (OGS) | 24 |
| Spiritforged (SFD) | 288 |
| Unleashed (UNL) | 288 |
| Radiance (RAD) | 219 |
| Vendetta (VEN) | 237 |
| Total | 1,408 |

The update added 458 IDs (219 RAD, 237 VEN, two UNL), retained all previous 950 IDs, and completed without missing image downloads or skipped hashes. The generated SQLite metadata, WebP images, and 16×16 RGB feature database were refreshed. Repeating image synchronization required zero downloads. The previous matcher database and SQLite metadata were backed up under `src-tauri/target/card-data-update/backup/` before the update. These generated assets and local evidence files are ignored by Git.

## Browser regression

`tests/fixtures/card-validation.html` uses the actual browser canvas matcher, quality gate, and quantized ONNX detector. It does not open a camera or write to the user's imported database or collection.

All 1,408 references were decoded and drawn at 360×504. For the 456 RAD/VEN cards, six additional scenarios covered dim light with deterministic noise, a warm color cast, downscaling to 80×112, severe darkness, a half-card shadow, and a white glare patch. These are transformed reference images, not independent camera photographs. Each query was compared against the full database, without a set filter.

| Input | Cases | Correct first candidate | Accepted | Wrong accepted | Quality rejected |
| --- | ---: | ---: | ---: | ---: | ---: |
| Clean references | 1,408 | 1,389 | 1,224 | 0 | 0 |
| Dim light + noise | 456 | 447 | 403 | 0 | 0 |
| Warm color cast | 456 | 448 | 405 | 0 | 0 |
| Low resolution | 456 | 447 | 408 | 0 | 0 |
| Severe darkness | 456 | 444 | 0 | 0 | 456 |
| Partial shadow | 456 | 382 | 74 | 0 | 0 |
| Glare | 456 | 403 | 78 | 0 | 0 |
| ONNX detection + matching | 72 | 69 | 65 | 0 | 0 |

Acceptance here means that the single observation satisfies the shared similarity, candidate-gap and quality requirements. Live auto-scan additionally requires independent stable observations. A correct first candidate can remain unaccepted when the gap to the next candidate is too small. Zero wrong accepted results in this finite synthetic sample does not establish a real-camera false-positive rate. Strong shadow and glare still produce many unaccepted results.

## Crop orientation regression

The detector sample evenly selected 12 cards from each of RAD and VEN, using clean, dim/noisy and low-resolution inputs. Cards were placed on a flat gray 480×640 canvas and passed through the camera ROI path, including its context-scale retry.

Before the fix, 69 of the 72 inputs produced a detection, but none produced the correct first match: the OBB model represented the long edge as width, leaving crops sideways. Normalizing those equivalent box axes to portrait yielded 69 correct first matches and 65 accepted observations, with zero wrong accepted observations on the same inputs. A regression test covers both axis representations.

`rad-r05a` (Chaos Rune, RAD-R05a) remained undetected in all three versions. Its artwork differs substantially from the framed card layout. This remains a detector limitation; the crop fix does not resolve it. Upside-down orientation, perspective correction and real-camera validation also remain outside this regression's coverage.

## Reproduction

1. Restore the ignored model assets and refresh cards with `python model/cards_scraper.py` using the model Python environment.
2. Run `npm run check`. This includes frontend regressions, card-asset completeness/coverage, the UI production build, Rust checks and Rust tests.
3. Run `python -m unittest discover -s tests -p test_cards_scraper.py` using the model environment.
4. Start `npm run tauri:dev-server`, open `/tests/fixtures/card-validation.html`, and select **Run scanner checks**. The optional `?detectorOnly=1` query runs the smaller detector diagnostic. Avoid rebuilding the app during a browser run because development hot reload can reset the page.

Local JSON evidence for this run is in `src-tauri/target/card-data-update/update-report.json`, `browser-before-crop-fix.json`, `browser-detector-after-fix.json`, and `browser-validation.json`.
