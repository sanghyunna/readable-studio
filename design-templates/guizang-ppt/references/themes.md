# Theme Color Presets

Five carefully tuned palettes preserve the "editorial magazine × electronic ink" aesthetic. **Do not allow custom colors—poor combinations immediately make the deck look worse.** Choose only from the presets below.

---

## How to use a preset

1. Ask the user to choose a preset, or recommend one from the content.
2. Open the `<style>` block in `assets/template.html`.
3. Find the opening `:root{}` block.
4. **Replace as a group** the theme-color lines for `--ink`, `--ink-rgb`, `--paper`, `--paper-rgb`, `--paper-tint`, and `--ink-tint`.
5. All other CSS uses `var(--...)`; no other changes are needed.

---

## 🖋 Ink Classic (Monocle default)

**Best for:** general talks, commercial launches, technology products, and any situation that needs a safe default.
**Tone:** pure ink black with warm off-white; the strongest magazine feel, in the vein of Monocle, Apricot, and A Book Apart.

```css
--ink:#0a0a0b;
--ink-rgb:10,10,11;
--paper:#f1efea;
--paper-rgb:241,239,234;
--paper-tint:#e8e5de;
--ink-tint:#18181a;
```

---

## 🌊 Indigo Porcelain

**Best for:** technology, research, and data talks; engineering culture; deep content; and technical launches.
**Tone:** deep indigo with porcelain white—calm, rational, and substantial, like an academic journal or blue-and-white porcelain.

```css
--ink:#0a1f3d;
--ink-rgb:10,31,61;
--paper:#f1f3f5;
--paper-rgb:241,243,245;
--paper-tint:#e4e8ec;
--ink-tint:#152a4a;
```

---

## 🌿 Forest Ink

**Best for:** nature, sustainability, culture, non-fiction, outdoor brands, and environmental themes.
**Tone:** deep forest green with ivory—grounded and breathable, like a vintage issue of National Geographic.

```css
--ink:#1a2e1f;
--ink-rgb:26,46,31;
--paper:#f5f1e8;
--paper-rgb:245,241,232;
--paper-tint:#ece7da;
--ink-tint:#253d2c;
```

---

## 🍂 Kraft Paper

**Best for:** nostalgic, humanist, reading, history, and literary talks; independent magazines; and handmade brands.
**Tone:** deep brown with warm beige, like a kraft envelope or an old notebook—warm and timeworn.

```css
--ink:#2a1e13;
--ink-rgb:42,30,19;
--paper:#eedfc7;
--paper-rgb:238,223,199;
--paper-tint:#e0d0b6;
--ink-tint:#3a2a1d;
```

---

## 🌙 Dune

**Best for:** art, design, creative, and fashion talks; gallery handbooks; and aesthetics-first private salons.
**Tone:** charcoal gray with sand—restrained, refined, and neutral, like a desert dusk or an architectural monograph.

```css
--ink:#1f1a14;
--ink-rgb:31,26,20;
--paper:#f0e6d2;
--paper-rgb:240,230,210;
--paper-tint:#e3d7bf;
--ink-tint:#2d2620;
```

---

## Quick selection guide

| If the deck is about... | Recommended theme |
|---|---|
| First use or an uncertain choice | 🖋 Ink Classic |
| AI, technology, or product launches | 🌊 Indigo Porcelain |
| Content, industry observation, or culture | 🌿 Forest Ink |
| Book reviews, lifestyle, or humanities | 🍂 Kraft Paper |
| Design, art, or brands | 🌙 Dune |

---

## Switching rules

- **Use one theme per deck**; do not change colors partway through.
- The default WebGL shader accents (titanium dispersion and silver flow) work with all five presets.
- Borders and icons driven by `currentColor` follow the section text color automatically; no additional tuning is required.
- After choosing a theme, use the `<title>` and `chrome` copy to reinforce its meaning—for example, `Vol.03 · Autumn` for Kraft Paper.

## ❌ Do not

- ❌ **Do not mix palettes**—for example, Ink Classic's ink with Dune's paper. The result will clash.
- ❌ **Do not accept an arbitrary hex value**. Politely refuse and offer the five presets.
- ❌ **Do not modify colors elsewhere in `template.html`**. The scattered `rgba` values use variables; change `:root` in one place.

After choosing a theme, tell the user which preset is in use and record it in the deck project notes so later iterations stay consistent.
