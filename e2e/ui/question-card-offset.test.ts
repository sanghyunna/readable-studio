import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { T } from '@/timeouts';

async function layout(page: Page) {
  return page.locator('.chat-log').evaluate(log => {
    const ancestors = [];
    for (let node = log.parentElement; node; node = node.parentElement) {
      const rect = node.getBoundingClientRect();
      ancestors.push({ tag: node.tagName, className: node.className, top: rect.top, height: rect.height, scrollTop: node.scrollTop });
    }
    const shell = document.querySelector('.workspace-shell')!.getBoundingClientRect();
    return { ancestors, shellTop: shell.top, shellBottom: shell.bottom, viewport: innerHeight };
  });
}

for (const overflowAncestor of [false, true]) {
test(`[P1] inline question mount and answered follow-up never displace chat ancestors (overflow=${overflowAncestor})`, async ({ page, request }) => {
  // Keep native scrolling, but make completion synchronous so geometry cannot pass mid-animation.
  await page.addInitScript(() => {
    const reveal = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (options) {
      reveal.call(this, typeof options === 'object' ? { ...options, behavior: 'instant' } : options);
    };
    const scroll = Element.prototype.scrollTo;
    Element.prototype.scrollTo = function (options?: ScrollToOptions | number, y?: number) {
      if (typeof options === 'number') Reflect.apply(scroll, this, [options, y ?? 0]);
      else Reflect.apply(scroll, this, [{ ...options, behavior: 'instant' }]);
    };
  });
  await page.setViewportSize({ width: 1920, height: 1152 });
  await applyStandardMocks(page);
  const form = `<question-form id="layout-question" title="Choose a task">${JSON.stringify({ questions: [{
    id: 'taskType', type: 'radio', label: 'Task type', required: true,
    options: [{ value: 'prototype', label: 'Prototype' }, { value: 'slides', label: 'Slide deck' }],
  }] })}</question-form>`;
  let releaseQuestion: () => void = () => undefined;
  const questionReady = new Promise<void>(resolve => { releaseQuestion = resolve; });
  let run = 0;
  await page.route('**/api/runs', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    await route.fulfill({ json: { runId: `question-layout-${++run}` } });
  });
  await page.route('**/api/runs/question-layout-*/events*', async route => {
    await questionReady;
    const content = route.request().url().includes('question-layout-1/')
      ? Array.from({ length: 30 }, (_, i) => `Paragraph ${i}: preparing the document.\n\n`).join('') + form
      : 'Layout follow-up received.';
    await route.fulfill({ contentType: 'text/event-stream', body:
      `event: start\ndata: {}\n\nevent: agent\ndata: ${JSON.stringify({ type: 'text_delta', delta: content })}\n\nevent: end\ndata: {"status":"succeeded","code":0}\n\n` });
  });
  const created = await request.post('/api/projects', { data: {
    id: randomUUID(), name: 'Question layout regression', skillId: null, designSystemId: null, metadata: { kind: 'prototype' },
  } });
  expect(created.ok(), await created.text()).toBe(true);
  const { project, conversationId } = await created.json();
  try {
    await page.goto(`/projects/${project.id}/conversations/${conversationId}`);
    await expect(page.locator('.chat-log')).toBeVisible({ timeout: T.long });
    await page.getByTestId('chat-composer-input').fill('Ask which task to create.');
    await page.getByTestId('chat-send').click();
    // Given a hidden root with scroll range, AFTER the composer click so only
    // question arrival/focus can cause displacement in the measured interval.
    if (overflowAncestor) await page.addStyleTag({ content: 'body { height: calc(100% - 98px); overflow: hidden; }' });
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
    const before = await layout(page);
    expect(before.shellTop).toBe(0);
    // When the waiting response mounts the real question card and takes focus.
    releaseQuestion();
    const card = page.locator('.chat-log .questions-panel');
    await expect(card).toHaveAttribute('data-pending', 'true');
    const mounted = await layout(page);
    expect(mounted).toEqual(before);
    await card.getByRole('radio', { name: 'Prototype', exact: true }).click();
    await card.locator('.questions-continue').click();
    await expect(card).toHaveAttribute('data-answered', 'true');
    await expect(page.getByText('Layout follow-up received.', { exact: true })).toBeVisible();
    expect(await layout(page)).toEqual(before);
    for (const viewport of [{ width: 1280, height: 800 }, { width: 1920, height: 1152 }]) {
      await page.setViewportSize(viewport);
      const current = await layout(page);
      expect(current.shellTop).toBe(0);
      expect(current.shellBottom).toBe(current.viewport);
      for (const ancestor of current.ancestors) expect(ancestor.scrollTop, ancestor.className || ancestor.tag).toBe(0);
    }
    expect(run).toBe(2);
  } finally {
    releaseQuestion();
    await page.close();
    const deleted = await request.delete(`/api/projects/${project.id}`);
    expect(deleted.ok(), await deleted.text()).toBe(true);
  }
});
}
