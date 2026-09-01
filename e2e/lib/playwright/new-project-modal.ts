import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { ensureRailOpen } from './rail.js';

export async function openNewProjectModal(page: Page, context = 'new-project-modal'): Promise<void> {
  await ensureRailOpen(page);
  const trigger = page.getByTestId('hub-new-project');
  await expect(trigger, `[${context}] control must be visible on the real home surface`).toBeVisible({ timeout: 2_000 });
  await trigger.click();
  await expect(page.getByTestId('new-project-modal'), `[${context}] control must be visible on the real home surface`).toBeVisible({ timeout: 2_000 });
  await expect(page.getByTestId('new-project-panel')).toBeVisible({ timeout: 2_000 });
}
