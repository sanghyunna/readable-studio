import { expect, type Locator, type Page } from '@playwright/test';
import { T } from '../timeouts.js';

export const RAIL = '[data-project-rail]';
export const TOGGLE = '[data-project-rail-toggle]';
export const SHELL = '.workspace-shell';
export const BODY = '.workspace-shell__body';
export const CONTENT = '[data-surface="hub"]';

export interface Box { x: number; y: number; width: number; height: number; right: number; bottom: number }
export interface MotionPoint { x: number; y: number; width: number; time: number }
export interface MotionEvidence {
  initialState: string | undefined;
  state: string | undefined;
  points: MotionPoint[];
  animations: { owner: string; properties: string[]; status: string; replacement: number | null; endState: boolean }[];
}

/** Half a physical pixel, never a whole CSS pixel that could hide vertical drift. */
export async function tolerance(page: Page): Promise<number> {
  return page.evaluate(() => 0.5 / window.devicePixelRatio);
}

export function horizontalOnly(points: readonly MotionPoint[], epsilon: number): boolean {
  return points.length > 1 && Math.max(...points.map((p) => p.y)) - Math.min(...points.map((p) => p.y)) <= epsilon;
}

export async function box(locator: Locator): Promise<Box> {
  return locator.evaluate((node) => {
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  });
}

/** Subscribe before the action. Mutation delivery, not a polling interval, owns readiness. */
export async function changeAndWait(page: Page, selector: string, present: boolean, action: () => Promise<unknown>): Promise<void> {
  const signal = await page.evaluateHandle(({ selector, present, timeout }) => {
    let observer: MutationObserver;
    let timer: ReturnType<typeof setTimeout>;
    const done = new Promise<void>((resolve, reject) => {
      // Object methods remain self-contained under both Playwright and tsx's
      // keepNames transform; named local arrows acquire an external __name helper.
      const signal = { check() {
        const node = document.querySelector(selector);
        const ready = present
          ? node instanceof HTMLElement && node.getBoundingClientRect().width > 0 && getComputedStyle(node).visibility !== 'hidden'
          : !node;
        if (!ready) return;
        observer.disconnect();
        clearTimeout(timer);
        resolve();
      } };
      observer = new MutationObserver(signal.check);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      timer = setTimeout(() => { observer.disconnect(); reject(new Error(`State signal timed out: ${selector}, present=${present}`)); }, timeout);
    });
    // The action is a separate protocol roundtrip; keep rejection observed until it returns.
    void done.catch(() => undefined);
    return { done, cancel() { observer.disconnect(); clearTimeout(timer); } };
  }, { selector, present, timeout: T.medium });
  try {
    await action();
    await signal.evaluate(({ done }) => done);
  } finally {
    await signal.evaluate(({ cancel }) => cancel());
    await signal.dispose();
  }
}

/** Await the actual finite animations, including CSS transitions, then read the next frame. */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(async (timeout) => {
    await document.fonts.ready;
    await new Promise<void>((resolve, reject) => {
      let frame = 0;
      const timer = setTimeout(() => { cancelAnimationFrame(frame); reject(new Error('Finite page animations did not finish')); }, timeout);
      const watch = {
        tick() {
          const animations = document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity
            && a.playState !== 'finished' && a.playState !== 'idle');
          if (!animations.length) { clearTimeout(timer); resolve(); return; }
          // A resize can cancel a CSS transition and replace it. Cancellation
          // is not completion: inspect the next rendered animation set, too.
          void Promise.allSettled(animations.map((a) => a.finished)).then((results) => {
            for (const [index, result] of results.entries()) {
              if (result.status === 'rejected'
                && !(result.reason?.name === 'AbortError' && animations[index]!.playState === 'idle')) {
                clearTimeout(timer);
                reject(result.reason);
                return;
              }
            }
            frame = requestAnimationFrame(watch.tick);
          });
        },
      };
      frame = requestAnimationFrame(watch.tick);
    });
  }, T.medium);
}

/** Armed before a real pointer press; samples survive animation replacement and failure. */
export async function toggleMotion(page: Page, evidence?: (value: MotionEvidence) => Promise<void>): Promise<MotionPoint[]> {
  const signal = await page.evaluateHandle(({ railSelector, toggleSelector, timeout }) => {
    const rail = document.querySelector<HTMLElement>(railSelector);
    const toggle = document.querySelector<HTMLElement>(toggleSelector);
    const body = document.querySelector<HTMLElement>('.workspace-shell__body');
    if (!rail || !toggle || !body) throw new Error('Persistent rail is missing');
    const initialState = rail.dataset.projectRailState;
    // Only the toggle's layout ancestry owns its path. In particular, the
    // adjacent routed surface and rail row entrance/hover effects do not.
    const owners: HTMLElement[] = [];
    for (let node: HTMLElement | null = toggle; node; node = node.parentElement) {
      owners.push(node);
      if (node === body) break;
    }
    const points: MotionPoint[] = [];
    const tracked = new Map<Animation, {
      target: Element; properties: string[]; end: ComputedKeyframe;
      status: 'running' | 'finished' | 'cancelled'; replacement: number | null; endState: boolean;
      finish: () => void; cancel: () => void;
    }>();
    const geometry = /^(gridTemplate|margin|padding|inset|minWidth|maxWidth|minHeight|maxHeight|minBlockSize|maxBlockSize|minInlineSize|maxInlineSize|width$|height$|blockSize$|inlineSize$|transform$|translate$|rotate$|scale$|left$|right$|top$|bottom$|gap$|columnGap$|rowGap$|flexBasis$)/;
    let frame = 0;
    let observer: MutationObserver;
    let timer: ReturnType<typeof setTimeout>;
    let changed = false;
    let revision = 0;
    let previousRevision = -1;
    // Methods, rather than named local functions, serialize without tsx helpers.
    const probe = {
      record() {
        if (!rail.isConnected || !toggle.isConnected || !rail.contains(toggle)) throw new Error('Persistent rail/toggle node was replaced during motion');
        const r = toggle.getBoundingClientRect();
        points.push({ x: r.x + r.width / 2, y: r.y + r.height / 2, width: rail.getBoundingClientRect().width, time: performance.now() });
      },
      discover() {
        for (const owner of owners) for (const animation of owner.getAnimations()) {
          if (tracked.has(animation)) continue;
          const effect = animation.effect;
          if (!(effect instanceof KeyframeEffect) || effect.target !== owner || effect.getComputedTiming().iterations === Infinity) continue;
          const keyframes = effect.getKeyframes();
          const end = keyframes.at(-1);
          if (!end) continue;
          const properties = Object.keys(end).filter((key) => geometry.test(key));
          if (!properties.length) continue;
          const entry = {
            target: owner, properties, end,
            status: animation.playState === 'finished' ? 'finished' as const : 'running' as const,
            replacement: null, endState: false,
            finish() { tracked.get(animation)!.status = 'finished'; revision++; },
            cancel() { tracked.get(animation)!.status = 'cancelled'; revision++; },
          };
          tracked.set(animation, entry);
          animation.addEventListener('finish', entry.finish);
          animation.addEventListener('cancel', entry.cancel);
          revision++;
        }
      },
      snapshot(): MotionEvidence {
        return { initialState, state: rail.dataset.projectRailState, points,
          animations: [...tracked.values()].map((entry) => ({
            owner: entry.target === body ? '.workspace-shell__body' : entry.target === rail ? railSelector : entry.target === toggle ? toggleSelector : '[data-project-rail-head]',
            properties: entry.properties, status: entry.status, replacement: entry.replacement, endState: entry.endState,
          })),
        };
      },
      cancel() {
        cancelAnimationFrame(frame);
        observer.disconnect();
        clearTimeout(timer);
        for (const [animation, entry] of tracked) {
          animation.removeEventListener('finish', entry.finish);
          animation.removeEventListener('cancel', entry.cancel);
        }
      },
    };
    const done = new Promise<MotionPoint[]>((resolve, reject) => {
      const watch = {
        fail(error: unknown) {
          probe.cancel();
          reject(new Error(`${String(error)}; rail motion evidence: ${JSON.stringify(probe.snapshot())}`));
        },
        tick() {
          try {
            probe.record(); // Flush layout before reading this frame's live animations.
            probe.discover();
            const entries = [...tracked.entries()];
            let active = false;
            for (const [animation, entry] of entries) {
              // Event delivery can follow rAF. Do not lose a cancellation or
              // finish simply because the animation left getAnimations().
              if (entry.status === 'running' && animation.playState === 'idle') { entry.status = 'cancelled'; revision++; }
              if (entry.status === 'running' && animation.playState === 'finished') { entry.status = 'finished'; revision++; }
              if (entry.status === 'running') active = true;
            }
            const last = points.at(-1)!, previous = points.at(-2);
            const stable = previous && last.x === previous.x && last.y === previous.y && last.width === previous.width;
            if (changed && !active && stable && previousRevision === revision) {
              for (const [index, [, entry]] of entries.entries()) {
                if (entry.status !== 'cancelled') continue;
                // Replacement must cover the SAME owner/properties, and must
                // itself finish (or reach a verified endpoint further below).
                const successor = entries.findIndex(([, next], nextIndex) => nextIndex > index && next.target === entry.target
                  && entry.properties.every((property) => next.properties.includes(property)));
                entry.replacement = successor < 0 ? null : successor;
                const style = getComputedStyle(entry.target);
                entry.endState = entry.properties.every((property) => style.getPropertyValue(property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)) === String(entry.end[property]));
                if (entry.replacement === null && !entry.endState) throw new Error('Rail animation cancelled without successor or end-state evidence');
              }
              probe.cancel();
              resolve(points);
              return;
            }
            previousRevision = revision;
            frame = requestAnimationFrame(watch.tick);
          } catch (error) { watch.fail(error); }
        },
      };
      observer = new MutationObserver(() => {
        if (rail.dataset.projectRailState !== initialState) changed = true;
        try { probe.record(); probe.discover(); } catch (error) { watch.fail(error); }
      });
      observer.observe(rail, { attributes: true, attributeFilter: ['data-project-rail-state'] });
      timer = setTimeout(() => watch.fail(new Error('Rail transition never completed')), timeout);
      probe.record();
      probe.discover(); // Subscribe to existing animations BEFORE the pointer action.
      frame = requestAnimationFrame(watch.tick);
    });
    void done.catch(() => undefined);
    return { done, cancel: probe.cancel, snapshot: probe.snapshot };
  }, { railSelector: RAIL, toggleSelector: TOGGLE, timeout: T.medium });
  try {
    const r = await box(page.locator(TOGGLE));
    await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
    return await signal.evaluate(({ done }) => done);
  } finally {
    try {
      await signal.evaluate(({ cancel }) => cancel());
      if (evidence) await evidence(await signal.evaluate(({ snapshot }) => snapshot()));
    } finally { await signal.dispose(); }
  }
}

export async function setTrack(page: Page, width: 262 | 420): Promise<void> {
  const resizer = page.getByTestId('hub-rail-resizer');
  await resizer.focus();
  await resizer.press(width === 262 ? 'Home' : 'End');
  await expect(resizer).toHaveAttribute('aria-valuenow', String(width));
  await settle(page);
  const track = await page.locator(BODY).evaluate((node) => Number.parseFloat(getComputedStyle(node).gridTemplateColumns));
  expect(track).toBeCloseTo(width, 5);
}

export async function chromeProbe(page: Page) {
  return page.evaluate(() => {
    const measure = {
      rect(selector: string) {
        const node = document.querySelector(selector);
        if (!node) throw new Error(`Missing ${selector}`);
        const r = node.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
      },
      overlap(a: Box, b: Box) { return Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y)); },
    };
    const rail = measure.rect('[data-project-rail]');
    const chrome = measure.rect('[data-testid="app-window-chrome"]');
    const lights = measure.rect('[data-testid="window-controls"]');
    const drag = measure.rect('.app-window-chrome__drag');
    const controls = Array.from(document.querySelectorAll('[data-project-rail-toggle], .window-controls button')).map((node) => {
      const r = node.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { id: node.getAttribute('data-testid'), reachable: !!hit && node.contains(hit) };
    });
    return { rail, chrome, lights, drag, overlap: measure.overlap(rail, chrome) + measure.overlap(rail, lights) + measure.overlap(rail, drag), controls, height: innerHeight };
  });
}

/** Samples every item near its trailing edge as well as the surface corners.
 * The trailing-edge probes fall outside a collapsed rail, where inline menus were clipped. */
export async function overlayProbe(locator: Locator) {
  return locator.evaluate(async (node, timeout) => {
    // Visibility is not paint readiness: fades/pop transforms can still run,
    // and portalled menus place themselves in a layout effect or resize task.
    // Observe only this surface, its contents and its actual ancestor effects.
    await new Promise<void>((resolve, reject) => {
      let frame = 0;
      let previous = '';
      const animations = new Set<Animation>();
      const ancestors: Element[] = [];
      for (let parent = node.parentElement; parent; parent = parent.parentElement) ancestors.push(parent);
      const watch = {
        invalidate() { previous = ''; },
        cleanup() {
          cancelAnimationFrame(frame);
          clearTimeout(timer);
          mutation.disconnect();
          resize.disconnect();
          for (const animation of animations) {
            animation.removeEventListener('finish', watch.invalidate);
            animation.removeEventListener('cancel', watch.invalidate);
          }
        },
        tick() {
          try {
            if (!node.isConnected) throw new Error('Overlay detached before paint probes');
            const r = node.getBoundingClientRect();
            const styles = [node, ...ancestors].map((element) => getComputedStyle(element));
            const current = JSON.stringify([r.x, r.y, r.width, r.height,
              ...styles.map((style) => [style.opacity, style.transform, style.visibility])]);
            const live = [...node.getAnimations({ subtree: true }), ...ancestors.flatMap((element) => element.getAnimations())]
              .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
            for (const animation of live) if (!animations.has(animation)) {
              animations.add(animation);
              animation.addEventListener('finish', watch.invalidate);
              animation.addEventListener('cancel', watch.invalidate);
            }
            const active = live.some((animation) => animation.playState !== 'finished' && animation.playState !== 'idle');
            const visible = r.width > 0 && r.height > 0 && styles.every((style) => style.visibility !== 'hidden' && Number(style.opacity) > 0);
            // Cancellation is not completion: replacements must also become
            // inactive, followed by an unchanged rendered position/material.
            if (!active && visible && previous === current) { watch.cleanup(); resolve(); return; }
            previous = active ? '' : current;
            frame = requestAnimationFrame(watch.tick);
          } catch (error) { watch.cleanup(); reject(error); }
        },
      };
      const mutation = new MutationObserver(watch.invalidate);
      mutation.observe(node, { attributes: true, childList: true, subtree: true });
      const resize = new ResizeObserver(watch.invalidate);
      resize.observe(node);
      const timer = setTimeout(() => { watch.cleanup(); reject(new Error('Overlay animations/placement did not settle')); }, timeout);
      frame = requestAnimationFrame(watch.tick);
    });
    const r = node.getBoundingClientRect();
    const points = [
      { x: r.x + 8, y: r.y + 8 }, { x: r.right - 8, y: r.y + 8 },
      { x: r.x + 8, y: r.bottom - 8 }, { x: r.right - 8, y: r.bottom - 8 },
      ...Array.from(node.querySelectorAll('button, input, [role="menuitem"], [role="menuitemradio"]')).map((item) => {
        const b = item.getBoundingClientRect();
        return { x: b.right - 8, y: b.y + b.height / 2 };
      }).filter((point) => point.y > r.top && point.y < r.bottom),
    ];
    const probes = points.map((point) => {
      const hit = document.elementFromPoint(point.x, point.y);
      return { ...point, painted: !!hit && node.contains(hit), hit: hit?.closest('[data-testid]')?.getAttribute('data-testid') ?? hit?.tagName ?? null };
    });
    const rail = document.querySelector('[data-project-rail]');
    const railBox = rail?.getBoundingClientRect();
    const clippingAncestors: string[] = [];
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const b = parent.getBoundingClientRect();
      if ((/(hidden|clip|auto|scroll)/.test(style.overflowX) && (r.left < b.left || r.right > b.right))
        || (/(hidden|clip|auto|scroll)/.test(style.overflowY) && (r.top < b.top || r.bottom > b.bottom))) clippingAncestors.push(parent.className);
    }
    return {
      rect: { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom },
      viewport: { width: innerWidth, height: innerHeight }, position: getComputedStyle(node).position,
      inRail: !!rail?.contains(node), clippingAncestors, probes,
      outsideRail: railBox ? probes.filter((p) => p.x > railBox.right) : [],
    };
  }, T.medium);
}

export async function assertOverlay(locator: Locator, requireEscape = true): Promise<void> {
  await expect(locator).toBeVisible();
  const p = await overlayProbe(locator);
  expect(p.rect.x).toBeGreaterThanOrEqual(0);
  expect(p.rect.y).toBeGreaterThanOrEqual(0);
  expect(p.rect.right).toBeLessThanOrEqual(p.viewport.width);
  expect(p.rect.bottom).toBeLessThanOrEqual(p.viewport.height);
  expect(p.clippingAncestors).toEqual([]);
  expect(p.probes.filter((point) => !point.painted)).toEqual([]);
  if (requireEscape) {
    expect(p.inRail).toBe(false);
    expect(p.outsideRail.length).toBeGreaterThan(0);
    expect(p.outsideRail.every((point) => point.painted)).toBe(true);
  }
}

/** CSSOM comes from the served page, not source files that may differ from the running build. */
export async function ambientProbe(page: Page) {
  return page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>('.workspace-shell');
    const rail = document.querySelector<HTMLElement>('[data-project-rail]');
    if (!shell || !rail) throw new Error('Missing ambient shell/rail');
    const colorParser = { alpha(color: string) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas color parser unavailable');
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return context.getImageData(0, 0, 1, 1).data[3]! / 255;
    } };
    const style = getComputedStyle(rail);
    const shellStyle = getComputedStyle(shell);
    const blockers: string[] = [];
    for (let parent = rail.parentElement; parent && parent !== shell; parent = parent.parentElement) {
      const s = getComputedStyle(parent);
      if (colorParser.alpha(s.backgroundColor) > 0 || s.backgroundImage !== 'none') blockers.push(parent.className);
    }
    const blooms: { owner: string; pseudo: string; image: string; shared: boolean; inert: boolean }[] = [];
    for (const node of [shell, ...shell.querySelectorAll('*')]) {
      if (rail.contains(node)) continue;
      for (const pseudo of ['', '::before', '::after']) {
        const s = getComputedStyle(node, pseudo || null);
        if (!s.backgroundImage.includes('radial-gradient') || (pseudo && s.content === 'none')) continue;
        if (node === shell && !pseudo) continue;
        blooms.push({ owner: node.className, pseudo, image: s.backgroundImage,
          shared: !node.closest('[data-surface]'), inert: s.pointerEvents === 'none' });
      }
    }
    const signatures: { selector: string; property: string; value: string; href: string | null }[] = [];
    const css = { visit(rules: CSSRuleList, href: string | null) {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule) {
          for (const property of ['background', 'background-image', 'backdrop-filter', '--hub-canvas-background', '--hub-wash-bloom-accent', '--hub-wash-bloom-warm', '--hub-wash-bloom-cool']) {
            const value = rule.style.getPropertyValue(property);
            if (value && (/hub-(canvas|wash|glass)/.test(value) || property.startsWith('--hub-'))) signatures.push({ selector: rule.selectorText, property, value, href });
          }
        }
        if ('cssRules' in rule) css.visit((rule as CSSGroupingRule).cssRules, href);
      }
    } };
    for (const sheet of Array.from(document.styleSheets)) {
      if (sheet.href && new URL(sheet.href).origin !== location.origin) continue;
      css.visit(sheet.cssRules, sheet.href);
    }
    const r = shell.getBoundingClientRect();
    return { alpha: colorParser.alpha(style.backgroundColor), railImage: style.backgroundImage, blur: style.backdropFilter,
      shellImage: shellStyle.backgroundImage, shellRect: { x: r.x, y: r.y, right: r.right, bottom: r.bottom },
      blockers, blooms, signatures };
  });
}

/** Differential paint probe: vary ONLY the shared canvas underneath the real rail.
 * If the sampled rail pixels do not change, an opaque layer blocks transmission.
 * Restores the exact inline style; the positive rail material is never patched. */
export async function canvasTransmission(page: Page): Promise<number> {
  const { PNG } = await import('pngjs');
  const shell = page.locator(SHELL);
  const original = await shell.getAttribute('style');
  const r = await box(page.locator(RAIL));
  const clip = { x: Math.floor(r.x + r.width / 2 - 2), y: Math.floor(r.y + r.height * 0.55), width: 4, height: 4 };
  const samples: Buffer[] = [];
  try {
    for (const color of ['rgb(255, 0, 0)', 'rgb(0, 0, 255)']) {
      await shell.evaluate((node, color) => { node.style.setProperty('background', color, 'important'); }, color);
      // Screenshot synchronizes with rendering; this is not a wall-clock readiness wait.
      samples.push(PNG.sync.read(await page.screenshot({ clip })).data);
    }
  } finally {
    await shell.evaluate((node, original) => {
      if (original === null) node.removeAttribute('style');
      else node.setAttribute('style', original);
    }, original);
  }
  const first = samples[0]!, last = samples[1]!;
  let difference = 0;
  for (let i = 0; i < first.length; i += 4) {
    difference += Math.abs(first[i]! - last[i]!) + Math.abs(first[i + 2]! - last[i + 2]!);
  }
  return difference / (first.length / 2);
}
