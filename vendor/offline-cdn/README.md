# Offline CDN assets

Source: npm registry tarballs obtained with `npm pack <package>@<version>`.
Every tarball was verified against `npm view <package>@<version> dist.integrity`
using SHA-512 before extraction and again before copying. Vendored file bytes are unmodified.

Source root: `vendor/offline-cdn/` (the existing sanctioned vendor guard path).
Packaged root: `app/resources/readable-studio/offline-cdn/`, under `READABLE_RESOURCE_ROOT`.

## Sources and integrity

- font-awesome@4.7.0
  - sha512-U6kGnykA/6bFmg1M/oT9EkFeIYv7JlX3bozwQJWiiLz6L0w3F5vBVPxHlwyX/vtNq1ckcpRKOB9f2Qal/VtFpg==
- @fortawesome/fontawesome-free@5.15.4
  - sha512-eYm8vijH/hpzr/6/1CJ/V/Eb1xQFW2nnUKArb3z+yUWv7HTwj6M7SP957oMjfZjAHU6qpoNc2wQvIxBLWYa/Jg==
- @fortawesome/fontawesome-free@6.7.2
  - sha512-JUOtgFW6k9u4Y+xeIaEiLr3+cjoUPiAuLXoyKOJSia6Duzb7pq+A76P9ZdPDoAoxHdHzq6gE9/jKBGXlZT8FbA==
- @fortawesome/fontawesome-free@7.3.1
  - sha512-wmglKKPDIkgV3aWlZzWECCPoGIkYCulzBwxG9+w7rc5BGapZ6cPMpoPOT8k36J0Ni7PPX6c/rsoMWfS4d1MUMg==
- chart.js@2.9.4
  - sha512-B07aAzxcrikjAPyV+01j7BmOpxtQETxTSlQ26BEYJ+3iUkbNKaOJ/nDbT6JjyqYxseM0ON12COHYdU2cTIjC7A==
- chart.js@3.9.1
  - sha512-Ro2JbLmvg83gXF5F4sniaQ+lTbSv18E+TIf2cOeiH1Iqd2PGFOtem+DUufMZsCJwFE7ywPOpfXFBwRTGq7dh6w==
- chart.js@4.5.1
  - sha512-GIjfiT9dbmHRiYi6Nl2yFCq7kkwdkp1W/lp2J99rX0yo9tgJGn3lKQATztIjb5tVtevcBtIdICNWqlq5+E8/Pw==

## Licenses

Font Awesome Free 5, 6 and 7: icons CC BY 4.0, fonts SIL OFL 1.1, code MIT.
Their upstream LICENSE.txt files are included. Font Awesome 4: fonts SIL OFL 1.1,
code MIT (documentation CC BY 3.0). Its npm tarball contains no LICENSE.txt;
`fontawesome/4/LICENSE.txt` is a byte-for-byte copy of the upstream README.md
which contains its license declarations, renamed to satisfy the resource layout.
Chart.js: MIT; each upstream LICENSE.md is included.

## Deliberate selection

Only the specified CSS, fonts/webfonts and browser JavaScript distributions are
included; SVG icon trees, sprites, preprocessors, metadata and source maps are omitted.
Font Awesome 7.3.1 is a stable FREE npm release. Chart.js 4 includes both UMD builds.
Its ESM `dist/chart.js` is not self-contained: it imports
`./chunks/helpers.dataset.js` and the bare package `@kurkle/color`. Per the
self-contained-only contract, that ESM build is omitted; no @kurkle/color is vendored.
Google Fonts and Tailwind are not included.

The manifest lists every file beneath each library/major root, sorted by path.
