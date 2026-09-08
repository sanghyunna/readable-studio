import { expect, type Page } from '@playwright/test';
import { T } from '../timeouts.ts';
import { observeResourceLoads } from './resource-load.ts';

/** Readiness is a working guide, not a bundler filename or a source-code literal. */
export async function expectInlineUseEverywhereGuide(
  page: Page,
  reachIntegrations: () => Promise<unknown>,
): Promise<void> {
  const resources = observeResourceLoads(page);
  const retiredModal = page.locator(
    '[role="dialog"], .use-everywhere-modal__backdrop, .use-everywhere-modal',
  );
  const integrations = page.locator('.integrations-view');
  try {
    await reachIntegrations();
    await expect(page).toHaveURL(/\/integrations$/);
    await Promise.all([
      integrations.getByTestId('use-everywhere-section-overview').waitFor({ state: 'visible', timeout: T.medium }),
      integrations.getByTestId('integrations-tab-use-everywhere').click(),
    ]);
    await expect(integrations.getByTestId('integrations-tab-use-everywhere')).toHaveAttribute('aria-selected', 'true');
    for (const id of ['overview', 'cli', 'mcp', 'http', 'skills']) {
      const tab = integrations.getByTestId(`use-everywhere-tab-${id}`);
      const section = integrations.getByTestId(`use-everywhere-section-${id}`);
      await Promise.all([
        section.waitFor({ state: 'visible', timeout: T.medium }),
        tab.click(),
      ]);
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      await expect(integrations.locator('[data-testid^="use-everywhere-section-"]')).toHaveCount(1);
      await expect(section.locator('pre code').first()).toBeVisible();
      await expect(retiredModal).toHaveCount(0);
    }
    await expect(integrations.getByTestId('use-everywhere-copy-guide')).toBeEnabled();
    await integrations.getByTestId('use-everywhere-open-settings').click();
    await expect(integrations.getByTestId('integrations-tab-mcp')).toHaveAttribute('aria-selected', 'true');
    await expect(integrations.getByTestId('use-everywhere-tab-overview')).toHaveCount(0);
    await expect(retiredModal).toHaveCount(0);
    // Reopening must still mount inline, not resurrect the removed modal wrapper.
    await Promise.all([
      integrations.getByTestId('use-everywhere-section-overview').waitFor({ state: 'visible', timeout: T.medium }),
      integrations.getByTestId('integrations-tab-use-everywhere').click(),
    ]);
    await expect(retiredModal).toHaveCount(0);
    expect(resources.failures, 'scripts/styles and module execution must succeed').toEqual([]);
  } finally {
    resources.dispose();
  }
}
