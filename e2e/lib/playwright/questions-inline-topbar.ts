import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import type { Page, TestInfo } from '@playwright/test';
import { T } from '../timeouts.ts';

/** Read the shipped machine-consumed theme IDs, rather than maintaining a second catalog. */
export function bundledThemes(source = readFileSync(new URL('../../../apps/web/src/state/themes.ts', import.meta.url), 'utf8')) {
  return [...source.matchAll(/\{ id: '([^']+)', labelKey: '[^']+', scheme: '(light|dark)'/g)]
    .map((match) => ({ id: match[1]!, scheme: match[2]! as 'light' | 'dark' }));
}

export interface Box { x: number; y: number; width: number; height: number }

/** Visible candidates only; the browser must still verify the actual hit target. */
export function outsidePoints(surface: Box, layer: Box, viewport: { width: number; height: number }) {
  const left = Math.max(0, surface.x), right = Math.min(viewport.width, surface.x + surface.width);
  const top = Math.max(0, surface.y), bottom = Math.min(viewport.height, surface.y + surface.height);
  const xs = [left, Math.max(left, Math.min(right, layer.x)), Math.max(left, Math.min(right, layer.x + layer.width)), right];
  const ys = [top, Math.max(top, Math.min(bottom, layer.y)), Math.max(top, Math.min(bottom, layer.y + layer.height)), bottom];
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < ys.length - 1; j++) {
    const x1 = xs[i]!, x2 = xs[i + 1]!, y1 = ys[j]!, y2 = ys[j + 1]!;
    if (x2 - x1 <= 4 || y2 - y1 <= 4) continue;
    for (const x of [(x1 + x2) / 2, x1 + 2, x2 - 2]) for (const y of [(y1 + y2) / 2, y1 + 2, y2 - 2]) {
      if (x < layer.x || x > layer.x + layer.width || y < layer.y || y > layer.y + layer.height) points.push({ x, y });
    }
  }
  return points;
}

/** Native input, live hit testing, and an observer of the exact mounted editor.
 * Browser callbacks are self-contained for Playwright serialization (not tsx).
 */
export async function dismissQuestionsOutside(page: Page, testInfo: TestInfo, label: string) {
  const probe = await page.evaluateHandle(() => {
    const panel = document.querySelector('[data-testid="questions-panel"]')!;
    const editor = document.querySelector('body > .questions-panel__popover--text')!;
    const owners = [...panel.querySelectorAll('.questions-panel__row[aria-expanded="true"][aria-controls]')]
      .filter(node => node.getAttribute('aria-controls') === editor?.id);
    const anchor = owners.length === 1 ? owners[0]! : null;
    const textbox = editor?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
    function describe(target: EventTarget | null) {
      if (target instanceof Element) return { tag: target.tagName, id: target.id,
        class: target.getAttribute('class'), role: target.getAttribute('role'),
        html: target.outerHTML.slice(0, 1200) };
      return target === window ? 'window' : target === document ? 'document' : null;
    }
    function state() {
      const editorRect = editor?.getBoundingClientRect();
      return { editor: describe(editor), anchor: describe(anchor), ownerCount: owners.length,
        editorRect: editorRect?.toJSON() ?? null,
        editorVisible: Boolean(editorRect?.width && editorRect.height && getComputedStyle(editor).visibility === 'visible'),
        anchorRect: anchor?.getBoundingClientRect().toJSON() ?? null,
        editorConnected: editor?.isConnected ?? false, textboxConnected: textbox?.isConnected ?? false,
        anchorExpanded: anchor?.getAttribute('aria-expanded') ?? null,
        // Text input disabled is bound ONLY to saving, unlike Apply's disabled.
        saveInFlight: textbox?.disabled ?? null, saveSignal: 'textbox.disabled',
        anchorAriaDisabled: anchor?.getAttribute('aria-disabled') ?? null,
        draft: textbox?.value ?? null, viewport: { width: innerWidth, height: innerHeight } };
    }
    function outside(hit: Element | null) {
      // Requiring panel ancestry also excludes EVERY body portal, not just the
      // current editor. Reject nested popovers and interactive ancestors too.
      return Boolean(hit && panel.contains(hit) && !editor?.contains(hit) && !anchor?.contains(hit)
        && !hit.closest('[popover], [class*="popover"], [role="listbox"], [role="menu"], button, a, input, textarea, select, label, summary, [role="button"], [contenteditable]')
        && getComputedStyle(hit).visibility === 'visible');
    }
    type Point = { x: number; y: number };
    const evidence = { chosen: null as Point | null, selection: null as null | ReturnType<typeof state>,
      resolved: null as ReturnType<typeof describe>,
      pointerdown: null as null | { point: Point; target: ReturnType<typeof describe>; hit: ReturnType<typeof describe>;
        composedPath: ReturnType<typeof describe>[]; isTrusted: boolean; pointerType: string;
        validOutside: boolean; state: ReturnType<typeof state> },
      reachedDocument: false, outcome: 'armed', final: null as null | ReturnType<typeof state> };
    let complete!: () => void;
    const completion = new Promise<void>(resolve => { complete = resolve; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    function finish(outcome: string) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      observer.disconnect();
      evidence.outcome = outcome;
      evidence.final = state();
      complete();
    }
    const observer = new MutationObserver(() => {
      if (!editor?.isConnected && !textbox?.isConnected) {
        // Native-event microtask checkpoints can run React's commit before
        // our later document listener. Check bubbling after mouse.click ends.
        finish(evidence.pointerdown?.validOutside
          && !evidence.pointerdown.state.saveInFlight ? 'unmounted' : 'unmounted-without-valid-outside-pointerdown');
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    function capture(event: PointerEvent) {
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      const point = { x: event.clientX, y: event.clientY };
      evidence.pointerdown = { point, target: describe(event.target), hit: describe(hit),
        composedPath: event.composedPath().map(describe), isTrusted: event.isTrusted, pointerType: event.pointerType,
        validOutside: event.isTrusted && event.pointerType === 'mouse' && event.button === 0
          && point.x === evidence.chosen?.x && point.y === evidence.chosen?.y
          && hit === event.target && outside(hit), state: state() };
      // Do not intercept or manufacture the product event. Invalid input fails
      // the probe, even if some unrelated action happened to close the editor.
      if (!evidence.pointerdown.validOutside || evidence.pointerdown.state.saveInFlight) {
        queueMicrotask(() => finish('invalid-outside-pointerdown'));
      }
    }
    function atDocument() { evidence.reachedDocument = true; }
    window.addEventListener('pointerdown', capture, true);
    document.addEventListener('pointerdown', atDocument);
    return {
      choosePoint(timeout: number) {
        evidence.selection = state();
        if (!editor?.isConnected || !evidence.selection.editorVisible || !textbox?.isConnected || !anchor || textbox.disabled) {
          finish('editor-not-ready-or-saving');
          return null;
        }
        // Current DOM rects, not boxes/candidates retained by the caller. Try
        // text surfaces first, then visible panel/descendant interiors.
        const surfaces = [panel.querySelector('h2')!, ...panel.querySelectorAll('h3, p'), panel, ...panel.querySelectorAll('*')];
        for (const surface of surfaces) {
          if (!surface) continue;
          const rect = surface.getBoundingClientRect();
          const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
          const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
          if (right - left <= 4 || bottom - top <= 4) continue;
          for (const x of [Math.floor((left + right) / 2), Math.ceil(left + 2), Math.floor(right - 2)]) {
            for (const y of [Math.floor((top + bottom) / 2), Math.ceil(top + 2), Math.floor(bottom - 2)]) {
              const hit = document.elementFromPoint(x, y);
              if (!outside(hit)) continue;
              evidence.chosen = { x, y };
              evidence.resolved = describe(hit);
              timer = setTimeout(() => finish('editor-did-not-unmount'), timeout);
              return evidence.chosen;
            }
          }
        }
        finish('no-live-outside-target');
        return null;
      },
      completion,
      snapshot: () => ({ ...evidence, current: state() }),
      dispose() {
        clearTimeout(timer);
        observer.disconnect();
        window.removeEventListener('pointerdown', capture, true);
        document.removeEventListener('pointerdown', atDocument);
      },
    };
  });
  let error: string | null = null;
  try {
    // No intervening test work between live geometry selection and native
    // mouse move/down/up. Capture rechecks elementFromPoint AT pointerdown.
    const point = await probe.evaluate((probe, timeout) => probe.choosePoint(timeout), T.short);
    assert.ok(point, 'No valid live outside point; see outside-dismissal artifact');
    await page.mouse.click(point.x, point.y);
    await probe.evaluate(probe => probe.completion);
    const result = await probe.evaluate(probe => probe.snapshot());
    assert.equal(result.outcome, 'unmounted', JSON.stringify(result));
    assert.equal(result.reachedDocument, true, 'pointerdown must reach the product document listener');
    assert.equal(result.current.editorConnected, false);
    assert.equal(result.current.textboxConnected, false);
    assert.equal(result.current.anchorExpanded, 'false');
    assert.equal(await page.locator('body > .questions-panel__popover').count(), 0);
  } catch (failure) {
    error = String(failure);
    throw failure;
  } finally {
    try {
      await testInfo.attach(`outside-dismissal-${label}`, { contentType: 'application/json',
        body: JSON.stringify({ error, ...await probe.evaluate(probe => probe.snapshot()) }, null, 2) });
    } finally {
      await probe.evaluate(probe => probe.dispose());
      await probe.dispose();
    }
  }
}

/** Compare complete browser serializations, never RGB decoded from translucent pixels.
 * expectedVeil is computed independently from blue 30% at 10%, pink 30% at 92%.
 * Exact equality pins token identity, order, positions AND alpha before raster tolerance.
 */
export function assertVeilContract(image: string, expectedVeil: string) {
  assert.match(expectedVeil, /^linear-gradient\(90deg, .+ 10%, .+ 92%\)$/);
  assert.equal(image, expectedVeil, 'Topbar must use the exact blue10 -> pink92 30% veil');
}

/** Check painted endpoint pixels against the SAME pixel with the image removed
 * and with the canonical endpoint made opaque. All inputs are screenshot RGBA,
 * never background-color or canvas readbacks of unresolved color-mix strings.
 * Exact 30% belongs to assertVeilContract; byte rounding only applies here.
 */
export function assertVeilComposite(painted: readonly number[], backing: readonly number[], opaque: readonly number[]) {
  const evidence = JSON.stringify({ painted, backing, opaque });
  for (const pixel of [painted, backing, opaque]) {
    assert.equal(pixel.length, 4, `Expected screenshot RGBA: ${evidence}`);
    assert.equal(pixel[3], 255, `Expected opaque screenshot backing: ${evidence}`);
  }
  const expected = opaque.slice(0, 3).map((value, channel) => value * 0.3 + backing[channel]! * 0.7);
  for (const [channel, value] of expected.entries()) {
    assert.ok(Math.abs(painted[channel]! - value) <= 2, `Painted 30% veil channel ${channel}: ${evidence}, expected ${expected}`);
  }
  assert.ok(painted.slice(0, 3).some((value, channel) => value !== backing[channel]), `Veil must change the painted backing: ${evidence}`);
  return expected;
}

/** Standalone resolved-color validator, NOT a measurement of a gradient layer.
 * Preserved color-mix is checked by the complete computed-gradient contract.
 */
export function assertVeilMixAlpha(css: string, alpha: number | undefined) {
  const value = css.trim();
  const evidence = `CSS ${JSON.stringify(css)}, canvas alpha ${alpha}`;
  if (value.startsWith('color-mix(')) return;
  const resolved = /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(([^()]*)\)$/.exec(value);
  assert.ok(resolved, `Expected a resolved color or preserved color-mix: ${evidence}`);
  const body = resolved[2]!;
  // Modern color functions use a slash; legacy rgb/hsl use a fourth comma
  // component. Missing alpha means opaque, never an implicit 30%.
  const components = body.split(',');
  const token = (body.includes('/') ? body.split('/')[1] : components.length === 4 ? components[3] : undefined)?.trim();
  assert.ok(token && /^[+-]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?%?$/i.test(token), `Missing resolved alpha: ${evidence}`);
  const resolvedAlpha = token.endsWith('%') ? Number(token.slice(0, -1)) / 100 : Number(token);
  assert.equal(resolvedAlpha, 0.3, `Resolved veil must be exactly 30%: ${evidence}`);
  assert.ok(alpha === 76 || alpha === 77, `Resolved 30% veil raster alpha: ${evidence}`);
}

/** Required identities prevent vacuous coverage; every present indicator must pass. */
export function assertIndicatorContrast(samples: ReadonlyArray<{ selector: string; kind: 'text' | 'indicator'; ratio: number }>, required: readonly string[]) {
  const indicators = samples.filter(sample => sample.kind === 'indicator');
  for (const selector of required) assert.ok(indicators.some(sample => sample.selector === selector), `Missing indicator: ${selector}`);
  for (const sample of indicators) assert.ok(sample.ratio >= 3, `${sample.selector}: contrast ${sample.ratio} < 3`);
}

/** Independent placePopover oracle: viewport rect anchor, offsetWidth/Height
 * panel, window.innerWidth/Height viewport. Right-aligned, 12px gutter, 8px gap.
 */
export function anchoredPosition(anchor: Box, panel: Pick<Box, 'width' | 'height'>, viewport: { width: number; height: number }) {
  const preferredLeft = anchor.x + anchor.width - panel.width;
  const maxLeft = Math.max(12, viewport.width - panel.width - 12);
  const below = anchor.y + anchor.height + 8;
  const above = anchor.y - panel.height - 8;
  const preferredTop = below + panel.height <= viewport.height - 12 || above < 12 ? below : above;
  const maxTop = Math.max(12, viewport.height - panel.height - 12);
  return {
    x: Math.min(Math.max(preferredLeft, 12), maxLeft),
    y: Math.min(Math.max(preferredTop, 12), maxTop),
  };
}
