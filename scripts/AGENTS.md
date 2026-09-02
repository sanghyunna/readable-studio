# scripts

Repo-level checks and maintenance utilities. The entry point is `pnpm guard`, which runs
`guard.ts` and then chains six `node --test` files.

```bash
pnpm guard
tsx ./scripts/guard.ts        # checks only, skips the chained tests
```

`guard.ts` includes `checkNoCheckboxUi` from `check-no-checkbox-ui.ts`: a fail-closed scan of the web/components production source for banned checkbox UI (JSX/role/glyph/class/selector/icons). Its exceptions live in that file, not in prose.

## Generated — do not hand-edit

- `plugins/registry/official/readable-studio-marketplace.json` is owned by
  `readable-plugin-catalog.ts`, which has `check` / `generate` / `audit`. `check`
  compares bytes; *stale* means run `generate` and commit the result.
- Design-system metadata is owned by `regenerate-design-system-metadata.ts` and
  `sync-design-systems.ts`; component manifests by `extract-components-manifest.ts`.
- Every raster brand icon is owned by `generate-brand-icons.ts`. `apps/web/public/app-icon.svg`
  is the only hand-authored brand asset; `logo.svg`, `brand-icon.svg`, `app-icon.png`,
  `logo.png`, `docs/assets/logo.png` and `tools/pack/resources/win/icon.ico` are generated
  from it and must not be hand-edited. `app-icon-transparent.svg` / `.png` are the kept
  pre-plate originals and are *not* generated. `docs/assets/banner.svg` duplicates the mark
  geometry inline on purpose and deliberately omits the white plate — update it by hand only
  when the mark path itself changes.

  ```bash
  pnpm bake:brand-icons                                              # regenerate
  node --experimental-strip-types scripts/generate-brand-icons.ts --check   # verify, no writes
  ```

## Expected failures whose fix is the pin

`json-resources.test.ts` pins an exact shipped-JSON count. Adding or removing a JSON
resource fails it on purpose — updating the pin to the newly measured value **is** the
fix, not a workaround. Say so in the PR body.

## Adding a check

Append to the `checks` array in `guard.ts` (~line 1475) with an explicit `name`; the name
is what a failing agent sees, so make it say which file is wrong. A check that needs
assertions gets a sibling `*.test.ts` added to the `guard` script's chain in the root
`package.json`.

Scripts are TypeScript and typecheck under `scripts/tsconfig.json` (part of root
`pnpm typecheck`). `postinstall.mjs` and `bake-plugin-previews.mjs` are the allowlisted
`.mjs` exceptions — don't add more.
