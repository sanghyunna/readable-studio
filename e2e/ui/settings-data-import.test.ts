import { expect, test } from '@playwright/test';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { addStorageInitScript } from '@/playwright/storage-init';
import { gotoEntryHome } from '@/playwright/amr';
import { T } from '@/timeouts';
import type { Page } from '@playwright/test';

// Source runtimes cannot offer packaged data. These UI fixtures exercise the
// HTTP boundary; daemon/package tests cover real discovery, guards and copying.
const candidate = {
  sourceRoot: 'D:\\Readable-Studio-1.3.4',
  sourceData: 'D:\\Readable-Studio-1.3.4\\ReadableStudioData\\namespaces\\rg\\data',
  projectCount: 2,
  modifiedAt: '2026-10-01T00:00:00Z',
};

test.beforeEach(async ({ page }) => {
  await applyStandardMocks(page);
  await addStorageInitScript(page, () => {
    window.localStorage.setItem('readable-studio:locale', 'ko');
    window.localStorage.setItem('readable-studio:locale-source', 'manual');
  }, undefined);
  await page.route('**/api/data-import/candidates', route => route.fulfill({ json: { state: 'unavailable', candidates: [] } }));
});

async function importEntry(page: Page) {
  await gotoEntryHome(page);
  const trigger = page.getByTestId('entry-settings-menu-trigger').or(page.getByTestId('hub-footer-settings')).first();
  await trigger.click();
  const settings = page.locator('.modal-settings');
  if (await page.getByTestId('entry-settings-menu').isVisible()) {
    await page.getByTestId('entry-settings-open-details').click();
  }
  await expect(settings).toBeVisible({ timeout: T.medium });
  await settings.getByRole('button', { name: /^프로젝트 위치/ }).click();
  const button = settings.getByRole('button', { name: '이전 버전 데이터 가져오기', exact: true });
  await expect(button).toBeVisible({ timeout: T.medium });
  return { settings, button };
}

test('[P1] settings reopens an earlier import offer and cancel restores keyboard focus without a decision', async ({ page }, testInfo) => {
  const writes: unknown[] = [];
  const manualQueries: string[] = [];
  await page.route('**/api/data-import/candidates?manual=1', route => {
    manualQueries.push(route.request().url());
    return route.fulfill({ json: { state: 'offered', candidates: [candidate] } });
  });
  await page.route('**/api/data-import/request', route => {
    writes.push(route.request().postDataJSON());
    return route.fulfill({ json: { state: 'declined', restartRequired: false } });
  });
  const { settings, button } = await importEntry(page);
  await page.screenshot({ path: testInfo.outputPath('settings-import-entry.png') });
  await button.click();
  const modal = page.getByTestId('data-import-modal');
  await expect(modal.getByText(candidate.sourceRoot, { exact: true })).toBeVisible();
  const firstDiscoveryCount = manualQueries.length;
  const settingsBackdrop = page.locator('.modal-backdrop').filter({ has: settings });
  await expect(settingsBackdrop).toHaveAttribute('inert', '');
  await expect(settingsBackdrop).toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('settings-import-dialog.png') });
  await modal.press('Shift+Tab');
  await expect(modal.getByRole('button', { name: '가져오기', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(modal.getByRole('button', { name: new RegExp(candidate.projectCount + '개') })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(settings).toBeVisible();
  expect(writes).toEqual([]);
  const nextDiscovery = page.waitForRequest(request => request.method() === 'GET' && request.url().endsWith('/api/data-import/candidates?manual=1'), { timeout: T.medium });
  await button.click();
  await nextDiscovery;
  await expect(modal.getByText(candidate.sourceRoot, { exact: true })).toBeVisible();
  expect(manualQueries.length).toBeGreaterThan(firstDiscoveryCount);
  expect(manualQueries.every(url => new URL(url).searchParams.get('manual') === '1')).toBe(true);
  await modal.getByRole('button', { name: '닫기', exact: true }).click();
  expect(writes).toEqual([]);
});

test('[P1] manual import queues a restart only after confirmation and supports cancelling the pending request', async ({ page }) => {
  const writes: unknown[] = [];
  await page.route('**/api/data-import/candidates?manual=1', route => route.fulfill({ json: { state: 'offered', candidates: [candidate] } }));
  await page.route('**/api/data-import/request', route => {
    const body = route.request().postDataJSON();
    writes.push(body);
    return route.fulfill({ json: body.action === 'decline' ? { state: 'declined', restartRequired: false } : { state: 'pending', restartRequired: true } });
  });
  const { button } = await importEntry(page);
  await button.click();
  const modal = page.getByTestId('data-import-modal');
  await modal.getByRole('button', { name: '가져오기', exact: true }).click();
  await expect(modal.getByRole('button', { name: '다시 시작하기', exact: true })).toBeVisible();
  expect(writes).toEqual([{ action: 'import', from: candidate.sourceData }]);
  await modal.getByRole('button', { name: '가져오지 않기', exact: true }).click();
  await expect(modal).toHaveCount(0);
  expect(writes).toEqual([{ action: 'import', from: candidate.sourceData }, { action: 'decline' }]);
});

test('[P1] manual discovery explains completed, populated, unsupported and empty states', async ({ page }) => {
  const states = [
    { state: 'done', candidates: [], message: '이미 이전 버전의 작업 내역을 가져왔습니다' },
    { state: 'unavailable', candidates: [], unavailableReason: 'projects-present', message: '현재 폴더에 프로젝트가 있어 가져올 수 없습니다' },
    { state: 'unavailable', candidates: [], unavailableReason: 'unsupported-runtime', message: '포터블 앱에서 사용할 수 있습니다' },
    { state: 'unavailable', candidates: [], message: '이전 버전의 작업 폴더를 찾지 못했습니다' },
  ];
  let current = 0;
  await page.route('**/api/data-import/candidates?manual=1', route => route.fulfill({ json: states[current] }));
  const { button } = await importEntry(page);
  for (const [index, state] of states.entries()) {
    current = index;
    await button.click();
    const modal = page.getByTestId('data-import-modal');
    await expect(modal.getByRole('status')).toContainText(state.message);
    await expect(modal.getByRole('button', { name: '가져오기', exact: true })).toHaveCount(0);
    await modal.getByRole('button', { name: '닫기', exact: true }).click();
  }
});

test('[P1] manual discovery exposes loading and a recoverable connection error without trapping settings', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  let errorReleased = false;
  await page.route('**/api/data-import/candidates?manual=1', async route => {
    if (!errorReleased) {
      await held;
      await route.fulfill({ status: 503, body: 'Unavailable' });
    } else await route.fulfill({ json: { state: 'offered', candidates: [candidate] } });
  });
  const { button } = await importEntry(page);
  await button.click();
  const modal = page.getByTestId('data-import-modal');
  await expect(modal.getByRole('status')).toContainText('이전 작업 내역을 확인하고 있습니다');
  await expect(modal.getByRole('button', { name: '닫기', exact: true })).toBeEnabled();
  release();
  await expect(modal.getByRole('alert')).toContainText('이전 버전의 작업 내역을 확인하지 못했습니다');
  errorReleased = true;
  await modal.getByRole('button', { name: '다시 확인', exact: true }).click();
  await expect(modal.getByText(candidate.sourceRoot, { exact: true })).toBeVisible();
  await modal.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(button).toBeFocused();
});

test('[P1] a delayed startup offer cannot replace or duplicate the settings import dialog', async ({ page }) => {
  let releaseStartup!: () => void;
  const startupHeld = new Promise<void>(done => { releaseStartup = done; });
  let startupDelivered = false;
  await page.unroute('**/api/data-import/candidates');
  await page.route('**/api/data-import/candidates', async route => {
    await startupHeld;
    await route.fulfill({ json: { state: 'offered', candidates: [{ ...candidate, sourceRoot: 'D:\\Delayed-Startup' }] } });
    startupDelivered = true;
  });
  await page.route('**/api/data-import/candidates?manual=1', route => route.fulfill({ json: { state: 'offered', candidates: [candidate] } }));
  const { button } = await importEntry(page);
  await button.click();
  const modal = page.getByTestId('data-import-modal');
  await expect(modal.getByText(candidate.sourceRoot, { exact: true })).toBeVisible();
  releaseStartup();
  await expect.poll(() => startupDelivered, { timeout: T.medium }).toBe(true);
  await expect(modal).toHaveCount(1);
  await expect(modal.getByText(candidate.sourceRoot, { exact: true })).toBeVisible();
  await expect(page.getByText('D:\\Delayed-Startup', { exact: true })).toHaveCount(0);
  await modal.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expect(button).toBeFocused();
  await button.click();
  await expect(modal).toHaveCount(1);
  await modal.getByRole('button', { name: '닫기', exact: true }).click();
});
