# design-systems

150 brand systems. Each is a folder of content, not code — but `pnpm guard` enforces its
shape.

## Minimum for a new brand

`<brand>/DESIGN.md` — prose voice and rules, following the 9-section schema in
[`docs/design-systems.md`](../docs/design-systems.md). That alone is a valid system.

Rich systems add `tokens.css`, `design-tokens.json`, `manifest.json`, `components.html`,
`components.manifest.json`, `USAGE.md`, `preview/*.html`, `assets/`, `fonts/` and
importer evidence under `source/`. `default/` is the reference implementation — copy its
shape rather than inventing one.

## Guard requirements

Guard enforces A1 identity/structure tokens, **all** A2 tokens (fallbacks mirroring
`_schema/defaults.css`), and **all** B-slot tokens (which may alias with `var(...)`).
Unknown tokens need a `BRAND_EXTENSIONS` or `BRAND_EXTENSION_PREFIXES` entry. The token
contract lives in `packages/contracts/src/design-systems/token-schema.ts`, re-exported by
`_schema/tokens.schema.ts`; the layer model is explained in
[`docs/design-systems-token-layers.md`](../docs/design-systems-token-layers.md).

A committed `components.manifest.json` must match a fresh derivation from
`components.html` plus `tokens.css`, so regenerate rather than edit it.

## How a brand reaches the model

`designSystemId` → `apps/daemon/src/design-systems.ts` → `apps/daemon/src/prompts/system.ts`.
Prose is injected before tokens and component fixtures, so structured tokens
disambiguate the prose; craft rules sit between the brand and the skill body.
`READABLE_DESIGN_TOKEN_CHANNEL=0` disables the structured channel.
