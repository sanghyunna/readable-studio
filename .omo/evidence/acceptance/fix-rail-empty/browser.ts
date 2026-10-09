import { chromium, expect } from 'playwright/test';
import { writeFileSync } from 'node:fs';
const E = 'D:/readable-studio/.omo/evidence/acceptance/fix-rail-empty';
const results: unknown[] = [];
const browser = await chromium.launch({ headless: true });
try {
  for (const theme of ['light', 'dark']) for (const width of [262, 420, 44]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    await context.addInitScript(({ theme, width }) => {
      localStorage.setItem('readable-studio:config', JSON.stringify({ mode: 'daemon', onboardingCompleted: true, privacyDecisionAt: 1, telemetry: { metrics: false, content: false, artifactManifest: false }, theme, locale: 'ko' }));
      localStorage.setItem('readable-studio:welcome-modal-shown', '1');
      localStorage.setItem('readable-studio:home-first-run-guide', 'done');
      localStorage.setItem('readable-studio:hub-rail-width', String(width === 44 ? 262 : width));
      localStorage.setItem('readable-studio:hub-rail-collapsed', String(width === 44));
    }, { theme, width });
    const page = await context.newPage();
    const railRead = page.waitForResponse(r => r.url().endsWith('/api/rail') && r.request().method() === 'GET');
    await page.goto('http://127.0.0.1:18351', { timeout: 90000 });
    expect((await railRead).ok()).toBe(true);
    await expect(page.getByTestId('hub-sessions-loading')).toHaveCount(0);
    await expect(page.locator('.hub__nav-loading')).toHaveCount(0);
    await expect(page.getByTestId('hub-empty')).toBeVisible();
    await page.getByTestId('home-hero-input').waitFor({ timeout: 60000 });
    const nav = page.getByTestId('hub-nav');
    if (width === 44) {
      await expect(nav).toHaveAttribute('data-project-rail-state', 'collapsed');
      await expect(nav.locator('.hub-tree__empty')).toHaveCount(0);
    } else {
      await expect(page.getByTestId('hub-no-recents')).toBeVisible({ timeout: 60000 });
      await expect(nav.locator('.hub-tree__empty, .hub-tree__note')).toHaveCount(1);
      await expect(page.getByTestId('hub-section-recents').getByTestId('hub-no-recents')).toBeVisible();
    }
    results.push({ theme, width, geometry: await nav.evaluate(n => {
      const hint = n.querySelector('[data-testid="hub-no-recents"]');
      const label = n.querySelector('[data-testid="hub-section-recents-label"]');
      const range = document.createRange();
      if (hint) range.selectNodeContents(hint);
      return { rail: n.getBoundingClientRect().toJSON(), hintText: hint ? range.getBoundingClientRect().toJSON() : null, header: label?.getBoundingClientRect().toJSON(), emptyCount: n.querySelectorAll('.hub-tree__empty, .hub-tree__note').length };
    }) });
    await page.screenshot({ path: `${E}/${theme}-${width}-empty.png` });
    if (width === 44) {
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(nav).toHaveAttribute('data-project-rail-state', 'collapsed');
      await page.screenshot({ path: `${E}/${theme}-mobile-empty.png` });
    }
    await context.close();
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    localStorage.setItem('readable-studio:config', JSON.stringify({ mode: 'daemon', onboardingCompleted: true, privacyDecisionAt: 1, theme: 'light', locale: 'ko' }));
    localStorage.setItem('readable-studio:welcome-modal-shown', '1');
    localStorage.setItem('readable-studio:home-first-run-guide', 'done');
  });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:18351');
  await expect(page.getByTestId('hub-no-recents')).toBeVisible({ timeout: 60000 });
  const created = await context.request.post('http://127.0.0.1:18350/api/sessions', { data: { title: 'Empty-state acceptance session' } });
  expect(created.ok()).toBe(true);
  const body = await created.json();
  await expect(page.getByTestId(`hub-session-${body.session.id}`)).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('hub-no-recents')).toHaveCount(0);
  const rowInset = await page.getByTestId(`hub-session-${body.session.id}`).locator('.hub-row__title').evaluate(n => n.getBoundingClientRect().x);
  results.push({ createdStatus: created.status(), sessionId: body.session.id, rowTextX: rowInset, emptyCount: await page.getByTestId('hub-nav').locator('.hub-tree__empty').count() });
  await page.screenshot({ path: `${E}/light-session-created.png` });
  await context.close();
} finally {
  await browser.close();
  writeFileSync(`${E}/browser-results.json`, JSON.stringify(results, null, 2));
}
