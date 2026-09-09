import { randomUUID } from 'node:crypto';
import { expect, test as base } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { applyStandardMocks, routeAgents, STORAGE_KEY } from '@/playwright/mock-factory';
import { NativePageZoom, openSettledSwitcherPopover, readZoomMetrics } from '@/playwright/native-page-zoom';
import { T } from '@/timeouts';
import { addStorageInitScript } from '@/playwright/storage-init';

// Full Chromium's new headless mode includes chrome://settings; headless-shell
// does not. An isolated persistent profile is essential: settingsPrivate refuses
// zoom writes in an off-the-record context. No viewport or DPR emulation is used
// in the positive cases. --window-size sets the physical browser window once.
const test = base.extend({
  context: async ({ playwright, browserName, headless, baseURL }, use) => {
    test.skip(browserName !== 'chromium', 'Native page zoom is a Chromium-specific regression boundary');
    const context = await playwright.chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless,
      ...(baseURL ? { baseURL } : {}),
      viewport: null,
      reducedMotion: 'reduce',
      args: ['--window-size=1440,1000'],
    });
    try {
      await use(context);
    } finally {
      await context.close();
    }
  },
});

const MODEL = 'zoom-regression-model-with-a-deliberately-long-name';
const EFFORT = 'zoom-regression-extended-reasoning';
const PROJECT_NAME = 'Native Chromium zoom - a deliberately long editable project title';
const FACTORS = [1, 1.25, 1.5, 1.75, 2] as const;

test.beforeEach(async ({ page }) => {
  await applyStandardMocks(page);
  const config = {
    mode: 'daemon',
    agentId: 'mock',
    onboardingCompleted: true,
    skillId: null,
    designSystemId: null,
    agentModels: { mock: { model: MODEL, reasoning: EFFORT } },
    privacyDecisionAt: 1,
    telemetry: { metrics: false, content: false, artifactManifest: false },
  };
  await addStorageInitScript(page, ({ key, value }) => {
    localStorage.setItem(key, JSON.stringify(value));
    localStorage.setItem('readable-studio:hub-rail-collapsed', 'true');
    localStorage.setItem('readable-studio.project.chatPanelWidth', '600');
  }, { key: STORAGE_KEY, value: config });
  await page.route('**/api/app-config', async (route) => {
    if (route.request().method() === 'GET') await route.fulfill({ json: { config } });
    else await route.continue();
  });
  await routeAgents(page, [{
    id: 'mock', name: 'Mock Agent', bin: 'mock-agent', available: true, version: 'test',
    models: [{ id: MODEL, label: MODEL }],
    reasoningOptions: [{ id: EFFORT, label: 'Extended reasoning with a deliberately long label' }],
  }]);
});

async function openProject(page: Page): Promise<string> {
  const id = randomUUID();
  const response = await page.request.post('/api/projects', {
    data: { id, name: PROJECT_NAME, skillId: null, designSystemId: null, metadata: { kind: 'prototype', nameSource: 'user' } },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const body = await response.json() as { project: { id: string }; conversationId: string };
  await page.goto(`/projects/${body.project.id}/conversations/${body.conversationId}`);
  await expect(page.getByTestId('chat-composer-input')).toBeVisible();
  await expect(page.getByTestId('composer-execution-switcher').getByTestId('inline-model-switcher-reasoning-trigger')).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.getByTestId('chat-composer-input').fill('Check native zoom send reachability');
  await expect(page.getByTestId('chat-send')).toBeEnabled();
  return body.project.id;
}

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };

type SplitResizeWindow = Window & {
  nativeZoomSplitResize?: { done: Promise<boolean>; cancel(): void };
};

async function resizeSplit(page: Page, action: () => Promise<void>): Promise<void> {
  // Rail state commits before ProjectView's ResizeObserver clamps the split.
  // Subscribe before the pointer action, after the product observer is mounted.
  await page.evaluate((timeoutMs) => {
    const split = document.querySelector('.app .split')!;
    const before = split.getBoundingClientRect().width;
    let complete: (resized: boolean) => void;
    const done = new Promise<boolean>((resolve) => { complete = resolve; });
    const finish = (resized: boolean) => {
      clearTimeout(timeout);
      observer.disconnect();
      complete(resized);
    };
    const observer = new ResizeObserver(() => {
      if (split.getBoundingClientRect().width !== before) finish(true);
    });
    const timeout = window.setTimeout(() => finish(false), timeoutMs);
    observer.observe(split);
    (window as SplitResizeWindow).nativeZoomSplitResize = { done, cancel: () => finish(false) };
  }, T.medium);
  try {
    await action();
    const resized = await page.evaluate(() => (window as SplitResizeWindow).nativeZoomSplitResize!.done);
    expect(resized, 'rail toggle must deliver the project split resize').toBe(true);
  } finally {
    await page.evaluate(() => (window as SplitResizeWindow).nativeZoomSplitResize!.cancel());
  }
}

function inside(inner: Rect, outer: Rect, label: string): void {
  expect(inner.width, `${label}: nonzero width`).toBeGreaterThan(0);
  expect(inner.height, `${label}: nonzero height`).toBeGreaterThan(0);
  expect(inner.left, `${label}: left`).toBeGreaterThanOrEqual(outer.left - 1);
  expect(inner.top, `${label}: top`).toBeGreaterThanOrEqual(outer.top - 1);
  expect(inner.right, `${label}: right`).toBeLessThanOrEqual(outer.right + 1);
  expect(inner.bottom, `${label}: bottom`).toBeLessThanOrEqual(outer.bottom + 1);
}

async function pointerTarget(locator: Locator): Promise<{ x: number; y: number }> {
  const hit = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const target = document.elementFromPoint(x, y);
    return { x, y, reachable: target !== null && element.contains(target), hitElement: target?.outerHTML ?? null };
  });
  expect(hit.reachable, `${locator}: centre must receive a real pointer, without scrolling or force; hit=${hit.hitElement}`).toBe(true);
  return hit;
}

async function assertLayout(page: Page, phase: string) {
  // One renderer task: never compare a pre-reflow parent with a post-reflow
  // child. Capture hits and overflow too, and retain them even on failure.
  const layout = await page.evaluate(() => {
    const rect = (element: Element): Rect => {
      const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
      return { left, top, right, bottom, width, height };
    };
    const element = (selector: string) => {
      const matches = document.querySelectorAll(selector);
      if (matches.length !== 1) throw new Error(`Expected one ${selector}, got ${matches.length}`);
      return matches[0]!;
    };
    const control = (selector: string, label: string) => {
      const target = element(selector);
      const bounds = rect(target);
      const x = bounds.left + bounds.width / 2;
      const y = bounds.top + bounds.height / 2;
      const hit = document.elementFromPoint(x, y);
      // A boolean alone cannot distinguish a real overlay from a stale hit-test
      // result. Keep the receiver and its ancestors in this same renderer task.
      const hitAncestry = [];
      for (let node = hit; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        hitAncestry.push({
          tag: node.tagName, id: node.id, class: node.getAttribute('class'),
          testId: node.getAttribute('data-testid'), bounds: rect(node),
          pointerEvents: style.pointerEvents, zIndex: style.zIndex,
          transform: style.transform,
        });
      }
      return { label, bounds, x, y, reachable: hit !== null && target.contains(hit), hitAncestry };
    };
    const shell = rect(element('.workspace-shell__body'));
    const surface = rect(element('.workspace-shell__body > [data-surface]'));
    const railElement = element('[data-project-rail]');
    return {
      viewport: { left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight },
      rail: rect(railElement),
      railTrack: { ...shell, right: surface.left, width: surface.left - shell.left },
      railInset: Number.parseFloat(getComputedStyle(railElement).marginInlineStart),
      pane: rect(element('.split-chat-slot > .pane')),
      composer: rect(element('[data-testid="chat-composer"]')),
      row: rect(element('.composer-row')),
      send: rect(element('[data-testid="chat-send"]')),
      cluster: rect(element('[data-testid="composer-execution-switcher"]')),
      executionControls: ['agent', 'model', 'reasoning'].map((variant) => control(
        `[data-testid="composer-execution-switcher"] [data-testid="inline-model-switcher-${variant}-trigger"]`, variant,
      )),
      primaryControls: [
        control('[data-testid="chat-send"]', 'Send'),
        control('[data-testid="project-title"]', 'project title'),
        control('[data-project-rail-toggle]', 'rail toggle'),
      ],
      popovers: Array.from(document.querySelectorAll('.inline-switcher__popover--layer'), (popover) => ({
        testId: popover.getAttribute('data-testid'), bounds: rect(popover),
        style: popover.getAttribute('style'),
      })),
      animations: document.getAnimations().map((animation) => ({
        name: animation instanceof CSSAnimation ? animation.animationName : null,
        property: animation instanceof CSSTransition ? animation.transitionProperty : null,
        playState: animation.playState,
        timing: animation.effect?.getComputedTiming(),
      })),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  await test.info().attach(`native-page-zoom-layout-${phase}`, {
    body: JSON.stringify(layout, null, 2), contentType: 'application/json',
  });
  const { pane, composer, row, send, cluster, rail, viewport } = layout;
  inside(rail, layout.railTrack, 'rail surface inside its shell track');
  inside(rail, viewport, 'persistent rail inside viewport');
  inside(pane, viewport, 'chat pane inside viewport');
  inside(composer, pane, 'composer inside its actual pane, not a body portal');
  inside(send, composer, 'Send inside composer');
  inside(send, viewport, 'Send inside viewport');
  inside(cluster, row, 'execution cluster yields inside footer');
  expect(cluster.right, 'cluster must not overlap Send').toBeLessThanOrEqual(send.left + 1);
  let previousRight = cluster.left;
  for (const { label, bounds, reachable } of layout.executionControls) {
    inside(bounds, cluster, `${label} inside yielding cluster`);
    inside(bounds, viewport, `${label} inside viewport`);
    expect(bounds.left, `${label} must not overlap its preceding control`).toBeGreaterThanOrEqual(previousRight - 1);
    previousRight = bounds.right;
    expect(reachable, `${label}: centre must receive a real pointer, without scrolling or force`).toBe(true);
  }
  for (const { label, bounds, reachable } of layout.primaryControls) {
    inside(bounds, viewport, `${label} inside viewport`);
    expect(reachable, `${label}: centre must receive a real pointer, without scrolling or force`).toBe(true);
  }
  expect(layout.overflow, 'native zoom must not create horizontal page overflow').toBeLessThanOrEqual(1);
  return layout;
}

for (const factor of FACTORS) {
  test(`[P1] native Chromium page zoom ${factor * 100}% keeps composer, rail, title and yielding model/effort usable`, async ({ page }, testInfo) => {
    const projectId = await openProject(page);
    try {
      const capability = await NativePageZoom.detect(page);
      if (!capability.supported) {
        await testInfo.attach('native-zoom-capability', { body: capability.reason, contentType: 'text/plain' });
        test.skip(true, capability.reason);
        return;
      }
      const zoom = capability.controller;
      try {
        const baseline = await assertLayout(page, 'baseline');
        const observed = await zoom.set(factor);
        // Persist the actual zoom even if a downstream layout assertion fails.
        await testInfo.attach('native-page-zoom-metrics', { body: JSON.stringify({ factor, observed }, null, 2), contentType: 'application/json' });
        // These assertions are deliberately downstream of the observed zoom
        // factor/DPR/reflow checks, including a 125% probe in the 100% case.
        const current = await assertLayout(page, 'zoomed');
        await testInfo.attach('native-page-zoom-observed', { body: JSON.stringify({ factor, observed, baseline, current }, null, 2), contentType: 'application/json' });
        expect(current.cluster.width).toBeLessThanOrEqual(baseline.cluster.width + 1);
        // Zoom need not shrink the chat pane monotonically: the narrow split
        // releases the workspace minimum and can restore the saved 600px chat
        // width. Judge overflow against the actual viewport above, and yielding
        // against the composer's compact container contract, not the zoom label.
        if (current.composer.width <= 430) {
          expect(current.cluster.width, 'model/effort must yield before Send is pushed out').toBeLessThan(baseline.cluster.width);
        }
        for (const variant of ['model', 'reasoning']) {
          const label = page.getByTestId('composer-execution-switcher').getByTestId(`inline-model-switcher-${variant}-label`);
          const widths = await label.evaluate((element) => ({ visible: element.clientWidth, content: element.scrollWidth }));
          expect(widths.visible).toBeGreaterThan(0);
          expect(widths.content, `${variant} long label should truncate, not widen the pane`).toBeGreaterThan(widths.visible);
        }

        // Real pointer interactions: no force, DOM click, or offscreen scroll.
        const title = page.getByTestId('project-title');
        const titlePoint = await pointerTarget(title);
        await page.mouse.click(titlePoint.x, titlePoint.y);
        await expect(title).toBeFocused();
        await page.keyboard.press('Enter');

        const rail = page.locator('[data-project-rail]');
        const toggle = page.locator('[data-project-rail-toggle]');
        await expect(rail).toHaveAttribute('data-project-rail-state', 'collapsed');
        expect(Math.abs(current.rail.width - 44), 'collapsed rail retains its desktop strip width').toBeLessThanOrEqual(1);
        // This is a CSS viewport breakpoint, not a physical-window or zoom
        // breakpoint. Narrow mode intentionally exposes a disabled toggle.
        const narrowRail = await page.evaluate(() => matchMedia('(max-width: 900px)').matches);
        if (narrowRail) {
          await expect(toggle).toBeDisabled();
          await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        } else {
          await expect(toggle).toBeEnabled();
          const togglePoint = await pointerTarget(toggle);
          await resizeSplit(page, () => page.mouse.click(togglePoint.x, togglePoint.y));
          await expect(rail).toHaveAttribute('data-project-rail-state', 'expanded');
          await expect(toggle).toHaveAttribute('aria-expanded', 'true');
          const expanded = await assertLayout(page, 'expanded');
          // 292px is the outer shell track: the visible slab stretches into
          // its remaining 282px after the intentional 10px inline inset.
          expect(expanded.railTrack.width, 'default expanded outer rail track').toBeCloseTo(292, 4);
          expect(expanded.railInset, 'expanded rail inline inset').toBe(10);
          expect(expanded.rail.width + expanded.railInset, 'rail fills the inset track').toBeCloseTo(expanded.railTrack.width, 4);
          const expandedTogglePoint = await pointerTarget(toggle);
          await resizeSplit(page, () => page.mouse.click(expandedTogglePoint.x, expandedTogglePoint.y));
          await expect(rail).toHaveAttribute('data-project-rail-state', 'collapsed');
          await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        }
        await assertLayout(page, 'collapsed');

        for (const variant of ['model', 'reasoning']) {
          const trigger = page.getByTestId('composer-execution-switcher').getByTestId(`inline-model-switcher-${variant}-trigger`);
          const point = await pointerTarget(trigger);
          await openSettledSwitcherPopover(page, `inline-model-switcher-${variant}-popover`,
            () => page.mouse.click(point.x, point.y));
          await expect(page.getByTestId(`inline-model-switcher-${variant}-popover`)).toBeVisible();
          await expect(page.getByTestId(`inline-model-switcher-${variant}-option-${variant === 'model' ? MODEL : EFFORT}`)).toBeVisible();
          // Opening either menu must not sacrifice Send's reserved space.
          await assertLayout(page, `${variant}-open`);
          await page.keyboard.press('Escape');
          await expect(trigger).toHaveAttribute('aria-expanded', 'false');
        }
        // Actionability verifies the enabled Send action without dispatching a
        // real agent run; the native-zoom regression is layout, not inference.
        await page.getByTestId('chat-send').click({ trial: true });
      } finally {
        await zoom.close();
      }
    } finally {
      const response = await page.request.delete(`/api/projects/${projectId}`);
      expect(response.ok(), await response.text()).toBe(true);
    }
  });
}

test('[P1] negative control: viewport emulation changes width but is not native page zoom', async ({ page }, testInfo) => {
  // Intentionally independent of capability detection, so an unsupported zoom
  // lane still runs this control instead of claiming resize coverage as zoom.
  await page.goto('/');
  await expect(page.getByTestId('home-hero-input')).toBeVisible();
  const session = await page.context().newCDPSession(page);
  try {
    const before = await readZoomMetrics(page, session);
    await page.setViewportSize({ width: Math.floor(before.width / 2), height: Math.floor(before.height / 2) });
    const after = await readZoomMetrics(page, session);
    expect(after.width).toBeLessThan(before.width);
    expect(after.height).toBeLessThan(before.height);
    expect(after.zoom).toBeCloseTo(before.zoom, 4);
    expect(after.zoom).not.toBeCloseTo(2, 3);
    expect(after.dpr).toBeCloseTo(before.dpr, 4);
    expect(after.pinchScale).toBeCloseTo(1, 4);
    await testInfo.attach('viewport-negative-control', { body: JSON.stringify({ before, after }, null, 2), contentType: 'application/json' });
  } finally {
    await session.detach();
  }
});
