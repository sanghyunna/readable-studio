import { expect, type Locator } from '@playwright/test';
import type { DesignSystemSummary } from '@readable-studio/contracts';
import { checked, test } from '@/playwright/ui-batch';
import { T } from '@/timeouts';

// Real served app geometry, not a jsdom rectangle simulation. This companion
// is intentionally separate from the Questions form-control acceptance lane.
test.describe.configure({ retries: 0, timeout: T.xlong });

async function hitTarget(tab: Locator) {
  return tab.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const bar = node.closest('.ws-tabs-bar')!.getBoundingClientRect();
    const x = (Math.max(rect.left, bar.left) + Math.min(rect.right, bar.right)) / 2;
    const y = rect.top + rect.height / 2;
    return { width: Math.min(rect.right, bar.right) - Math.max(rect.left, bar.left),
      hit: node.contains(document.elementFromPoint(x, y)),
      position: getComputedStyle(node).position };
  });
}

for (const width of [375, 768, 1280]) {
  test(`[P1] workspace permanent tabs and Questions have visible hit targets at ${width}px`, async ({ page, request, batch }) => {
    await page.setViewportSize({ width, height: 900 });
    await batch.configure();
    // Use a shipped design system, so this exercises all three real permanent
    // tabs without synthesizing a tab or bypassing the project route.
    const catalog = await checked(await request.get('/api/design-systems'));
    const { designSystems } = await catalog.json() as { designSystems: DesignSystemSummary[] };
    expect(designSystems.length).toBeGreaterThan(0);
    const { id, conversationId } = await batch.create({ kind: 'prototype', importedFrom: 'design-system' }, designSystems[0]!.id);
    await batch.seedForm(id, conversationId);
    await page.goto(`/projects/${id}/conversations/${conversationId}`);
    const workspace = page.getByTestId('file-workspace');
    const bar = workspace.getByRole('tablist');
    await expect(page.getByTestId('questions-tab')).toBeAttached();
    for (const testId of ['design-system-project-tab', 'design-files-tab', 'questions-tab']) {
      const tab = page.getByTestId(testId);
      // Native keyboard focus must bring even offscreen permanent tabs back.
      // Then perform a real pointer click, not dispatchEvent or forced click.
      await tab.focus();
      const target = await hitTarget(tab);
      expect(target.width).toBeGreaterThan(24);
      expect(target.hit).toBe(true);
      expect(target.position).toBe('static');
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
    }
    const panel = page.getByTestId('questions-panel');
    await expect(panel).toBeVisible();
    const layout = await workspace.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const split = node.closest('.split')!;
      const chat = split.querySelector('.split-chat-slot')!.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width, top: rect.top,
        chatBottom: chat.bottom, stacked: split.classList.contains('split-stacked'),
        columns: getComputedStyle(split).gridTemplateColumns,
        pageOverflow: document.documentElement.scrollWidth - innerWidth };
    });
    expect(layout.left).toBeGreaterThanOrEqual(0);
    expect(layout.right).toBeLessThanOrEqual(width);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.pageOverflow).toBeLessThanOrEqual(1);
    expect(layout.stacked).toBe(width < 1280);
    if (layout.stacked) {
      expect(layout.top).toBeGreaterThanOrEqual(layout.chatBottom);
      await expect(page.locator('.split-resize-handle')).toHaveCount(0);
    } else {
      const separator = page.getByRole('separator', { name: /resize chat/i });
      await expect(separator).toBeVisible();
      const before = Number(await separator.getAttribute('aria-valuenow'));
      await separator.press('ArrowLeft');
      await expect(separator).toHaveAttribute('aria-valuenow', String(before - 16));
      await separator.press('ArrowRight');
      await expect(separator).toHaveAttribute('aria-valuenow', String(before));
    }
    await test.info().attach(`workspace-${width}-layout`, { contentType: 'application/json', body: JSON.stringify(layout) });

    if (width === 375) {
      // Restore the failure mechanism: fixed chat consumes more than the
      // viewport, while a zero-minimum workspace is still placed in column 3.
      const control = await page.addStyleTag({ content: '.app .split { grid-template-columns: 395px 8px minmax(0,1fr) !important; grid-template-rows: minmax(0,1fr) !important; } .split > .workspace { grid-column:3; grid-row:1; }' });
      const broken = await workspace.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return { width: rect.width, left: rect.left };
      });
      expect(broken.width).toBe(0);
      expect(broken.left).toBeGreaterThan(width);
      await control.evaluate((node) => node.parentNode!.removeChild(node));
    }
    if (width === 768) {
      // Restore a 130px sticky anchor in a 100px scrollport. The sibling is
      // scrolled to the viewport, but elementFromPoint must report the anchor.
      const control = await page.addStyleTag({ content: '.workspace .ws-tabs-bar { flex:0 0 100px !important; width:100px !important; } .workspace .ws-tab.design-files-tab { position:sticky !important; left:0 !important; z-index:10 !important; min-width:130px !important; }' });
      await bar.evaluate((node) => {
        const tab = node.querySelector('.questions-tab')!;
        node.scrollLeft += tab.getBoundingClientRect().right - node.getBoundingClientRect().right;
      });
      const broken = await hitTarget(page.getByTestId('questions-tab'));
      expect(broken.width).toBeGreaterThan(0);
      expect(broken.hit).toBe(false);
      await control.evaluate((node) => node.parentNode!.removeChild(node));
    }
  });
}
