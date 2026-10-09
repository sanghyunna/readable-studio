# Rail empty-state acceptance

## Result

Removed the legacy whole-tree duplicate. The only empty-rail message is the quiet `hub.noRecents` hint inside Recent. Its x=40 text edge matches the actual standalone session row text edge (x=40), rather than sitting outside the section header (x=30). Hub content-area guidance was not changed.

The existing rail inset supplies a shared session-text inset token; hint colors and typography retain the existing semantic empty-state recipe. No new hardcoded color or typography values were added. The design spec does not prescribe a separate empty-folder hint; the empty folder remains an expandable folder with an empty session group. A regression test covers that behavior.

## Verification

- RED: 18 tests, 16 passed, 2 failed on empty-state ownership and collapsed text (`red.log`).
- Requested rail command: **19 files passed; 170 tests passed; 0 failed**, parsed from `tests.json` into `counts.json`. One execution after the fix.
- `pnpm --filter @readable-studio/web exec tsc -b --noEmit`: exit 0 (`tsc.log`, empty).
- `pnpm --filter @readable-studio/web build`: exit 0 (`build.log`).
- Language-server diagnostics unavailable: TypeScript and CSS language servers are not installed. TypeScript compiler and production build supplied the executable checks.
- Dev runtime: tools-dev namespace `fixempty`, tools root `D:/readable-studio/.tmp/fixempty-td`, daemon/web ports 18350/18351, initially empty `READABLE_DATA_DIR=D:/readable-studio/.tmp/fixempty`.
- Windows free commit memory measured before runtime launch: 7.1199913024902344 GiB (minimum 6 GiB).
- Headless screenshots inspected individually: light/dark expanded track widths 262 and 420, light/dark collapsed 44, light/dark 390x844 mobile, and the session-created surface. Four expanded cases have exactly 1 hint; collapsed cases have 0. All expanded hint text edges are x=40.
- `POST /api/sessions`: HTTP 200; awaited the actual session row arriving through the live rail update. Hint disappeared (count 0). `browser-results.json` records the session id and row inset.
- Browser screenshots await the rail GET and exact loaded state, not timing delays. The first browser pass captured transient loading copy in collapsed screenshots; evidence was replaced after awaiting the exact loaded state. No loading/empty text remains in the final collapsed screenshots.
- Namespace-specific tools-dev shutdown stopped only this runtime. Stop result reports no remaining PIDs; `cleanup-proof.json` independently confirms owned PIDs are absent.

## Scope

Source paths: `HubSessionTree.tsx`, `hub.css`, `HubSessionTree.test.tsx`. No edits to HubRail or HubHome were necessary. Other lanes' dirty paths were left untouched.

Pre-existing narrow Hub composer/carousel clipping and collapsed search glyph appearance are visible in screenshots, outside this rail empty-state change.
