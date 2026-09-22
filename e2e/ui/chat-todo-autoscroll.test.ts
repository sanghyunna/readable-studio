import { expect, test, type Page } from '@playwright/test';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { T } from '@/timeouts';

// Todo cards now live inside the message log. Growth increases scrollHeight,
// rather than shrinking clientHeight as the retired pinned sibling did.
async function seedProjectWithTodos(page: Page, suffix: string) {
  const projectId = `todo-scroll-${suffix}-${Date.now()}`;
  const created = await page.request.post('/api/projects', { data: {
    id: projectId, name: `Todo Scroll ${suffix}`, skillId: null,
    designSystemId: null, pendingPrompt: null, metadata: { kind: 'prototype' },
  } });
  expect(created.ok(), await created.text()).toBe(true);
  const { conversationId } = await created.json();
  for (let i = 0; i < 12; i++) {
    for (const role of ['user', 'assistant'] as const) {
      const response = await page.request.put(
        `/api/projects/${projectId}/conversations/${conversationId}/messages/${projectId}-${role}-${i}`, {
          data: { role, content: `Filler ${role} ${i}: doing the work carefully.`,
            createdAt: Date.now() - (14 - i) * 1000 + (role === 'assistant' ? 500 : 0) },
        });
      expect(response.ok(), await response.text()).toBe(true);
    }
  }
  const response = await page.request.put(
    `/api/projects/${projectId}/conversations/${conversationId}/messages/${projectId}-todos`, {
      data: { role: 'assistant', content: 'Here is the plan', runStatus: 'succeeded',
        createdAt: Date.now(), events: [{ kind: 'tool_use', id: 'todos', name: 'TodoWrite',
          input: { todos: Array.from({ length: 4 }, (_, i) => ({ content: `Task ${i + 1}`, status: 'pending' })) } }] },
    });
  expect(response.ok(), await response.text()).toBe(true);
  await page.goto(`/projects/${projectId}/conversations/${conversationId}`);
  await expect(page.locator('.op-todo')).toBeVisible({ timeout: T.medium });
  await expect(page.locator('.chat-log').getByText('Filler user 0: doing the work carefully.', { exact: true })).toBeVisible();
}

async function geometry(page: Page) {
  return page.locator('.chat-log').evaluate(node => ({
    top: node.scrollTop, height: node.scrollHeight, viewport: node.clientHeight,
    bottom: node.scrollHeight - node.scrollTop - node.clientHeight,
  }));
}

async function growTodo(page: Page) {
  await page.locator('.op-todo').evaluate(node => new Promise<void>((resolve, reject) => {
    if (!(node instanceof HTMLElement)) throw new Error('Todo card must be an HTML element');
    const before = node.offsetHeight;
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Todo resize was not observed')); }, 5000);
    // Subscribe before changing layout. Two paint callbacks drain the product's
    // ResizeObserver -> animation-frame scroll correction, without a sleep.
    const observer = new ResizeObserver(() => {
      if (node.offsetHeight <= before) return;
      observer.disconnect();
      requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
    });
    observer.observe(node);
    node.style.minHeight = `${before + 80}px`;
  }));
}

test.describe('chat pane autoscroll on inline TodoCard growth', () => {
  test.beforeEach(async ({ page }) => { await applyStandardMocks(page); });

  test('[P2] scenario A: pinned user stays at bottom after inline TodoCard grows', async ({ page }) => {
    // Given a real persisted conversation with enough content to scroll.
    await seedProjectWithTodos(page, 'a');
    const before = await geometry(page);
    expect(before.height - before.viewport).toBeGreaterThan(50);
    expect(before.bottom).toBeLessThan(20);
    // When the inline card grows.
    await growTodo(page);
    // Then content really grew and the pinned reader follows it.
    const after = await geometry(page);
    expect(after.height).toBeGreaterThan(before.height);
    expect(after.bottom).toBeLessThan(20);
  });

  test('[P2] scenario B: user scroll-up is preserved when inline TodoCard grows', async ({ page }) => {
    // Given a reader deliberately away from the tail.
    await seedProjectWithTodos(page, 'b');
    await page.locator('.chat-log').evaluate(node => {
      node.scrollTop = Math.max(0, node.scrollTop - 150);
      node.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    const before = await geometry(page);
    expect(before.bottom).toBeGreaterThan(80);
    // When content grows below the reader.
    await growTodo(page);
    // Then the growth was real, without pulling the reader down.
    const after = await geometry(page);
    expect(after.height).toBeGreaterThan(before.height);
    expect(Math.abs(after.top - before.top)).toBeLessThan(20);
  });
});
