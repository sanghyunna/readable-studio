# Magazine Directions

Five **preset directions** package the theme palette, layouts, slide count, and chrome copy together, so you do not offer five unrelated choices across six clarification questions.

> Inspired by [alchaincyf/huashu-design](https://github.com/alchaincyf/huashu-design)'s "20 design philosophies × 5 streams". We reduce it to five magazine-flavored directions; each maps to a theme in `themes.md` and a combination in `layouts.md`.

---

## When to use this document

At the beginning of SKILL.md's `Step 1 · Requirements clarification`: **have the user choose one of these five directions first**, then ask about theme color, duration, audience, and outline. The flow is:

```
1. The user says, "I want to make a presentation."
2. You (the agent) introduce the five directions (copy the one-line summaries below).
3. The user chooses a direction (or says, "I don't know; recommend one").
4. Answer the two questions about theme color and slide count for the chosen direction, then ask the other four.
```

**Hard rule**: choose only from these five directions; do not mix them. Mixing directions follows a known failing path from huashu-design (brand asset protocol v1). If the user dislikes all five, gently guide them to the closest one, then allow small tone adjustments in `chrome` / `kicker` only; **never recolor it**.

---

## 1. Monocle Editorial · International magazine style ✦ Default recommendation

**Keywords**: restrained, knowledgeable, international, with *taste*

| Recipe | Choice |
|---|---|
| Theme color | 🖋 Classic ink |
| Recommended slide count | 18–24 slides (60% non-hero / 40% hero) |
| Primary layouts | **1 Cover / 2 Chapter break / 4 Text left, image right / 8 Large quote / 10 Mixed text and image** |
| Chrome copy | `Vol.04 · Spring 2026` / `Act II · 12 / 24` / `lukew.com · 2026.04` |
| Kicker style | Short English plus middle dot: `THE TWIST` / `BUT` / `DEC.` |
| Foot copy | `Page 12 · A new way of working` |

**Good for**: business launches, internal industry talks, product announcements, and personal-brand sharing. **Choose this by default**; it is hard to go wrong.

**Counterexamples**: deep technical reports (too sparse) and operations retrospectives with lots of tables (no suitable layout).

**Visual anchors**: *Monocle* / *Apricot Magazine* / *A Book Apart* / *Apartamento*.

---

## 2. WIRED Tech · Data + engineering

**Keywords**: hard data, pipelines, comparisons, a sense of the future

| Recipe | Choice |
|---|---|
| Theme color | 🌊 Indigo porcelain |
| Recommended slide count | 14–18 slides (compact and data-dense) |
| Primary layouts | **1 Cover / 3 Data poster / 6 Pipeline / 7 Problem page / 9 Before/After** |
| Chrome copy | `Q2 / 2026 · Field Report` / `Data · 03` / `Eng Notes` |
| Kicker style | All caps plus number: `38× FASTER` / `RUNTIME 04` / `CASE 02` |
| Foot copy | `Page 03 · benchmark` / `methodology footnote` |

**Good for**: technical launches, research sharing, benchmark reports, engineering-team communication, and AI product demo days.

**Counterexamples**: humanities quote collections (too cold) and art brands (not warm enough).

**Visual anchors**: *WIRED* long-form editions / *MIT Technology Review* / *The Pudding* / *Stripe Press*.

**Special guidance**: set every stat-card's `stat-label` in monospaced English (central to the WIRED feel). Do not use thousands separators in numbers (not engineering enough); abbreviate with `K` / `M` / `×`.

---

## 3. Kinfolk Slow · Slow living / humanities

**Keywords**: whitespace, serif type, warmth, private salons

| Recipe | Choice |
|---|---|
| Theme color | 🍂 Kraft paper |
| Recommended slide count | 9–12 slides (slow, relaxed, low density) |
| Primary layouts | **1 Cover / 4 Text left, image right / 8 Large quote / 10 Mixed text and image / 2 Chapter break** |
| Chrome copy | `Vol.07 · Autumn` / `A letter · 03` / `Notes from Kyoto` |
| Kicker style | Short phrase plus punctuation: "For a friend." / "Late autumn." / "Letter Three" |
| Foot copy | `Page 03 · Letter Three` / `2026 · Spring Issue` |

**Good for**: private salons, book talks, interview retrospectives, lifestyle brands, and personal essays.

**Counterexamples**: product launches (too slow), technical talks (too soft), and serious data (insufficient information density).

**Visual anchors**: *Kinfolk* / *The Gentlewoman* / *Cereal* / *Drift Magazine*.

**Special guidance**:
- **Deliberately keep the slide count below 10** — Kinfolk's core is "less is more"; do not cram it full.
- Use Layout 8 (large quote) and Layout 10 (mixed text and image) extensively.
- Do not use Layout 3 (data poster) — it conflicts with the mood.
- Set `<title>` text, chapter names, and kickers in serif type with short phrases.

---

## 4. Domus Architectural · Architecture / spatial feeling

**Keywords**: scale, geometry, asymmetry, restrained showmanship

| Recipe | Choice |
|---|---|
| Theme color | 🌙 Dune |
| Recommended slide count | 12–18 slides (medium density, visually strong) |
| Primary layouts | **1 Cover / 2 Chapter break / 5 Image grid / 9 Before/After / 10 Mixed text and image** |
| Chrome copy | `Spazio 09 · Project File` / `Plan · 03` / `Fig.4` |
| Kicker style | Number plus category: `PROJECT 04` / `SECTION B` / `FIGURE 12` |
| Foot copy | `Page 09 · West Wing` / `1:200 scale` |

**Good for**: design and architecture case studies, product-design reviews, brand visual launches, and gallery-style portfolio presentations.

**Counterexamples**: quote collections (too hard) and technical deep dives (poor at pipelines).

**Visual anchors**: *Domus* / *Apartamento* / *Mark Magazine* / *Pin-Up*.

**Special guidance**:
- **Leave 60% of every hero slide empty** — do not cram it full; the architectural feeling comes from breathing room.
- Use Layout 5 (image grid) extensively but **place only four large images**, never six small ones.
- Keep `chrome` copy austere, entirely in English and numbers.

---

## 5. Lab / Reference · Academic + craft manual

**Keywords**: restrained, visual and tabular, reproducible, loved by engineers

| Recipe | Choice |
|---|---|
| Theme color | 🌿 Forest ink |
| Recommended slide count | 16–24 slides (high density, with charts and tables) |
| Primary layouts | **1 Cover / 2 Chapter break / 3 Data poster / 6 Pipeline / 9 Before/After** |
| Chrome copy | `Field Notes · Vol.II` / `Section 3.2 · Method` / `Reference 04` |
| Kicker style | Numbering: `§ 3.2` / `Ref. 04` / `Method 01` |
| Foot copy | `Page 12 · 3.2 Calibration` / `appendix A` |

**Good for**: academic presentations, internal research retrospectives, sustainability and nature themes, long-running product retrospectives, and methodical craft-sharing (coffee, fragrance, tea).

**Counterexamples**: commercial launches (too calm) and marketing campaigns (not catchy enough).

**Visual anchors**: *National Geographic* (older editions) / *Hand-Eye Magazine* / *Nautilus* / *MIT Press* book layouts.

**Special guidance**:
- Use `meta-row` heavily to label sources, methods, and references.
- Use `<figcaption class="img-cap">` **more frequently than the other directions** to number each image.
- Use section numbers in `kicker`, not exclamatory sentences.

---

## Recommendation quick reference (which direction to choose for a stated intent)

| What the user says | Recommended direction |
|---|---|
| "General presentation" / "I don't know what to choose" | **1. Monocle** |
| "Solo company / AI compression / startup demo day" | **1. Monocle** (default) or **2. WIRED** (if technical) |
| "AI / benchmark / model evaluation" | **2. WIRED** |
| "Product launch / engineering-team presentation" | **2. WIRED** |
| "Book talk / interview / one person's story" | **3. Kinfolk** |
| "Private salon / sharing with friends / weekend-chat style" | **3. Kinfolk** |
| "Design case study / brand launch / portfolio presentation" | **4. Domus** |
| "Architecture / space / installation" | **4. Domus** |
| "Academic / research / methodology / tutorial" | **5. Lab** |
| "Sustainability / environmental protection / nature theme" | **5. Lab** |

---

## Decision record (required before generation)

After choosing a direction, **create or update `Project Record.md`** (or `Outline-v1.md`) in the project directory. The first line must state:

```markdown
# [Talk title] · Project Record

- Direction: **Monocle Editorial** (from `references/styles.md`)
- Theme: 🖋 Classic ink
- Audience: Internal team (product + design)
- Duration: 25 min · approximately 18 slides
- Chrome style: Vol.04 / Act II / 12 of 18
- Kicker style: Short English plus middle dot
```

Update this section whenever later iterations adjust the direction. **Do not switch directions halfway through** — the tonal difference among the five directions is larger than it appears; mixing them tears the deck apart.

---

## ❌ Do not

- ❌ Mix layout choices from the five directions (for example, Monocle with several Layout 6 Pipeline pages plus Kinfolk chrome) — it becomes cluttered.
- ❌ Invent a sixth direction yourself ("I want a technology + art-literature style") — gently guide the user to the nearest choice and explain that mixed directions have historically failed at a high rate.
- ❌ Switch direction halfway through, such as deciding on slide 8 that "Kinfolk would be better" — the first seven slides are wasted; either rebuild everything or stay with the original direction.
- ❌ Spend time on layouts outside the chosen direction (for example, four Kinfolk Layout 6 Pipeline pages) — that signals the wrong direction was chosen.

## ✅ Do

- ✅ Choose only among the five directions; use the chosen direction to answer the other five clarification questions.
- ✅ State the direction explicitly on the first line of `Project Record.md`, and keep it unchanged throughout.
- ✅ Let chrome, kicker, and foot copy speak for the direction — together they carry half of its recognizability.
- ✅ When uncertain, **default to Monocle Editorial** — it is the safest fallback of the five directions.
