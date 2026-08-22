# presenter-mode-reveal · Presenter Mode Template

A full-deck template for **technical talks with speaker notes**. Its core feature is a practical **snap-card presenter view**: current-slide iframe preview + next-slide iframe preview + large speaker script + timer. All four cards can be dragged and resized; everything is integrated in `runtime.js` with zero dependencies.

## Use cases

- Technical talks (30–60 min)
- Product-launch keynotes
- Teaching sessions
- Any formal talk that **needs guidance without sounding read aloud**

## Quick start

```bash
cp -r templates/full-decks/presenter-mode-reveal examples/my-talk
open examples/my-talk/index.html
```

## Keyboard controls

| Key | Action |
|---|---|
| `S` | Open presenter window (a new window; the original page stays put) |
| `T` | Switch themes (five presets) |
| `←` `→` | Change slides |
| `Space` / `PgDn` | Next slide |
| `F` | Fullscreen |
| `O` | Overview thumbnails |
| `R` | Reset timer (presenter view only) |
| `Esc` | Close every overlay |

## Theme switching

The template includes five presentation-ready themes in the `<html data-themes="...">` attribute:

```html
<html lang="zh-CN" data-themes="tokyo-night,dracula,catppuccin-mocha,nord,corporate-clean">
```

Press `T` to cycle them. You can use any theme in `assets/themes/*.css`.

## Speaker-note guidelines

**Write 150–300 words in every slide’s `<aside class="notes">`.** Three rules:

1. **Not a script: a prompt signal** — bold key points, separate transitions, and list data clearly
2. **150–300 words per page** — pace for two to three minutes per slide
3. **Write as you speak** — choose “so” over “therefore”; read it aloud to ensure it sounds natural

Example:
```html
<aside class="notes">
  <p>Welcome. Today we will discuss a <strong>problem many people overlook</strong>...</p>
  <p>Here is the point: <em>making slides and giving a talk are different skills</em>.</p>
  <p>Next, I will prove that point with three examples...</p>
</aside>
```

Supported inline tags:
- `<strong>` — highlight (orange)
- `<em>` — italic emphasis (blue)
- `<code>` — monospace
- `<p>` — paragraphs (aim for 30–60 seconds of speech each)

## File structure

```
presenter-mode-reveal/
├── index.html       # six sample slides, each with complete speaker notes
├── style.css        # scoped .tpl-presenter-mode-reveal styles
└── README.md        # this file
```

## Modify / extend

- **Add pages:** copy any `<section class="slide">` block and change its content and `<aside class="notes">`
- **Change themes:** edit the `data-themes` list or `<link id="theme-link" href="...">` directly
- **Change styles:** edit only `style.css`, not the root `assets/base.css`
- **Add motion:** add `data-anim="fade-up"` and similar attributes (see `references/animations.md`)

## The presenter window’s four cards

The window opened with `S` contains:

- 🔵 **CURRENT** — current-slide iframe preview (loads `?preview=N`, pixel-perfect with the audience CSS, theme, and fonts)
- 🟣 **NEXT** — next-slide preview to prepare transitions
- 🟠 **SPEAKER SCRIPT** — large, scrollable speaker notes
- 🟢 **TIMER** — elapsed time + page count + Prev/Next/Reset buttons

Card operations:
- **Drag the card header** (colored dot and title bar) → move the card
- **Drag the lower-right corner** → resize it
- Position and size save automatically to localStorage and restore next time
- The bottom “Reset layout” button restores the default card arrangement

Slide changes stay smooth: each iframe loads once, then later navigation uses `postMessage` to change its internal slide, **without reloads or flicker**. The two windows synchronize both ways through `BroadcastChannel`.

## Notes

- **The audience never sees `.notes` content** — CSS defaults to `display:none`; it is visible only in presenter view
- **Do not put private prompts in slide content** — all prompts belong in `<aside class="notes">`
- **Two-screen talks:** open `index.html`, press S to open the presenter window, move the audience window to a projector or external display and press F for fullscreen, then keep the presenter window on your own screen
