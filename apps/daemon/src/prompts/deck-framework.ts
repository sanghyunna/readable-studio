/**
 * Stable deck framework injected into the system prompt when the active skill
 * mode is `deck`. The whole point: stop regenerating the scale-to-fit JS, the
 * keyboard handler, the slide visibility toggle, the counter, and the print
 * rules each turn — every regeneration has subtly different bugs (focus is
 * wrong, scaling drifts inside the iframe wrapper, arrow keys swallowed).
 *
 * Two pieces ship together:
 *   - DECK_SKELETON_HTML : the literal scaffold the model copies verbatim.
 *   - DECK_FRAMEWORK_DIRECTIVE : the prompt fragment that tells the model
 *     what is fixed and what they're allowed to change.
 *
 * Pattern: 1920×1080 fixed canvas anchored at the shell's top-left,
 * centered into the viewport by `fit()` with `transform-origin: top left`
 * and an explicit `translate(tx, ty) scale(s)` whose factor is recomputed
 * on every resize. The shell is intentionally NOT a grid/flex container —
 * any extra centering layer would stack with the explicit translate and
 * push the scaled stage off-screen (see the Readable Studio srcdoc bridge's deck-fix
 * placement note in `apps/web/src/runtime/srcdoc.ts:injectDeckBridge`).
 * Slides are `<section class="slide">` inside the stage, only
 * `.slide.active` is visible. Prev/next + counter live OUTSIDE the scaled
 * stage so they don't shrink with it.
 *
 * Why this pattern (not horizontal scroll-snap):
 *   - It matches what the model has the strongest prior on, so the framework
 *     gets adopted verbatim instead of being "blended" with the model's own
 *     instincts (which is what produced the drift in the first place).
 *   - 1920×1080 is the canonical slide canvas. Designs scale predictably.
 *   - Print becomes trivial: render every slide as block, page-break between.
 *
 * Drift fixes baked in:
 *   - `transform-origin: top left` with an explicit
 *     `translate(tx, ty) scale(s)`. The shell is plain block flow (no
 *     grid/flex/place-content), so the stage's natural top-left is (0, 0)
 *     and the translate centers it correctly even inside the Readable Studio viewer's
 *     nested transform wrapper.
 *   - Capture-phase keydown on BOTH window and document so iframe focus
 *     quirks can't swallow arrow keys.
 *   - Auto-focus body on load and on every click.
 *   - localStorage position restored on load.
 *   - Print stylesheet shows every slide as a 1920×1080 page-broken block,
 *     producing a multi-page vertical PDF on Save-as-PDF.
 */

export const DECK_SKELETON_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title><!-- SLOT: deck title --></title>
  <style>
    /* ===========================================================
       Deck framework — DO NOT EDIT the rules in this <style> block.
       Edit only inside the second <style> block below (per-deck
       styles) and inside <section class="slide"> bodies.

       Contract this framework provides:
         - 1920×1080 fixed canvas, scaled to fit the viewport
         - Only .slide.active is visible at a time
         - Prev/next + counter rendered outside the scaled stage
         - Keyboard (← → space PgUp PgDn Home End), click, and stored
           position survive iframe focus quirks
         - "Save as PDF" produces a multi-page vertical PDF, one slide
           per page, by toggling every slide visible under @media print
       =========================================================== */
    :root {
      /* SLOT: theme tokens — the only top-level CSS the agent edits.
         Add or override --bg / --fg / --accent / etc. here. */
      --bg: #ffffff;
      --fg: #1c1b1a;
      --muted: #6b6964;
      --accent: #c96442;
      --surface: #ffffff;
      --shell: #08090d;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: var(--shell);
      color: var(--fg);
      font: 18px/1.5 -apple-system, system-ui, sans-serif;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    .deck-shell {
      position: fixed;
      inset: 0;
      overflow: hidden;
    }
    .deck-stage {
      width: 1920px;
      height: 1080px;
      background: var(--bg);
      position: relative;
      transform-origin: top left;
      box-shadow: 0 30px 80px rgba(0, 0, 0, 0.35);
    }
    .slide {
      position: absolute;
      inset: 0;
      overflow: hidden;
      padding: 80px 120px;
    }
    /* Visibility toggle hardened with :not(.active) + !important so cascade
       order can't break it. The previous \`.slide { display:none }\` rule
       lost the cascade whenever a per-slide variant class (e.g.
       \`.s-cold { display:grid }\`) was declared after it on the same
       element — every slide silently became visible at once. The
       \`!important\` is a belt-and-suspenders against agent code that adds
       \`!important\` on variant classes too. */
    .slide:not(.active) { display: none !important; }
    /* The active default uses :where() so it has zero specificity. Per-slide
       variant classes like \`.s-cold { display:grid }\` or
       \`.s-magazine { display:block }\` can override the default flex layout
       just by declaring \`display\` — no need for the variant to be more
       specific. The hide rule above still wins for inactive slides. */
    :where(.slide.active) { display: flex; flex-direction: column; justify-content: center; }

    /* Chrome — counter + prev/next live outside the scaled stage so they
       don't shrink with it. Do not relocate them inside .deck-stage. */
    .deck-counter {
      position: fixed;
      bottom: 22px;
      left: 50%;
      transform: translateX(-50%);
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: rgba(10, 14, 26, 0.92);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      padding: 6px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: #fff;
      font: 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: 0.18em;
      z-index: 1000;
    }
    .deck-counter button {
      width: 36px; height: 36px;
      background: transparent;
      color: #fff;
      border: 0;
      border-radius: 50%;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      display: grid;
      place-items: center;
      transition: background 0.15s;
    }
    .deck-counter button:hover { background: rgba(255, 255, 255, 0.12); }
    .deck-counter button[disabled] { opacity: 0.3; cursor: default; }
    .deck-counter .deck-count {
      padding: 0 14px;
      letter-spacing: 0.22em;
    }
    .deck-counter .deck-count .total { color: rgba(255, 255, 255, 0.5); }
    .deck-hint {
      position: fixed;
      bottom: 26px;
      right: 28px;
      color: rgba(255, 255, 255, 0.4);
      font: 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      z-index: 999;
      pointer-events: none;
    }

    /* Print / PDF stitching — every slide stacks top-to-bottom, one per
       page. The viewer's "Share → PDF" relies on this; do not remove. */
    @media print {
      @page { size: 1920px 1080px; margin: 0; }
      html, body {
        width: 1920px !important;
        height: auto !important;
        overflow: visible !important;
        background: #fff !important;
      }
      .deck-shell {
        position: static !important;
        display: block !important;
        inset: auto !important;
      }
      .deck-stage {
        width: 1920px !important;
        height: auto !important;
        transform: none !important;
        box-shadow: none !important;
        position: static !important;
      }
      .slide {
        display: flex !important;
        position: relative !important;
        inset: auto !important;
        width: 1920px !important;
        height: 1080px !important;
        page-break-after: always;
        break-after: page;
      }
      /* Zero-specificity restore of the screen-mode default
         (:where(.slide.active) { flex-direction: column; ... }), which
         above us forces display:flex on EVERY slide (not just .active) so
         all of them render for the multi-page PDF. Without this, only the
         slide that happened to carry .active gets flex-direction: column;
         every other slide falls back to the flexbox default row, turning
         its vertical stack into a horizontal smash. :where() keeps this at
         zero specificity so a per-slide variant that legitimately wants a
         different flex-direction/justify-content still wins, exactly like
         it already does on screen. */
      :where(.slide) { flex-direction: column; justify-content: center; }
      .slide:last-child { page-break-after: auto; break-after: auto; }
      .deck-counter, .deck-hint { display: none !important; }
    }
  </style>
  <style>
    /* SLOT: per-deck styles — typography, layout helpers, slide variants.
       Add classes used by the slide content below, e.g. .title, .big-stat,
       .grid-3. Do not redefine .deck-shell / .deck-stage / .slide /
       .deck-counter / .deck-hint or anything inside @media print. */
  </style>
</head>
<body>
  <div class="deck-shell">
    <div class="deck-stage" id="deck-stage">

      <!-- SLOT: slides — one <section class="slide"> per slide. The first
           slide must have class="slide active". The framework auto-counts
           them and toggles .active as the user navigates. -->

      <section class="slide active" data-screen-label="01 Title">
        <!-- SLOT: slide 1 content -->
      </section>

      <section class="slide" data-screen-label="02">
        <!-- SLOT: slide 2 content -->
      </section>

      <!-- ... add as many <section class="slide"> blocks as the brief asks
           for. The first one is .active; the rest are not. -->

    </div>
  </div>

  <!-- Framework chrome — DO NOT EDIT below this line. -->
  <nav class="deck-counter" role="navigation" aria-label="Deck navigation">
    <button type="button" id="deck-prev" aria-label="Previous slide">‹</button>
    <span class="deck-count"><span id="deck-cur">01</span> <span class="total">/ <span id="deck-total">01</span></span></span>
    <button type="button" id="deck-next" aria-label="Next slide">›</button>
  </nav>
  <div class="deck-hint">← / → · space</div>

  <script>
    (function () {
      var stage = document.getElementById('deck-stage');
      var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
      var prev = document.getElementById('deck-prev');
      var next = document.getElementById('deck-next');
      var cur = document.getElementById('deck-cur');
      var total = document.getElementById('deck-total');
      var STORE = 'deck:idx:' + (location.pathname || '/');
      var idx = 0;

      // ---- scale-to-fit ---------------------------------------------------
      // The stage is 1920×1080 and sits at .deck-shell's (0, 0) in normal
      // block flow — the shell is intentionally NOT a grid/flex container,
      // so the stage's natural top-left is (0, 0). We scale via transform
      // with transform-origin:top-left, then translate by the remainder to
      // center the scaled box in the viewport. This survives nested
      // transforms (e.g. when the Readable Studio viewer wraps the iframe in its own
      // scale wrapper at zoom != 100%).
      function fit() {
        var sw = window.innerWidth;
        var sh = window.innerHeight;
        var pad = 32;
        var s = Math.min((sw - pad) / 1920, (sh - pad) / 1080);
        if (!isFinite(s) || s <= 0) s = 1;
        var tx = (sw - 1920 * s) / 2;
        var ty = (sh - 1080 * s) / 2;
        stage.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')';
      }

      // ---- navigation -----------------------------------------------------
      function pad2(n) { return (n < 10 ? '0' : '') + n; }
      function paint() {
        slides.forEach(function (el, i) { el.classList.toggle('active', i === idx); });
        if (cur) cur.textContent = pad2(idx + 1);
        if (total) total.textContent = pad2(slides.length);
        if (prev) prev.toggleAttribute('disabled', idx <= 0);
        if (next) next.toggleAttribute('disabled', idx >= slides.length - 1);
      }
      function go(i) {
        idx = Math.max(0, Math.min(slides.length - 1, i));
        paint();
        try { localStorage.setItem(STORE, String(idx)); } catch (_) {}
      }
      function onKey(e) {
        if (e.defaultPrevented) return;
        var t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        // Yield trusted arrow keys to manual-edit object nudging: with a
        // selected object (and no active inline edit session) arrows move the
        // object, not the slide. Synthetic host-driven keys keep navigating.
        if (e.isTrusted && (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'ArrowDown') && document.documentElement.hasAttribute('data-readable-edit-mode') && document.querySelector('[data-readable-edit-selected]') && !document.querySelector('[data-readable-editing="true"]')) return;
        if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); go(idx + 1); }
        else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(idx - 1); }
        else if (e.key === 'Home') { e.preventDefault(); go(0); }
        else if (e.key === 'End') { e.preventDefault(); go(slides.length - 1); }
      }
      // Capture phase + listen on both targets — inside the Readable Studio iframe,
      // focus may be on window OR document; a single non-capture listener
      // silently misses presses. The same keydown therefore fires onKey on
      // BOTH targets, so onKey bails on e.defaultPrevented (set by the first
      // call's preventDefault) — one press advances exactly one slide.
      window.addEventListener('keydown', onKey, true);
      document.addEventListener('keydown', onKey, true);
      if (prev) prev.addEventListener('click', function () { go(idx - 1); });
      if (next) next.addEventListener('click', function () { go(idx + 1); });

      // Auto-focus body so arrow keys work without an initial click.
      document.body.setAttribute('tabindex', '-1');
      document.body.style.outline = 'none';
      function focusDeck() { try { window.focus(); document.body.focus({ preventScroll: true }); } catch (_) {} }
      document.addEventListener('mousedown', focusDeck);
      window.addEventListener('load', focusDeck);

      // Restore last position.
      try {
        var saved = parseInt(localStorage.getItem(STORE) || '0', 10);
        if (!isNaN(saved) && saved >= 0 && saved < slides.length) idx = saved;
      } catch (_) {}

      window.addEventListener('resize', fit);
      fit();
      paint();
      focusDeck();
    })();
  </script>
</body>
</html>`;

export const DECK_FRAMEWORK_DIRECTIVE = `# Slide deck — fixed framework (this is non-negotiable for deck mode)

Decks regress when each turn re-authors the scale-to-fit logic, the keyboard handler, the slide visibility toggle, the counter, and the print rules. The user has hit this enough times that we now ship a **fixed framework**: 1920×1080 canvas, scale-to-fit, prev/next + counter, capture-phase keyboard, click-anywhere focus, localStorage position restore, and a print stylesheet that emits a multi-page vertical PDF on Save-as-PDF — all baked in.

**You do not write any of that. You do not modify any of that.** Your job is to fill content slots only.

## Workflow — copy framework first, then fill content

When the user asks for slides, your TodoWrite plan **must** start with "copy the deck framework verbatim" before any content step. The intended order is:

\`\`\`
1.  Bind the active direction's palette + fonts to :root in the framework
2.  Copy the canonical skeleton below as index.html (nothing else first)
3.  Plan the slide arc and theme rhythm (state aloud before writing)
4.  Add per-deck classes inside the second <style> block
5.  Replace each <section class="slide"> SLOT with real content
6.  Self-check (no rewriting framework chrome / @media print / nav script)
7.  Emit single <artifact> if a new canonical deck HTML was written this turn; otherwise summarize the edits (see "Artifact emission is conditional" in the discovery layer)
\`\`\`

If you find yourself writing \`<style>\` rules for \`.deck-shell\`, \`.deck-stage\`, \`.slide\`, \`.canvas\`, \`fit()\`, \`@media print\`, or a keyboard handler — STOP. The framework already has them. Re-read this directive, then keep going from "fill SLOT content".

## The contract

When you start a new deck, your output is a single HTML file built from the canonical skeleton below. **Copy the skeleton verbatim**, including its first \`<style>\` block, the \`.deck-shell\` / \`.deck-stage\` / \`.deck-counter\` / \`.deck-hint\` chrome, and the entire trailing \`<script>\`.

You may edit only inside slots marked \`SLOT:\`:
- \`SLOT: deck title\` — the \`<title>\` element.
- \`SLOT: theme tokens\` — the \`:root\` CSS custom properties (\`--bg\`, \`--fg\`, \`--accent\`, \`--shell\`, …). Add new tokens here if needed.
- \`SLOT: per-deck styles\` — the second \`<style>\` block. Define classes used by your slide content (e.g. \`.title\`, \`.big-stat\`, \`.grid-3\`, custom typography). **Never redefine** \`.deck-shell\`, \`.deck-stage\`, \`.slide\`, \`.deck-counter\`, \`.deck-hint\`, or anything inside \`@media print\`.
- \`SLOT: slides\` — the \`<section class="slide">\` blocks. Add as many as the brief calls for. The first slide MUST be \`<section class="slide active" …>\`; the rest are \`<section class="slide" …>\` (no \`active\`). The script auto-counts them.
- \`SLOT: slide N content\` — content inside each \`<section>\`.

## Common drift modes — DO NOT DO THESE

These are the failure patterns we just spent days debugging. Each one looks "equivalent" but breaks something specific:

- ❌ Don't write your own \`fit()\` function or \`transform: scale()\` script. The framework already does it, and ad-hoc versions drift inside the Readable Studio viewer's nested transform wrapper.
- ❌ Don't use \`transform-origin: center center\` on the stage. The framework uses \`top left\` plus an explicit translate so scaled content lands at the same place every render.
- ❌ Don't use \`document.addEventListener('keydown', …)\` alone, and don't drop the dedupe guard. Inside an iframe, focus is sometimes on window, so the framework adds capture-phase \`keydown\` listeners on **both** \`window\` and \`document\`. Because one physical key press then fires \`onKey\` twice (once per target), \`onKey\` MUST start with \`if (e.defaultPrevented) return;\` — the first call runs \`preventDefault()\`, so the duplicate bails and a press advances exactly one slide. Replace the dual listener with a single one and the iframe silently swallows arrow keys; drop the guard and every arrow press jumps two slides. The manual-edit yield guard right below it (\`e.isTrusted && … data-readable-edit-mode … data-readable-edit-selected …\`) is load-bearing too: it is what lets arrow keys nudge a selected object in the Readable Studio manual-edit overlay instead of advancing slides. Removing it makes every object nudge also change the slide.
- ❌ Don't replace the localStorage key, the slide-visibility toggle (\`.slide.active\`), or the counter element IDs (\`#deck-cur\`, \`#deck-total\`, \`#deck-prev\`, \`#deck-next\`). The framework reads them by ID.
- ❌ Don't put the prev/next buttons or the counter **inside** \`.deck-stage\`. They must live outside the scaled element so they stay legible at any viewport size.
- ❌ Don't redefine \`.slide\`, \`.slide.active\`, or \`.slide:not(.active)\` directly. The framework owns the visibility toggle through those exact selectors. If you want a non-flex layout on a slide, **add a variant class to the same \`<section class="slide …">\` element** (e.g. \`.s-cold\`, \`.s-magazine\`) and declare \`display: grid\` / \`display: block\` on the variant. The framework's active default is wrapped in \`:where(...)\` so it has zero specificity — your variant always wins for the active slide. Variant classes do NOT need to be more specific than \`.slide.active\`. (The inactive-hide rule still wins because it uses \`:not(.active) { display: none !important; }\`.)
- ❌ Don't strip or "tidy" the \`@media print\` block. It is how Share → PDF stitches every slide into a multi-page document. Without it, PDF export collapses to a single screenshot.

## Why this matters (so you can judge edge cases)

The framework is a contract with the host viewer. The Readable Studio iframe sits inside a transformed wrapper (the zoom control); the keyboard handler needs capture phase + dual targets; "Share → PDF" reads the print stylesheet; the position survives reloads via localStorage. If a turn rewrites any of these — even with "equivalent" code — the next turn diverges, and three turns in the deck has subtly broken nav and a one-page PDF. Treat the framework as load-bearing infrastructure.

If the user asks for something the framework genuinely doesn't support (vertical decks, custom slide transitions, multi-column simultaneous slides), say so and ask before forking. **Default answer: keep the framework, change the slide content.**

## Each slide

Each \`<section class="slide" data-screen-label="NN Title">\` is one slide rendered onto the 1920×1080 canvas. Inside the section, lay out content with your own \`SLOT: per-deck styles\` classes. Slide labels are 1-indexed (\`01 Title\`, \`02 Problem\`…). The first slide gets \`class="slide active"\`; the others just \`class="slide"\`.

Real copy only — no lorem ipsum, no invented metrics, no generic emoji icon rows. If you don't have a value, leave a short honest placeholder.

## Density and overflow discipline (the #1 cause of ugly decks)

Even with the visibility toggle working, slides go ugly when content overflows the 1920×1080 canvas. Specific failure modes that ship today:

- ❌ Title slides with a display headline ≥ 160px **plus** a multi-line subtitle/deck paragraph **plus** an absolutely-positioned \`.footer\` at \`bottom: ~56px\`. The flow content grows downward, the absolute footer occupies the bottom band, and the two collide in the last ~100px of the slide.
- ❌ Stat slides with three numbers + three captions + a footer. Split into three stat slides — the framework counts slides for you, more slides cost nothing.
- ❌ "Magazine spread" attempts that pack masthead + display headline + body grid + sidebar + absolute footer all into a single 1080px slide.

Rules — non-negotiable:

1. **Display headlines on cover/title slides: max ~140px font-size, max 8 words, max 3 lines.** If the headline doesn't fit those bounds, the slide is the wrong shape — split it, don't shrink the font and pack more in.
2. **Fill the vertical canvas — don't pool empty space at the bottom.** Overflow is one failure; the opposite — content clustered in the top half with a blank lower third — is just as ugly, and it is the more common one. The active-slide CSS already defaults to \`justify-content: center\`, so a single-idea slide should sit centered in the full 1080px height. For a multi-part slide that wants a header/body/footer distribution instead, scope the override to THAT slide only — e.g. \`.slide[data-screen-label="03 Title"] { display: flex; flex-direction: column; justify-content: space-between; }\`, or apply it to an inner wrapper \`<div>\` styled by its own per-deck class — then let the main body region be \`flex: 1\` so it absorbs leftover height, and push the footer down with \`margin-top: auto\`. **Never write a bare \`.slide\` or \`section.slide\` rule for this.** \`.slide\` matches every slide in the deck; an unscoped \`justify-content: space-between\` there replaces the shared centered default deck-wide, and any OTHER slide with only two children (say, a title plus one content block) then gets pinned to the top and bottom edges with a large dead gap between them — the exact failure this rule exists to prevent, just moved to a different slide. Give exactly ONE "hero" element (the headline block, the chart, the lead stat) \`flex: 1\` to soak up slack — do not spread the slack as equal gaps between everything. Create breathing room with **padding, never trailing bottom margins**; add \`*:last-child { margin-bottom: 0; }\` to your \`SLOT: per-deck styles\` so a trailing margin never leaks a gap below the last element. A slide that stops at ~60% height with an empty lower band is as broken as one that overflows.
3. **Reserve a footer safe-zone.** If you use \`.footer { position: absolute; bottom: Npx; }\`, flow content above the footer must stop at least 80px before \`1080 − footer_height − N\` so the two never collide. A safe-zone is a no-collision margin, **not** a directive to leave the bottom of the slide empty. If you bound the main content area (e.g. a \`max-height\` content region with the footer absolute below it, roughly \`height: 760px\`), that content region must still FILL its band per Rule 2 — center or distribute its contents, don't let them float at the top of the band with dead space beneath.
4. **Body slides: ≤ 3 paragraphs, ≤ 56ch lead text width, ≤ 12 words per line.**
5. **One idea per slide.** Two ideas = two slides.

## Pre-emit self-check — run this BEFORE writing the \`<artifact>\` tag

For every \`<section class="slide">\`, mentally render at 1920×1080 and answer:

- [ ] Does the slide's content fit inside the canvas without clipping or overflowing the bottom?
- [ ] Is there a large empty band (> ~15% of slide height, i.e. ≳ 160px of the 1080px canvas) pooled at the bottom? If so, CENTER the content (the active slide already defaults to \`justify-content: center\`) or DISTRIBUTE it (\`justify-content: space-between\` + a \`flex: 1\` body, scoped to that one slide only — never a bare \`.slide\`/\`section.slide\` rule) to fill the canvas — do not leave pooled empty space.
- [ ] If there's an absolutely-positioned footer/header, does flow content stop before the footer's reserved band without leaving the rest of the slide empty? (See the footer safe-zone rule above.)
- [ ] Is the display headline ≤ 140px and ≤ 8 words?
- [ ] Does the slide carry ≤ one big idea? (No mashed-together masthead + display headline + subtitle + absolute footer + sidebar.)

If any answer is "no", redesign the slide BEFORE emitting. Decks that overflow are the most common single failure mode reported by users; the user has rejected one before and will reject one again.

## Prefer the simple-deck skill's layout vocabulary when reachable

If \`plugins/_official/examples/simple-deck/assets/template.html\` and its \`references/layouts.md\` are readable from the project workspace, **prefer those layouts over inventing your own**. The simple-deck skill ships eight paste-ready slide skeletons (cover, body, big-stat, three-point row, pipeline, dark quote, before/after, closing) with tested type scales, density rules, and a P0/P1/P2 checklist. Re-inventing those layouts is the source of most density / overflow bugs the framework can't catch.

## Canonical skeleton (this is exactly what the file you write looks like)

\`\`\`html
${DECK_SKELETON_HTML}
\`\`\`

When the brief is "make me a deck", your output is this skeleton with theme tokens tuned, per-deck classes added, and \`<section class="slide">\` blocks filled in — nothing more, nothing less. Skill-specific guidance (typography, theme presets, layout vocabulary) layers *on top of* this framework, not in place of it.
`;
