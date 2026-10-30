# Scanner development and validation

Perspective correction and English text verification are enabled by default. Normal settings have no similarity slider or feature switches. Debug overlays, capture exports, session recording and model-comparison controls are available only in development builds. Production ignores stored debug preferences and excludes the native diagnostic commands.

## Recognition pipeline

`useCamera` captures the visible guide region at native resolution and prefers clearer recent frames. Copies of the same video frame cannot count as independent evidence. Motion, a camera or filter change, and database revisions invalidate unfinished evidence.

`yoloDetector` keeps its normal confidence threshold of `.75`. When no primary detection is inside the guide, camera recognition can try card-shaped proposals starting at `.25`. A proposal retains its actual confidence and requires independently verified geometry or text evidence; coarse artwork similarity alone cannot authorize it. Upload review retains its normal detector behavior.

`cardRecognition` shares crop selection and acceptance between camera recognition and photo review. It compares the original portrait crop with supported perspective corrections. `cardPerspective` uses bounded Sobel/RANSAC edge searches and validates the quadrilateral before homography resampling. Uncertain geometry falls back to the original crop; conflicting strong interpretations require text or manual review.

`cardVisualVerifier` compares illustration keypoints and projective geometry with the offline OpenCV worker. Shared frames, symbols and text strips are excluded. A strong unique identity needs two fresh source frames before automatic acceptance. Printing rivals with the same name or near-identical reference art are checked across the full database, including hidden sets. Actual similarity scores and candidate gaps are never increased to make a decision pass.

Unique alternate rune illustrations use this visual path after all known family printings have been compared. Shared rune illustrations require two independent high-confidence readings of the complete name and set code, with geometry distinguishing that set's printing. Ambiguous same-set printings still require the full collector code. Registered pixel correlation supports the rune name/set path and is not standalone acceptance evidence.

`cardTextReader` uses pinned Tesseract.js 7.0.0 and English integerized language data. Worker, WASM and language files are bundled for offline use. Name and collector tokens require confidence 90, which is a heuristic rather than a correctness probability. Both fields come from the same source frame. Alternatives cannot combine partial fields or count as independent camera frames. Full codes retain suffixes, stars, prefixes and readable denominators; missing characters are not inferred.

`cardTextVerification` runs at most one OCR job plus the latest waiting observation, with a bounded reading deadline. Strong unique visual evidence can qualify without waiting for OCR. Text may corroborate supported artwork below the coarse similarity threshold; trusted contradictions and unusable quality block automatic acceptance. Unreadable text can fall back only to independently eligible artwork. Worker failures fail closed or return to the original path as appropriate.

`scanAcceptance` owns the shared evidence rules; `useAutoScan` requires independent sources and preserves the consecutive same-card lock. A different card must be accepted before that ID can be automatically added again. Uncertain manual scans offer explicit candidate review without automatically adding the candidate.

## Development captures

Run `npm run desktop:dev` and enable **Debug overlay**. This runs real auto-scan and adds accepted cards to Pending. Each acceptance saves the exact native ROI, an annotated PNG and JSON evidence under `%LOCALAPPDATA%\Teme1999\RiftboundScanner\data\debug-scans`. Capture failure retains the queued card and supports capture-only retry. A bounded background queue prevents unlimited retained frames.

**Save native frame** explicitly saves the current ROI and a JSON sidecar under `data\native-frames`, including rejected observations. Its source can differ from an earlier detection; frame IDs distinguish them. Browser previews use an explicit download fallback.

**Start scan recording** streams camera video without audio and a synchronized `.jsonl` timeline to `data\debug-recordings`. Recording ends when stopped, after five minutes, when the camera/debug view closes, or when scan settings change. A supported desktop WebView is required. Start with an empty view and remove the final card before stopping. Recording adds encoding overhead; measure speed with recording off too.

Session-only **Diagnostic overrides** independently disable perspective or text verification for comparisons. Both reset to ON when debug closes or the app restarts. Release builds do not save camera images or video automatically.

## Reproducible checks

Install the runtime card/model assets described in the README, then run:

```sh
npm run check
python -m unittest discover -s tests -p test_cards_scraper.py
```

Use the Python environment containing the model dependencies for the second command. `npm run check` runs frontend and installed-asset regressions, builds the UI, and checks/tests the Rust shell. Real OpenCV tests also exercise the CSP adapter with JavaScript code generation disabled. These checks do not measure physical-camera accuracy or locking speed.

The public test suite uses generated data and synthetic reference values. The offline OCR check renders its own text in memory, and native export tests generate their own PNG bytes. Camera captures, capture-derived descriptors, OCR case recordings and personal replay tools are not required by the public checks.

Keep local investigation material under ignored `tests/local/`, and generated captures, browser profiles and reports under ignored `src-tauri/target/`. Neither directory belongs in a public commit. Local case tests must remain optional and independent of `npm run check`.

See [release notes](release-2026.10.30.1.md) for the current changes and pre-release checks. Synthetic transformations and finite negative tests do not establish physical-camera accuracy or a general false-positive rate.
