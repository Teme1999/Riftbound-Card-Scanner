# Notices

This project is an independent non-commercial fork maintained by Teme1999. It
is not affiliated with, endorsed by, sponsored by, or connected to Riot Games or
the upstream project maintainer.

## Upstream MIT Notice

The upstream project was distributed under the MIT License. The required notice
is preserved below for portions derived from that project.

```text
MIT License

Copyright (c) 2026 Nekoraru22

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Riot Games Fan Project Notice

This project uses Riot Games intellectual property under Riot Games' Legal
Jibber Jabber fan-project policy. Riot Games is not affiliated with this project
and does not sponsor or endorse it.

## Runtime Card Assets

Generated card images, card metadata, artwork fingerprints, and detector models
are produced by the local scripts in `model/`. They are intentionally ignored in
git and must be regenerated or restored before production builds.

## Price Data

The optional price cache imports `cards.csv` from the community-maintained
`cristian-bravo/riftbound-prices` repository and stores matched rows locally.
Exchange rates are fetched from the European Central Bank when price data is
imported; bundled fallback rates are used if that request fails.

## Training Asset Provenance

Best-effort provenance notes for training helper assets live in
`model/ASSET_NOTICES.md`. Those files are used only for synthetic detector
training and are not part of the app runtime.
