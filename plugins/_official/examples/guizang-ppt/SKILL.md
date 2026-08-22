---
name: magazine-web-ppt
description: Generates a horizontal-swipe web PPT (single HTML file) in an "electronic magazine x e-ink" style, with a WebGL fluid background, serif headings + sans-serif body text, chapter title cards, big-number data slides, image grids, and more templates. Use when the user needs to create a web PPT for a talk, presentation, or launch event, or mentions "magazine-style PPT", "horizontal swipe deck", "editorial magazine", or "e-ink presentation".
triggers:
  - "ppt"
  - "deck"
  - "slides"
  - "presentation"
  - "magazine"
- "magazine"
  - "Magazine style PPT"
  - "horizontal swipe"
  - "horizontal swipe deck"
  - "editorial magazine"
  - "e-ink presentation"
  - "Webpage PPT"
  - "press conference"
  - "Share PPT"
readable:
  mode: deck
  scenario: marketing
  featured: 9
  default_for: deck
  upstream: "https://github.com/op7418/guizang-ppt-skill"
  preview:
    type: html
    entry: index.html
  design_system:
    requires: false
  example_prompt: "Create a magazine-style PPT about 'One-person companies: organizations folded by AI' for a 25-minute talk aimed at designers and founders. First recommend one direction for me to choose from: Monocle, WIRED, Kinfolk, Domus, or Lab."
---

# Magazine Web Ppt

## What this skill does

Generates a **single-file HTML** horizontal-swipe PPT with this visual tone:

- **Electronic magazine + e-ink** hybrid style
- **WebGL fluid / contour / dispersion background** (visible on hero slides)
- **Serif headings (Noto Serif SC + Playfair Display) + sans-serif body text (Noto Sans SC + Inter) + monospace metadata (IBM Plex Mono)**
- **Lucide line icons** (no emoji)
- **Horizontal left/right paging** (keyboard ← →, scroll wheel, touch swipe, bottom dots, ESC index)
- **Smooth theme interpolation**: colors and the shader ease smoothly when paging into a hero slide

The aesthetic of this skill is neither "corporate PPT" nor "consumer internet UI" — it looks like *Monocle* magazine given a coat of code.

## When to use it

**Good fit**:
- In-person talks / internal industry talks / private sharing sessions
- AI product launches / demo days
- Talks with a strong personal style
- Web-based slides you want to build once with no separate paging tool

**Poor fit**:
- Large data tables or overlapping charts (use a regular PPT)
- Training courseware (information density is too low)
- Content that needs multi-person collaborative editing (this is static HTML)

## Workflow

### Step 0 · Pick a direction (Direction · mandatory first step)

**Before asking the 6 clarifying questions, have the user pick one of 5 magazine directions first**. Each direction bundles a theme color, recommended layout, chrome style, and recommended slide count — picking a direction answers half of the clarifying questions up front.

Open `references/styles.md`, **copy the whole section over** to show the user the 1-line summary of the 5 directions, then let them choose:

```
1. Monocle Editorial · international-magazine style ✦ default
2. WIRED Tech · data + engineering
3. Kinfolk Slow · slow living / humanistic
4. Domus Architectural · architecture / spatial feel
5. Lab / Reference · academic + craft manual
```

If the user says "I don't know, you recommend one" — **default to Monocle Editorial**, since it has the lowest failure rate. If the user mentions "AI / benchmark / tech launch" — recommend WIRED; "reading / private circle / social feed" — recommend Kinfolk; "design / architecture / portfolio" — recommend Domus; "research / academia / methodology" — recommend Lab.

After picking a direction, create or update `project-record.md` (project-record.md) in the project directory, with the first line stating the direction + theme color + audience + duration (template at the end of `styles.md`). **Never switch direction mid-way** — switching halfway means everything built so far is wasted.

### Step 1 · Requirements clarification (**mandatory before starting work**)

**If the user has already provided a full outline + images**, you can skip straight to Step 2.

**If the user has only given a topic or a vague idea**, align on it using these 6 questions one by one before starting. Don't start writing slides based on guesses — once the structure is wrong, revising later is expensive:

#### 6-question clarification checklist

> Question 5 is already answered during the Step 0 direction pick (direction → theme color). Of the remaining 5 questions below, question 5 can be left blank.

| # | Question | Why it matters |
|---|------|-----------|
| 1 | **Who is the audience? What's the sharing scenario?** (internal industry talk / commercial launch / demo day / private session) | Determines language style and depth |
| 2 | **How long is the talk?** | 15 minutes ≈ 10 slides, 30 minutes ≈ 20 slides, 45 minutes ≈ 25-30 slides (see `styles.md` for the recommended range per direction) |
| 3 | **Is there source material?** (docs / data / an old PPT / article links) | Build on the material if it exists, otherwise help construct it |
| 4 | **Are there images? Where are they?** | See the "image conventions" section below |
| 5 | ~~**Which theme color do you want?**~~ | ✓ Already decided by the direction in Step 0 |
| 6 | **Are there any hard constraints?** (must include XX data / must not mention YY) | Avoids rework |

#### Outline assistance (if the user has no outline)

Use the "narrative arc" template to build the skeleton, then fill in content:

```
Hook           → 1 slide   : open with a contrast / question / hard number that makes people stop
Context         → 1-2 slides : explain the background / who you are / why this talk
Core            → 3-5 slides : the core content, interspersed with Layout 4/5/6/9/10
Shift           → 1 slide   : break expectations / present a new viewpoint
Takeaway        → 1-2 slides : a memorable line / a suspense question / a call to action
```

Align the narrative arc + slide-count plan + theme rhythm table (see `layouts.md`) — **only after all three are aligned** should you move to Step 2.

It's recommended to save the outline as `project-record.md` (project-record.md) or `outline-v1.md` (outline-v1.md) for easier iteration later.

#### Image conventions (tell the user)

Before starting work, make clear to the user:

- **Folder location**: under `project/XXX/ppt/images/` (project/XXX/ppt/images/), at the same level as `index.html`
- **Naming convention**: `{slide-number}-{semantic-name}.{ext}`, e.g. `01-cover.jpg` / `03-figma.jpg` / `05-dashboard.png`
  - Zero-pad the slide number for easy sorting
  - Use English for the semantic part — short, specific, matching the content
- **Spec recommendations**:
  - A single image should be ≥ 1600px wide (avoid blur on large screens)
  - Use JPG for photos/screenshots, PNG for transparent UI/charts
  - Keep the total size under 10MB (affects paging smoothness)
- **How to replace images**: overwriting with the **same filename** is safest (no need to change paths in the HTML); if a filename changes, remember to globally search `images/old-name` and replace it with the new name
- **What if there are no images**: align with the user — you can generate the structure first with placeholder color blocks and add images later, but let them know that image-heavy layouts like 4/5/10 can't be visually verified without images

### Step 2 · Copy the template

Copy `assets/template.html` to the target location (typically `project/XXX/ppt/index.html`, i.e. project/XXX/ppt/index.html), and create an `images/` folder at the same level to receive images.

```bash
mkdir -p "project/XXX/ppt/images"
cp "<SKILL_ROOT>/assets/template.html" "project/XXX/ppt/index.html"
```

`template.html` is a **fully runnable** file — CSS, the WebGL shader, paging JS, and font/icon CDNs are all preconfigured; only the `<main id="deck">` contains 3 example slides (cover, chapter title card, blank filler slide).

#### 2.1 · Placeholders that must be changed (**easy to miss**)

Right after copying, immediately replace the following placeholders, otherwise the browser tab will show an awkward "[REQUIRED] Replace with PPT title" text:

| Location | Original | Replace with |
|------|------|--------|
| `<title>` | `[REQUIRED] Replace with PPT title · Deck Title` | The actual deck title (e.g. `A New Way of Working · Luke Wroblewski`) |

Every time you copy template.html, the first thing to do is grep for "[REQUIRED]" to confirm every placeholder has been replaced.

#### 2.2 · Pick a theme color (5 presets · no custom colors allowed)

This skill **only allows choosing one of 5 carefully tuned presets** — custom hex values from the user are not accepted, since a wrong color combination instantly looks ugly; protecting the aesthetic matters more than giving free choice.

| # | Theme | Good for |
|---|------|------|
| 1 | 🖋 Ink Classic | General-purpose / commercial launches / the default when unsure |
| 2 | 🌊 Indigo Porcelain | Tech / research / data / tech launch events |
| 3 | 🌿 Forest Ink | Nature / sustainability / culture / non-fiction |
| 4 | 🍂 Kraft Paper | Nostalgia / humanities / literature / indie magazines |
| 5 | 🌙 Dune | Art / design / creative / gallery |

**How to proceed**:
1. Recommend a preset based on the content topic, or just ask the user to pick one
2. Open `references/themes.md` and find the `:root` block for the matching theme
3. **Wholesale-replace** the lines marked with a "theme color" comment inside the `:root{` block at the top of `assets/template.html` (the already-copied version) (`--ink` / `--ink-rgb` / `--paper` / `--paper-rgb` / `--paper-tint` / `--ink-tint`)
4. All other CSS goes through `var(--...)`, no other changes needed

**Hard rules**:
- One deck uses one theme only — don't switch colors partway through
- Don't accept arbitrary hex values from the user — politely decline and show the 5 presets to choose from
- Don't mix and match (e.g. taking `ink` from Ink Classic and `paper` from Dune) — it will clash badly

### Step 3 · Fill in content

#### 3.0 · Pre-flight check: every class name must be defined in template.html (**the most important step**)

**This is the root cause of every generation problem**. The skeletons in layouts.md use many class names (`h-hero` / `h-xl` / `stat-card` / `pipeline` / `grid-2-7-5`, etc.) — if `assets/template.html`'s `<style>` block doesn't define the corresponding class, the browser falls back to default styling: big headings turn sans-serif, data cards get crammed together, the pipeline collapses into one line, and images stack up at the bottom of the page.

**Before writing any slide code:**

1. **Read `assets/template.html` first** (at least through the end of the `<style>` block)
2. **Check against the Pre-flight list in layouts.md** and confirm every class you plan to use exists in `<style>`
3. If a class is missing: **add it inside template.html's `<style>` block**, don't rewrite it inline in each slide
4. **template.html is the single source of truth for class names** — don't invent new class names; for custom needs use inline `style="..."`

Classes that are commonly missed (must be confirmed to exist beforehand):
`h-hero` / `h-xl` / `h-sub` / `h-md` / `lead` / `kicker` / `meta-row` / `stat-card` / `stat-label` / `stat-nb` / `stat-unit` / `stat-note` / `pipeline-section` / `pipeline-label` / `pipeline` / `step` / `step-nb` / `step-title` / `step-desc` / `grid-2-7-5` / `grid-2-6-6` / `grid-2-8-4` / `grid-3-3` / `grid-6` / `grid-3` / `grid-4` / `frame` / `frame-img` / `img-cap` / `callout` / `callout-src` / `chrome` / `foot`

#### 3.0.5 · Plan the theme rhythm (**just as important as the class pre-flight check**)

**Before choosing layouts**, you must first list the theme class for every single slide (`hero dark` / `hero light` / `light` / `dark`) and write it into a document or draft to align on. See the "theme rhythm planning" section at the top of `references/layouts.md` for the detailed rules.

**Mandatory rules**:

- Every section must carry one of `light` / `dark` / `hero light` / `hero dark` — don't just write `hero`
- 3 or more consecutive slides with the same theme = visual fatigue, not allowed
- If there are 8+ slides, there must be ≥1 `hero dark` and ≥1 `hero light`
- The whole deck can't be all `light` body slides — there must be `dark` body slides to create breathing room
- Insert 1 hero slide every 3-4 slides (cover / chapter card / question / big quote)

**Self-check after generation**: `grep 'class="slide' index.html` to list every theme used, and manually confirm the rhythm makes sense before delivering.

#### 3.1 · Pick a layout

**Don't write a slide from scratch**. Open `references/layouts.md`, which has 10 ready-made layout skeletons, each a complete, copy-pasteable `<section>` code block:

| Layout | Use for |
|---|---|
| 1. Opening cover | Slide 1 |
| 2. Chapter title card | Start of each act |
| 3. Big-number data slide | Presenting a hard stat |
| 4. Text-left, image-right (Quote + Image) | Identity contrast / storytelling |
| 5. Image grid | Multi-image comparison / screenshot evidence |
| 6. Two-column pipeline | Workflow |
| 7. Suspense close / question slide | End of an act / closing |
| 8. Big quote slide | Serif pull-quote / takeaway |
| 9. Side-by-side comparison (Before / After) | Old pattern vs new pattern |
| 10. Mixed text + image (Lead image + side text) | Information-dense image+text slide |

Pick the matching layout, paste it in, then edit the copy and image paths. **Be sure to finish the 3.0 pre-flight check first**.

#### 3.2 · Image aspect-ratio rules

Always use **standard ratios** — never a raw image's odd native ratio (e.g. `2592/1798`):

| Scenario | Recommended ratio |
|------|---------|
| Text-left, image-right — main image | 16:10 or 4:3 + `max-height:56vh` |
| Image grid (multi-image comparison) | **Fixed `height:26vh`**, don't use aspect-ratio |
| Small image left + text right | 1:1 or 3:2 |
| Full-screen hero visual | 16:9 + `max-height:64vh` |
| Small inset image in mixed text+image | 3:2 or 3:4 |

**Never use `align-self:end` on images** — it will slide down and get clipped by the browser toolbar. Use a grid container + `align-items:start` (already preset in the template) to keep images pinned to the top; if the left column should be pinned to the bottom, use flex column + `justify-content:space-between`.

Component details (fonts, colors, grids, icons, callouts, stat-cards, etc.) are in `references/components.md`.

### Step 4 · Self-check against the checklist

After generating, always open `references/checklist.md` and go through it item by item. It summarizes **every pitfall hit during real iteration**, and the P0-level issues (emoji, images blowing out their container, heading wrapping, font role mixing) must all pass.

A few things to pay special attention to:

1. **Big headings must be serif** — if one renders sans-serif, 99% of the time the 3.0 pre-flight check was skipped and the `h-hero` class is missing from template.html
2. **In image grids, only use `height:Nvh`, never `aspect-ratio`** (it will blow out the container)
3. **Images must not stack at the bottom of the page** — don't use `align-self:end`; use grid + `align-items:start` (see Step 3.2)
4. **Images must only use standard ratios** (16:10 / 4:3 / 3:2 / 1:1 / 16:9) — don't just copy a raw image's odd ratio
5. **CJK headings ≤ 5 characters and `nowrap`** (avoid 1 character per line)
6. **Use Lucide, not emoji**
7. **Headings in serif, body in sans-serif, metadata in monospace**

### Step 5 · Local preview

Just open `index.html` directly in a browser. On macOS:

```bash
open "project/XXX/ppt/index.html"
```

No local server is needed. Images use relative paths like `images/xxx.png`.

### Step 6 · Iterate

Revise based on user feedback — the template's CSS is highly parameterized, so 90% of adjustments are just inline style edits (font size `font-size:Xvw` / height `height:Yvh` / spacing `gap:Zvh`).

---

## Resource file guide

```
magazine-web-ppt/
├── SKILL.md              ← you are reading this
├── assets/
│   ├── template.html     ← the full runnable template (seed file)
│   └── example-slides.html ← a 9-slide sample deck (for the Examples preview)
└── references/
    ├── styles.md         ← 5 magazine directions (Monocle / WIRED / Kinfolk / Domus / Lab)
    ├── components.md     ← component manual (fonts, colors, grids, icons, callouts, stats, pipeline...)
    ├── layouts.md        ← 10 page layout skeletons (ready to paste)
    ├── themes.md         ← 5 preset theme colors (choose only, no customization)
    └── checklist.md      ← quality checklist (P0/P1/P2/P3 tiers)
```

**Recommended loading order**:
1. First read `SKILL.md` (this file) to get the overall picture
2. **When picking a direction in Step 0, read `styles.md`** — each of the 5 directions bundles a theme color + recommended layout + chrome style
3. Once Step 1 clarification is done, if the direction still needs confirming, read `themes.md` for palette details
4. **Before starting work, read the `<style>` block of `assets/template.html`** — this is the single source of truth for class names; a missing class breaks the whole page's styling
5. Read `layouts.md` to pick a layout (top has the Pre-flight class checklist and theme rhythm plan)
6. When adjusting details, read `components.md` for component reference
7. After generating, read `checklist.md` to self-check (the P0-0 rule at the top enforces the pre-flight check)

## Core design principles (philosophy)

> These principles are distilled from 5 rounds of iteration on the "one-person company" talk deck. Violating any one of them will collapse the visual feel.

1. **Restraint over showmanship** — the WebGL background only shows through on hero slides; it's nearly invisible on regular slides
2. **Structure over decoration** — no shadows, no floating cards, no padding boxes; all hierarchy comes from **large type size + font contrast + grid whitespace**
3. **Content hierarchy is defined jointly by size and typeface** — largest serif = main heading, medium serif = subheading, large sans-serif = lead, small sans-serif = body, monospace = metadata
4. **Images are first-class citizens** — only crop from the bottom, keeping the top and both sides intact; grids use a fixed `height:Nvh`, never stretch with `aspect-ratio`
5. **Rhythm comes from hero slides** — alternating hero and non-hero slides keeps the eyes from tiring
6. **Consistent terminology** — "Skills" stays "Skills"; don't mix translated and untranslated terms

## Reference works

The visual tone of this skill draws on:

- Guī Cáng's "One-Person Companies: Organizations Folded by AI" talk (2026-04-22, 27 slides)
- The layout of *Monocle* magazine
- The demo from YC president Garry Tan's "Thin Harness, Fat Skills" blog post

Treat these as style anchors.
