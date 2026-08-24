# design-systems/_schema

Structural contracts for design systems. Parent: `design-systems/AGENTS.md`.

```
_schema/
├── manifest.schema.ts ← project manifest schema (enforced when manifest.json exists)
├── tokens.schema.ts   ← token schema re-export (always enforced)
├── defaults.css       ← A2 fallback values, human reference mirror
└── AGENTS.md          ← this file
```

The TypeScript schemas are the source of truth. `tokens.schema.ts` re-exports
`packages/contracts/src/design-systems/token-schema.ts` so daemon importers and repo
guards consume one copy. `defaults.css` mirrors the A2 `fallback` fields so reviewers can
scan real CSS; drift between the two fails the `design-system: A2 defaults parity` guard.
`scripts/check-design-system-manifests.ts` validates any brand that ships `manifest.json`
— legacy `DESIGN.md`-only folders stay valid.

## Editing the schema

- Adding an A2 entry: also add the byte-equivalent declaration to `defaults.css`.
- Renaming a token: update every brand's `tokens.css` and the matching `components.html`
  `:root` paste in the same commit, or the drift guard fails.
- Removing a token that survives in exactly one brand: add it to that brand's
  `BRAND_EXTENSIONS` entry so the unknown-token guard passes.
- Then run `pnpm guard` and confirm `default` and `kami` still pass every design-system
  sub-check.

The full layer model (A1-identity, A1-structure, A2, B-slot, C-extensions), the rationale
for why A2 and B-slot are strictly required today, the promotion path, and the open
questions deferred to the derive script live in
[`docs/design-systems-token-layers.md`](../../docs/design-systems-token-layers.md).
