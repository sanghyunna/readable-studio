# Themes catalog

Every theme is a short CSS file in `assets/themes/` that overrides tokens
defined in `assets/base.css`. Switch themes by changing the `href` of
`<link id="theme-link">` or by pressing **T** if the deck has a
`data-themes="a,b,c"` attribute on `<body>` or `<html>`.

All themes define the same variables: `--bg`, `--bg-soft`, `--surface`,
`--surface-2`, `--border`, `--text-1/2/3`, `--accent`, `--accent-2/3`,
`--good`, `--warn`, `--bad`, `--grad`, `--grad-soft`, `--radius*`, `--shadow*`,
`--font-sans`, `--font-display`.

## Light & calm

| name | description | when to use |
|---|---|---|
| `minimal-white` | minimalist white, Restrain advanced.Inter, Strong text hierarchy, Very low shadow. | internal reporting, One-on-one technical review, Serious topics that don’t steal content |
| `editorial-serif` | magazine style Playfair serif + Cream base. | Brand story, Long speeches with dense text |
| `soft-pastel` | Soft macaron three-color gradient. | product launch, For consumers, light topic |
| `xiaohongshu-white` | little red book white background + warm red accent + serif title. | Little red book pictures and texts, Life/Aesthetic content |
| `solarized-light` | Classic low-glare color scheme. | long viewing workshop, teaching |
| `catppuccin-latte` | catppuccin light color. | Developer, Geek-friendly technology sharing |

## Bold & statement

| name | description | when to use |
|---|---|---|
| `sharp-mono` | pure black and white + Archivo Black + hard shadow. | Declaration, Highly impactful visuals |
| `neo-brutalism` | thick stroke, hard shadow, bright yellow accent. | Entrepreneurship Roadshow, Dare to speak and act |
| `bauhaus` | geometry + Red, yellow and blue primary colors. | design talk, art history/Product aesthetic theme |
| `swiss-grid` | swiss grid + Helvetica feel + 12 column shading. | serious typesetting, design industry |
| `memphis-pop` | Memphis pop background dots + big font title. | young, trend, Brand cooperation |

## Cool & dark

| name | description | when to use |
|---|---|---|
| `catppuccin-mocha` | catppuccin deep. | Shared within developers, long viewing |
| `dracula` | classic Dracula Main color purple. | Code-intensive technology sharing |
| `tokyo-night` | Tokyo Night blue night. | Sharing of cold technology, infrastructure |
| `nord` | Nordic cool blue and white. | infrastructure, Cloud products |
| `gruvbox-dark` | Warm retro dark color. | Terminal / vim / *nix community |
| `rose-pine` | rose pine, Soft dark colors. | design+development interface, Aesthetics to technology |
| `arctic-cool` | blue/green/slate gray Light version. | business analysis, finance, Calm and rational |

## Warm & vibrant

| name | description | when to use |
|---|---|---|
| `sunset-warm` | Orange / coral / Amber three color gradient. | lifestyle, Award presentation, Positive emotions |

## Effect-heavy

| name | description | when to use |
|---|---|---|
| `glassmorphism` | frosted glass + Multicolor light spots background. | Apple press conference, Product feature display |
| `aurora` | Aurora gradient + blur + saturate. | cover / CTA / Conclusion page |
| `rainbow-gradient` | white background + rainbow flowing gradient accent. | Happy to, festival, celebration page |
| `blueprint` | blueprint project + grid shading + Montage font. | System architecture, Engineering blueprint |
| `terminal-green` | green screen terminal + Equal width + Luminous text. | CLI/black-hat/retro punk |

## v2 additions

### Light & professional

| name | description | when to use |
|---|---|---|
| `corporate-clean` | pure white + navy blue accent + Inter + conservative border. | Board report, B2B Sale, Financial insurance |
| `pitch-deck-vc` | YC wind white background + blue-purple gradient accent + big white space. | Financing roadshow, Seed round, VC meeting |
| `academic-paper` | Paper white + Serif body text + black ink + blue link. | academic report, Research sharing, conference papers |
| `japanese-minimal` | ivory white + red accent + Great white space + Noto Serif. | Brand upgrade, Craftsman story, Zen narrative |
| `engineering-whiteprint` | white background + graph paper grid + navy ink line + monospaced characters. | System design, API document, Architecture White Paper |

### Bold & editorial

| name | description | when to use |
|---|---|---|
| `magazine-bold` | Cream base + Extra large Playfair serif + orange color spot. | Column article, cover story, Brand Monthly |
| `news-broadcast` | white background + red vertical bar + Oswald capital + hard shadow. | breaking news, Release press release, Data broadcast |
| `midcentury` | Cream base + mustard/green/burnt orange + sharp geometry. | design history, home aesthetics, vintage brand |
| `retro-tv` | warm cream + CRT scan line + amber orange accent. | nostalgic narrative, 80s and 90s theme |

### Effect-heavy / dramatic

| name | description | when to use |
|---|---|---|
| `cyberpunk-neon` | pure black + Neon pink green and yellow + glow + JetBrains Mono. | hacker, underground culture, Cyber talk |
| `vaporwave` | deep purple + pink cyan blue gradient + Blooming spots. | music, trendy art, A E S T H E T I C |
| `y2k-chrome` | silver chrome gradient + rainbow accent + Large rounded corners + Space Grotesk. | Millennial Nostalgia, fashion brand, Gen-Z |

## How to apply

```html
<link rel="stylesheet" id="theme-link" href="../assets/themes/aurora.css">
```

Or enable `T`-cycling by listing themes on the body:

```html
<body data-themes="minimal-white,aurora,catppuccin-mocha" data-theme-base="../assets/themes/">
```

## How to extend

Copy an existing theme, rename it, and override only the variables you want to
change. Keep each theme under ~200 lines. Prefer adjusting tokens to adding
new selectors.
