import { describe, expect, it, vi } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import type { DOMWindow } from 'jsdom';
import { buildSrcdoc } from '../../src/runtime/srcdoc';

// Regression coverage for issue #46's legacy-deck hole: decks generated BEFORE
// the template yield guard existed ship a capture-phase `onKey` that advances
// slides on trusted arrow keys even while manual edit has an object selected.
// Their handler runs at window capture, ahead of the edit bridge's
// document-capture nudge listener, so the nudge lands AND the slide advances.
//
// The universal fix lives in the srcdoc deck injection: a tiny script placed
// right after <head> — before ANY deck script can register — that calls
// preventDefault() on user arrows under the edit-yield condition (edit mode
// + selected object + no active inline edit session). Host-driven synthetic
// nav is exempted via the same `__readableStudioDeckSynthetic` flag the edit bridge keys
// off. Every framework-derived deck bails on `e.defaultPrevented` (its
// documented dedupe contract), so the key yields to the edit bridge's nudge
// without stopping propagation.

// A legacy class-toggle deck: the pre-guard framework keyboard contract
// (capture listeners on window AND document, `if (e.defaultPrevented) return;`
// dedupe, no manual-edit yield guard).
function legacyDeckHtml(): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8"><style>',
    '.slide { display: none; } .slide.active { display: block; }',
    '</style></head><body>',
    '<div class="deck-stage" id="deck-stage">',
    '  <section class="slide active"><img data-readable-id="deck-object" alt="Deck object"></section>',
    '  <section class="slide"><h1>Slide Two</h1></section>',
    '</div>',
    '<span id="deck-cur">01</span>',
    '<script>(function(){',
    '  var slides = Array.prototype.slice.call(document.querySelectorAll(".slide"));',
    '  var cur = document.getElementById("deck-cur");',
    '  var idx = 0;',
    '  function pad2(n){ return (n < 10 ? "0" : "") + n; }',
    '  function paint(){ slides.forEach(function(el, i){ el.classList.toggle("active", i === idx); }); if (cur) cur.textContent = pad2(idx + 1); }',
    '  function go(i){ idx = Math.max(0, Math.min(slides.length - 1, i)); paint(); }',
    '  function onKey(e){',
    '    if (e.defaultPrevented) return;',
    '    var t = e.target;',
    '    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;',
    '    if (e.key === "ArrowRight") { e.preventDefault(); go(idx + 1); }',
    '    else if (e.key === "ArrowLeft") { e.preventDefault(); go(idx - 1); }',
    '  }',
    '  window.addEventListener("keydown", onKey, true);',
    '  document.addEventListener("keydown", onKey, true);',
    '})();</script>',
    '</body></html>',
  ].join('\n');
}

function setupDeck() {
  const srcdoc = buildSrcdoc(legacyDeckHtml(), { deck: true, editBridge: true });
  const dom = new JSDOM(srcdoc, {
    pretendToBeVisual: true,
    runScripts: 'dangerously',
    url: 'https://example.test/legacy-deck.html',
    virtualConsole: new VirtualConsole(),
  });
  const win = dom.window;
  const postMessage = vi.spyOn(win.parent, 'postMessage');
  // Boot the edit bridge the way the host does: enable edit mode, then mark
  // the deck object as the selected target (revision 1).
  win.dispatchEvent(new win.MessageEvent('message', { data: { type: 'readable-edit-mode', enabled: true } }));
  return { dom, win, postMessage };
}

function selectDeckObject(win: DOMWindow) {
  win.dispatchEvent(new win.MessageEvent('message', {
    data: { type: 'readable-edit-selected-target', id: 'deck-object', revision: 1 },
  }));
}

// The yield treats any key not wrapped in the deck-synthetic flag as user
// input, so plain dispatched KeyboardEvents exercise the user-key path.
function userKey(win: DOMWindow, key: string) {
  return new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
}

describe('srcdoc deck edit-yield — trusted arrows vs object nudging (#46 legacy decks)', () => {
  it('injects the yield script before any deck script, decks only', () => {
    const deckSrcdoc = buildSrcdoc(legacyDeckHtml(), { deck: true, editBridge: true });
    expect(deckSrcdoc).toContain('data-readable-deck-edit-yield');
    // The whole mechanism depends on registration order: the yield listener
    // must exist before the deck's own capture listeners register.
    expect(deckSrcdoc.indexOf('data-readable-deck-edit-yield')).toBeLessThan(deckSrcdoc.indexOf('addEventListener("keydown", onKey, true)'));
    // Non-deck artifacts carry no slide nav, so no yield script.
    const plainSrcdoc = buildSrcdoc(legacyDeckHtml(), { editBridge: true });
    expect(plainSrcdoc).not.toContain('data-readable-deck-edit-yield');
  });

  it('yields a user arrow to object nudging instead of advancing the legacy deck', () => {
    const { dom, win, postMessage } = setupDeck();
    selectDeckObject(win);
    postMessage.mockClear();

    const event = userKey(win, 'ArrowRight');
    win.document.dispatchEvent(event);

    // The deck's own handler bailed on defaultPrevented: still on slide 01.
    expect(win.document.getElementById('deck-cur')?.textContent).toBe('01');
    // Propagation was NOT stopped: the edit bridge still nudged the object.
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'readable-edit-nudge', direction: 'right', targetId: 'deck-object' }),
      '*',
    );
    expect(event.defaultPrevented).toBe(true);

    dom.window.close();
  });

  it('keeps deck navigation on user arrows when no object is selected', () => {
    const { dom, win, postMessage } = setupDeck();
    postMessage.mockClear();

    win.document.dispatchEvent(userKey(win, 'ArrowRight'));

    expect(win.document.getElementById('deck-cur')?.textContent).toBe('02');
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'readable-edit-nudge' }), '*');

    dom.window.close();
  });

  it('keeps deck navigation on synthetic host-driven keys while an object is selected', () => {
    const { dom, win, postMessage } = setupDeck();
    selectDeckObject(win);
    postMessage.mockClear();

    // What the deck bridge's dispatchKey does: flags the key as deck-synthetic
    // (and the event itself is untrusted, like every dispatchEvent).
    (win as unknown as { __readableStudioDeckSynthetic?: boolean }).__readableStudioDeckSynthetic = true;
    win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    win.document.dispatchEvent(new win.KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    (win as unknown as { __readableStudioDeckSynthetic?: boolean }).__readableStudioDeckSynthetic = false;

    expect(win.document.getElementById('deck-cur')?.textContent).toBe('02');
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'readable-edit-nudge' }), '*');

    dom.window.close();
  });

  it('keeps deck navigation while an inline edit session is active', () => {
    const { dom, win, postMessage } = setupDeck();
    selectDeckObject(win);
    win.document.querySelector('[data-readable-id="deck-object"]')?.setAttribute('data-readable-editing', 'true');
    postMessage.mockClear();

    win.document.dispatchEvent(userKey(win, 'ArrowRight'));

    expect(win.document.getElementById('deck-cur')?.textContent).toBe('02');
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'readable-edit-nudge' }), '*');

    dom.window.close();
  });
});
