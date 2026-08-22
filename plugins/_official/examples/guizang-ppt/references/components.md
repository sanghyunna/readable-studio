# Component Reference · Components

This is the component handbook for the `magazine-web-ppt` skill. `template.html` already defines all styles; this reference explains what each component looks like and how to use it.

## Contents

- [Base Slide Shell](#base-slide-shell)
- [Typography](#typography)
- [Chrome & Foot](#chrome--foot)
- [Callout Quotation](#callout-quotation)
- [Stat Matrix](#stat-matrix)
- [Platform Card](#platform-card)
- [Rowline Table Row](#rowline-table-row)
- [Pillar Card](#pillar-card)
- [Tag & Kicker](#tag--kicker)
- [Figure Frame](#figure-frame)
- [Icons](#icons)
- [Ghost Background Text](#ghost-background-text)
- [Highlight Marker](#highlight-marker)

---

## Base Slide Shell

Every page is a `<section class="slide ...">`. It must include a `data-theme` attribute (`light` or `dark`); the page-turning JavaScript uses it to switch backgrounds.

```html
<section class="slide light" data-theme="light">   <!-- light page -->
<section class="slide dark" data-theme="dark">     <!-- dark page -->
<section class="slide light hero" data-theme="light">  <!-- hero page: light with a thin overlay that reveals WebGL -->
<section class="slide dark hero" data-theme="dark">    <!-- hero page: dark with a thin overlay -->
```
**Use light and dark alternately.** Switch themes every two or three pages and avoid more than three consecutive pages with the same theme. On page turns, the WebGL background automatically crossfades between the two shaders.

**Use the hero class** only on visually led pages (cover, pull quote, section transition, ending). With `hero`, the overlay drops to 12–16% and the WebGL background shows through strongly, so do not put too much text on a hero page.

---

## Typography

Typography roles are the most important rule in this template; never mix them.

| Class | Purpose | Typeface |
|---|---|---|
| `.display` | Oversized English (hero page) | Playfair Display 700, 11vw |
| `.display-zh` | Oversized Chinese heading | Noto Serif SC 700, 7.8vw |
| `.h1-zh` | Page title | Noto Serif SC 700, 4.6vw |
| `.h2-zh` | Subtitle | Noto Serif SC 600, 3.2vw |
| `.h3-zh` | Pipeline step title | Noto Serif SC 500, 1.9vw |
| `.lead` | Lead paragraph (larger than body) | Noto Serif SC 400, 1.9vw |
| `.body-zh` | **Body/description (sans serif)** | Noto Sans SC 400, 1.22vw |
| `.body-serif` | Body copy (serif) | Noto Serif SC 400, 1.3vw |
| `.kicker` | Section cue (above the title) | IBM Plex Mono, 12px uppercase |
| `.meta` | Metadata label | IBM Plex Mono, 0.88vw uppercase |
| `.big-num` | Giant number | Playfair Display 800, 10vw |
| `.mid-num` | Medium number | Playfair Display 700, 5.5vw |

**Core rules**:
- **Serif** (`serif-zh` / `serif-en`): headings, key quotations, and numbers — for visual emphasis.
- **Sans serif** (`sans-zh`): body copy and long reading — for information density.
- **Monospace** (`mono`): English labels in kicker, meta, and foot — for decorative rhythm.

**Emphasis techniques**:
- `<em class="en">English words</em>` — renders English words in Playfair Display italic.
- `<em style="opacity:.65">a phrase</em>` — fades the second half of a title to create rhythm.

---

## Chrome & Foot

Metadata strips at the top and bottom of every page. Nearly every page should include them.

```html
<div class="chrome">
  <div class="left">
    <span>Act I · Hard Data</span>
    <span class="sep"></span>
    <span>Act I</span>
  </div>
  <div class="right"><span>02 / 27</span></div>
</div>

<!-- ... page body ... -->

<div class="foot">
  <div class="title">Project Name · CodePilot | github.com/codepilot</div>
  <div>Act I · Dev Numbers</div>
</div>
```

**Rules**:
- `chrome.right` always holds page numbering as `NN / TOTAL`.
- `foot.title` is the descriptive label; `foot.right` is the English act marker.
- Chrome and foot together form an editorial header and footer.

---

## Callout Quotation

Use for a pull quote, key point, or another person's statement.

```html
<div class="callout" style="max-width:80vw">
  <div class="q-big">"Three years ago,<br>this needed a ten-person team for a year."</div>
  <span class="cite">— An observer's assessment</span>
</div>
```

Variants:
- Without a cite: remove `<span class="cite">`.
- With an English pull quote: `<em class="en">"Thin Harness, Fat Skills."</em>`.
- On a hero page: add `style="position:relative;z-index:2"` to the wrapper so the background overlay does not cover it.

---

## Stat Matrix

Displays metrics and commonly pairs with `.grid-6` or `.grid-4`.

```html
<div class="grid-6">
  <div class="stat">
    <span class="m">Duration</span>
    <span class="n">64<em style="font-size:.4em;opacity:.5;font-style:normal"> days</em></span>
    <span class="l">From zero to now</span>
  </div>
  <!-- ... more stats ... -->
</div>
```

Three-part structure: `.m` monospace label → `.n` giant number → `.l` description. Put the unit after the number in an `<em>` reduced to 0.4em with opacity 0.5.

**Common layout containers**:
- `.grid-6` — a 3×2 grid (the usual choice, six stats).
- `.grid-4` — a 2×2 grid (four stats).
- `.grid-3` — three equal columns (three stats or pillars).

---

## Platform Card

Shows a social platform or channel plus its audience size.

```html
<div class="plat">
  <div class="sub">Weibo</div>
  <div class="name">Weibo</div>
  <div class="nb">289K</div>
</div>
```

Optional fourth row (supporting note):
```html
<div class="body-zh" style="font-size:max(11px,.8vw);opacity:.5;margin-top:.6vh">
  Includes Little Green Book sync
</div>
```

**"Also On" variant** (additional platforms):
```html
<div class="plat" style="border-top-style:dashed;opacity:.72">
  <div class="sub">Also On</div>
  <div class="body-zh" style="font-weight:600;margin-top:.8vh">
    Bilibili · Zhihu
  </div>
</div>
```

---

## Rowline Table Row

List-style content with one entry per row.

```html
<div class="rowline">
  <div class="k">CLAUDE.md</div>
  <div class="v">How to work — behavioral rules + work preferences + prohibited actions</div>
  <div class="m">EMPLOYEE · HANDBOOK</div>
</div>
```

Three-column structure: `.k` serif keyword · `.v` body description · `.m` monospaced tag (right-aligned). The first and last rowline automatically receive top and bottom borders.

**Variant: two columns**: `style="grid-template-columns:1fr 3fr"` removes the `.m` column.

---

## Pillar Card

A three-pillar structure, often used for pages that present parallel concepts.

```html
<div class="grid-3">
  <div class="pillar">
    <div class="ic">01</div>
    <div class="t">Three-layer<br>document system</div>
    <div class="d">CLAUDE.md<br>+ Project knowledge base<br>+ Guardrail files</div>
  </div>
  <!-- ... more pillars ... -->
</div>
```

**Pillar with an icon (for emphasis pages)**:
```html
<div class="pillar" style="padding:4vh 2vw;border:1px solid currentColor;border-color:rgba(10,10,11,.2)">
  <div class="ic"><i data-lucide="compass" class="ico-lg"></i></div>
  <div class="t">Judgment</div>
  <div class="d">Authority over decisions and direction.<br>Tradeoffs, taste, and a sense of direction.</div>
</div>
```

`.ic` can contain an ordinal (`01 / 02 / 03` or `A. / B. / C.`) or a Lucide icon.

---

## Tag & Kicker

**Kicker** is the small hint text above a title (monospace, uppercase, and small):
```html
<div class="kicker">THE PAST 64 DAYS · DEVELOPMENT</div>
<div class="h1-zh">What one person built.</div>
```

**Tag** is a standalone bordered label pill:
```html
<div style="display:flex;gap:1.6vw;flex-wrap:wrap">
  <div class="tag">Wake up at 10 AM</div>
  <div class="tag">Gym on Tuesday / Thursday afternoons</div>
  <div class="tag">Still watch shows · play games at night</div>
</div>
```

---

## Figure Image Frame

**This is the component most likely to cause problems in this template; follow these rules exactly.**

### Basic Structure

```html
<figure class="tile">
  <div class="frame-img" style="height:26vh">
    <img src="image-assets/xxx.png" alt="Description">
  </div>
  <figcaption class="frame-cap">
    <span class="pf">Twitter · Twitter</span>
    <span class="nb">137K</span>
  </figcaption>
</figure>
```

### Critical constraints (hard-won lessons; do not violate)

1. **You must use a fixed `height:Nvh`**, not `aspect-ratio`.
   - Why: `aspect-ratio` can overflow the parent container in a grid, causing images to stack.
   - Recommended sizes: `height:18vh` (compact strip) / `22vh` (standard grid) / `26vh` (featured display) / `28vh` (large image).

2. **`object-position:top center` (already set in CSS)**; only crop the bottom.
   - Never crop the left, right, or top — those areas contain the image's core identifying information.

3. **When a grid contains multiple images, use an inline grid instead of `grid-3`**:
   ```html
   <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:1vh 1.2vw">
     <figure class="tile">...</figure>
     <figure class="tile">...</figure>
     <figure class="tile">...</figure>
   </div>
   ```

4. **Align images with the rest of the layout**: add `align-self:end` to the figure so the image sits on the bottom edge.

### Frame Caption variants

```html
<!-- Standard: figure name on the left, number on the right -->
<figcaption class="frame-cap">
  <span class="pf">Twitter · Twitter</span>
  <span class="nb">137K</span>
</figcaption>

<!-- With an index -->
<figcaption class="frame-cap">
  <span class="idx">01</span>
  <span class="pf">AI polishing</span>
  <span>Polish</span>
</figcaption>
```

### Image placeholders (for the design phase)

Use a dashed placeholder frame while the image is not yet available:
```html
<div class="img-slot r-4x3">  <!-- r-4x3 / r-16x9(default) / r-3x2 / r-1x1 -->
  <span class="plus">+</span>
  <span class="label">GitHub screenshot placement</span>
</div>
```

---

## Icons

**Never use emoji**. Use Lucide via CDN (already included by `template.html`).

```html
<i data-lucide="compass" class="ico-lg"></i>     <!-- Large icon (for pillars) -->
<i data-lucide="target" class="ico-md"></i>      <!-- Medium icon (for list items) -->
<i data-lucide="check-circle" class="ico-sm"></i>  <!-- Small icon (for inline use) -->
```

**Common Lucide icon names** (grouped by meaning):

- Judgment: `compass`, `target`, `crosshair`, `search-check`
- Relationship: `share-2`, `users`, `network`, `link`, `handshake`
- Brand: `crown`, `gem`, `award`, `star`, `badge-check`
- Process: `workflow`, `route`, `arrow-right-left`, `repeat`
- Data: `grid-2x2`, `bar-chart-3`, `trending-up`, `activity`
- Aesthetic: `palette`, `brush`, `eye`, `sparkles`
- Correct/incorrect: `check-circle`, `x-circle`, `check`, `x`
- Direction: `arrow-right`, `arrow-up-right`, `corner-down-right`

**Inline icon-and-text composition**:
```html
<div class="h3-zh" style="display:flex;align-items:center;gap:.8em">
  <i data-lucide="target" class="ico-md"></i>
  Judgment — What is worth writing
</div>
```

---

## Ghost Giant Background Text

Used as decorative background text at very low opacity to create an editorial feel.

```html
<div class="ghost" style="right:-6vw;top:-8vh">BUT</div>
<div class="ghost" style="left:-8vw;bottom:-18vh;font-style:italic">Harness</div>
```

- Font size: 34vw; opacity: 0.06.
- Common positioning: `right:-6vw;top:-8vh` (overflowing upper right) / `left:-8vw;bottom:-18vh` (overflowing lower left).
- Content: English words or numbers (section indices 01/02/03; keywords such as BUT/NOW/HERE).

**Note**: On a page that uses a ghost, add `position:relative;z-index:2` to other content so it is not covered.

---

## Highlight Marker

A highlighter effect for inline phrases:

```html
<span class="hi">Not</span>
<span class="hi">a one-time burst</span>
```

Generates a translucent highlight bar beneath the text. Dark themes use a light bar and light themes use a dark bar (handled in CSS).

**Best for**: one to three key words only; do not use it over large areas.
