# Readable Studio Design System

## 1. Atmosphere & Identity

Readable Studio is a calm, local document workspace: quiet around the work, precise in controls, and warm enough to feel editorial rather than developer-centric. Its signature is the multicolor rounded document mark against neutral application chrome. Product language follows the workflow in `CONTEXT.md`: Source Text -> AI Generation -> Direct Editing -> Standalone HTML.

## 2. Color

The canonical palette is implemented in `apps/web/src/styles/tokens.css`. Components consume semantic variables rather than raw colors.

| Role | Canonical tokens | Usage |
|---|---|---|
| App surfaces | `--bg`, `--bg-app`, `--bg-panel`, `--bg-elevated` | Shell, panels, dialogs |
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

The loading surface adopts StyleGallery's `cover` spatial contract (`https://github.com/changeroa/StyleGallery/blob/main/patterns/viewport-shell/cover.md`): a viewport-bounded centered region with no internal scroll owner. It uses `min-block-size: 100dvb` and ordinary document reading order.

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
