# Theme Presets

Five carefully tuned theme palettes preserve the "editorial magazine × electronic ink" aesthetic. **Do not let users customize colors—bad combinations make the result ugly immediately**; choose only from the presets below.

---

## How to use

1. Ask the user which palette they want (or recommend one from the content).
2. Open the `<style>` block in `assets/template.html`.
3. Find the opening `:root{` block.
4. **Replace as a group** the lines marked with the "theme colors" comment: `--ink` / `--ink-rgb` / `--paper` / `--paper-rgb` / `--paper-tint` / `--ink-tint`.
5. All other CSS uses `var(--...)`; no other changes are needed.

---

## 🖋 Classic Ink (Monocle default)

**Best for**: General presentations, business launches, technology products, and a safe default for any setting.
**Tone**: Pure ink black + warm off-white; the strongest magazine feel, in the style of Monocle / Apricot / A Book Apart.

```css
--ink:#0a0a0b;
--ink-rgb:10,10,11;
--paper:#f1efea;
--paper-rgb:241,239,234;
--paper-tint:#e8e5de;
--ink-tint:#18181a;
```

---

## 🌊 Indigo Porcelain (Indigo Porcelain)

**Best for**: Technology, research, and data presentations; engineering culture; deep content; technical launches.
**Tone**: Deep indigo + porcelain white; calm, rational, and deep, like an academic journal or blue-and-white porcelain.

```css
--ink:#0a1f3d;
--ink-rgb:10,31,61;
--paper:#f1f3f5;
--paper-rgb:241,243,245;
--paper-tint:#e4e8ec;
--ink-tint:#152a4a;
```

---

## 🌿 Forest Ink (Forest Ink)

**Best for**: Nature, sustainability, culture, and nonfiction; outdoor brands; environmental themes.
**Tone**: Deep forest green + ivory; grounded and breathable, like an old issue of National Geographic.

```css
--ink:#1a2e1f;
--ink-rgb:26,46,31;
--paper:#f5f1e8;
--paper-rgb:245,241,232;
--paper-tint:#ece7da;
--ink-tint:#253d2c;
```

---

## 🍂 Kraft Paper (Kraft Paper)

**Best for**: Nostalgia, humanities, reading, history, and literature presentations; independent magazines; handmade brands.
**Tone**: Deep brown + warm cream, like a kraft envelope or old notebook: warm and timeworn.

```css
--ink:#2a1e13;
--ink-rgb:42,30,19;
--paper:#eedfc7;
--paper-rgb:238,223,199;
--paper-tint:#e0d0b6;
--ink-tint:#3a2a1d;
```

---

## 🌙 Dune (Dune)

**Best for**: Art, design, creative, and fashion presentations; gallery guides; taste-led private sessions.
**Tone**: Charcoal gray + sand; restrained, refined, and neutral, like desert dusk or an architectural design book.

```css
--ink:#1f1a14;
--ink-rgb:31,26,20;
--paper:#f0e6d2;
--paper-rgb:240,230,210;
--paper-tint:#e3d7bf;
--ink-tint:#2d2620;
```

---

## Selection guide

| If it is... | Recommended theme |
|---|---|
| Unsure what to choose / first use | 🖋 Classic Ink |
| AI / technology / product launch | 🌊 Indigo Porcelain |
| Content / industry observations / culture | 🌿 Forest Ink |
| Book review / lifestyle / humanities | 🍂 Kraft Paper |
| Design / art / brand | 🌙 Dune |

---

## Switching principles

- **Use one theme per deck**; do not switch colors midway.
- WebGL shaders' default primary colors (titanium dispersion / silver flow) work with all five palettes (tested and acceptable).
- Borders and icons driven by `currentColor` automatically follow each section's text color; no additional adjustment is needed.
- After choosing a theme, `<title>` text and `chrome` copy may reinforce its meaning (for example, Kraft Paper with "Vol.03 · Autumn").

## ❌ Do not do this

- ❌ **Do not mix palettes** (for example, ink from Classic Ink and paper from Dune)—the result will clash completely.
- ❌ **Do not allow users to pick an arbitrary hex value**—politely refuse and show the five presets.
- ❌ **Do not edit colors elsewhere in template.html directly**—all scattered rgba values use var; update only `:root`.

After choosing a theme, tell the user in the skill conversation: "Use 🖋 Classic Ink / 🌊 Indigo Porcelain ..." and note it in the deck project record to keep future iterations consistent.
