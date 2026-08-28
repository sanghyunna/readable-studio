// Todo 12 - the collapsed rail, the project flyout and the narrow layout.
//
// Every assertion here is a MEASUREMENT, not a class-name check. `hub--rail-collapsed`
// being present proves nothing: todo 10 shipped that exact class with a rule that
// merely set `visibility: hidden`, which reads as "collapsed" to a selector and as
// "the rail is gone" to a user. So the rail's collapse is proved by its RENDERED WIDTH,
// its keyboard reachability by focusing real rows, and the filter row's fit by
// comparing it against the nav that contains it.

import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EVIDENCE_DIR =
  process.env.READABLE_TASK12_EVIDENCE_DIR ??
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../.omo/evidence/task-12');

// Kept in sync with `--hub-rail-collapsed` in apps/web/src/styles/home/hub.css.
const COLLAPSED_RAIL_PX = 78;
// The expanded rail is 292px (`.hub` grid-template-columns). Anything at or below
// this is unambiguously not the expanded rail.
const EXPANDED_RAIL_PX = 292;
const NARROW_BREAKPOINT_PX = 900;
const FILTER_WIDTHS = [1280, 1440, 1600, 1920];

mkdirSync(EVIDENCE_DIR, { recursive: true });

// One daemon and one database serve the whole file, so a fixed project id would make
// every test after the first collide on the primary key. The scope separates the
// tests within a run, and RUN_ID separates one run from the next: this spec is
// committed, so it has to pass on a re-run against a data directory it already
// seeded, without anyone deleting state in between.
const RUN_ID = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

async function seedProject(
  request: APIRequestContext,
  scope: string,
  name: string,
  sessions: string[],
) {
  const id = `task-12-${RUN_ID}-${scope}-${name.toLocaleLowerCase().replace(/[^a-z0-9]+/gu, '-')}`;
  const response = await request.post('/api/projects', {
    data: {
      id,
      name,
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: { kind: 'prototype', nameSource: 'user' },
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const project = (await response.json()).project as { id: string };
  const created: { id: string; title: string }[] = [];
  for (const title of sessions) {
    const conversationResponse = await request.post(`/api/projects/${project.id}/conversations`, {
      data: { title },
    });
    expect(conversationResponse.ok(), await conversationResponse.text()).toBeTruthy();
    created.push((await conversationResponse.json()).conversation);
  }
  return { id: project.id, name, sessions: created };
}

async function gotoHub(page: Page) {
  // `addInitScript` re-runs on every navigation, so clearing the collapse preference
  // here would wipe the very state the reload assertions are meant to read back. The
  // per-test starting state is cleared once, after the first load, instead.
  await page.addInitScript(() => {
    window.localStorage.removeItem('readable-studio:workspace-tabs:v1');
    window.localStorage.setItem(
      'readable-studio:config',
      JSON.stringify({
        mode: 'daemon',
        agentId: 'codex',
        agentModels: {},
        agentCliEnv: {},
        onboardingCompleted: true,
        privacyDecisionAt: 1,
        telemetry: { metrics: false, content: false, artifactManifest: false },
      }),
    );
  });
  await page.goto('/');
  await expect(page.getByTestId('entry-view-home')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('hub-nav')).toBeVisible();
  const stale = await page.evaluate(() => {
    const had = window.localStorage.getItem('readable-studio:hub-rail-collapsed') === 'true';
    window.localStorage.removeItem('readable-studio:hub-rail-collapsed');
    window.sessionStorage.removeItem('readable-studio:hub-open-work');
    return had;
  });
  // A previous test may have left the rail collapsed; reload once so the rendered
  // state matches the cleared preference before any assertion runs.
  if (stale) {
    await page.reload();
    await expect(page.getByTestId('hub-nav')).toBeVisible();
  }
}

/** The rail's real painted width. A hidden rail measures 0 and fails the collapsed check too. */
async function railWidth(page: Page): Promise<number> {
  return page.getByTestId('hub-nav').evaluate((node) => node.getBoundingClientRect().width);
}

/**
 * Overflow of the filter row against the rail that must contain it.
 * `.hub-tree__filters` wraps, so its own scrollWidth equals its clientWidth even when
 * it is spilling out of the nav - the containing box is the only honest reference.
 */
async function filterOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const filters = document.querySelector('.hub-tree__filters');
    const nav = document.querySelector('.hub__nav');
    if (!filters || !nav) return Number.NaN;
    const filterBox = filters.getBoundingClientRect();
    const navBox = nav.getBoundingClientRect();
    return Math.max(0, Math.round(filterBox.right - navBox.right));
  });
}

async function isCollapsed(page: Page): Promise<boolean> {
  return (await page.locator('.hub').getAttribute('data-rail-collapsed')) === 'true';
}

test.describe('todo 12 - collapsed rail, flyout and narrow layout', () => {
  test('the toggle and Ctrl+B collapse the rail, and the collapse survives a reload', async ({
    page,
    request,
  }) => {
    const alpha = await seedProject(request, 'toggle', 'Alpha Quarterly', [
      'Chart cleanup',
      'Legend fix',
    ]);
    await seedProject(request, 'toggle', 'Beta Pricing', ['Pricing comparison']);
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoHub(page);
    await expect(page.getByTestId(`hub-session-${alpha.sessions[0]!.id}`)).toBeVisible();

    // Expanded baseline, measured.
    expect(await railWidth(page)).toBeGreaterThan(EXPANDED_RAIL_PX - 40);
    expect(await isCollapsed(page)).toBe(false);

    // --- the toggle button ---
    const toggle = page.getByTestId('hub-rail-toggle');
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(() => railWidth(page), { message: 'rail must narrow to the icon rail' })
      .toBeLessThanOrEqual(COLLAPSED_RAIL_PX + 2);
    // ...and it must NOT have merely been hidden: an icon rail is still a visible rail.
    expect(await railWidth(page)).toBeGreaterThan(COLLAPSED_RAIL_PX - 20);
    await expect(page.getByTestId('hub-nav')).toBeVisible();

    await page.screenshot({ path: `${EVIDENCE_DIR}/collapsed-1280.png`, fullPage: false });

    await toggle.click();
    await expect
      .poll(() => railWidth(page))
      .toBeGreaterThan(EXPANDED_RAIL_PX - 40);

    // --- Ctrl+B, the same binding todo 10 registered ---
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+b');
    await expect.poll(() => railWidth(page)).toBeLessThanOrEqual(COLLAPSED_RAIL_PX + 2);
    await page.keyboard.press('Control+b');
    await expect.poll(() => railWidth(page)).toBeGreaterThan(EXPANDED_RAIL_PX - 40);

    // Ctrl+B must not steal the character from a text field.
    const search = page.getByTestId('hub-search');
    await search.focus();
    await page.keyboard.press('Control+b');
    await expect.poll(() => railWidth(page)).toBeGreaterThan(EXPANDED_RAIL_PX - 40);

    // --- persistence, and no stale-state desync after reload ---
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+b');
    await expect.poll(() => railWidth(page)).toBeLessThanOrEqual(COLLAPSED_RAIL_PX + 2);
    expect(
      await page.evaluate(() => window.localStorage.getItem('readable-studio:hub-rail-collapsed')),
    ).toBe('true');

    await page.reload();
    await expect(page.getByTestId('hub-nav')).toBeVisible();
    // stale_state observable: the persisted flag and the painted width must agree.
    expect(await isCollapsed(page)).toBe(true);
    expect(
      await page.evaluate(() => window.localStorage.getItem('readable-studio:hub-rail-collapsed')),
    ).toBe('true');
    await expect.poll(() => railWidth(page)).toBeLessThanOrEqual(COLLAPSED_RAIL_PX + 2);

    // ...and expanding again persists the opposite value rather than just clearing it.
    await page.getByTestId('hub-rail-toggle').click();
    await expect.poll(() => railWidth(page)).toBeGreaterThan(EXPANDED_RAIL_PX - 40);
    await page.reload();
    await expect(page.getByTestId('hub-nav')).toBeVisible();
    expect(await isCollapsed(page)).toBe(false);
    await expect.poll(() => railWidth(page)).toBeGreaterThan(EXPANDED_RAIL_PX - 40);
  });

  test('collapsed rows show glyphs and state, and stay reachable from the keyboard', async ({
    page,
    request,
  }) => {
    const alpha = await seedProject(request, 'glyphs', 'Alpha Quarterly', [
      'Chart cleanup',
      'Legend fix',
    ]);
    const beta = await seedProject(request, 'glyphs', 'Beta Pricing', ['Pricing comparison']);
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoHub(page);
    await expect(page.getByTestId(`hub-session-${alpha.sessions[0]!.id}`)).toBeVisible();

    await page.getByTestId('hub-rail-toggle').click();
    await expect.poll(() => railWidth(page)).toBeLessThanOrEqual(COLLAPSED_RAIL_PX + 2);

    const alphaRow: Locator = page.locator(`[data-project-id="${alpha.id}"]`);
    const betaRow: Locator = page.locator(`[data-project-id="${beta.id}"]`);
    await expect(alphaRow).toBeVisible();
    await expect(betaRow).toBeVisible();

    // The glyph is the row's whole visible content when collapsed, and it is rendered -
    // not merely present as an attribute.
    await expect(alphaRow).toHaveAttribute('data-initial', 'A');
    await expect(betaRow).toHaveAttribute('data-initial', 'B');
    const glyph = await alphaRow.evaluate((node) => {
      const before = window.getComputedStyle(node, '::before');
      return { content: before.content, size: before.fontSize };
    });
    expect(glyph.content).toContain('A');
    expect(Number.parseFloat(glyph.size)).toBeGreaterThan(0);

    // The title is hidden but the accessible name survives the collapse. Scoped with
    // `>` because the project node also contains its session rows' titles.
    await expect(alphaRow.locator('> .hub-row__title')).toBeHidden();
    await expect(alphaRow).toHaveAttribute('aria-label', alpha.name);

    // The state indicator is a real attribute the stylesheet keys off, present on
    // every collapsed project row (idle included, so the selector can never miss).
    for (const row of [alphaRow, betaRow]) {
      const state = await row.getAttribute('data-state');
      expect(['idle', 'running', 'awaiting', 'failed']).toContain(state);
      await expect(row).toHaveAttribute('data-current', /true|false/u);
    }

    // Keyboard reachability: the tree still takes focus and the arrow keys still move
    // between project rows even though no session rows are rendered.
    //
    // The rail sorts by recency and one daemon serves the whole file, so neither the
    // traversal order nor the row count can be assumed - other tests' projects are in
    // this list too. Read the real order and pick THIS test's two rows out of it, then
    // assert they are adjacent, because ArrowDown across a gap would prove nothing and
    // ArrowDown on the last row legitimately clamps.
    const order = await page
      .locator('.hub-row--project[data-project-id]')
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.projectId ?? ''));
    const alphaAt = order.indexOf(alpha.id);
    const betaAt = order.indexOf(beta.id);
    expect(alphaAt, 'seeded project must be in the collapsed rail').toBeGreaterThanOrEqual(0);
    expect(betaAt, 'seeded project must be in the collapsed rail').toBeGreaterThanOrEqual(0);
    expect(Math.abs(alphaAt - betaAt), 'seeded rows must be adjacent').toBe(1);
    const firstRow = alphaAt < betaAt ? alphaRow : betaRow;
    const secondRow = alphaAt < betaAt ? betaRow : alphaRow;

    await firstRow.focus();
    await expect(firstRow).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(secondRow).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(firstRow).toBeFocused();
    // Home lands on the first row of the whole tree, which must still be a real,
    // visible project row rather than a hidden session left in the model.
    await page.keyboard.press('Home');
    const homeRow = page.locator(`[data-project-id="${order[0]}"]`);
    await expect(homeRow).toBeFocused();
    await expect(homeRow).toBeVisible();

    // Search stays in the tab order rather than being display:none'd away.
    await page.getByTestId('hub-search').focus();
    await expect(page.getByTestId('hub-search')).toBeFocused();

    // Sessions are not rendered inline, so no invisible row can hold focus.
    await expect(page.getByTestId(`hub-session-${alpha.sessions[0]!.id}`)).toBeHidden();
  });

  test('hovering and activating a collapsed project opens the flyout', async ({
    page,
    request,
  }) => {
    const alpha = await seedProject(request, 'flyout', 'Alpha Quarterly', [
      'Chart cleanup',
      'Legend fix',
    ]);
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoHub(page);
    await expect(page.getByTestId(`hub-session-${alpha.sessions[0]!.id}`)).toBeVisible();
    await page.getByTestId('hub-rail-toggle').click();
    await expect.poll(() => railWidth(page)).toBeLessThanOrEqual(COLLAPSED_RAIL_PX + 2);

    const alphaRow = page.locator(`[data-project-id="${alpha.id}"]`);
    const flyout = page.getByTestId('hub-project-flyout');

    // Hover opens it, and it lists the project's sessions plus the new-session action.
    await alphaRow.hover();
    await expect(flyout).toBeVisible();
    await expect(flyout).toContainText('Chart cleanup');
    await expect(flyout).toContainText('Legend fix');
    await expect(page.getByTestId('hub-project-flyout-new-session')).toBeVisible();
    await expect(alphaRow).toHaveAttribute('aria-haspopup', 'menu');
    await expect(alphaRow).toHaveAttribute('aria-expanded', 'true');
    await page.screenshot({ path: `${EVIDENCE_DIR}/collapsed-flyout.png`, fullPage: false });

    await page.keyboard.press('Escape');
    await expect(flyout).toHaveCount(0);

    // Keyboard activation reaches the same flyout without a pointer, so the collapsed
    // rail's sessions are navigable with no mouse at all.
    await page.mouse.move(600, 400);
    await alphaRow.focus();
    await page.keyboard.press('Enter');
    await expect(flyout).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(flyout).toHaveCount(0);
    await expect(alphaRow).toBeFocused();

    // Expanding the rail dismisses any flyout instead of leaving one anchored to a
    // row that has changed shape underneath it. The pointer is still parked on the row
    // from the previous hover, so move it away first - re-hovering an element the mouse
    // already sits on fires no `mouseenter` and would wait on an event that never comes.
    await page.mouse.move(600, 400);
    await alphaRow.hover();
    await expect(flyout).toBeVisible();
    await page.getByTestId('hub-rail-toggle').click();
    await expect(flyout).toHaveCount(0);
    await expect.poll(() => railWidth(page)).toBeGreaterThan(EXPANDED_RAIL_PX - 40);
  });

  test('below 900px the rail auto-collapses to the icon rail without stacking', async ({
    page,
    request,
  }) => {
    const alpha = await seedProject(request, 'narrow', 'Alpha Quarterly', ['Chart cleanup']);
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoHub(page);
    await expect(page.getByTestId(`hub-session-${alpha.sessions[0]!.id}`)).toBeVisible();
    expect(await railWidth(page)).toBeGreaterThan(EXPANDED_RAIL_PX - 40);

    await page.setViewportSize({ width: NARROW_BREAKPOINT_PX - 40, height: 900 });
    await expect.poll(() => railWidth(page)).toBeLessThanOrEqual(COLLAPSED_RAIL_PX + 2);
    expect(await railWidth(page)).toBeGreaterThan(COLLAPSED_RAIL_PX - 20);
    expect(await isCollapsed(page)).toBe(true);

    // The mockup keeps the two-column split: the rail sits BESIDE the canvas, never
    // stacked above it. Proved by geometry, not by a media-query reading.
    const geometry = await page.evaluate(() => {
      const nav = document.querySelector('.hub__nav')!.getBoundingClientRect();
      const start = document.querySelector('.hub__start')!.getBoundingClientRect();
      return { navRight: nav.right, startLeft: start.left, navTop: nav.top, startTop: start.top };
    });
    expect(geometry.startLeft).toBeGreaterThanOrEqual(geometry.navRight - 2);
    expect(Math.abs(geometry.startTop - geometry.navTop)).toBeLessThan(80);

    // The toggle cannot fight the viewport: below the breakpoint it is inert.
    await expect(page.getByTestId('hub-rail-toggle')).toBeDisabled();
    await page.screenshot({ path: `${EVIDENCE_DIR}/narrow-860.png`, fullPage: false });

    // Widening restores the user's stored preference (expanded) rather than latching.
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect.poll(() => railWidth(page)).toBeGreaterThan(EXPANDED_RAIL_PX - 40);
    expect(
      await page.evaluate(() => window.localStorage.getItem('readable-studio:hub-rail-collapsed')),
    ).not.toBe('true');
  });

  test('the filter row never overflows the rail at 1280, 1440, 1600 or 1920', async ({
    page,
    request,
  }) => {
    const alpha = await seedProject(request, 'filters', 'Alpha Quarterly', [
      'Chart cleanup',
      'Legend fix',
    ]);
    await seedProject(request, 'filters', 'Beta Pricing', ['Pricing comparison']);
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoHub(page);
    await expect(page.getByTestId(`hub-session-${alpha.sessions[0]!.id}`)).toBeVisible();

    for (const width of FILTER_WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByTestId('hub-filter-all')).toBeVisible();
      const overflow = await filterOverflow(page);
      expect(overflow, `filter row overflow at ${width}px`).toBe(0);
      // The single sort control from todo 11 must survive alongside the filters.
      await expect(page.getByTestId('hub-sort')).toHaveCount(1);
      await expect(page.getByTestId('hub-filter-attention')).toBeVisible();
      await expect(page.getByTestId('hub-filter-running')).toBeVisible();
    }
  });
});
