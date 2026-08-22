import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { buildSrcdoc } from '../../src/runtime/srcdoc';

const deckHtml = `<!doctype html>
<html>
  <head><title>Deck</title></head>
  <body>
    <section class="slide active">One</section>
    <section class="slide">Two</section>
    <section class="slide">Three</section>
  </body>
</html>`;

describe('buildSrcdoc', () => {
  it('injects an initial slide index for deck previews', () => {
    const doc = buildSrcdoc(deckHtml, { deck: true, initialSlideIndex: 2 });

    expect(doc).toContain('var initialSlideIndex = 2;');
    expect(doc).toContain('setTimeout(restoreInitialSlide, 200)');
    expect(doc).toContain('setTimeout(restoreInitialSlide, 100)');
  });

  it('clamps invalid initial slide indices before injecting deck bridge script', () => {
    const doc = buildSrcdoc(deckHtml, { deck: true, initialSlideIndex: -4 });

    expect(doc).toContain('var initialSlideIndex = 0;');
  });

  it('injects the snapshot bridge used by draw annotations', () => {
    const srcdoc = buildSrcdoc('<main style="color:red">Hero</main>');

    expect(srcdoc).toContain('data-readable-snapshot-bridge');
    expect(srcdoc).toContain("data.type !== 'readable-studio:snapshot'");
    expect(srcdoc).toContain("type: 'readable-studio:snapshot:result'");
    expect(srcdoc).toContain('copyComputedStyle');
    expect(srcdoc).toContain('foreignObject');
  });

  it('paints an opaque background before drawing so empty rasters never flatten to black', () => {
    const srcdoc = buildSrcdoc('<main style="color:red">Hero</main>');

    // A fresh 2D canvas is transparent black; without an opaque base, a
    // foreignObject that paints nothing flattens to a solid BLACK PNG in
    // clipboards/viewers (the reported bug). The bridge must fill first.
    expect(srcdoc).toContain('function snapshotBackgroundColor()');
    expect(srcdoc).toContain('ctx.fillStyle = bgColor;');
    expect(srcdoc).toContain('ctx.fillRect(0, 0, w, h);');
    // The fill happens before the rasterized image is drawn over it.
    const fillIdx = srcdoc.indexOf('ctx.fillRect(0, 0, w, h);');
    const drawIdx = srcdoc.indexOf('ctx.drawImage(img, 0, 0, w, h);');
    expect(fillIdx).toBeGreaterThan(-1);
    expect(drawIdx).toBeGreaterThan(fillIdx);
  });

  it('reports an empty-render error instead of shipping a blank capture', () => {
    const srcdoc = buildSrcdoc('<main style="color:red">Hero</main>');

    // When the foreignObject paints nothing the canvas is uniform; the bridge
    // must surface that as an honest failure so the host can fall back / show
    // an error rather than copy a (now white-filled but still empty) frame.
    expect(srcdoc).toContain('function canvasLooksBlank(');
    expect(srcdoc).toContain("error: 'empty-render'");
  });

  it('renders snapshot SVGs through data URLs so canvas export stays origin-clean', () => {
    const srcdoc = buildSrcdoc('<main style="color:red">Hero</main>');

    expect(srcdoc).toContain('function encodedSvgDataUrl()');
    expect(srcdoc).toContain('img.src = encodedSvgDataUrl();');
    expect(srcdoc).not.toContain('createObjectURL');
    expect(srcdoc).not.toContain('snapshot too large');
  });

  it('crops snapshots with an XHTML wrapper instead of moving foreignObject offscreen', () => {
    const srcdoc = buildSrcdoc('<main style="color:red">Hero</main>');

    expect(srcdoc).toContain('function scrollOffset()');
    expect(srcdoc).toContain('left:\' + (-scroll.x) + \'px;top:\' + (-scroll.y) + \'px;');
    expect(srcdoc).toContain('<foreignObject x="0" y="0"');
    expect(srcdoc).not.toContain('<foreignObject x="\' + (-window.scrollX || 0)');
  });

  it('removes external stylesheet dependencies from snapshot clones before rasterizing', () => {
    const srcdoc = buildSrcdoc('<link rel="stylesheet" href="https://fonts.example/app.css"><style>@import "https://fonts.example/css"; @font-face { font-family: Remote; src: url(remote.woff2); } main { color: red; }</style><main>Hero</main>');

    expect(srcdoc).toContain('link[rel~="stylesheet"], link[rel~="preload"], link[rel~="preconnect"]');
    expect(srcdoc).toContain('.replace(/@import[^;]+;/gi,');
    expect(srcdoc).toContain('.replace(/@font-face\\s*\\{[^}]*\\}/gi,');
  });

  it('does not force Pretendard onto artifact content - previews must render the font the artifact itself declares', () => {
    // Regression coverage: a prior commit (7dd214fe) bundled Pretendard for
    // the app's own UI chrome (apps/web/src/styles/fonts.css, see
    // tests/styles/default-background.test.ts) but also wired the same
    // override into buildSrcdoc, which builds the artifact PREVIEW iframe -
    // scope creep that silently replaced every generated deck/design's own
    // font choice with the app's UI font, deck-wide, via an
    // `!important` rule. A user explicitly asked for the artifact's own
    // font (whatever the agent chose for that design) to survive into both
    // the live preview and PDF export; forcing Pretendard here broke that
    // for every artifact regardless of what font it actually declared.
    const srcdoc = buildSrcdoc('<main style="font-family: Inter">Hero</main>');

    expect(srcdoc).not.toContain('data-readable-pretendard-font');
    expect(srcdoc).not.toContain('PretendardVariable');
    expect(srcdoc).not.toContain("font-family: 'Pretendard', sans-serif !important;");
    expect(srcdoc).toContain('font-family: Inter');
  });

  it('prunes hidden snapshot clone nodes before rasterizing decks', () => {
    const srcdoc = buildSrcdoc(deckHtml, { deck: true });

    expect(srcdoc).toContain('function pruneHiddenSnapshotNodes');
    expect(srcdoc).toContain("computed.display === 'none'");
    expect(srcdoc).toContain("computed.visibility === 'hidden'");
    expect(srcdoc).toContain('pruneHiddenSnapshotNodes(document.documentElement, clone)');
  });

  it('can guard preview iframes against load-time focus stealing', () => {
    // This test would fail if injectPreviewFocusGuard were removed from
    // buildSrcdoc — the guard script would be absent, and the assertions
    // below would not find the data-readable-preview-focus-guard marker.
    const srcdoc = buildSrcdoc(
      '<!doctype html><html><head><script>window.focus();document.body.focus();</script></head><body>Hero</body></html>',
      { previewFocusGuard: true },
    );

    expect(srcdoc).toContain('data-readable-preview-focus-guard');
    expect(srcdoc).toContain("Object.defineProperty(window, 'focus'");
    expect(srcdoc).toContain("Object.defineProperty(HTMLElement.prototype, 'focus'");
    expect(srcdoc.indexOf('data-readable-preview-focus-guard')).toBeLessThan(
      srcdoc.indexOf('<script>window.focus();document.body.focus();</script>'),
    );
  });

  it('only uses directly mutable slide conventions for setActive support', () => {
    const srcdoc = buildSrcdoc(
      '<section class="slide">One</section><section class="slide">Two</section>',
      { deck: true }
    );

    const canSetActive = srcdoc.match(/function canSetActive\(list\)\{([\s\S]*?)\n  \}/)?.[1] ?? '';

    expect(canSetActive).toContain('var active = findActiveByClass(list);');
    expect(canSetActive).toContain('hasComputedHiddenSibling(list, active)');
    expect(canSetActive).toContain("list[i].style.display === 'none'");
    expect(canSetActive).toContain("list[i].style.visibility === 'hidden'");
    expect(canSetActive).toContain("list[i].hasAttribute('hidden')");
    expect(canSetActive).not.toContain('findActiveByVisibility');
  });

  it('injects the selection bridge for comment mode', () => {
    const srcdoc = buildSrcdoc('<main data-readable-id="hero">Hero</main>', {
      commentBridge: true,
    });

    expect(srcdoc).toContain('data-readable-selection-bridge');
    // The bridge boots with the requested mode already on so a click
    // immediately after srcdoc rebuild is not lost to the listener-install
    // race against the host's `readable-studio:*-mode` postMessage.
    expect(srcdoc).toContain('var commentEnabled = true;');
    expect(srcdoc).toContain('var inspectEnabled = false;');
    expect(srcdoc).toContain("type: 'readable-studio:comment-target'");
    expect(srcdoc).toContain("type: 'readable-studio:comment-hover'");
    expect(srcdoc).toContain("type: 'readable-studio:comment-leave'");
    expect(srcdoc).toContain("type: 'readable-studio:comment-targets'");
    expect(srcdoc).toContain("postStroke('readable-studio:pod-stroke')");
    expect(srcdoc).toContain("postStroke('readable-studio:preadable-select')");
    expect(srcdoc).toContain('data-readable-comment-mode-kind');
    expect(srcdoc).toContain("body * { cursor: crosshair !important; }");
    expect(srcdoc).toContain('MutationObserver(schedulePostTargets)');
    expect(srcdoc).toContain('schedulePostPreviewScroll');
    expect(srcdoc).toContain("type: 'readable-studio:preview-scroll'");
    expect(srcdoc).toContain("type: 'readable-studio:preview-scroll-request'");
    expect(srcdoc).toContain("data.type === 'readable-studio:preview-scroll-by'");
    expect(srcdoc).toContain('previewScrollBy(data.left, data.top)');
    expect(srcdoc).toContain('data-readable-selection-bridge-style');
    expect(srcdoc).toContain('html[data-readable-comment-mode] body iframe');
    expect(srcdoc).toContain('html[data-readable-inspect-mode] body iframe');
    expect(srcdoc).toContain('pointer-events: none !important');
  });

  it('adds manual edit source paths to inline text leaves', () => {
    const dom = new JSDOM('');
    globalThis.DOMParser = dom.window.DOMParser;
    const srcdoc = buildSrcdoc('<main><div class="zh"><b>Bold text</b><figcaption>Caption text</figcaption></div></main>', {
      editBridge: true,
    });
    Reflect.deleteProperty(globalThis, 'DOMParser');

    expect(srcdoc).toContain('<b data-readable-source-path="path-0-0-0">Bold text</b>');
    expect(srcdoc).toContain('<figcaption data-readable-source-path="path-0-0-1">Caption text</figcaption>');
  });

  it('annotates semantic SVG roots inside deck slides without annotating decorative SVG icons', () => {
    const dom = new JSDOM('');
    globalThis.DOMParser = dom.window.DOMParser;
    try {
      const srcdoc = buildSrcdoc(
        '<section class="slide"><div class="bd"><svg role="img" aria-label="Diagram"><text>Label</text></svg><img src="hero.png" alt="Hero"><button><svg aria-hidden="true"><path d="M0 0h1v1z"></path></svg>Save</button><div aria-hidden="true"><svg role="img" aria-label="Hidden ancestor"><path d="M0 0h1v1z"></path></svg></div></div></section>',
        { deck: true, editBridge: true },
      );
      const parsed = new JSDOM(srcdoc).window.document;
      const diagram = parsed.querySelector('section.slide > .bd > svg[role="img"]');
      const image = parsed.querySelector('section.slide > .bd > img');
      const icon = parsed.querySelector('button > svg');
      const hiddenAncestor = parsed.querySelector('[aria-hidden="true"] > svg[role="img"]');

      expect(diagram?.getAttribute('data-readable-source-path')).toBe('path-0-0-0');
      expect(image?.getAttribute('data-readable-source-path')).toBe('path-0-0-1');
      expect(icon?.hasAttribute('data-readable-source-path')).toBe(false);
      expect(hiddenAncestor?.hasAttribute('data-readable-source-path')).toBe(false);
    } finally {
      Reflect.deleteProperty(globalThis, 'DOMParser');
    }
  });

  it('annotates SVG roots identified by child titles or aria-labelledby', () => {
    const dom = new JSDOM('');
    globalThis.DOMParser = dom.window.DOMParser;
    try {
      const srcdoc = buildSrcdoc(
        '<section class="slide"><div class="bd"><svg><title>Chart</title><path d="M0 0h1v1z"></path></svg><svg aria-labelledby="chart-label"><path d="M0 0h1v1z"></path></svg><span id="chart-label">Accessible chart</span></div></section>',
        { deck: true, editBridge: true },
      );
      const parsed = new JSDOM(srcdoc).window.document;
      const roots = parsed.querySelectorAll('section.slide > .bd > svg');

      expect(roots[0]?.getAttribute('data-readable-source-path')).toBe('path-0-0-0');
      expect(roots[1]?.getAttribute('data-readable-source-path')).toBe('path-0-0-1');
    } finally {
      Reflect.deleteProperty(globalThis, 'DOMParser');
    }
  });

  it('emits free-pin fallback coordinates in viewport space', () => {
    const srcdoc = buildSrcdoc('<main>Hero</main>', { commentBridge: true });
    const freePinStart = srcdoc.indexOf('var pinX = Math.round(ev.clientX);');
    const freePinEnd = srcdoc.indexOf('// Pod drawing', freePinStart);
    const freePinBlock = srcdoc.slice(freePinStart, freePinEnd);

    expect(freePinBlock).toContain('var pinX = Math.round(ev.clientX);');
    expect(freePinBlock).toContain('var pinY = Math.round(ev.clientY);');
    expect(freePinBlock).toContain('position: { x: pinX - 12, y: pinY - 12, width: 24, height: 24 }');
    expect(freePinBlock).not.toContain('scrollX');
    expect(freePinBlock).not.toContain('scrollY');
    expect(freePinBlock).not.toContain('pageXOffset');
    expect(freePinBlock).not.toContain('pageYOffset');
  });

  it('injects the selection bridge for inspect mode and exposes override hooks', () => {
    const srcdoc = buildSrcdoc('<main data-readable-id="hero">Hero</main>', {
      inspectBridge: true,
    });

    expect(srcdoc).toContain('data-readable-selection-bridge');
    expect(srcdoc).toContain('var commentEnabled = false;');
    expect(srcdoc).toContain('var inspectEnabled = true;');
    expect(srcdoc).toContain("type: 'readable-studio:inspect-overrides'");
    expect(srcdoc).toContain("data.type === 'readable-studio:inspect-mode'");
    expect(srcdoc).toContain("data.type === 'readable-studio:inspect-set'");
    expect(srcdoc).toContain("data.type === 'readable-studio:inspect-reset'");
    expect(srcdoc).toContain("data.type === 'readable-studio:inspect-extract'");
    expect(srcdoc).toContain("data-readable-inspect-overrides");
    expect(srcdoc).toContain('html[data-readable-inspect-mode]');
  });

  it('hydrates inspect overrides from a persisted style block on bridge boot', () => {
    // Without hydration, the first readable-studio:inspect-set rebuilds the override
    // sheet from an empty in-memory map and silently drops every previously
    // saved rule for other elements — Save-to-source would then erase them
    // from the artifact too.
    const srcdoc = buildSrcdoc('<main data-readable-id="hero">Hero</main>', {
      inspectBridge: true,
    });
    expect(srcdoc).toContain('function hydrateOverridesFromDom()');
    expect(srcdoc).toContain('hydrateOverridesFromDom();');
    expect(srcdoc).toContain("document.querySelector('style[data-readable-inspect-overrides]')");
    // After hydration, the bridge must seed the host's overrides state so a
    // Save-to-source before the user has touched any control does not splice
    // an empty CSS body that erases the persisted style block.
    expect(srcdoc).toContain('if (Object.keys(overrides).length) setTimeout(postOverrides, 0);');
  });

  it('reflects the requested initial bridge modes on the documentElement attributes', () => {
    const commentDoc = buildSrcdoc('<main data-readable-id="hero">Hero</main>', {
      commentBridge: true,
    });
    expect(commentDoc).toContain("document.documentElement.toggleAttribute('data-readable-comment-mode', true)");

    const inspectDoc = buildSrcdoc('<main data-readable-id="hero">Hero</main>', {
      inspectBridge: true,
    });
    expect(inspectDoc).toContain("document.documentElement.toggleAttribute('data-readable-inspect-mode', true)");
  });

  it('omits the selection bridge entirely when neither comment nor inspect mode is on', () => {
    const srcdoc = buildSrcdoc('<main data-readable-id="hero">Hero</main>', {});
    expect(srcdoc).not.toContain('data-readable-selection-bridge');
  });

  // Regression for nexu-io/readable-studio#362: the bridge must accept an
  // readable-studio:inspect-replay message that replaces its in-memory override map
  // with the host's authoritative set. Without this, toggling Inspect
  // off/on or switching to Comment mode reloads the iframe from
  // previewSource without the host's unsaved style block, leaving
  // preview and persisted state out of sync — saveInspectToSource()
  // could then commit CSS the user is no longer seeing.
  it('accepts readable-studio:inspect-replay to rehydrate from the host map after a srcdoc rebuild', () => {
    const srcdoc = buildSrcdoc('<main data-readable-id="hero">Hero</main>', {
      inspectBridge: true,
    });
    expect(srcdoc).toContain("data.type === 'readable-studio:inspect-replay'");
    // Re-validates the inbound payload under the same allow-list and
    // value sanitizer used for readable-studio:inspect-set. A parent able to post to
    // this bridge is otherwise trusted, but applying its payload through
    // the bridge's own contract keeps the override sheet under known
    // rules instead of whatever the parent sent.
    expect(srcdoc).toContain('Object.prototype.hasOwnProperty.call(ALLOWED_PROPS, name)');
    // The replay handler installs the host map atomically — clears the
    // previous in-memory map first, then re-applies validated entries
    // and rebuilds the sheet in a single pass so the user does not see
    // a flash of unstyled preview between the two postMessages a
    // per-prop replay would require.
    expect(srcdoc).toContain('overrides = Object.create(null);');
  });

  it('hardens inspect overrides with a prop allow-list, value sanitizer, and trusted selector', () => {
    const srcdoc = buildSrcdoc('<main data-readable-id="hero">Hero</main>', {
      inspectBridge: true,
    });

    // Allow-list rejects anything off the InspectPanel surface — without
    // this a malicious parent could smuggle CSS via readable-studio:inspect-set.
    expect(srcdoc).toContain('var ALLOWED_PROPS');
    expect(srcdoc).toContain("'color': true");
    expect(srcdoc).toContain("'background-color': true");
    expect(srcdoc).toContain("'border-radius': true");
    expect(srcdoc).toContain("Object.prototype.hasOwnProperty.call(ALLOWED_PROPS, prop)");

    // Value sanitizer drops any character that could close the declaration,
    // the rule, or the <style> element.
    expect(srcdoc).toContain('var UNSAFE_VALUE = /[;{}<>\\n\\r]/;');
    expect(srcdoc).toContain('UNSAFE_VALUE.test(v)');

    // Selector is recomputed from elementId, not echoed back from the
    // inbound message — defends against a forged selector breaking out
    // of the override <style> block. The inbound selector is still
    // inspected to pick the attribute kind (data-readable-id vs
    // data-screen-label) the user clicked, so an artifact that carries
    // both attributes on different nodes with the same id tunes the
    // node the host serializer keys off, not whichever attribute
    // happens to come first in safeSelectorFor's fallback order.
    expect(srcdoc).toContain('function safeSelectorFor(elementId, hint)');
    expect(srcdoc).toContain('var safeSelector = safeSelectorFor(elementId, selector)');
    expect(srcdoc).toContain("hint.indexOf('[data-readable-id=') === 0");
    expect(srcdoc).toContain("hint.indexOf('[data-screen-label=') === 0");
  });

  it('marks source-authored edit targets before runtime scripts can add nodes', () => {
    const dom = new JSDOM('');
    globalThis.DOMParser = dom.window.DOMParser;
    const srcdoc = buildSrcdoc(
      '<main><h1>Source title</h1><script>document.body.prepend(document.createElement("h1"));</script></main>',
      { editBridge: true },
    );
    Reflect.deleteProperty(globalThis, 'DOMParser');

    expect(srcdoc).toContain('data-readable-source-path="path-0"');
    expect(srcdoc).toContain('data-readable-source-path="path-0-0"');
    expect(srcdoc).not.toContain('<script data-readable-source-path=');
    expect(srcdoc.indexOf('data-readable-source-path="path-0"')).toBeLessThan(srcdoc.indexOf('document.body.prepend'));
  });

  it('injects only the manual edit bridge when edit mode is enabled without picker bridges', () => {
    const dom = new JSDOM('');
    globalThis.DOMParser = dom.window.DOMParser;
    const srcdoc = buildSrcdoc('<main data-readable-id="hero">Hero</main>', {
      editBridge: true,
    });
    Reflect.deleteProperty(globalThis, 'DOMParser');

    expect(srcdoc).toContain('data-readable-source-path=');
    expect(srcdoc).toContain('data-readable-edit-bridge');
    expect(srcdoc).not.toContain('data-readable-selection-bridge');
    expect(srcdoc).not.toContain("type: 'readable-studio:comment-target'");
    expect(srcdoc).not.toContain("type: 'readable-studio:inspect-overrides'");
    expect(srcdoc).not.toContain('html[data-readable-comment-mode] body iframe');
  });

  // Regression for nexu-io/readable-studio#892: imported designs (e.g. Claude
  // Design ZIP) may not carry data-readable-id annotations. The selection bridge
  // depends on these attributes to identify clickable targets, so we
  // auto-annotate structural elements when they are missing.
  it('auto-annotates imported HTML that lacks data-readable-id or data-screen-label', () => {
    const dom = new JSDOM('');
    globalThis.DOMParser = dom.window.DOMParser;
    const srcdoc = buildSrcdoc(
      '<section><h1>Title</h1></div></section><article>Body</article>',
      { commentBridge: true },
    );
    Reflect.deleteProperty(globalThis, 'DOMParser');

    // Structural elements get path-based data-readable-id
    expect(srcdoc).toContain('data-readable-id="');
    // Script / style elements are skipped
    expect(srcdoc).not.toContain('<script data-readable-id=');
  });

  it('does not overwrite existing data-readable-id or data-screen-label annotations', () => {
    const dom = new JSDOM('');
    globalThis.DOMParser = dom.window.DOMParser;
    const srcdoc = buildSrcdoc(
      '<section data-readable-id="hero">Hero</section><div data-screen-label="cta">CTA</div>',
      { commentBridge: true },
    );
    Reflect.deleteProperty(globalThis, 'DOMParser');

    // Existing annotations must be preserved intact on their elements.
    expect(srcdoc).toContain('<section data-readable-id="hero">');
    expect(srcdoc).toContain('<div data-screen-label="cta">');
    // The div already has data-screen-label, so it must not get a fallback
    // data-readable-id injected by auto-annotation.
    expect(srcdoc).not.toContain('<div data-readable-id=');
  });

  it('auto-annotates direct-child divs with class or id under semantic containers', () => {
    const dom = new JSDOM('');
    globalThis.DOMParser = dom.window.DOMParser;
    const srcdoc = buildSrcdoc(
      '<section><div class="wrapper">Wrapper</div><div id="named">Named</div></section>',
      {},
    );
    Reflect.deleteProperty(globalThis, 'DOMParser');

    // Direct-child divs under section get data-readable-id
    expect(srcdoc).toContain('<div class="wrapper" data-readable-id=');
    expect(srcdoc).toContain('<div id="named" data-readable-id=');
  });

  it('skips deeply nested divs to avoid layout-noise in the selection bridge', () => {
    const dom = new JSDOM('');
    globalThis.DOMParser = dom.window.DOMParser;
    const srcdoc = buildSrcdoc(
      '<section><div class="outer"><div class="inner">Deep</div></div></section>',
      {},
    );
    Reflect.deleteProperty(globalThis, 'DOMParser');

    // The outer div is a direct child of section, so it gets annotated
    expect(srcdoc).toContain('<div class="outer" data-readable-id=');
    // The inner div is nested two levels deep; it must NOT get annotated
    expect(srcdoc).not.toContain('<div class="inner" data-readable-id=');
  });

  it('auto-annotates even when no bridge flags are set (always-on for persistence)', () => {
    const dom = new JSDOM('');
    globalThis.DOMParser = dom.window.DOMParser;
    const srcdoc = buildSrcdoc(
      '<article><h1>Title</h1></article>',
      {},
    );
    Reflect.deleteProperty(globalThis, 'DOMParser');

    // Without commentBridge or inspectBridge, annotation still runs so that
    // saved inspect tweaks (which reference data-readable-id selectors) survive
    // when the user later leaves inspect mode.
    expect(srcdoc).toContain('<article data-readable-id=');
    expect(srcdoc).toContain('<h1 data-readable-id=');
  });

  it('skips iframe, object, and embed tags from auto-annotation even when they have id', () => {
    const dom = new JSDOM('');
    globalThis.DOMParser = dom.window.DOMParser;
    const srcdoc = buildSrcdoc(
      '<section><iframe src="x"></iframe><object data="x"></object><embed src="x"></embed><iframe id="framed" src="y"></iframe></section>',
      {},
    );
    Reflect.deleteProperty(globalThis, 'DOMParser');

    expect(srcdoc).not.toContain('<iframe data-readable-id=');
    expect(srcdoc).not.toContain('<object data-readable-id=');
    expect(srcdoc).not.toContain('<embed data-readable-id=');
    expect(srcdoc).not.toContain('<iframe id="framed" data-readable-id=');
  });

  it('annotates div children of elements with id', () => {
    const dom = new JSDOM('');
    globalThis.DOMParser = dom.window.DOMParser;
    const srcdoc = buildSrcdoc(
      '<div id="wrapper"><div class="content">Content</div><div id="named">Named</div></div>',
      {},
    );
    Reflect.deleteProperty(globalThis, 'DOMParser');

    // The wrapper div itself is matched by [id] and gets annotated
    expect(srcdoc).toContain('<div id="wrapper" data-readable-id=');
    // Its direct-child divs are matched by [id] > div[class] / [id] > div[id]
    expect(srcdoc).toContain('<div class="content" data-readable-id=');
    expect(srcdoc).toContain('<div id="named" data-readable-id=');
  });
});
