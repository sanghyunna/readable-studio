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

The hub adopts StyleGallery's `fixed-sidenav-shell` contract (`https://github.com/changeroa/StyleGallery/blob/main/patterns/viewport-shell/fixed-sidenav-shell.md`) and its nested `scroll-body-shell` contract (`https://github.com/changeroa/StyleGallery/blob/main/patterns/viewport-shell/scroll-body-shell.md`): its pearl rail stays inset on the sides/top and flush to the viewport bottom. `.hub__stage` owns stage scrolling; within the fixed rail, `.hub__nav-list` is the bounded tree scroll owner while the rail header, actions, and `HubRailFooter` remain fixed. Rail, stage, and inspector own explicit grid tracks so transient status/live-region siblings can never displace the shell. The reference-calibration tokens `--hub-stage-reference-offset` and `--hub-placeholder-reference-top` own the DPR2 alignment adjustments. The home route owns one 44px topbar, not a second workspace-tab row, and its centered start content has an 880px maximum measure inside the stage.

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
