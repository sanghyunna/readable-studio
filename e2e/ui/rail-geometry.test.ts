import { expect, test, type Page } from '@playwright/test';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { addStorageInitScript } from '@/playwright/storage-init';
import { T } from '@/timeouts';
import {
  RAIL, TOGGLE, ambientProbe, assertOverlay, box, changeAndWait,
  canvasTransmission, chromeProbe, horizontalOnly, overlayProbe, setTrack, settle, toggleMotion, tolerance,
} from '@/playwright/rail-geometry';

// Real renderer/CSS; only external data and the native window IPC boundary are fixtures.
// No screenshot baselines, elapsed-time readiness, or production-source imports.
const PROJECT = 'rail-geometry-project';
const SESSION = 'rail-geometry-session';
const projectRow = `hub-project-${PROJECT}`;
const sessionRow = `hub-session-${SESSION}`;
const id = (value: string) => `[data-testid="${value}"]`;

test.use({ viewport: { width: 1600, height: 1000 } });
test.describe.configure({ timeout: T.xlong });

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await applyStandardMocks(page);
  await addStorageInitScript(page, () => {
    localStorage.setItem('readable-studio:hub-rail-collapsed', 'false');
    localStorage.removeItem('readable-studio:hub-rail-width');
  }, undefined);
  await page.addInitScript(() => {
    // Render the actual Windows traffic lights without pretending a browser can perform IPC.
    Object.defineProperty(window, 'readableStudioDesktop', { configurable: true, value: {
      window: {
        async close() {}, async minimize() {},
        async getState() { return { maximized: false }; },
        async toggleMaximize() { return { maximized: false }; },
        onStateChange() { return () => undefined; },
      },
    } });
  });
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'GET') throw new Error('Geometry spec must not mutate daemon projects');
    await route.fulfill({ json: { projects: [{
      id: PROJECT, name: 'Rail geometry project', createdAt: 1, updatedAt: 2,
      skillId: null, designSystemId: null, pendingPrompt: '', customInstructions: null,
      metadata: { kind: 'prototype' }, status: { value: 'succeeded' },
    }] } });
  });
  await page.route(`**/api/projects/${PROJECT}/conversations`, async (route) => {
    if (route.request().method() !== 'GET') throw new Error('Geometry spec must not create sessions');
    await route.fulfill({ json: { conversations: [{
      id: SESSION, projectId: PROJECT, title: 'Geometry session', createdAt: 1, updatedAt: 2,
      sessionMode: 'design', messageCount: 1,
    }] } });
  });
});

async function open(page: Page, theme: 'light' | 'dark' = 'light'): Promise<void> {
  await addStorageInitScript(page, (theme) => {
    const config = JSON.parse(localStorage.getItem('readable-studio:config') ?? '{}') as Record<string, unknown>;
    localStorage.setItem('readable-studio:config', JSON.stringify({ ...config, theme }));
  }, theme);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(page.getByTestId('home-hero-input')).toBeVisible();
  await expect(page.getByTestId(sessionRow)).toBeVisible();
  await expect(page.getByTestId('window-controls').locator('button')).toHaveCount(3);
  await settle(page);
}

function checkBoundary(p: Awaited<ReturnType<typeof chromeProbe>>, state: 'expanded' | 'collapsed', epsilon: number): void {
  const inset = state === 'expanded' ? 10 : 0;
  expect(p.chrome.y).toBe(0);
  expect(p.chrome.height).toBe(36);
  expect(Math.abs(p.rail.y - p.chrome.bottom - inset)).toBeLessThanOrEqual(epsilon);
  expect(Math.abs(p.height - p.rail.bottom - inset)).toBeLessThanOrEqual(epsilon);
  expect(Math.abs(p.rail.x - inset)).toBeLessThanOrEqual(epsilon);
  expect(p.overlap).toBe(0);
  expect(p.controls.every((control) => control.reachable), JSON.stringify(p.controls)).toBe(true);
  expect(p.lights.y).toBeGreaterThanOrEqual(p.chrome.y);
  expect(p.lights.bottom).toBeLessThanOrEqual(p.chrome.bottom);
}

for (const track of ['default', 262, 420] as const) {
  test(`[P0] rail toggle follows a horizontal-only path and brand/right-edge geometry (${track === 'default' ? 'default' : `${track}px`} track)`, async ({ page }, testInfo) => {
    await open(page);
    if (track !== 'default') await setTrack(page, track);
    else expect(await page.getByTestId('hub-rail-resizer').getAttribute('aria-valuenow')).toBe('292');
    const epsilon = await tolerance(page);
    const brand = await box(page.getByTestId('hub-brand'));
    const brandMark = await box(page.locator('.hub__brand-mark'));
    const expanded = await box(page.locator(TOGGLE));
    const newProject = await box(page.getByTestId('hub-new-project'));
    expect(Math.abs(expanded.right - newProject.right)).toBeLessThanOrEqual(epsilon);
    expect(expanded.x).toBeGreaterThanOrEqual(brand.right - epsilon);
    checkBoundary(await chromeProbe(page), 'expanded', epsilon);

    // Capture both directions before geometry assertions: a diagonal collapse
    // must not prevent recording expansion. Attach even a failed/cancelled run.
    const observations = [];
    for (const state of ['collapsed', 'expanded'] as const) {
      const samples = await toggleMotion(page, async (evidence) => {
        await testInfo.attach(`rail-motion-${state}`, { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
      });
      observations.push({ state, samples,
        actualState: await page.locator(RAIL).getAttribute('data-project-rail-state'),
        boundary: await chromeProbe(page), toggle: await box(page.locator(TOGGLE)), rail: await box(page.locator(RAIL)),
        brandVisible: await page.getByTestId('hub-brand').isVisible(),
        brandRects: await page.getByTestId('hub-brand').evaluate((node) => node.getClientRects().length),
        newProjectRight: (await box(page.getByTestId('hub-new-project'))).right,
      });
    }
    for (const { state, samples, actualState, boundary, toggle, rail, brandVisible, brandRects, newProjectRight } of observations) {
      expect(actualState).toBe(state);
      expect(horizontalOnly(samples, epsilon), JSON.stringify(samples)).toBe(true);
      const first = samples[0]!;
      const last = samples.at(-1)!;
      const low = Math.min(first.x, last.x), high = Math.max(first.x, last.x);
      expect(high - low).toBeGreaterThan(100);
      // Endpoints alone cannot prove a path. Require a painted intermediate track and X.
      expect(samples.some((p) => p.x > low + epsilon && p.x < high - epsilon && p.width !== first.width && p.width !== last.width)).toBe(true);
      checkBoundary(boundary, state, epsilon);
      expect(Math.abs(toggle.y + toggle.height / 2 - expanded.y - expanded.height / 2)).toBeLessThanOrEqual(epsilon);
      if (state === 'collapsed') {
        expect(brandVisible).toBe(false);
        expect(brandRects).toBe(0);
        expect(Math.abs(toggle.x + toggle.width / 2 - rail.x - rail.width / 2)).toBeLessThanOrEqual(epsilon);
        expect(Math.abs(toggle.y + toggle.height / 2 - brandMark.y - brandMark.height / 2)).toBeLessThanOrEqual(epsilon);
      } else {
        expect(Math.abs(toggle.right - newProjectRight)).toBeLessThanOrEqual(epsilon);
      }
    }
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`[P0] wide ${theme} rail transmits the shared ambient canvas and blooms`, async ({ page }, testInfo) => {
    await open(page, theme);
    for (const state of ['expanded', 'collapsed'] as const) {
      if (state === 'collapsed') await toggleMotion(page);
      const p = await ambientProbe(page);
      await testInfo.attach(`served-ambient-${state}`, { body: JSON.stringify(p, null, 2), contentType: 'application/json' });
      expect(p.shellRect).toEqual({ x: 0, y: 0, right: 1600, bottom: 1000 });
      expect((p.shellImage.match(/radial-gradient/g) ?? []).length).toBeGreaterThanOrEqual(3);
      expect(p.alpha).toBeGreaterThan(0);
      expect(p.alpha).toBeLessThan(1);
      expect(p.railImage).toBe('none');
      expect(p.blur).toContain('blur(');
      expect(p.blockers).toEqual([]);
      const shared = p.blooms.filter((bloom) => bloom.shared && bloom.inert);
      expect(shared.length, JSON.stringify(p.blooms)).toBeGreaterThanOrEqual(3);
      for (const property of ['--hub-canvas-background', '--hub-wash-bloom-accent', '--hub-wash-bloom-warm', '--hub-wash-bloom-cool']) {
        expect(p.signatures.some((s) => s.property === property && s.value.includes('radial-gradient'))).toBe(true);
      }
      expect(p.signatures.some((s) => s.href !== null && s.value.includes('--hub-glass-fill'))).toBe(true);
      expect(await canvasTransmission(page)).toBeGreaterThan(2);
    }
  });
}

async function menuCycle(page: Page, menuId: string, triggerId: string, action: () => Promise<unknown>, escapes = true): Promise<void> {
  const menu = page.getByTestId(menuId);
  await changeAndWait(page, id(menuId), true, action);
  await assertOverlay(menu, escapes);
  expect((await overlayProbe(menu)).inRail).toBe(false);
  await page.setViewportSize({ width: 1024, height: 520 });
  await assertOverlay(menu, escapes);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await assertOverlay(menu, escapes);
  await expect(menu.locator(':focus')).toHaveCount(1);
  await changeAndWait(page, id(menuId), false, () => page.keyboard.press('Escape'));
  await expect(page.getByTestId(triggerId)).toBeFocused();
  await changeAndWait(page, id(menuId), true, action);
  await changeAndWait(page, id(menuId), false, () => page.getByTestId('home-hero-input').click());
  await expect(page.getByTestId('home-hero-input')).toBeFocused();
}

for (const track of [262, 420] as const) {
  test(`[P0] all rail menus escape clipping, dismiss and restore focus (${track}px and collapsed)`, async ({ page }) => {
    await open(page);
    await setTrack(page, track);
    await menuCycle(page, 'hub-library-menu', 'hub-library', () => page.getByTestId('hub-library').click(), false);
    await menuCycle(page, 'hub-sort-menu', 'hub-sort', () => page.getByTestId('hub-sort').click(), false);
    for (const row of [projectRow, sessionRow]) {
      await menuCycle(page, 'hub-row-menu', row, async () => {
        await page.getByTestId(row).focus();
        await page.keyboard.press('Shift+F10');
      }, false);
    }
    // Real pointer context position near the wide track's trailing edge; shrinking
    // the viewport while open forces both horizontal clamping and vertical flipping.
    // End the preceding outside-click/editor interaction before starting the
    // independent pointer-context scenario. Right-click does not focus a row.
    await page.getByTestId(projectRow).focus();
    await expect(page.getByTestId(projectRow)).toBeFocused();
    const title = page.getByTestId(projectRow).locator('> .hub-row__title');
    const r = await box(title);
    await changeAndWait(page, id('hub-row-menu'), true, () => page.mouse.click(r.right - 2, r.y + r.height / 2, { button: 'right' }));
    await expect(page.getByTestId('hub-row-menu').locator(':focus')).toHaveCount(1);
    await page.setViewportSize({ width: 320, height: 420 });
    await settle(page);
    await assertOverlay(page.getByTestId('hub-row-menu'));
    await expect(page.getByTestId('hub-row-menu').locator(':focus')).toHaveCount(1);
    await changeAndWait(page, id('hub-row-menu'), false, () => page.keyboard.press('Escape'));
    await expect(page.getByTestId(projectRow)).toBeFocused();
    await page.setViewportSize({ width: 1600, height: 1000 });
    await settle(page);
    await toggleMotion(page);
    await menuCycle(page, 'hub-project-flyout', projectRow, async () => {
      await page.getByTestId(projectRow).focus();
      await page.keyboard.press('Enter');
    });
    await menuCycle(page, 'hub-library-menu', 'hub-library', () => page.getByTestId('hub-library').click());
    await changeAndWait(page, id('hub-library-menu'), true, () => page.getByTestId('hub-library').click());
    await page.setViewportSize({ width: 1024, height: 420 });
    await settle(page);
    await assertOverlay(page.getByTestId('hub-library-menu'));
    const menu = await box(page.getByTestId('hub-library-menu'));
    const anchor = await box(page.getByTestId('hub-library'));
    expect(menu.bottom).toBeLessThanOrEqual(anchor.y); // Footer menu must flip upward.
    await changeAndWait(page, id('hub-library-menu'), false, () => page.keyboard.press('Escape'));
    await expect(page.getByTestId('hub-library')).toBeFocused();
  });

  test(`[P1] rail confirmation, palette, inspector and undo paint above content (${track}px)`, async ({ page }) => {
    await open(page);
    await setTrack(page, track);
    await changeAndWait(page, id('hub-delete-confirm'), true, async () => {
      await page.getByTestId(projectRow).focus();
      await page.keyboard.press('Delete');
    });
    await assertOverlay(page.getByTestId('hub-delete-confirm'));
    await changeAndWait(page, id('hub-delete-confirm'), false, () => page.keyboard.press('Escape'));
    await expect(page.getByTestId(projectRow)).toBeFocused();
    await changeAndWait(page, id('hub-delete-confirm'), true, () => page.keyboard.press('Delete'));
    await changeAndWait(page, id('hub-delete-confirm'), false, () => page.getByTestId('hub-delete-confirm-backdrop').click({ position: { x: 4, y: 4 } }));
    await expect(page.getByTestId(projectRow)).toBeFocused();

    await page.getByTestId('hub-open-palette').focus();
    await changeAndWait(page, id('hub-command-palette'), true, () => page.keyboard.press('Enter'));
    await assertOverlay(page.getByTestId('hub-command-palette'));
    await changeAndWait(page, id('hub-command-palette'), false, () => page.keyboard.press('Escape'));
    await expect(page.getByTestId('hub-open-palette')).toBeFocused();
    await changeAndWait(page, id('hub-command-palette'), true, () => page.keyboard.press('Enter'));
    await changeAndWait(page, id('hub-command-palette'), false, () => page.getByTestId('hub-palette-scrim').click({ position: { x: 4, y: 4 } }));
    await expect(page.getByTestId('hub-open-palette')).toBeFocused();

    await page.getByTestId(sessionRow).focus();
    await changeAndWait(page, id('hub-inspector'), true, () => page.keyboard.press('Space'));
    await assertOverlay(page.getByTestId('hub-inspector'));
    await page.setViewportSize({ width: 1024, height: 520 });
    await settle(page);
    await assertOverlay(page.getByTestId('hub-inspector'));
    // Inspector is deliberately non-modal; outside interaction must not dismiss it.
    // The right-hand inspector covers the composer's center at the wide track.
    // Use the exposed native input, not Lexical's independently owned selection.
    await page.getByTestId('hub-search').click();
    await expect(page.getByTestId('hub-search')).toBeFocused();
    await expect(page.getByTestId('hub-inspector')).toBeVisible();
    await changeAndWait(page, id('hub-inspector'), false, () => page.keyboard.press('Escape'));
    await expect(page.getByTestId(sessionRow)).toBeFocused();

    // Freeze the undo deadline without freezing renderer frames or hit-target stability.
    // The actual toast and controller still schedule their real timers on the fake clock.
    const frames = await page.evaluateHandle(() => ({
      request: window.requestAnimationFrame.bind(window), cancel: window.cancelAnimationFrame.bind(window),
    }));
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    await frames.evaluate(({ request, cancel }) => {
      window.requestAnimationFrame = request;
      window.cancelAnimationFrame = cancel;
    });
    await frames.dispose();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await changeAndWait(page, '.readable-toast', true, () => page.keyboard.press('Delete'));
    await expect(page.locator('.readable-toast')).toBeVisible();
    await assertOverlay(page.locator('.readable-toast'));
    await changeAndWait(page, '.readable-toast', false, () => page.locator('.readable-toast-undo').click());
    await expect(page.getByTestId(sessionRow)).toBeVisible();
  });
}

test('[P1] rail tooltip and New Project overlay escape both resized and collapsed tracks', async ({ page }) => {
  await open(page);
  for (const track of [262, 420] as const) {
    await setTrack(page, track);
    await toggleMotion(page);
    await page.getByTestId('home-hero-input').focus();
    await page.keyboard.press('Escape'); // Establish keyboard modality, without a hover timer.
    await changeAndWait(page, '[role="tooltip"]', true, () => page.locator(TOGGLE).focus());
    const tooltip = page.getByRole('tooltip');
    await settle(page);
    // Tooltip is intentionally pointer-inert. Temporarily admit it to hit testing
    // to measure its real paint order, then restore the exact authored behavior.
    const pointer = await tooltip.evaluate((node) => {
      const previous = node.style.pointerEvents;
      node.style.pointerEvents = 'auto';
      return previous;
    });
    try { await assertOverlay(tooltip); }
    finally { await tooltip.evaluate((node, previous) => { node.style.pointerEvents = previous; }, pointer); }
    await changeAndWait(page, '[role="tooltip"]', false, () => page.keyboard.press('Escape'));
    await expect(page.locator(TOGGLE)).toBeFocused();
    await changeAndWait(page, id('new-project-modal'), true, () => page.getByTestId('hub-new-project').click());
    await settle(page);
    await assertOverlay(page.locator('.new-project-modal'));
    await changeAndWait(page, id('new-project-modal'), false, () => page.keyboard.press('Escape'));
    await toggleMotion(page);
  }
});

test('[P1] negative controls reject diagonal motion, opaque glass, chrome overlap and clipped inline Library', async ({ page }) => {
  await open(page);
  const epsilon = await tolerance(page);
  const diagonal = await page.addStyleTag({ content: `
    [data-project-rail-toggle] { transition: transform 180ms linear !important; }
    [data-project-rail-state="collapsed"] [data-project-rail-toggle] { transform: translateY(-10px) !important; }
  ` });
  expect(horizontalOnly(await toggleMotion(page), epsilon)).toBe(false);
  await diagonal.evaluate((node) => node.parentNode?.removeChild(node));
  await settle(page);
  const opaque = await page.addStyleTag({ content: '[data-project-rail] { background: rgb(0, 0, 0) !important; }' });
  expect((await ambientProbe(page)).alpha).toBe(1);
  expect(await canvasTransmission(page)).toBe(0);
  await opaque.evaluate((node) => node.parentNode?.removeChild(node));
  const overlap = await page.addStyleTag({ content: '[data-project-rail] { transform: translateY(-36px) !important; }' });
  expect((await chromeProbe(page)).overlap).toBeGreaterThan(0);
  await overlap.evaluate((node) => node.parentNode?.removeChild(node));
  await changeAndWait(page, id('hub-library-menu'), true, () => page.getByTestId('hub-library').click());
  await assertOverlay(page.getByTestId('hub-library-menu'));
  // Reproduce the old inline menu, preserving its real items and actual rail overflow.
  await page.getByTestId('hub-library-menu').evaluate((menu) => {
    const rail = document.querySelector('[data-project-rail]');
    if (!rail) throw new Error('Missing rail for inline negative control');
    rail.append(menu);
    menu.style.position = 'absolute';
    menu.style.left = '0';
    menu.style.top = '100px';
    menu.style.width = '208px';
  });
  const clipped = await overlayProbe(page.getByTestId('hub-library-menu'));
  expect(clipped.inRail).toBe(true);
  expect(clipped.clippingAncestors.length).toBeGreaterThan(0);
  expect(clipped.outsideRail.length).toBeGreaterThan(0);
  expect(clipped.outsideRail.some((p) => !p.painted)).toBe(true);
});
