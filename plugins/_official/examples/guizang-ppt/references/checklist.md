# Quality Checklist

This checklist comes from real iterations on a "one-person company" presentation. Every item was learned the hard way and is ordered by importance.

Read it once before generating a presentation, then check each item after generation.

---

## 🔴 P0 · Non-negotiable mistakes

### 0. Required class-name validation before generation (most important)

**Symptom**: You paste a layout skeleton from layouts.md into new HTML and all styling disappears: display headings turn sans-serif, large-number typography shrinks to body size, multi-page pipelines blur together, and images pile up at the bottom of the browser.

**Root cause**: If the `<style>` in `template.html` does not define these classes, the browser falls back to default styles.

**Practice**:
- **Before generating the presentation, `Read` `assets/template.html`**, and confirm every class used by layouts.md is defined.
- Commonly missed classes: `h-hero / h-xl / h-sub / h-md / lead / meta-row / stat-card / stat-label / stat-nb / stat-unit / stat-note / pipeline-section / pipeline-label / pipeline / step / step-nb / step-title / step-desc / grid-2-7-5 / grid-2-6-6 / grid-2-8-4 / grid-3-3 / frame / img-cap / callout-src`
- If a class is genuinely missing, **add it to the `<style>` in template.html**; do not rewrite it inline on every page.
- After generation, open the page in a browser. If a "display heading is sans-serif" or "pipeline steps are squeezed onto one line," this is almost certainly the cause.

### 1. Do not use emoji as icons

**Symptom**: Emoji (🎯 💡 ✅) immediately break the tone of a Chinese editorial style.

**Practice**: Use the Lucide icon library through its CDN:

```html
<script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>
...
<i data-lucide="target" class="ico-md"></i>
...
<script>lucide.createIcons();</script>
```

Common icon names: `target / palette / search-check / compass / share-2 / crown / check-circle / x-circle / plus / arrow-right / grid-2x2 / network`

### 2. Images may be cropped only at the bottom; never crop the sides or top

**Symptom**: Using `aspect-ratio` to size images lets grids stack when their parent is too small or crops important image content (such as the title bar at the top of a screenshot).

**Practice**: Give the image container a **fixed height + overflow hidden**, then use `object-fit:cover + object-position:top` for the image:

```html
<figure class="frame-img" style="height:26vh">
  <img src="screenshot.png">
</figure>
```

The CSS for `.frame-img img` already sets `object-position:top`, so only the bottom is cropped.

**Never use this pattern** (it breaks out of its container in a grid):

```html
<!-- Bad example -->
<figure class="frame-img" style="aspect-ratio: 16/9">...</figure>
```

**Exception**: A single hero image (not inside a grid) may use `aspect-ratio + max-height`, because its parent container provides a fallback.

### 2b. Light pages with dark WebGL look hazy (theme switching did not apply)

**Symptom**: Every light page looks covered by gray haze, including light heroes.

**Root cause**: JavaScript switches the opacity of two canvases according to each slide's theme. If the deck opens on a dark hero and nothing can switch the background to light, the body never gets the `light-bg` class and `canvas#bg-dark` remains on top.

**Practice**:
- The template's `go()` function now infers the theme from `classList` (`light` / `dark`), so **every slide must explicitly include a `light` or `dark` class**. Do not omit it or use another custom theme name.
- Use `hero light` / `hero dark` for hero pages and `light` / `dark` for body pages. `hero` without a theme is invalid.
- A deck must include at least one **non-hero light page** so the body can receive `light-bg`.

### 2b-2. An all-light deck has no rhythm

**Symptom**: Aside from the `hero dark` cover, every page defaults to `light`; the result is flat and relentlessly white.

**Root cause**: The layouts.md skeletons default to `light`. Pasting them without adjusting themes makes the entire deck bright.

**Practice**:
- **Create a theme-rhythm table before generating**: specify `hero dark`, `hero light`, `light`, or `dark` for every page, then write code only after it is aligned.
- **Hard rule**: three or more consecutive pages of the same theme are forbidden; eight or more pages require at least one `hero dark` and one `hero light`; body pages cannot all be `light`—include a `dark` body page.
- **Choose themes by layout** (see "Theme Rhythm Planning" at the start of layouts.md):
  - Text-left/image-right (Layout 4), large quote (Layout 8), and mixed image-text (Layout 10) → alternate **`light` / `dark`**
  - Big numbers, image grids, pipelines, and comparison pages → `light` (screenshots, numbers, and processes need a bright ground)
  - Covers and question pages → `hero dark`
  - Section-divider covers → alternate `hero dark` and `hero light`
- **Check after generation**: run `grep 'class="slide' index.html` and visually confirm the rhythm alternates.

### 2c. Do not write the same phrase in chrome and kicker

**Symptom**: The upper-left `.chrome` says "Design First · Design-led," while the same page's `.kicker` says "Phase 01 · Design phase"—a redundant translation with an AI-generated feel.

**Practice**:
- **chrome = magazine running head / navigation label**: it may repeat across pages (for example, "Act II · Workflow", "Data · Result", or "lukew.com · 2026.04")
- **kicker = the page's unique lead-in**: brief, hook-like, and a small prefix for the main heading (for example, "BUT", "What did one person make?", or "The Question")
- One describes the section and one describes the page; never translate one into the other.

### 3. Display-heading font size cannot exceed screen width / per-line character capacity

**Symptom**: A Chinese display heading set too large (for example, 13vw) fits only one character per line, forcing ugly line breaks.

**Practice**:
- `h-hero` (largest): 10vw, **and title length ≤ 5 characters**
- `h-xl` (second largest): 6vw-7vw
- Manually break long headings with `<br>`; never rely on automatic wrapping.
- Add `white-space:nowrap` when necessary.

**Example**: `I am not a programmer.` (six Chinese characters in the original) uses `h-xl` at 7.2vw + nowrap to fit on one line.

### 4. Font roles: serif headings, sans-serif body text

**Practice**:
- Display headings, emphasized quotes, and large-number typography → **serif fonts** (Noto Serif SC + Playfair Display + Source Serif)
- Body text, descriptions, and pipeline step names → **sans-serif fonts** (Noto Sans SC + Inter)
- Metadata, code, and labels → **monospace fonts** (IBM Plex Mono + JetBrains Mono)

Load all fonts through the Google Fonts CDN; the template already includes them.

### 4b. Do not bottom-align images with `align-self:end`

**Symptom**: In a text-left/image-right layout, `align-self:end` is added to `<figure>` to align the right-column image with the left-column callout. The result:
- If the parent is not a grid (for example, because a class is undefined), `align-self` does nothing and the image drops to the bottom of the document flow, under the browser bar.
- Even in a grid, the image sits at the bottom of its cell and can still be obscured by `.foot` and `#nav` dots on short screens.

**Practice**:
- Mixed image-text layouts **must use `.frame.grid-2-7-5`** (or `.grid-2-6-6` / `.grid-2-8-4`).
- Use a **standard 16/10 or 4/3 ratio + max-height:56vh** for the right-column `<figure class="frame-img">`; natural top alignment is enough.
- To make the left callout look "bottom-aligned," make the **left column** a flex column with `justify-content:space-between`; do not alter the right column.

### 4c. Do not use an image's unusual source ratio

**Symptom**: Copying a source ratio such as `aspect-ratio: 2592/1798` creates strange whitespace or overflow at different screen sizes.

**Practice**: Whatever the original image ratio, use a standard placeholder ratio: **16/10 / 4/3 / 3/2 / 1/1 / 16/9**. Images automatically use `object-fit:cover + object-position:top`; a little bottom cropping is harmless while the top remains intact.

### 5. Do not add heavy borders / shadows to images

**Symptom**: A strong shadow or black frame added for "premium feel" instantly turns the deck into corporate slides.

**Practice**: At most use a 1-4px subtle radius + **extremely faint base noise** (already in the template). Do not add `box-shadow` or `border` (except an extremely faint 1px gray border).

---

## 🟡 P1 · Typographic rhythm

### 6. Alternate hero and non-hero pages

**Recommended rhythm** (25-30 pages):
```
Hero Cover → Act Divider (hero) → 3-4 pages non-hero → Act Divider (hero)
→ 4-5 pages non-hero → Hero Question → ... → Hero Close
```

More than two consecutive hero pages tire the audience; more than four consecutive non-hero pages kill the rhythm.

### 7. Alternate big-number and dense pages

Big-number pages (big numbers / hero question) and dense pages (pipeline / image grid) should alternate so the audience's eyes can rest.

### 8. Keep English/Chinese terminology consistent for the same concept

**Symptom**: The deck alternates among "Skills," its Chinese translation, and a Chinese compound phrase, making the document inconsistent.

**Practice**:
- Prefer **English terms** (Skills / Harness / Pipeline / Workflow); they are familiar within the field.
- **Do not force translations**; they read awkwardly.
- Use one spelling for each term throughout the deck.

### 9. Keep bottom-chrome page numbers consistent

Use the format `XX / total pages` (for example, `05 / 27`). **Do not add a dynamic page number in the upper right** (it duplicates `.chrome`).

---

## 🟢 P2 · Visual polish

### 10. WebGL background overlay opacity

**dark hero**: overlay 12-15% (WebGL clearly shows through)
**light hero**: overlay 16-20% (WebGL is faintly visible and does not compete with text)
**regular light/dark pages**: overlay 92-95% (almost opaque)

If a page has very little copy (a hero question), the overlay can be thinner; if body text is dense, thicken it to preserve readability.

### 11. A light-hero shader must not have a strong center point

**Symptom**: Spiral Vortex and radial ripples are too prominent in a light theme and resemble a Windows 98 screensaver.

**Practice**: Use centerless flow driven by FBM domain warping for light heroes. Keep the base silver/paper-colored (near #F0F0F0 / #FBF8F3) with subtle rainbow shifts (below 0.05).

### 12. Dark heroes may use more visual impact

Dark heroes can use shaders with centered structures such as Holographic Dispersion (titanium iridescence), because dark backgrounds can hold more visual information.

### 13. Text-left/image-right alignment

- Set `justify-content:space-between` on the left text group: heading at the top and quote box at the bottom.
- Set `align-self:end` on the right image: align it with the left column's bottom element.
- Set the overall grid to `align-items:start` (not `center` / `end`).

### 14. Subtle image corner radius

Apply `border-radius:4px` to every `.frame-img` and `.frame-img img`: visually soft, but not squishy. **Do not exceed 8px**, or it will resemble consumer-app UI.

---

## 🔵 P3 · Operational details

### 15. Use relative image paths

Put images in the `images/` directory and use relative paths such as `images/xxx.png` in HTML; never use absolute paths.

### 16. Hard-code page numbers in `.chrome`

JavaScript dynamically calculates the total number of pages and expands the bottom navigation dots, but `XX / N` in `.chrome` is hard-coded. Update N manually when adding or removing pages.

### 17. Keep page-turn navigation

The template supports ← → / mouse wheel / touch swipe / bottom dots / Home·End by default. Do not remove the navigation logic from JavaScript.

### 18. Do not force `height:100vh`; use `min-height:80vh`

`100vh` makes content exactly fill the screen, but browser chrome consumes height and causes overflow. `min-height:80vh + align-content:center` is safer.

---

## 🧪 Final self-checklist

After generating a presentation, compare each item against this checklist (tick it off):

```
Preflight (before generation)
  □ Read the `<style>` in template.html and confirmed every needed class exists
  □ Selected a Layout (1-10) for every page
  □ Created a theme-rhythm table: every page explicitly uses hero dark / hero light / light / dark
  □ The rhythm table meets hard rules: no three consecutive same-theme pages / ≥1 hero dark + ≥1 hero light (8+ pages) / at least one dark body page
  □ `<title>` changed to the actual deck title (grep "[required]" returns no results)

Content
  □ Page allocation across sections is balanced (no top-heavy or bottom-heavy deck)
  □ No emoji used as icons
  □ Terminology such as Skills / Harness is consistent
  □ Every page has a clear three-level hierarchy: kicker + heading + body

Typography
  □ No display heading wraps as one character per line
  □ Image grids use height:Nvh rather than aspect-ratio
  □ Images crop only at the bottom; top and sides remain complete
  □ Serif/sans-serif role assignment follows the template
  □ Pipeline groups have clear separation

Visual
  □ Hero and non-hero pages alternate
  □ WebGL background is visible on hero pages
  □ Images have a subtle corner radius
  □ No heavy shadows or borders

Interaction
  □ ← → page navigation works
  □ Number of bottom dots matches total page count
  □ Page numbers in chrome match actual page numbers
  □ ESC opens the index view (if retained)
```

Only after every item is checked is the presentation ready.
