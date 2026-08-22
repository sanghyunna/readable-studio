# Page Layout Library (Layouts)

This document contains ten of the most common page-layout skeletons. Each is a complete, paste-ready `<section class="slide ...">...</section>` code block; replace the copy and images to use it.

---

## ⚠️ Required Reading Before Generation (Pre-flight)

### A. Class names must come from template.html

Every class used in layouts.md (`h-hero` / `h-xl` / `h-sub` / `h-md` / `lead` / `meta-row` / `stat-card` / `stat-label` / `stat-nb` / `stat-unit` / `stat-note` / `pipeline-section` / `pipeline-label` / `pipeline` / `step` / `step-nb` / `step-title` / `step-desc` / `grid-2-7-5` / `grid-2-6-6` / `grid-2-8-4` / `grid-3-3` / `grid-6` / `grid-3` / `grid-4` / `frame` / `frame-img` / `img-cap` / `callout` / `callout-src` / `kicker`) is predefined in the `<style>` block of `assets/template.html`.

**Do not invent new class names**. If customization is necessary, write it inline with `style="..."`. Before generating, grep template.html if you are unsure whether a class exists.

### B. Image ratio rules (very important)

**Always use standard ratios**; do not use odd source-image ratios such as `aspect-ratio: 2592/1798`:

| Context | Recommended ratio | Syntax |
|------|---------|------|
| Main image with text on the left | 16:10 or 4:3 | `aspect-ratio:16/10; max-height:54vh` |
| Image grid (multi-image comparison) | Consistent | **Set `height:26vh`; do not use aspect-ratio** |
| Small left image + right text | 1:1 or 3:2 | `aspect-ratio:1/1; max-width:40vw` |
| Full-screen key visual | 16:9 | `aspect-ratio:16/9; max-height:64vh` |
| Small image in mixed text and image layout | 3:2 | `aspect-ratio:3/2; max-width:30vw` |

Images must be wrapped in `<figure class="frame-img">`; its `<img>` automatically uses `object-fit:cover + object-position:top center`, cropping only the bottom, not the top, left, or right.

### C. Image positioning rules (prevent images from piling up at the bottom or being hidden by browser chrome)

**Incorrect approaches** (known pitfalls; do not repeat them):
- Use `align-self:end` in a non-grid container: `align-self` is completely ineffective outside flex/grid, so images fall to the end of the document flow.
- Use `position:absolute + bottom:0` to pin an image to the bottom: the bottom `.foot` and `#nav` dots will obscure it.
- Set only `height:N vh` without `max-height` on a single image: it will exceed the viewport on low-resolution screens.

**Correct approaches**:
- Mixed text-and-image layouts **must use the grid structure of `.frame.grid-2-7-5`** (or `.grid-2-6-6` / `.grid-2-8-4`).
- Grid containers default to `align-items:start` (already set in the template), so images naturally sit at the top of their cell.
- To align an image bottom with a left-column callout: **use a flex column with `justify-content:space-between` in the left column** (so the callout sits at the bottom); **keep the right figure at align-items:start** and do not add `align-self:end`.
- Add inline `style="padding-top:6vh"` to every grid parent to leave breathing room for the title area.

### D. Theme colors and theme rhythm

- Choose a theme color from the five presets in `references/themes.md`; custom hex values are not allowed.
- Theme rhythm (which of light / dark / hero light / hero dark each page uses) has hard rules in the “Theme rhythm planning” section below; read it before generating.
- Decide both before selecting a layout to avoid rework.

---

## 0. Base structure (all slides are the same)

```html
<section class="slide [light|dark|hero light|hero dark]">
  <div class="chrome">
    <div>Context label · sublabel</div>
    <div>ACT · page / total pages</div>
  </div>
  <!-- Main content -->
  <div class="foot">
    <div>Page note · Page Description</div>
    <div>— · —</div>
  </div>
</section>
```

- Non-hero pages should use the `light` or `dark` theme; hero pages use `hero light` or `hero dark` (which participate in WebGL theme interpolation).
- `chrome` and `foot` are optional but recommended four-corner metadata.
- **Use hero pages for section covers, openings, closings, and transitions**; use non-hero pages for body content.

### ⚠️ Do not make chrome and kicker say the same thing

This is the most common content-duplication problem. They serve entirely different semantic roles:

| Position | Role | Content type | Examples |
|------|------|---------|------|
| Upper-left `.chrome` | **Magazine header / navigation metadata** | A stable “section name” or “chapter category” that can repeat across pages | "Act II · Workflow" / "Data · Result" / "lukew.com · 2026.04" |
| Upper-right `.chrome` | **Page number + act number** | Fixed format | "Act II · 15 / 25" |
| `.kicker` | **A one-of-a-kind lead-in for this page** | The “small prefix” to a headline, like a line above a magazine headline; it should differ on every page | "BUT" / "What did one person do?" / "Phase 01 · Design phase" |

**Counterexample** (a known pitfall): chrome says “Design first · Design First” and kicker says “Phase 01 · Design phase” — the meaning repeats, so readers immediately feel it was generated by AI.

**Correct approach**: chrome is a **section label** (stable and reusable across pages), while kicker is the **hook for this page** (a short, dramatic line). They complement rather than translate each other.

### ⚠️ Theme rhythm planning (required reading · do before generation)

**Core mechanism**: Every `<section>` must have one of `light` / `dark` / `hero light` / `hero dark`. JS infers the theme from its class and decides whether to add `light-bg` to body, thereby choosing which dark or light WebGL canvas is in front. Omitting the theme or writing a custom name causes a fallback error.

#### Default themes by layout

| Layout | Default theme | Reason |
|---|---|---|
| 1. Opening cover | `hero dark` | Ceremonial opening, strong impact on a dark ground |
| 2. Act divider | `hero dark` and `hero light` **must alternate** | Breathing rhythm |
| 3. Big numbers (data) | `light` | Numbers need a paper-white ground; insert `dark` occasionally across multiple acts |
| 4. Text left, image right | **Alternate `light` / `dark`** | Main body rhythm |
| 5. Image grid | `light` | Screenshots need a light ground |
| 6. Pipeline | `light` | Flow diagrams need clarity |
| 7. Question page | `hero dark` | Default for strong visual impact |
| 8. Big quote | **Prefer `dark`**, use `light` occasionally | A dark ground gives a key quote ceremony |
| 9. Comparison page | `light` | Two columns need clarity |
| 10. Mixed text and image | **Alternate `light` / `dark`** | Rhythm |

#### Hard rhythm rules (self-check with grep after generation)

- ❌ **Do not** use the same theme for three or more consecutive pages (including stacked light or dark pages).
- ❌ **Do not** make an eight-page-or-longer deck without at least one `hero dark` and one `hero light`.
- ❌ **Do not** make a whole deck with only `light` body pages and no `dark` body page — it will feel flat and airless.
- ✅ **Recommended**: Insert one hero every 3–4 pages (cover, act divider, question, or big quote).

#### Eight-page rhythm template (ready to use)

| Page | Theme | Layout | Notes |
|---|---|---|---|
| 1 | `hero dark` | Cover | Opening |
| 2 | `light` | Big numbers | Lead with data |
| 3 | `dark` | Text left, image right | Comparison / story |
| 4 | `light` | Pipeline | Process |
| 5 | `hero light` | Act divider | Breathing room |
| 6 | `dark` | Text left, image right or big quote | |
| 7 | `hero dark` | Question page | Resolve suspense |
| 8 | `light` | Big quote / ending | Close |

**Map this table first, then write slides**. Skip planning and paste skeletons directly = all light pages.

---

## Layout 1: Opening Cover (Hero Cover)

```html
<section class="slide hero dark">
  <div class="chrome">
    <div>A Talk · 2026.04.22</div>
    <div>Vol.01</div>
  </div>
  <div class="frame" style="display:grid; gap:4vh; align-content:center; min-height:80vh">
    <div class="kicker">Private session · Li Jigang</div>
    <h1 class="h-hero">A company of one</h1>
    <h2 class="h-sub">An organization compressed by AI</h2>
    <p class="lead" style="max-width:60vw">
      An AI creator — who wrote 110,000 lines of code in 64 days and published continuously across nine platforms, with almost no change to their life rhythm.
    </p>
    <div class="meta-row">
      <span>Guizang</span><span>·</span><span>Independent creator / CodePilot author</span>
    </div>
  </div>
  <div class="foot">
    <div>A talk about AI · organizations · individuals</div>
    <div>— 2026 —</div>
  </div>
</section>
```

**Key points**:
- Use `hero dark` so the WebGL background shows through most of the page.
- `h-hero` is the largest type size (10vw), used here as the title key visual.
- Use `min-height:80vh + align-content:center` to vertically center the overall content.
- Do not put a page number in `.chrome`; the cover stands on its own.

---

## Layout 2: Act Divider (Act Divider)

```html
<section class="slide hero light">
  <div class="chrome">
    <div>Act One · Hard data</div>
    <div>Act I · 01 / 25</div>
  </div>
  <div class="frame" style="display:grid; gap:6vh; align-content:center; min-height:80vh">
    <div class="kicker">Act I</div>
    <h1 class="h-hero" style="font-size:8.5vw">Hard data</h1>
    <p class="lead" style="max-width:55vw">
      Look at the numbers first, then discuss the method.
    </p>
  </div>
  <div class="foot">
    <div>Act One lead-in</div>
    <div>— · —</div>
  </div>
</section>
```

**Key points**:
- Keep it minimal: only a kicker, large title, and one-line pull quote.
- Covers for two acts can alternate `hero light` / `hero dark` to create rhythm.
- Adjust `h-hero` from 10vw to 8.5vw for title length.

---

## Layout 3: Big Numbers Grid (Big Numbers Grid)

```html
<section class="slide light">
  <div class="chrome">
    <div>The past 64 days · development</div>
    <div>Act I / Dev · 02 / 25</div>
  </div>
  <div class="frame" style="padding-top:6vh">
    <div class="kicker">What did one person do?</div>
    <h2 class="h-xl">The past 64 days</h2>
    <p class="lead" style="margin-bottom:5vh">From zero to open-source CodePilot.</p>

    <div class="grid-6" style="margin-top:6vh">
      <div class="stat-card">
        <div class="stat-label">Duration</div>
        <div class="stat-nb">64 <span class="stat-unit">days</span></div>
        <div class="stat-note">From zero to now</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Lines of Code</div>
        <div class="stat-nb">110K+</div>
        <div class="stat-note">Written line by line to 110K+</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">GitHub Stars</div>
        <div class="stat-nb">5,166</div>
        <div class="stat-note">One open-source repository</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Downloads</div>
        <div class="stat-nb">41K+</div>
        <div class="stat-note">Installed on tens of thousands of computers</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">AI Providers</div>
        <div class="stat-nb">19</div>
        <div class="stat-note">Cross-platform integration</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Commits</div>
        <div class="stat-nb">608+</div>
        <div class="stat-note">No collaborators</div>
      </div>
    </div>
  </div>
  <div class="foot">
    <div>Project · CodePilot　|　github.com/codepilot</div>
    <div>Act I · Dev Numbers</div>
  </div>
</section>
```

**Key points**:
- A 3×2 or 4×2 grid is most reliable (see `.grid-6`).
- Every `stat-card` has a fixed structure: label (small English text) → nb (large number) → note (annotation).
- Keep numbers to 2–3 characters (longer values overflow); use K / M abbreviations.
- Leave more than 5vh of top buffer so the title area attracts attention first.

---

## Layout 4: Text Left, Image Right (Quote + Image)

```html
<section class="slide light">
  <div class="chrome">
    <div>Identity contrast · The Twist</div>
    <div>03 / 25</div>
  </div>
  <div class="frame grid-2-7-5" style="padding-top:6vh">
    <!-- Left column: title + body + callout; flex column places callout at column bottom -->
    <div style="display:flex; flex-direction:column; justify-content:space-between; gap:3vh">
      <div>
        <div class="kicker">BUT</div>
        <h2 class="h-xl" style="white-space:nowrap; font-size:7.2vw">
          I am not a programmer.
        </h2>
        <p class="lead" style="margin-top:3vh">
          After graduating from university, I did not write another line of code. For the past decade, I worked in UI design and AI visual effects.
        </p>
      </div>
      <div class="callout">
        "Three years ago, this<br>
        would have taken a ten-person team one year."
        <div class="callout-src">— An observer's assessment</div>
      </div>
    </div>
    <!-- Right column: use standard 16/10 image ratio + max-height; do not use align-self:end -->
    <figure class="frame-img" style="aspect-ratio:16/10; max-height:56vh">
      <img src="images/codepilot.png" alt="CodePilot product screenshot">
      <figcaption class="img-cap">CodePilot · product screenshot</figcaption>
    </figure>
  </div>
  <div class="foot">
    <div>Page 03 · I am not a programmer</div>
    <div>— · —</div>
  </div>
</section>
```

**Key points**:
- Use `grid-2-7-5` (seven left parts, five right parts); `align-items:start` is already preset in the template.
- Use a flex column with `justify-content:space-between` for the **left column**: the title stays at the top and the callout naturally sits at the bottom.
- **Do not add `align-self:end` to the right-column image**. It makes the image slide to the bottom of the cell and can hide it behind browser chrome on low-resolution screens.
- Images must use a **standard 16/10 or 4/3 ratio + `max-height:56vh`**; do not use unusual source ratios such as `2592/1798`.

---

## Layout 5: Image Grid (Multi-image Comparison)

```html
<section class="slide light">
  <div class="chrome">
    <div>Platform follower proof</div>
    <div>Act I / Ops · 05 / 27</div>
  </div>
  <div class="frame" style="padding-top:5vh">
    <div class="kicker">Proof · follower proof</div>
    <h2 class="h-xl">10 platforms · 6 screenshots</h2>

    <div class="grid-3-3" style="margin-top:4vh">
      <figure class="frame-img" style="height:26vh">
        <img src="images/weibo.png" alt="Weibo 289K">
        <figcaption class="img-cap">Weibo · 289K</figcaption>
      </figure>
      <figure class="frame-img" style="height:26vh">
        <img src="images/twitter.png" alt="Twitter 137K">
        <figcaption class="img-cap">Twitter · 137K</figcaption>
      </figure>
      <figure class="frame-img" style="height:26vh">
        <img src="images/wechat.png" alt="WeChat Official Account 96K">
        <figcaption class="img-cap">WeChat Official Account · 96K</figcaption>
      </figure>
      <figure class="frame-img" style="height:26vh">
        <img src="images/jike.png" alt="Jike 26K">
        <figcaption class="img-cap">Jike · 26K</figcaption>
      </figure>
      <figure class="frame-img" style="height:26vh">
        <img src="images/xhs.png" alt="Xiaohongshu 19K">
        <figcaption class="img-cap">Xiaohongshu · 19K</figcaption>
      </figure>
      <figure class="frame-img" style="height:26vh">
        <img src="images/douyin.png" alt="Douyin 10K">
        <figcaption class="img-cap">Douyin · 10K</figcaption>
      </figure>
    </div>
  </div>
  <div class="foot">
    <div>Screenshot date · 2026.04</div>
    <div>Page 05 · follower proof</div>
  </div>
</section>
```

**Key points**:
- Critical: every `frame-img` must set a fixed `height:NNvh` (do not use `aspect-ratio`) or the grid will break.
- Images automatically use `object-fit:cover + object-position:top`, cropping only the bottom.
- Use `.grid-3-3` (3×2) or `.grid-3` (3×1) to hold them.

---

## Layout 6: Two-column Pipeline (Pipeline)

```html
<section class="slide light">
  <div class="chrome">
    <div>My workflow · Workflow</div>
    <div>Act II · 15 / 27</div>
  </div>
  <div class="frame">
    <div class="kicker">Pipeline · flow</div>
    <h2 class="h-xl">Two pipelines</h2>

    <!-- First group: text side -->
    <div class="pipeline-section">
      <div class="pipeline-label">Text side · Text Pipeline</div>
      <div class="pipeline">
        <div class="step">
          <div class="step-nb">01</div>
          <div class="step-title">Draft</div>
          <div class="step-desc">AI drafts the first version</div>
        </div>
        <div class="step">
          <div class="step-nb">02</div>
          <div class="step-title">Polish</div>
          <div class="step-desc">AI polishes it and removes the AI feel</div>
        </div>
        <div class="step">
          <div class="step-nb">03</div>
          <div class="step-title">Morph</div>
          <div class="step-desc">AI turns it into Twitter / Xiaohongshu posts</div>
        </div>
        <div class="step">
          <div class="step-nb">04</div>
          <div class="step-title">Illustrate</div>
          <div class="step-desc">AI generates infographics</div>
        </div>
        <div class="step">
          <div class="step-nb">05</div>
          <div class="step-title">Distribute</div>
          <div class="step-desc">Distribute to nine platforms in one click</div>
        </div>
      </div>
    </div>

    <!-- Second group: video side -->
    <div class="pipeline-section">
      <div class="pipeline-label">Visual · video side · Video Pipeline</div>
      <div class="pipeline">
        <div class="step">
          <div class="step-nb">06</div>
          <div class="step-title">Cut</div>
          <div class="step-desc">AI helps with editing</div>
        </div>
        <div class="step">
          <div class="step-nb">07</div>
          <div class="step-title">Wrap</div>
          <div class="step-desc">AI helps package the video</div>
        </div>
        <div class="step">
          <div class="step-nb">08</div>
          <div class="step-title">Cover</div>
          <div class="step-desc">AI generates the cover</div>
        </div>
      </div>
    </div>
  </div>
  <div class="foot">
    <div>Page 15 · My content factory</div>
    <div>Workflow</div>
  </div>
</section>
```

**Key points**:
- Group with `.pipeline-section` and use `.pipeline-label` as the group title.
- Leave 3.6vh between the two groups plus a thin top divider (already preset in CSS).
- Every step has the fixed nb → title → desc structure.
- The number of steps is unlimited, but keep a row to ≤5; otherwise move to a second pipeline.

---

## Layout 7: Suspense Close / Question Page (Hero Question)

```html
<section class="slide hero dark">
  <div class="chrome">
    <div>A question for you</div>
    <div>24 / 27</div>
  </div>
  <div class="frame" style="display:grid; gap:8vh; align-content:center; min-height:80vh">
    <div class="kicker">The Question</div>
    <h1 class="h-hero" style="font-size:7vw; line-height:1.15">
      In your company,<br>
      which roles should<br>
      never have been human work?
    </h1>
    <p class="lead" style="max-width:50vw">
      This is not a technical question; it is an architectural question.
    </p>
  </div>
  <div class="foot">
    <div>Page 24 · The Question</div>
    <div>— · —</div>
  </div>
</section>
```

**Key points**:
- The more white space on a hero page, the better; put only one question there.
- Adjust `h-hero` size for length (7vw suits three lines, 10vw suits one line).
- Insert `<br>` manually so line breaks follow semantic boundaries.
- Add one `lead` line at the end to make the point explicit.

---

## Layout 8: Big Quote Page (Big Quote · Serif Key Quote)

```html
<section class="slide light">
  <div class="chrome">
    <div>The Takeaway · key quote</div>
    <div>18 / 25</div>
  </div>
  <div class="frame" style="display:grid; gap:5vh; align-content:center; min-height:80vh">
    <div class="kicker">Quote · key line</div>
    <blockquote style="font-family:var(--serif-zh); font-weight:700; font-size:5.8vw; line-height:1.2; letter-spacing:-.01em; max-width:72vw">
      "There is no handoff;<br>everyone is building."
    </blockquote>
    <p class="lead" style="max-width:55vw; opacity:.65">
      Without the handoff, everyone builds.<br>
      And that makes all the difference.
    </p>
    <div class="meta-row">
      <span>— Luke Wroblewski</span><span>·</span><span>2026.04.16</span>
    </div>
  </div>
  <div class="foot">
    <div>Page 18 · key quote</div>
    <div>— · —</div>
  </div>
</section>
```

**Key points**:
- Leave the whole page open and place only one big quote plus its source.
- Enlarge `<blockquote>` independently with inline style (5–6vw); do not use `h-hero` (that name is for the page's main title).
- Follow it with the English original (lead · opacity:.65) to create hierarchy.
- Use `meta-row` for source · date.

---

## Layout 9: Side-by-side Comparison (A vs B · Old vs New)

```html
<section class="slide light">
  <div class="chrome">
    <div>Old vs new · The Shift</div>
    <div>12 / 25</div>
  </div>
  <div class="frame" style="padding-top:5vh">
    <div class="kicker">Before / After · paradigm shift</div>
    <h2 class="h-xl" style="margin-bottom:4vh">From handoff to co-creation</h2>

    <div class="grid-2-6-6" style="gap:5vw 4vh">
      <!-- Left column: old -->
      <div style="padding:3vh 2vw; border-left:3px solid currentColor; opacity:.55">
        <div class="kicker" style="opacity:.9">Before · old model</div>
        <h3 class="h-md" style="margin-top:2vh">Design → development → handoff</h3>
        <ul style="margin-top:3vh; padding-left:1.2em; display:flex; flex-direction:column; gap:1.4vh; font-family:var(--sans-zh); font-size:max(14px,1.1vw); line-height:1.55">
          <li>Designers create files in Figma</li>
          <li>Developers translate pixels while staring at the files</li>
          <li>Repeated PR communication to align details</li>
          <li>Non-technical people cannot touch the code</li>
        </ul>
      </div>
      <!-- Right column: new -->
      <div style="padding:3vh 2vw; border-left:3px solid currentColor">
        <div class="kicker" style="opacity:.9">After · new model</div>
        <h3 class="h-md" style="margin-top:2vh">Shared tools · parallel work · co-creation</h3>
        <ul style="margin-top:3vh; padding-left:1.2em; display:flex; flex-direction:column; gap:1.4vh; font-family:var(--sans-zh); font-size:max(14px,1.1vw); line-height:1.55">
          <li>Three roles work in Intent at the same time</li>
          <li>agents.md serves as shared context</li>
          <li>Agents handle alignment / conflicts / animation</li>
          <li>Anyone can contribute code safely</li>
        </ul>
      </div>
    </div>
  </div>
  <div class="foot">
    <div>Page 12 · paradigm shift</div>
    <div>Before / After</div>
  </div>
</section>
```

**Key points**:
- Use `.grid-2-6-6` (1:1) to split the page in half.
- Use `opacity:.55` in the left column to weaken the “old” visual, and full brightness in the right column to emphasize the “new”.
- Give both columns a quotation-block feel with `border-left:3px solid` + `padding-left`.
- Keep each column's structure consistent: `kicker` → `h-md` → `<ul>` points, with matching rhythm.

---

## Layout 10: Mixed Text and Image (Lead Image + Side Text)

```html
<section class="slide light">
  <div class="chrome">
    <div>Design First · design first</div>
    <div>08 / 16</div>
  </div>
  <div class="frame grid-2-8-4" style="padding-top:6vh">
    <!-- Left column: long body copy + quote -->
    <div>
      <div class="kicker">Phase 01 · design phase</div>
      <h2 class="h-xl" style="margin-top:1vh; margin-bottom:3vh">Design first · 2 weeks</h2>

      <p class="lead" style="margin-bottom:3vh">
        Complete visual exploration and the design system in Figma: grids / typography / color variables / reusable components, with several feedback iterations for desktop and mobile comps.
      </p>

      <p style="font-family:var(--sans-zh); font-size:max(14px,1.15vw); line-height:1.75; opacity:.78; margin-bottom:2.4vh">
        Within two weeks, the visual style, rough structure, and directional content all stabilize. This is a solid traditional design process — nothing novel yet.
      </p>

      <div class="callout" style="margin-top:3vh">
        "This phase was pretty standard.<br>Just a solid Web design process."
        <div class="callout-src">— Luke Wroblewski</div>
      </div>
    </div>
    <!-- Right column: supporting image · portrait or square -->
    <figure class="frame-img" style="aspect-ratio:3/4; max-height:60vh">
      <img src="images/figma.png" alt="Figma design system">
      <figcaption class="img-cap">Figma · Design System</figcaption>
    </figure>
  </div>
  <div class="foot">
    <div>Page 08 · Design First</div>
    <div>About 2 weeks</div>
  </div>
</section>
```

**Key points**:
- `.grid-2-8-4` (8:4) lets body copy lead while the image supports it.
- The left column contains several information levels: kicker → large title → lead → body paragraphs → callout (quote).
- Use a **portrait 3:4** or square 1:1 image in the right column to avoid competing with the left text.
- This layout suits pages with **more information density** (unlike Layout 4, which has only one key quote).

---

## Appendix: Common grid templates

| Class name | Ratio | Use |
|---|---|---|
| `.grid-2-6-6` | 6:6 (1:1) | Split in half |
| `.grid-2-7-5` | 7:5 | Text-led + supporting image |
| `.grid-2-8-4` | 8:4 (2:1) | Long text + small image/data |
| `.grid-3` | 1:1:1 | Three parallel items (cases/screenshots) |
| `.grid-3-3` | 3×2 | Six-image matrix |
| `.grid-6` | 3×2 | Six data cards |

All grids reserve `gap: 3vw 4vh` (3vw horizontal, 4vh vertical), which can be overridden individually.

---

## Suggested page rhythm

For a 25–30-page talk, use the following recommended rhythm:

1. **Hero Cover** (page 1)
2. **Act Divider** (opening of Act One, hero light or hero dark)
3. **Big Numbers** (lead with hard data for impact)
4. **Quote + Image** (tell an identity-contrast story / hook)
5. **Image Grid** (support with evidence)
6. **Hero Question** (end the act, leave suspense)
7. ... repeat the same rhythm for Acts Two and Three ...
8. **Hero Close** (last page, question or thanks)

Hero and non-hero pages should alternate at a **2–3 : 1 ratio**; do not use more than three consecutive non-hero pages or two consecutive hero pages.
