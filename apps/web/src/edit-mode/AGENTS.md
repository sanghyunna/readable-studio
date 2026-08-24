# apps/web/src/edit-mode

PowerPoint-like direct editing — the product's differentiator. Treat its invariant as
non-negotiable.

## The invariant

**Every patch mutates the canonical HTML source, not the iframe's DOM.**
`source-patches.ts` parses the source, locates the node by `data-readable-id`, applies
and sanitizes, re-serializes, and returns new source plus before/after snapshots for
history. A change that only repaints the iframe is a bug, even when it looks correct on
screen.

## Layout

| File | Responsibility |
|---|---|
| `bridge.ts` | Runs **inside** the iframe. Discovers source-mappable targets and reports `ManualEditTarget` (kind, hierarchy, geometry, attributes, computed vs authored sizing, fields, style snapshot) over postMessage. |
| `source-patches.ts` | Host-side source rewriting. All persistence goes through here. |
| `types.ts` | The host↔bridge contract. Both sides change in one commit. |
| `movement-session.ts`, `keyboard-move.ts`, `resize-geometry.ts` | Drag/keyboard/resize geometry only — no source writes. |

Supported patches: text, link, image, inline styles, attributes, inner/outer HTML, CSS
tokens, remove, undo/redo, duplicate-and-move, full-source replacement. Rich text uses
contenteditable plus selection state.

## Rules

- A new target kind needs a `data-readable-id` identity that survives a re-render.
  Positional selectors are not acceptable.
- Host↔iframe messages use the `readable-edit-*` namespace (`readable-edit-targets`,
  `readable-edit-select`, `readable-edit-preview-style-applied`, …).
- Editing requires the srcDoc path unless the artifact ships `readable-direct-edit.js`
  — see `../components/file-viewer-render-mode.ts`.
