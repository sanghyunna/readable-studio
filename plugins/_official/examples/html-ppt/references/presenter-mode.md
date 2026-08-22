# Presenter Mode Guide · Speaker Mode Guide

This document explains how to create **speaker mode PPT with verbatim** in the html-ppt skill.

## When to use speaker mode

When the user's needs involve any of the following, **speaker mode is preferred**:

- Mentions "**speech**", "**share**", "**speech**", "**verbatim**", "**speaker notes**"
- Mentions of "**presenter view**", "**presenter view**", "**presenter mode**"
- Requires "**30 minutes / 45 minutes / 1 hour** to share"
- Say "I'm going to tell the team about xxx", "I'm going to do a technology sharing", "I'm going to do a road show"
- Emphasis on "**don't want to forget the words**", "**afraid of not speaking fluently**", "**need a teleprompter**"

If the user only wants to make a "static and beautiful PPT" (such as Xiaohongshu pictures and texts, product albums, and report slides without speaking), there is no need for speaker mode.

## Two approaches

### ✅ Recommended approach: directly use the `presenter-mode-reveal` template

```bash
cp -r templates/full-decks/presenter-mode-reveal examples/my-talk
```

This template has all the required elements preset:
- Support S key to switch speaker view
- 5 themes available with T key cycle (tokyo-night/dracula/catppuccin-mocha/nord/corporate-clean)
- Use left and right keys to turn pages
- Each page has a sample verbatim draft of 150–300 words
- There are key hints at the bottom

Just change the content directly.

### 🔧 Advanced approach: add speaker mode to any existing template

html-ppt's **S key speaker view is built into `runtime.js` and is automatically supported by all full-deck templates**. You only need to do two things:

1. **Add `<aside class="notes">`** (or `<div class="notes">`) at the end of each slide, and write verbatim text inside
2. **Confirm that HTML introduces `assets/runtime.js`**

```html
<section class="slide">
<h2>Your title</h2>
<p>Content...</p>
  <aside class="notes">
<p>Here is what you want to say in your speech, 150-300 words...</p>
  </aside>
</section>
```

## Three rules of verbatim writing

This is the core of the entire methodology. AI must abide by the following when helping users write verbatim manuscripts:

### Iron Rule 1: It’s not a speech, it’s a “cue signal”

❌ **Wrong way of writing** (like reading a manuscript):
```
Hello everyone, welcome to today’s sharing. Today I will introduce to you the work our team has done in the past three months.
First, let's look at the background. Over the past three months, we have encountered several issues...
```

✅ **Correct writing** (prompt signal + bold core):
```
<p>Welcome! Today we’re sharing what our team has been working on in the<strong>past 3 months</strong>. </p>
<p>First let’s talk about the <em>background</em> – three months ago we encountered <strong>three core problems</strong>:
High latency, high cost, and poor stability. </p>
<p>The following will explain how to solve it one by one. </p>
```

**Difference**: The correct version puts the key words in bold, and the transitional sentences are separated into paragraphs, so you can connect them at a glance.

### Rule 2: 150–300 words per page

- **Less than 150 words**: Not enough prompts, you will get stuck in the middle of the sentence
- **More than 300 words**: You won’t have time to scan it all
- **2–3 minutes/page** is the most comfortable pace

### Rule 3: Use spoken language, not written language

| ❌ Written | ✅ Spoken |
|---|---|
| therefore | therefore |
| The plan | The plan |
| However | However / Yet |
| Optimize | Optimize |
| we will | we will / next |
| To sum up | So in simple terms |

**Checking method**: Read it after writing it to make sure it sounds like speaking.

## Required HTML structure

```html
<!DOCTYPE html>
<html lang="en" data-themes="tokyo-night,dracula,corporate-clean">
<head>
  <meta charset="utf-8">
  <title>...</title>
  <link rel="stylesheet" href="../../../assets/fonts.css">
  <link rel="stylesheet" href="../../../assets/base.css">
  <link rel="stylesheet" id="theme-link" href="../../../assets/themes/tokyo-night.css">
  <link rel="stylesheet" href="../../../assets/animations/animations.css">
  <link rel="stylesheet" href="style.css">
</head>
<body>
<div class="deck">

  <section class="slide" data-title="Cover">
<h1>Your title</h1>
<p>Subtitle</p>
    <aside class="notes">
<p>Speech paragraph 1 (add <strong>bold keywords</strong>). </p>
<p>Speech paragraph 2 (transitional sentences form independent paragraphs). </p>
<p>Speech paragraph 3 (natural ending, leading to the next page). </p>
    </aside>
  </section>

<!-- More slides ... -->

</div>
<script src="../../../assets/runtime.js"></script>
</body>
</html>
```

## Content displayed in speaker view

After pressing the `S` key, **an independent speaker window will pop up** (the original page remains in the audience view). The speaker window is **4 independent magnetic cards**:

```
Audience window (original page) Speaker window (magnetic card)
┌─────────────────┐   ┌─────────────────────┬──────────────────┐
│                 │   │ 🔵 CURRENT         │ 🟣 NEXT            │
│ Normal slide │ │ ━━━━━━━━━━━━━━━━ │ ━━━━━━━━━━━━━ │
│ Full screen display │◄►│ │ iframe preview │
│ │ │ iframe preview │ (next page) │
│ │ │ (Current page) ├───────────────────┤
│                 │   │                   │ 🟠 SPEAKER SCRIPT  │
│                 │   │                   │ ━━━━━━━━━━━━━ │
│ │ ├─────────────────────┤ [Large font verbatim draft] │
│ │ │ 🟢 TIMER │ [Scrollable] │
│                 │   │ ⏱ 12:34   3 / 8 │                   │
│                 │   │ [← Prev][Next →]  │                   │
└─────────────────┘   └─────────────────────┴──────────────────┘
↑ BroadcastChannel two-way synchronous page turning ↑
```

Card interaction rules:
- **Drag card header** (top bar with colored dots and title) → Move card position
- **Drag the triangle handle in the lower right corner of the card** → Resize the card
- **Position/size is automatically saved to localStorage** and restored next time it is opened.
- "Reset Layout" button at the bottom restores the default arrangement

Card content:
- 🔵 **CURRENT** — **Pixel-level perfect preview of the current page** (iframe loads the original HTML file in `?preview=N` mode, wrong color is impossible)
- 🟣 **NEXT** — Next page preview, also pixel perfect
- 🟠 **SPEAKER SCRIPT** — Verbatim script, font size 18px, supports `<strong>` (orange bold), `<em>` (blue emphasis), `<code>` and other inline styles
- 🟢 **TIMER** — timer will not lose focus, with page cut button

Synchronization of two windows: Press ← → in any window to turn pages, and the other window will automatically synchronize (BroadcastChannel).

Silky smooth page turning: the iframe is only loaded once, and subsequent page turning uses `postMessage` to switch the visible slide, **no reloading, no flickering**.

## Keyboard shortcuts (speaker mode)

| Key | Action |
|---|---|
| `S` | Open the speaker window (a new window pops up, the original page remains in audience view) |
| `←` `→` / Space / PgDn | Turn pages (even in speaker view) |
| `T` | Switch theme |
| `R` | Reset timer (only in speaker view) |
| `F` | Full screen |
| `O` | Overview |
| `Esc` | Close all overlays |

## Standard process for dual-screen speech

1. Open `index.html`, press `S` → pop up the speaker window
2. Drag the **audience window** (original page) to the projection/external screen and press `F` to go full screen
3. Leave the **speaker window** (pop-up window) on the screen in front of you
4. Press ← → in any window to turn pages, and both sides will be automatically synchronized.
5. View verbatim text + next page + timer in the speaker window

> 💡 **Why the preview is pixel perfect**: Each preview is an `<iframe>`, which loads the same deck HTML file, but the URL has more `?preview=N` parameters. When `runtime.js` detects this parameter, it will only render page N and hide all chrome. **iframe uses the exact same CSS, theme, fonts and viewport** as the viewer view - colors and typography are guaranteed to be consistent. The outer layer uses CSS `transform: scale()` to shrink 1920×1080 to the width and height of the card, and the proportional scaling will not deform it.

> 💡 **Why it doesn’t flicker**: The iframe stays there after it is loaded for the first time. When turning the page, the presenter window tells the iframe to switch to page N through `postMessage({type:'preview-goto', idx:N})`. The runtime.js in the iframe only switches the `.is-active` class without reloading or rendering a white screen.

## Common mistakes

### ❌ Write the verbatim manuscript in the visible position of the slide

```html
<!-- Error: this text will be seen by the audience -->
<p style="font-size:12px;color:gray">
Let’s talk about xxx here, then yyy...
</p>
```

✅ Correct:
```html
<aside class="notes">
<p>Here we talk about xxx, then we talk about yyy...</p>
</aside>
```

The `.notes` class defaults to `display:none`, which is only visible in the speaker view.

### ❌ Forgot to introduce runtime.js

No `<script src="../../../assets/runtime.js"></script>` = no S key, no speaker view, no page turning.

### ❌ Use written language for verbatim drafts

Pronounced like an AI robot. **Be sure to read it again after writing it**.

### ❌ 50 words per page

If the prompts are not enough, the words will still be forgotten.

### ❌ 500 words per page

My eyes can't scan it at all, which means I didn't write anything.

## Use AI to generate standard prompts for verbatim manuscripts

> "Please write a verbatim draft of **150-300 words** for each slide and put it in `<aside class="notes">`.
> Requirements:
> 1. Use **spoken language**, not written language (so/but/next, not therefore/however/all of the above)
> 2. Make the **core keywords** bold with `<strong>`
> 3. Transitional sentences form independent paragraphs (1-3 sentences per paragraph)
> 4. Reading sounds like speaking, not like reading a manuscript.
> 5. There should be a natural transition at the end, leading to the next page."

## Recommended combination

- **Theme**: `tokyo-night` (dark color, first choice for technology sharing), `corporate-clean` (light color, business report), `dracula` (dark color alternative)
- **Font**: Default Noto Sans SC + JetBrains Mono, no need to change
- **Animation**: Use with restraint, `fade-up` / `rise-in` is the most natural, do not use `glitch-in` / `confetti-burst` and other fancy ones
- **Number of pages**: 30 minutes to share = 8–12 pages; 45 minutes = 12–16 pages; 1 hour = 16–22 pages
