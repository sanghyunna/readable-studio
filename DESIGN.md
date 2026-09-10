# Readable Studio Design System

## 1. Atmosphere & Identity

Readable Studio is a calm, local document workspace: quiet around the work, precise in controls, and warm enough to feel editorial rather than developer-centric. Its signature is the multicolor rounded document mark against neutral application chrome. Product language follows the workflow in `CONTEXT.md`: Source Text -> AI Generation -> Direct Editing -> Standalone HTML.

## 2. Color

The canonical palette is implemented in `apps/web/src/styles/tokens.css`. Components consume semantic variables rather than raw colors.

| Role | Canonical tokens | Usage |
|---|---|---|
| App surfaces | `--bg`, `--bg-app`, `--bg-panel`, `--bg-elevated`, `--hub-canvas`, `--hub-composer-body`, `--hub-composer-*` | Shell, panels, dialogs; the approved hub uses a neutral white room, a pure-white composer body, and a pale blue composer footer around its pearl rail |
| Subtle surfaces | `--bg-subtle`, `--bg-muted`, `--bg-fill-*` | Rows, chips, quiet controls |
| Text | `--text`, `--text-strong`, `--text-muted`, `--text-soft`, `--text-faint` | Content hierarchy |
| Borders | `--border`, `--border-strong`, `--border-soft` | Dividers and control boundaries |
| Action | `--accent`, `--accent-strong`, `--accent-soft`, `--accent-tint`, `--accent-hover` | Primary actions and interactive emphasis |
| Selection | `--selected`, `--selected-soft` | Current option and focus selection |
| Status | `--success-*`, `--warning-*`, `--danger-*`, `--blue-*`, `--purple-*` | Feedback and diagnostics |
| Brand mark | `apps/web/public/app-icon.svg` | Product identity only; never recolor generated documents |

Theme variants in `tokens.css` own dark and named-theme values. New colors must first receive a semantic token there.

## 3. Typography

Pretendard is the single product type family, loaded from `apps/web/src/styles/fonts.css`. The canonical stacks are `--sans`, `--font`, `--font-body`, and `--font-display`; `--mono` intentionally aliases the same family in the current system.

| Level | Current range | Usage |
|---|---:|---|
| Display | fluid `clamp()` values in owned home styles | Home and onboarding focal copy |
| Page heading | 24-32px | Primary page identity |
| Section heading | 16-20px | Settings and workspace sections |
| Body | 13.5-16px | Product copy and controls |
| Caption | 11-13px | Metadata, hints, status |

Korean and other CJK copy must preserve natural phrase wrapping. Avoid narrow fixed measures that orphan particles, endings, or final syllables.

## 4. Spacing & Layout

Spacing follows a 4px base and the existing values in product styles: 4, 8, 12, 16, 20, 24, 32, 40, 48, and 64px. Browser mechanics such as `clamp()`, percentages, and intrinsic tracks remain local.

The workspace is a bounded application shell. Fixed chrome stays outside each named scrolling body; grid and flex scroll children require `min-block-size: 0`. Home and settings reflow at content-driven breakpoints and must not create horizontal primary-content scroll at 375px.

The hub adopts StyleGallery's `fixed-sidenav-shell` contract (`https://github.com/changeroa/StyleGallery/blob/main/patterns/viewport-shell/fixed-sidenav-shell.md`) and its nested `scroll-body-shell` contract (`https://github.com/changeroa/StyleGallery/blob/main/patterns/viewport-shell/scroll-body-shell.md`): its pearl rail, when expanded (292px track), is a panel floating inside the shell, inset by the single shared `--project-rail-inset` (10px) on the top, bottom and start edges (the trailing edge is the track boundary the resizer straddles); when collapsed it is the edge-anchored 44px strip, flush to the wall, the window top and the window floor. The rail's one collapse toggle lives in its brand row: immediately right of the wordmark while expanded, in the brand's place once collapsed; the 36px window-chrome strip carries only the traffic lights. `.hub__stage` owns stage scrolling; within the fixed rail, `.hub__nav-list` is the bounded tree scroll owner while the rail header, actions, and `HubRailFooter` remain fixed. Rail, stage, and inspector own explicit grid tracks so transient status/live-region siblings can never displace the shell. The reference-calibration tokens `--hub-stage-reference-offset` and `--hub-placeholder-reference-top` own the DPR2 alignment adjustments. The home route owns one 44px topbar, not a second workspace-tab row, and its centered start content has an 880px maximum measure inside the stage.

The loading surface adopts StyleGallery's `cover` spatial contract (`https://github.com/changeroa/StyleGallery/blob/main/patterns/viewport-shell/cover.md`): a viewport-bounded centered region with no internal scroll owner. It uses `min-block-size: 100dvb` and ordinary document reading order.

The hub command palette composes StyleGallery's `imposter` overlay contract (`https://github.com/changeroa/StyleGallery/blob/main/patterns/overlay-exception/imposter.md`) with a bounded `scroll-body-shell`: the translucent scrim and compact dialog stay fixed, while `.hub-palette__list` alone owns overflow. Search and keyboard guidance remain fixed so the next result-group label never strands at the viewport fold.

## 5. Components

### Product Loading Shell
- **Structure**: semantic status region containing the canonical product icon and loading label.
- **Variants**: local and hosted boot share the same product shell.
- **States**: loading only; the application replaces it when mounted. White-screen observability treats the class as a sentinel rather than meaningful app content.
- **Accessibility**: `role="status"`, polite live announcement, decorative image with empty alt text.
- **Motion**: none; startup motion is owned by the Electron splash media.
- **Layout**: `cover`; no internal scroll container.

### Application Chrome
- **Structure**: fixed header/rail actions around one active content region.
- **States**: default, hover, active, focus-visible, disabled where applicable.
- **Accessibility**: native buttons/links, useful accessible names, DOM order matches reading and focus order.
- **Layout**: fixed shell regions; the active content body owns scrolling.

### Buttons, Selects, Tooltips, Toasts, and Dialogs
- Shared primitives and legacy compatibility classes live in `packages/components` and `apps/web/src/styles/primitives.css`.
- Product-specific composition stays beside its component, preferably in CSS Modules.
- Every interactive primitive preserves hover, active, focus-visible, disabled, loading, success, and error states where applicable.

### Hub Drop-to-Edit Zone
- **Structure**: `HubDropToEdit` (`apps/web/src/components/hub/HubDropToEdit.tsx`, colocated CSS Module) sits below the Hub composer as a sibling, never an ancestor, so the composer's own attachment drop keeps its files. It is a native `button` (`type="button"`, `aria-labelledby` the visible label, `aria-describedby` the format line) over a hidden single-file `input[type=file]`; pointer drop and keyboard activation feed one handler that drives the existing import path (create project -> project-file API -> workspace route with the file open).
- **Material**: a transparent rounded rectangle (`--radius-lg`) with a 1px dashed `--border-strong` line and `--text-muted` ink at rest; no glass, no blur, no fill. The icon chip uses `--hub-control-surface` + `--hub-control-highlight`.
- **States** (`data-state="idle|drag-over|busy"`): hover/focus-visible move the dash toward the accent (`color-mix(--hub-accent 56%, --border-strong)`) and the ink to `--text`; focus-visible adds the Hub's 2px `--hub-accent` outline; drag-over turns the dash solid-accent, fills with `--hub-accent-fill`, inks with `--hub-accent-ink` and wears the composer's 3px ready ring (`color-mix(--hub-accent 16%, transparent)`); busy is a solid `--hub-accent-line` rule with `--text-soft` ink, `cursor: progress` and the spinner icon. The label text changes per state, so state is never colour-only.
- **Refusals**: several files, an unsupported format (anything but `.html`, `.htm`, `.md`) and a failed import each speak through the shared `Toast` (`role="alert"`, error tone) with typed `hub.drop*` copy in both product locales.
- **Adaptive**: transitions are paint-only (`--dur-quick`, `--ease-out`) and drop under reduced motion; reduced transparency swaps the drag-over fill for the opaque `--accent-tint`; forced-colors uses `ButtonText`/`ButtonFace`/`Highlight` like the selection primitives.

### Direct Listbox (single-value dropdown)
- **Rule**: product forms never render a native `<select>`; the OS-drawn control ignores every token above. Single-value choice fields use `DirectListbox` (`apps/web/src/components/DirectListbox.tsx`), the composer model/effort picker's mechanism made reusable: body-portaled panel placed by the shared `placePopover` maths, the `.inline-switcher__popover--model` / `.inline-switcher__model-list` / `.inline-switcher__model-option` skin (192px minimum widened to the trigger, `overflow-x: clip`, hover/focus reveal of overflowing labels via `ListboxOptionLabel`), and the `.readable-studio-select-trigger` field skin on the trigger.
- **Semantics**: native `button` trigger with `role="combobox"`, `aria-haspopup="listbox"`, `aria-expanded`, `aria-controls`; list is `role="listbox"` of `role="option"` + `aria-selected`; real focus roves through options. Keys: ArrowDown/ArrowUp/Enter/Space open; arrows, Home, End, single-character type-ahead move; Enter/Space pick; Escape/Tab dismiss; focus returns to the trigger.
- **States**: placeholder (`data-placeholder`, `--text-faint`), chosen, hover, focus-visible, expanded (chevron rotates), disabled/locked. Motion is the layer's entrance fade only; reduced motion drops it and the chevron/label transitions.

### Questions field ledger and anchored corrections
- **Composition**: required form first, compact influence/count row, confirmed fields, inferred fields, defaults. One 70ch content-limiter ([StyleGallery](https://github.com/changeroa/StyleGallery/blob/main/patterns/containment/content-limiter.md)); `.questions-panel-body` alone scrolls, header/footer and workspace tabs stay outside it. No equal-card mosaic or replacement correction step.
- **Rows**: shared Pretendard, 13px labels/status and 14px values; 16px group headings, 20px panel heading; 8/12/16/24px rhythm. Each field uses label/value/status/chevron tracks; below 540px container width label and value stack in one column beside the affordance. Confirmed values use semibold weight, not a new palette.
- **Material/contrast**: row and input background layers `--hub-control-engraved` over opaque `--bg`, hover strengthens only the inset shadow, inset `--hub-control-engraved-shadow`. All Questions copy uses `--text-strong` (small/regular secondary copy, semibold values) because named palettes' muted ramps cannot reliably meet 4.5:1. The row well is capped at the rest 8% ink mix on hover to retain Solarized contrast. Focus/selection markers use `--text-strong` at 3:1 minimum. Popovers use the same shared layer/radius/shadow, with `--bg` as the opaque contrast backing. No raw colors or theme forks.
- **Editors**: exactly one mounted editor anchored to the field. Enumerations reuse DirectListbox with an external anchor; multi-value listboxes keep stable values and selection caps, with Save/Cancel. Free text uses the same `placePopover` geometry and menu material, with Save/Cancel, no modal or scrim. Mechanism reference: [beui popover](https://beui.dev/r/popover/raw), adapted to the existing product entrance fade, without its decorative morph.
- **State**: Save waits for persistence, closes only on success, restores field focus; failure remains inline and retryable. Escape restores focus. Outside dismissal passes the click through; drafts survive dismissal and field switching in session storage, with visible draft status. Cancel explicitly discards. Pending writes prevent duplicate submission and field switching; hydration blocks writes but not draft input. All copy uses the existing en/ko dictionaries.
- **Verification boundary**: this task prohibits builds and browser runtime. Static theme-recipe contrast and focused DOM tests are required; 375/768/1280 rendered geometry, tab hit-testing, reduced motion and visual-review screenshots remain unverified until the parent runs browser QA. No visual sign-off is implied by DOM tests.

### Selection Primitives
- **Product checkbox ban**: visible product UI must not use checkbox inputs or checkbox glyphs. Protocol strings, serialized content, source-code examples, and other non-visible machine-consumed content are exceptions because they do not define product UI. `pnpm guard` enforces the ban fail-closed via `scripts/check-no-checkbox-ui.ts`.
- **Switch**: use only for a controlled binary setting whose effect can be understood as on/off. It is a native `button` with `role="switch"`, `aria-checked`, a moving thumb, and visible state text or an accessible label; pending state is busy and aria-disabled without changing the controlled value.
- **ToggleButton**: use for compact, independently pressable view or tool states such as formatting, alignment, or filters. It is a native `button` with `aria-pressed`; icon-only instances require an accessible name, while icon-and-text and text-only content are supported.
- **ToggleCard**: use when one selectable option needs title/description-scale content and the entire card is the target. It is a native `button` with `aria-pressed`; selected treatment covers the full surface, and interactive descendants are prohibited.
- All three expose `data-state="on|off"`, default to `type="button"`, retain native Enter/Space behavior, and use tonal rest/hover/pressed/selected states. State is communicated without color alone through thumb position, surface depth/position, pressed semantics, and visible text where context needs it.
- Focus-visible treatment uses the semantic selection token at a minimum 3:1 contrast against adjacent surfaces. Selection controls honor reduced motion, reduced transparency, and forced-colors modes; they use no gradients, black overlays, thick borders, nested pill decoration, hidden inputs, or checkbox descendants.

## 6. Motion & Interaction

| Type | Token | Usage |
|---|---|---|
| Quick | `--dur-quick` (120ms) | Hover/focus feedback |
| Enter | `--dur-enter` (200ms) | Menus, panels, conditional UI |
| Exit | `--dur-exit` (140ms) | Decisive dismissal |
| Easing | `--ease-out` | Product transitions |

Motion communicates state or spatial continuity. Animate composited properties (`transform`, `opacity`, `filter`) and honor `prefers-reduced-motion`. Decorative motion outside the branded Electron splash is not part of the product system.

## 7. Depth & Surface

The strategy is mixed but restrained: tonal shifts and borders establish the shell; `--shadow-xs` through `--shadow-lg` are reserved for genuine elevation such as menus, dialogs, and floating controls. Generated document previews remain palette-neutral so application chrome never biases document design.

### Ambient background vocabulary

One ambient composition lights every shell surface, so the Hub <-> workspace swap never changes the light itself. The ingredients are declared once in `styles/themes/recipes.css` and consumed by both surfaces:

| Ingredient | Token | Carrier |
|---|---|---|
| Canvas | `--hub-canvas-background` (four corner blooms over `--hub-canvas-base`) | painted once on `.workspace-shell`; every surface root above it stays transparent |
| Wash blooms | `--hub-wash-bloom-accent`, `--hub-wash-bloom-warm`, `--hub-wash-bloom-cool` (soft circular falloffs over the theme-aware `--hub-wash*` colours) | Hub: `.hub__wash` + `::before`/`::after`; workspace: `.app::before`/`::after` + `.split::before` |

Carriers are fixed to the viewport, blurred, faded, pill-shaped and inert; positions and intensity may vary per surface, but the ingredient set may not. No surface-local selector may re-declare or delete an ingredient: the wash colours substitute at the recipe root, so a scoped `--hub-wash*` override is dead by construction, and reduced transparency hides every carrier on both surfaces while the canvas flattens to `--hub-canvas`.

Radii use only `--radius-xs`, `--radius-sm`, `--radius`, `--radius-md`, `--radius-lg`, and `--radius-pill`.

## 8. Accessibility Constraints & Accepted Debt

### Constraints
- Target WCAG 2.2 AA: 4.5:1 body text, 3:1 large text and non-text controls.
- Every interactive element has a visible focus state and keyboard reachability.
- Loading, success, and error feedback uses semantic live/status behavior without trapping focus.
- Product icon images are decorative beside visible or accessible product names.
- Layout must hold at 375px, 768px, 1280px, 200% zoom, long labels, empty states, and unbroken strings.
- Reduced motion, color scheme, locale, and CJK wrapping are first-class adaptive constraints.

### Accepted Debt

No new accessibility or design debt is accepted for the Task19 brand migration.
