# Suave Negotiator false rejection, 2026-10-27

The user supplied a 2008×1123 screenshot of the camera preview holding Suave Negotiator, RAD-099/167. The scanner tracked the card but never accepted it. The screenshot includes the application's drawn overlays and is not an original webcam frame. The full screenshot is retained only in ignored local diagnostic files; it is not included in the repository.

## Cause and change

The real quantized ONNX detector found the card at approximately 94.8% detection confidence. The existing de-rotated crop ranked the correct card first. However, positive RGB grids have high cosine similarity even for unrelated artwork with similar colors. The margin to the next candidate was too small to pass the existing five-percentage-point requirement. The image quality gate did not reject this crop.

The matcher now combines 60% RGB cosine similarity with 40% normalized correlation after subtracting each channel's mean. This uses the existing feature database and adds no model downloads or dependencies. Channel statistics are cached when the database is loaded. Mean-centered correlation follows the approach described in [OpenCV's template-matching documentation](https://docs.opencv.org/4.12.0/de/da9/tutorial_template_matching.html). This implementation compares the fixed artwork grids; it does not slide templates over the camera frame.

Both camera identification and uploaded-photo review now call the same ranking implementation. Debug view shows the best candidate even when it is rejected, explicitly labels it unaccepted, and displays the score, candidate gap, required thresholds and score components.

The existing similarity setting, quality gate, five-point gap, independent-frame confirmations and consecutive-duplicate lock still apply. No acceptance threshold was lowered. Scores are heuristic similarities, not calibrated probabilities.

## Screenshot reproduction

The screenshot's camera viewport and scanning region were reconstructed, passed through the actual quantized ONNX detector using Python ONNX Runtime, and cropped using the detector's oriented box. Artwork features were extracted using OpenCV histogram equalization and area resampling. These features were then passed through the **real JavaScript matcher and quality analysis**. OpenCV and browser canvas resampling differ, so this is not a browser end-to-end or live-camera result.

| Same detector crop, all 1,408 candidate cards | Previous color score | New combined score |
| --- | ---: | ---: |
| Correct first candidate | RAD-099/167 | RAD-099/167 |
| Artwork score | 96.97% | 91.67% |
| Gap to second candidate | 3.49 pp | 9.81 pp |
| Passes default 90% score / 5 pp gap | No | Yes |

The lower combined score reflects the changed metric; the useful improvement is that unrelated artwork is separated more clearly. Approximate manual corner rectification alone still left the previous gap below five points. Those manually supplied corners were diagnostic only; automatic perspective rectification was not implemented.

`tests/fixtures/suave-query-features.json` contains only the 16×16 artwork feature grid extracted from the detector crop. The installed-asset regression compares it against the full database, reproduces the old rejection, verifies the new acceptance, and checks that a stricter user threshold still rejects it.

## Wider regression

The same real JavaScript ranking and quality analysis were run against OpenCV-preprocessed reference images: all 1,408 clean cards and six perturbations of all 456 RAD/VEN cards. Each query searched the full database. Reference images were resized to 360×504. Perturbations included 35% brightness with seeded noise, a warm RGB cast, downscaling to 80×112, 2.5% brightness, a half-card shadow and a white ellipse over the artwork.

| Input | Cases | Correct first candidate | Accepted | Wrong accepted | Quality rejected |
| --- | ---: | ---: | ---: | ---: | ---: |
| Clean | 1,408 | 1,405 | 1,294 | 0 | 0 |
| Dim + noise | 456 | 449 | 423 | 0 | 1 |
| Warm | 456 | 452 | 424 | 0 | 0 |
| Low resolution | 456 | 449 | 424 | 0 | 0 |
| Severe darkness | 456 | 448 | 0 | 0 | 456 |
| Partial shadow | 456 | 324 | 65 | 0 | 0 |
| Glare | 456 | 351 | 64 | 0 | 0 |

On these same preprocessed queries, the previous raw-color metric accepted 1,223 clean inputs, 403 dim inputs before quality gating, 404 warm inputs, 405 low-resolution inputs, 33 shadow inputs and 35 glare inputs. This comparison is separate from the browser-canvas measurements in the [2026-10-26 snapshot](scanner-validation-2026-10-26.md); the resampling methods and perturbation implementations are different.

There were **4,144 synthetic reference cases**, plus five targeted crops (the user screenshot's detector crop, manually rectified crop, and three synthetic angle crops). None produced a wrong accepted result. Two strongly tilted synthetic crops remained unaccepted. Partial shadow and glare still cause many missed matches, and first-candidate accuracy did not improve in every scenario. This finite sample does not establish real-camera accuracy or performance.

## Checks and remaining work

- `npm test`: 91 frontend regression tests passed, including spatial discrimination, lighting offsets, empty/invalid inputs, identical-artwork ambiguity, shared ranking, manual search, debug labels and the existing consecutive-duplicate lock.
- `npm run test:cards`: two installed-data tests passed, including the screenshot feature regression against all 1,408 cards.
- `npm run tauri:build-ui`: production frontend build passed. Rust code was not changed or rebuilt for this fix.
- The existing browser fixture `tests/fixtures/card-validation.html` automatically uses the new matcher, but a browser rerun and a live Develoop camera retest are still required. No browser control surface was available during this run.

Perspective rectification, OCR of the card name and collector code, and detector retraining remain separate follow-up work. In particular, the tiny footer in this screenshot may not contain enough pixels for reliable OCR; it should support identification rather than bypass ambiguous-artwork safeguards.

Ignored local evidence: `src-tauri/target/rad099-angle-audit/user-baseline.json`, `matching-python-report.json`, `matching-js-report.json`, detector crops, feature vectors and quality samples.
