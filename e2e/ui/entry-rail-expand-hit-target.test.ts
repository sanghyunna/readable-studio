// Regression: the collapsed project rail's expand control must be reachable by
// a REAL POINTER, not merely present in the DOM.
//
// The shipped defect put a rail expand control onto the "New project" button
// - 784px^2 of overlap, i.e. 100% of the control. Keyboard activation still
// worked, so the verification lane could keep going; a real mouse could not
// expand the rail at all. Home now owns the shared ProjectRail implementation,
// so this regression boundary exercises that real Hub rail directly.
//
// This test therefore HIT-TESTS. `toBeVisible()`, a bounding-box assertion and
// a DOM-driven `.click()` ALL pass on a fully covered element - only
// `elementFromPoint` at the control's own centre catches an overlay intercept,
// which is the second time that class of defect has appeared on this surface.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { applyStandardMocks } from '@/playwright/mock-factory';

const RAIL_COLLAPSED_STORAGE_KEY = 'readable-studio:hub-rail-collapsed';
const RAIL_TEST_ID = 'hub-nav';
const TOGGLE_TEST_ID = 'hub-rail-toggle';
const NEW_PROJECT_TEST_ID = 'hub-new-project';

type HitProbe = {
  centre: { x: number; y: number };
  /** The element the browser would actually deliver a press at that point to. */
  hitTestId: string | null;
  hitTag: string;
  /** True when the hit element IS the control or lies inside it. */
  reachable: boolean;
};

type RailGeometry = {
  collapse: { x: number; y: number; width: number; height: number };
  newProject: { x: number; y: number; width: number; height: number };
  /** Intersection area in px^2 between the expand control and New project. */
  overlapArea: number;
  probes: Record<'collapse' | 'newProject', HitProbe>;
};

test.beforeEach(async ({ page }) => {
  await applyStandardMocks(page);
  // Start on the collapsed strip - the state whose expand affordance is the
  // only way back to the panel with a mouse.
  await page.addInitScript(
    ({ key }: { key: string }) => window.localStorage.setItem(key, 'true'),
    { key: RAIL_COLLAPSED_STORAGE_KEY },
  );
});

/** Seed the theme through config - this product resolves theme from
 *  `readable-studio:config`, so `emulateMedia` would change nothing. */
async function seedTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.addInitScript(
    ({ key, value }: { key: string; value: string }) => {
      const raw = window.localStorage.getItem(key);
      const config: Record<string, unknown> = raw ? JSON.parse(raw) : {};
      config.theme = value;
      window.localStorage.setItem(key, JSON.stringify(config));
    },
    { key: 'readable-studio:config', value: theme },
  );
}

/** Wait until the rail's animated grid track has SETTLED. The track transitions
 *  between its collapsed strip and expanded panel, and geometry sampled
 *  mid-transition is meaningless. */
async function settleRail(page: Page): Promise<void> {
  await page.waitForFunction(
    ({ railTestId, toggleTestId, newProjectTestId }) => {
      const rail = document.querySelector(`[data-testid="${railTestId}"]`);
      const collapse = document.querySelector(`[data-testid="${toggleTestId}"]`);
      const newProject = document.querySelector(`[data-testid="${newProjectTestId}"]`);
      if (!rail || !collapse || !newProject) return false;
      const railBox = rail.getBoundingClientRect();
      const collapseBox = collapse.getBoundingClientRect();
      const newProjectBox = newProject.getBoundingClientRect();
      if (railBox.width <= 0 || collapseBox.width <= 0 || newProjectBox.width <= 0) return false;
      const key = [
        railBox.width,
        collapseBox.x, collapseBox.y,
        newProjectBox.x, newProjectBox.y,
      ].join(':');
      const scope = window as unknown as { __railKey?: string; __railHits?: number };
      scope.__railHits = scope.__railKey === key ? (scope.__railHits ?? 0) + 1 : 0;
      scope.__railKey = key;
      return (scope.__railHits ?? 0) >= 2;
    },
    {
      railTestId: RAIL_TEST_ID,
      toggleTestId: TOGGLE_TEST_ID,
      newProjectTestId: NEW_PROJECT_TEST_ID,
    },
    { timeout: 15_000, polling: 'raf' },
  );
}

async function readRailGeometry(page: Page): Promise<RailGeometry> {
  return await page.evaluate(({ toggleTestId, newProjectTestId }) => {
    const pick = (testId: string) =>
      document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

    const collapse = pick(toggleTestId);
    const newProject = pick(newProjectTestId);
    if (!collapse || !newProject) throw new Error('rail controls missing from the collapsed strip');

    const rect = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const collapseBox = rect(collapse);
    const newProjectBox = rect(newProject);

    const overlapWidth = Math.max(
      0,
      Math.min(collapseBox.x + collapseBox.width, newProjectBox.x + newProjectBox.width) -
        Math.max(collapseBox.x, newProjectBox.x),
    );
    const overlapHeight = Math.max(
      0,
      Math.min(collapseBox.y + collapseBox.height, newProjectBox.y + newProjectBox.height) -
        Math.max(collapseBox.y, newProjectBox.y),
    );

    const probe = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      const centre = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      const hit = document.elementFromPoint(centre.x, centre.y);
      return {
        centre,
        hitTestId: hit?.closest<HTMLElement>('[data-testid]')?.dataset.testid ?? null,
        hitTag: hit?.tagName.toLowerCase() ?? 'none',
        reachable: hit != null && (hit === el || el.contains(hit)),
      };
    };

    return {
      collapse: collapseBox,
      newProject: newProjectBox,
      overlapArea: overlapWidth * overlapHeight,
      probes: { collapse: probe(collapse), newProject: probe(newProject) },
    };
  }, { toggleTestId: TOGGLE_TEST_ID, newProjectTestId: NEW_PROJECT_TEST_ID });
}

/** Open Home, whose Hub is now the configured consumer of ProjectRail. */
async function gotoEntryRailSurface(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.readable-loading-shell')).toHaveCount(0, { timeout: 15_000 });
  const privacyDialog = page.getByRole('dialog').filter({ hasText: 'Help us improve Readable Studio' });
  if (await privacyDialog.isVisible().catch(() => false)) {
    await privacyDialog.getByRole('button', { name: /I get it|not now|got it|don't share/i }).click();
  }
  await expect(page.getByTestId('entry-view-home')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId(RAIL_TEST_ID)).toBeVisible();
  await settleRail(page);
  await expect(page.getByTestId(RAIL_TEST_ID)).toHaveAttribute('data-rail-state', 'collapsed');
}

for (const theme of ['light', 'dark'] as const) {
  test(`[P0] collapsed rail expand control is hit-testable, not just present (${theme})`, async ({ page }) => {
    await seedTheme(page, theme);
    await gotoEntryRailSurface(page);

    // The theme is a precondition for the measurement, so prove it applied.
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

    const geometry = await readRailGeometry(page);

    // THE ASSERTION THAT MATTERS: a real pointer press at the expand control's
    // own centre must be delivered to the expand control. This fails whenever
    // anything - the New project button, a drag surface, a tooltip layer -
    // covers that point, which no presence or bounding-box check can detect.
    expect(
      geometry.probes.collapse.reachable,
      `expand control centre (${geometry.probes.collapse.centre.x}, ${geometry.probes.collapse.centre.y}) ` +
        `is covered by <${geometry.probes.collapse.hitTag} data-testid=${geometry.probes.collapse.hitTestId}>`,
    ).toBe(true);

    // The two controls must not occupy the same pixels at all.
    expect(geometry.overlapArea).toBe(0);

    // Fixing the expand control must not cost New project its own clickability.
    expect(
      geometry.probes.newProject.reachable,
      `New project centre is covered by <${geometry.probes.newProject.hitTag} ` +
        `data-testid=${geometry.probes.newProject.hitTestId}>`,
    ).toBe(true);

    // End-to-end proof with a REAL mouse press at the control's centre - the
    // interaction the user could not perform. Playwright's own `.click()` is
    // deliberately avoided here: it would scroll/retarget and could pass on a
    // covered control.
    await page.mouse.click(geometry.probes.collapse.centre.x, geometry.probes.collapse.centre.y);
    await expect(page.getByTestId(RAIL_TEST_ID)).toHaveAttribute('data-rail-state', 'expanded');
  });
}

test('[P0] keyboard activation of the rail expand control still works', async ({ page }) => {
  await seedTheme(page, 'light');
  await gotoEntryRailSurface(page);

  // Keyboard was the fallback the verification lane was forced onto; it must
  // keep working alongside the restored pointer path.
  await page.getByTestId(TOGGLE_TEST_ID).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId(RAIL_TEST_ID)).toHaveAttribute('data-rail-state', 'expanded');
});

test('[P0] expanded rail keeps both controls independently hit-testable', async ({ page }) => {
  await seedTheme(page, 'light');
  await gotoEntryRailSurface(page);

  await page.getByTestId(TOGGLE_TEST_ID).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId(RAIL_TEST_ID)).toHaveAttribute('data-rail-state', 'expanded');
  await settleRail(page);

  const geometry = await readRailGeometry(page);
  expect(geometry.overlapArea).toBe(0);
  expect(geometry.probes.collapse.reachable).toBe(true);
  expect(geometry.probes.newProject.reachable).toBe(true);

  // New project must remain independently clickable in the expanded panel.
  await page.mouse.click(geometry.probes.newProject.centre.x, geometry.probes.newProject.centre.y);
  await expect(page.getByTestId(RAIL_TEST_ID)).toHaveAttribute('data-rail-state', 'expanded');
});
