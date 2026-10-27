# Updates, pricing and storage audit — 2026-10-26

## Application updates

The existing Tauri updater, public key, Windows capability and MSI upgrade code were present. The public latest release was `v2026.07.31.1`. Its `latest.json` advertised `Riftbound%20Scanner_2026.07.31.1_x64_en-US.msi`, but the uploaded asset is named `Riftbound.Scanner_2026.07.31.1_x64_en-US.msi`. Both Windows platform links returned HTTP 404. The corrected artifact URL returned HTTP 200 with a 123,633,664-byte package. The feed signature's key ID matches the configured public key; this metadata check is not cryptographic verification of the package bytes.

A repaired copy of that existing feed is prepared at `src-tauri/target/update-price-audit/repaired-feed/latest.json`, with the original at `published-latest.json` beside it. Only the URLs change; the package, version and signatures remain identical. **The public feed was not modified and a new application release was not published by this audit.** The prepared repair and the local code changes still need publication to reach installed users.

Local changes:

- The release workflow now generates GitHub-safe ASCII artifact names and checks version agreement, target URLs, file existence, signature sidecars and signing-key identity before publication. Tauri remains responsible for cryptographically checking the downloaded installer before installation.
- Release app/MSI versions now use `YY.month.(day*100+index)`, with index 1–99. For example, the second release on October 26 is `26.10.2602`, while its human label is `2026.10.26.2`. Windows Installer compares only the first three version fields; the former fourth-field-only daily increment was insufficient. [Microsoft ProductVersion documentation](https://learn.microsoft.com/windows/win32/msi/productversion).
- The workflow restores detector assets, refreshes bundled card data, runs app/card regressions, then builds and validates release artifacts. It no longer depends on an old runtime-assets archive for fresh card coverage.
- Runtime installation downloads first, stops capture and flushes the latest collection, pending rows and preferences before calling install. Failed persistence stops installation. This also covers edits made during the download. [Tauri documents automatic process exit during Windows installation](https://v2.tauri.app/plugin/updater/).
- Update checks and install controls remain accessible on the scanner-asset error screen.

No signing private keys or passwords were read or changed. The application identifier, WiX upgrade code and existing data paths remain unchanged. Local unit/build checks do not establish an installed-version-to-installed-version MSI upgrade; that still requires a separately controlled installation test.

## Price accuracy and coverage

The current source is [cristian-bravo/riftbound-prices](https://github.com/cristian-bravo/riftbound-prices), whose scraper collects TCGPlayer data. The downloaded CSV contained 1,590 rows, all carrying source date 2026-10-26. Prices are USD market/listing snapshots, not Cardmarket prices or guaranteed sale prices. Source timestamps have no explicit timezone, so only their calendar date is reported as the snapshot date.

Previously the importer allowed a name match plus either set or collector agreement. This allowed a promotional Flash price to be assigned to the regular Proving Grounds printing. Conversely, many champion names differed between sources, such as gallery `Graves` versus source `Graves, Blasting Through`, and were not priced.

The importer now requires an exact set and collector identity, including letter/star suffixes. `Origins: Proving Grounds` is an explicit alias for the gallery's `Proving Grounds`. Champion subtitles and parenthesized printing labels are normalized only after matching that identity, and the names must remain compatible. Multiple indistinguishable local printings and conflicting source prices are rejected instead of selecting one by row order.

| Set | Priced cards | Local cards |
| --- | ---: | ---: |
| Origins | 311 | 352 |
| Proving Grounds | 19 | 24 |
| Spiritforged | 238 | 288 |
| Unleashed | 244 | 288 |
| Radiance | 189 | 219 |
| Vendetta | 207 | 237 |
| Total | 1,208 | 1,408 |

The former importer priced 859 cards from the same CSV. The updated importer rejects 346 unmatched rows and leaves 18 conflicting card identities unpriced. There are no zero-priced placeholders for missing data, and two-decimal currencies preserve cents above ten units. A failed ECB request retains prior/bundled rates with an explicit fallback label rather than blocking the entire price update. The source date and local import timestamp are shown separately.

These checks establish mapping behavior and source coverage, not independent market-value accuracy. The CSV does not distinguish normal versus foil finish, language or condition for the same printing. Those collection fields therefore do not independently change the estimate. Market price is preferred; positive listing price is a fallback. There is no condition multiplier or inferred foil premium.

## Cardmarket is a viable separate source

Although [Cardmarket is not accepting new API applications](https://help.cardmarket.com/en/cardmarket-api), [its official announcement](https://news.cardmarket.com/en/StarWarsUnlimited/were-making-the-price-guide-and-product-catalogue-available-for-download) makes price guides and product catalogues publicly downloadable, with daily price refreshes.

The official Riftbound files were successfully retrieved without credentials:

- [Price guide](https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_22.json): schema version 1, created `2026-10-26T02:47:34+0100`, 1,862 rows including non-singles. It contains EUR averages, lows, trends, 1/7/30-day averages, and separate foil fields.
- [Singles catalogue](https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_22.json): schema version 1, 1,747 products, each with product ID, expansion ID and name. It does not contain collector numbers. There are 263 repeated `(expansion ID, name)` groups, so a name-only join would confuse printings.

This audit downloaded and inspected these files; it did not wire them into the app or guess product IDs. A reliable EU-price integration should first establish a reviewed `local card ID → Cardmarket product ID` mapping, preserve finish-specific prices, identify the chosen price metric and source timestamp, and convert from EUR when another display currency is selected. Language, condition and shipping still are not individual offers in the public guide. Keep independent sources labelled rather than silently substituting an exchange-converted TCGPlayer value for a Cardmarket value.

## Storage decision

| Data | Current location |
| --- | --- |
| Executable and bundled detector/card assets | Installed application |
| Downloaded card images | `%LOCALAPPDATA%\Teme1999\RiftboundScanner\data\cards` |
| Collection, pending rows and preferences | WebView localStorage |
| Matcher metadata/vectors and price snapshot | WebView IndexedDB |
| WebView profile | `%LOCALAPPDATA%\com.teme1999.riftboundscanner\EBWebView` |

The profile root was verified against the installed Tauri implementation and the existing app-specific directory. Settings now shows resolved paths and offers buttons for opening only these two application-managed folders. No collection/profile files were moved, reset or deleted.

Keep writable data in AppData for normal installations. [Microsoft recommends separating user data from Program Files](https://learn.microsoft.com/en-us/windows/win32/shell/sec-shell). Writing beside an installed executable can require elevated permissions, mix different Windows users' data and complicate application replacement. A portable build in a user-writable folder is a separate option that would require explicit profile selection and a tested migration. CSV export is useful for a collection copy, but is not a full backup/restore of WebView state.

## Validation evidence

- `npm run check`: 77 frontend/release tests, card-asset coverage test, production UI build, Rust check and three Rust tests passed.
- Three Python image-update regression tests passed.
- Release tests cover same-day version increments, GitHub-safe names, mismatched keys, signature sidecar mismatch and the original space-in-URL failure.
- Price tests cover set/number conflicts, champion names, alternate/runic identifiers, CSV errors, duplicate conflicts, currency precision and ECB failure.
- The settings component was rendered in a browser with labelled preview data. Price-source/date text, storage paths and the folder-button callback were verified. This is not a native Explorer or MSI install test.
- Local public-data snapshots and before/after audit JSON are in `src-tauri/target/update-price-audit/` (ignored by Git).

The duplicate-prevention policy for consecutive scans of the same card remains unchanged.
