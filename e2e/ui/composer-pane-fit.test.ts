// The chat pane is a fixed box - half of the split when it is stacked under a
// narrow CSS viewport (browser zoom 125% on a small window) - while the
// composer editor's max-height is viewport-relative. A growing composer must
// make the transcript shrink and then yield itself; it must never overflow
// the pane (whose clip would cut off its toolbar row) or the workspace shell.
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { addStorageInitScript } from '@/playwright/storage-init';
import { routeAgents } from '@/playwright/mock-factory';

function measure(page: Page) {
  return page.evaluate(() => {
    const q = (selector: string) => document.querySelector(selector)!;
    const rect = (el: Element) => { const r = el.getBoundingClientRect(); return { y: Math.round(r.y), bottom: Math.round(r.bottom), height: Math.round(r.height) }; };
    const shell = q('.workspace-shell');
    const pane = q('.split-chat-slot > .pane');
    const composer = q('.composer');
    const header = q('.chat-project-header');
    const send = q('[data-testid="chat-send"]');
    return {
      root: { scrollHeight: document.scrollingElement!.scrollHeight, clientHeight: document.scrollingElement!.clientHeight },
      shell: { scrollHeight: shell.scrollHeight, clientHeight: shell.clientHeight, scrollTop: shell.scrollTop },
      pane: { scrollHeight: pane.scrollHeight, clientHeight: pane.clientHeight, scrollTop: pane.scrollTop, ...rect(pane) },
      topbar: rect(q('[data-testid="app-window-chrome"]')),
      header: rect(header),
      composer: rect(composer),
      send: rect(send),
      stacked: q('.split').classList.contains('split-stacked'),
    };
  });
}

test('[P0] growing composer never overflows the chat pane or shell in a stacked split at 125% zoom', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1024, height: 560 }, deviceScaleFactor: 1.25, locale: 'ko-KR' });
  const page = await context.newPage();
  await addStorageInitScript(page, (config) => {
    window.localStorage.setItem('readable-studio:config', JSON.stringify(config));
    window.localStorage.setItem('readable-studio:locale', 'ko');
    window.localStorage.setItem('readable-studio:locale-source', 'manual');
  }, { mode: 'daemon', agentId: 'mock', onboardingCompleted: true, privacyDecisionAt: 1, theme: 'dark', telemetry: { metrics: false, content: false, artifactManifest: false } });
  await routeAgents(page, [{ id: 'mock', name: 'Mock Agent', bin: 'mock-agent', available: true, version: 'test', models: [{ id: 'default', label: 'Default' }] }]);
  const id = randomUUID();
  const created = await page.request.post('/api/projects', { data: { id, name: 'Composer pane fit', skillId: null, designSystemId: null, conversationMode: 'design', metadata: { kind: 'prototype' } } });
  expect(created.ok(), await created.text()).toBe(true);
  const { conversationId } = (await created.json()) as { conversationId: string };
  const messagePath = `/api/projects/${id}/conversations/${conversationId}/messages`;
  for (let i = 0; i < 6; i++) {
    const messageId = randomUUID();
    const saved = await page.request.put(`${messagePath}/${messageId}`, { data: { id: messageId, role: i % 2 === 0 ? 'user' : 'assistant', content: `Message ${i}\n\n${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(6)}`, createdAt: Date.now() - (10 - i) * 1000 } });
    expect(saved.ok(), await saved.text()).toBe(true);
  }
  await page.goto(`/projects/${id}/conversations/${conversationId}`);
  const composer = page.getByTestId('chat-composer-input');
  await expect(composer).toBeVisible();
  const before = await measure(page);
  expect(before.stacked, 'this viewport must exercise the stacked split').toBe(true);
  await composer.click();
  for (let line = 1; line <= 14; line++) {
    await composer.press('Shift+Enter');
    await composer.pressSequentially(`Line ${line}`);
    const grown = await measure(page);
    console.log(JSON.stringify({ line, ...grown }));
    expect(grown.topbar, `topbar moved after ${line} lines`).toEqual(before.topbar);
    expect(grown.root.scrollHeight, `document overflow after ${line} lines`).toBeLessThanOrEqual(grown.root.clientHeight);
    expect(grown.shell.scrollHeight, `shell overflow after ${line} lines`).toBeLessThanOrEqual(grown.shell.clientHeight);
    expect(grown.shell.scrollTop, `shell scrolled after ${line} lines`).toBe(0);
    expect(grown.pane.scrollHeight, `pane overflow after ${line} lines`).toBeLessThanOrEqual(grown.pane.clientHeight);
    expect(grown.pane.scrollTop, `pane scrolled after ${line} lines`).toBe(0);
    expect(grown.header.y, `pane header moved after ${line} lines`).toBe(before.header.y);
    expect(grown.composer.bottom, `composer cut off after ${line} lines`).toBeLessThanOrEqual(grown.pane.bottom);
    expect(grown.send.bottom, `send button cut off after ${line} lines`).toBeLessThanOrEqual(grown.pane.bottom);
    expect(grown.send.y, `send button above the pane after ${line} lines`).toBeGreaterThanOrEqual(grown.header.bottom);
  }
  await expect(page.getByTestId('chat-send')).toBeInViewport({ ratio: 1 });
  await context.close();
});
