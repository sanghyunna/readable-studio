import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ContextUsageSnapshot } from '@readable-studio/contracts';
import { addStorageInitScript } from '@/playwright/storage-init';
import { routeAgents } from '@/playwright/mock-factory';
import { T } from '@/timeouts';

const selection = { mode: 'daemon', agentId: 'codex', agentModels: { codex: { model: 'fixture-model' } } };
const measured: ContextUsageSnapshot = {
  state: 'measured', usedTokens: 284_000, limitTokens: 500_000,
  source: 'codex', limitSource: 'runtime', model: 'fixture-model', sessionId: 'fixture-session', updatedAt: 1,
};
test.use({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });

async function seedMessage(request: APIRequestContext, projectId: string, conversationId: string, id: string, snapshot: ContextUsageSnapshot) {
  const response = await request.put(`/api/projects/${projectId}/conversations/${conversationId}/messages/${id}`, { data: {
    id, role: 'assistant', agentId: 'codex', content: 'The document is ready for review.',
    runId: `fixture-context-${id}`, runStatus: 'succeeded', createdAt: Date.now(), endedAt: Date.now(),
    events: [{ kind: 'context_usage', snapshot }],
  } });
  expect(response.ok(), await response.text()).toBe(true);
}

async function geometry(page: Page) {
  return page.getByTestId('context-usage-meter').evaluate(meter => {
    const row = meter.closest('.composer-row')!;
    const rect = (element: Element) => {
      const value = element.getBoundingClientRect();
      return { x: value.x, right: value.right, y: value.y, height: value.height, width: value.width };
    };
    const fill = meter.querySelector('[data-testid="context-usage-fill"]')!;
    return {
      plus: rect(row.querySelector('[data-testid="chat-plus-trigger"]')!), meter: rect(meter),
      track: rect(fill.parentElement!), percent: rect(meter.lastElementChild!),
      agent: rect(row.querySelector('[data-testid="inline-model-switcher-agent-trigger"]')!),
      send: rect(row.querySelector('[data-testid="chat-send"]')!), row: rect(row),
      fontSize: getComputedStyle(meter.lastElementChild!).fontSize,
      animation: getComputedStyle(fill).animationName,
      zoom: Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1,
    };
  });
}

async function assertGeometry(page: Page) {
  const value = await geometry(page);
  expect(value.track.height).toBe(2 * value.zoom);
  expect(value.track.width).toBeLessThanOrEqual(96.1 * value.zoom);
  expect(value.percent.x - value.track.right).toBeCloseTo(8 * value.zoom, 0);
  expect(value.fontSize).toBe('12px');
  expect(value.meter.x).toBeGreaterThanOrEqual(value.plus.right);
  expect(value.meter.right).toBeLessThanOrEqual(value.agent.x);
  expect(value.send.right).toBeLessThanOrEqual(value.row.right + 1);
  expect(value.animation).toBe('none');
  await expect(page.getByTestId('context-usage-meter')).toBeInViewport({ ratio: 1 });
}

test('[P1] context usage restores real persisted snapshots, keeps the A footer geometry, and clears on model and conversation changes', async ({ page, request }, testInfo) => {
  test.setTimeout(T.xlong * 3);
  const config = {
    ...selection, onboardingCompleted: true, privacyDecisionAt: 1,
    telemetry: { metrics: false, content: false, artifactManifest: false },
  };
  await addStorageInitScript(page, value => {
    localStorage.setItem('readable-studio:config', JSON.stringify(value));
    localStorage.setItem('readable-studio:locale', 'en');
    localStorage.setItem('readable-studio:locale-source', 'manual');
    localStorage.setItem('readable-studio:welcome-modal-shown', '1');
  }, config);
  await routeAgents(page, [{ id: 'codex', name: 'Codex', bin: 'fixture-agent', available: true, version: 'fixture', models: [
    { id: 'fixture-model', label: 'Fixture model' }, { id: 'fixture-other', label: 'Other fixture model' },
  ] }]);
  await page.route('**/api/app-config', async route => {
    if (route.request().method() === 'GET') await route.fulfill({ json: { config } });
    else await route.continue();
  });
  const id = randomUUID();
  const created = await request.post('/api/projects', { data: { id, name: 'Context usage fixture', skillId: null, designSystemId: null, metadata: { kind: 'prototype' } } });
  expect(created.ok(), await created.text()).toBe(true);
  const { conversationId } = await created.json() as { conversationId: string };
  try {
    const selected = await request.patch(`/api/projects/${id}/conversations/${conversationId}`, { data: { selection } });
    expect(selected.ok(), await selected.text()).toBe(true);
    const empty = await request.post(`/api/projects/${id}/conversations`, { data: { title: 'Empty context fixture', selection } });
    expect(empty.ok(), await empty.text()).toBe(true);
    const { conversation: emptyConversation } = await empty.json() as { conversation: { id: string } };
    await seedMessage(request, id, conversationId, 'context-message', { ...measured, updatedAt: Date.now() });
    await page.goto(`/projects/${id}/conversations/${conversationId}`);
    const meter = page.getByTestId('context-usage-meter');
    await expect(meter).toHaveText('56.8%', { timeout: T.long });
    await expect(meter).toHaveAttribute('aria-valuenow', '284000');
    await assertGeometry(page);
    await page.screenshot({ path: testInfo.outputPath('context-meter-product.png') });
    await page.getByTestId('chat-composer').screenshot({ path: testInfo.outputPath('context-meter-A.png') });
    await meter.hover();
    await expect(page.getByRole('tooltip')).toHaveText('284k/500k');
    await page.screenshot({ path: testInfo.outputPath('context-meter-product-hover.png') });
    await page.getByTestId('chat-composer').screenshot({ path: testInfo.outputPath('context-meter-A-hover.png') });
    await page.mouse.move(0, 0);
    await page.keyboard.press('Tab');
    await meter.focus();
    await expect(page.getByRole('tooltip')).toHaveText('284k/500k');

    await page.getByTestId('inline-model-switcher-model-trigger').click();
    await page.getByTestId('inline-model-switcher-model-option-fixture-other').click();
    await expect(meter).toHaveText('—');
    await page.getByTestId('inline-model-switcher-model-trigger').click();
    await page.getByTestId('inline-model-switcher-model-option-fixture-model').click();
    await expect(meter).toHaveText('56.8%');
    await page.getByTestId('conversation-history-trigger').click();
    await page.getByTestId(`conversation-select-${emptyConversation.id}`).click();
    await expect(meter).toHaveText('—');
    await page.getByTestId('conversation-history-trigger').click();
    await page.getByTestId(`conversation-select-${conversationId}`).click();
    await expect(meter).toHaveText('56.8%');
    await page.reload();
    await expect(meter).toHaveText('56.8%');

    for (const theme of ['light', 'dark', 'nord']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      await assertGeometry(page);
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 375, height: 900 });
    await assertGeometry(page);
    await page.screenshot({ path: testInfo.outputPath('context-meter-narrow.png') });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
    await assertGeometry(page);
    await page.screenshot({ path: testInfo.outputPath('context-meter-zoom.png') });
    await page.evaluate(() => { document.documentElement.style.zoom = ''; });

    for (const snapshot of [
      { ...measured, usedTokens: 200_000 },
      { ...measured, usedTokens: 0 },
      { ...measured, usedTokens: 600_000 },
      { ...measured, state: 'estimated' as const, source: 'pi' as const, usedTokens: 284_000 },
      { ...measured, state: 'unknown' as const, usedTokens: null, reason: 'compacting' as const },
    ]) {
      await seedMessage(request, id, conversationId, 'context-message', { ...snapshot, updatedAt: Date.now() });
      await page.reload();
      await expect(meter).toHaveText(snapshot.state === 'unknown' ? '—' : `${snapshot.usedTokens! / 500_000 * 100}%`);
      if (snapshot.state === 'estimated') {
        await meter.hover();
        await expect(page.getByRole('tooltip')).toHaveText('Estimated · 284k/500k');
      }
    }
    await meter.hover();
    // The seeded compaction marker belongs to a finished run, so nothing can replace it.
    await expect(page.getByRole('tooltip')).toContainText('not been reported');
    for (const status of ['canceled', 'failed']) {
      const messageId = `context-${status}`;
      const saved = await request.put(`/api/projects/${id}/conversations/${conversationId}/messages/${messageId}`, { data: {
        id: messageId, role: 'assistant', agentId: 'codex', content: '', runId: `fixture-${status}`,
        runStatus: status, createdAt: Date.now(), endedAt: Date.now(), events: [],
      } });
      expect(saved.ok(), await saved.text()).toBe(true);
      await page.reload();
      await expect(meter).toHaveText('—');
      await seedMessage(request, id, conversationId, 'context-message', { ...measured, usedTokens: 450_000, updatedAt: Date.now() });
      await page.reload();
      await expect(meter).toHaveText('—');
    }
  } finally {
    const deleted = await request.delete(`/api/projects/${id}`);
    expect(deleted.ok(), await deleted.text()).toBe(true);
  }
});
