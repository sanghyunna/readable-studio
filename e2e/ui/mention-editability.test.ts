import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { applyStandardMocks } from '@/playwright/mock-factory';

const EVIDENCE_DIR = fileURLToPath(
  new URL('../../.omo/evidence/current-ui-batch/mention-freeze-fix/', import.meta.url),
);
const EDITOR = '[data-testid="chat-composer-input"]';
const PILL = '.composer-inline-mention--file';
const MENTION = '@reference.txt';
const SUFFIX = ' 후속입력';

test.beforeEach(async ({ page }) => {
  await applyStandardMocks(page);
});

async function openProjectChatWithFile(page: Page): Promise<void> {
  const response = await page.request.post('/api/projects', {
    data: {
      id: randomUUID(),
      name: 'Mention editability regression',
      skillId: null,
      designSystemId: null,
      metadata: { kind: 'prototype', nameSource: 'user' },
    },
  });
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as {
    readonly project: { readonly id: string };
    readonly conversationId: string;
  };
  const fileResponse = await page.request.post(`/api/projects/${body.project.id}/files`, {
    data: { name: 'reference.txt', content: 'Mention regression fixture.\n' },
  });
  expect(fileResponse.ok()).toBeTruthy();
  await page.goto(`/projects/${body.project.id}/conversations/${body.conversationId}`);
  await expect(page.locator(EDITOR)).toBeVisible();
}

test('context mention keeps Chromium editing live and remains atomically deletable', async ({ page }) => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  await openProjectChatWithFile(page);

  const editor = page.locator(EDITOR);
  await editor.evaluate((element) => {
    element.setAttribute('data-keydown-count', '0');
    element.setAttribute('data-beforeinput-count', '0');
    element.addEventListener('keydown', (event) => {
      if (!event.isTrusted) return;
      const current = Number(element.getAttribute('data-keydown-count') ?? '0');
      element.setAttribute('data-keydown-count', String(current + 1));
    });
    element.addEventListener('beforeinput', () => {
      const current = Number(element.getAttribute('data-beforeinput-count') ?? '0');
      element.setAttribute('data-beforeinput-count', String(current + 1));
    });
  });

  await editor.click();
  await editor.pressSequentially('@ref');
  const option = page
    .getByTestId('mention-popover')
    .getByRole('option')
    .filter({ hasText: 'reference.txt' })
    .first();
  await expect(option).toBeVisible();
  await option.click();
  await expect(page.locator(PILL)).toHaveCount(1);

  await editor.evaluate((element) => {
    element.setAttribute('data-keydown-count', '0');
    element.setAttribute('data-beforeinput-count', '0');
  });
  await editor.pressSequentially(SUFFIX);

  const trace = await editor.evaluate((element) => {
    const selection = window.getSelection();
    return {
      keydownCount: Number(element.getAttribute('data-keydown-count') ?? '0'),
      beforeinputCount: Number(element.getAttribute('data-beforeinput-count') ?? '0'),
      execCommand: document.execCommand('insertText', false, ''),
      activeElementIsEditor: document.activeElement === element,
      rangeCount: selection?.rangeCount ?? 0,
      anchorNode: selection?.anchorNode?.nodeName ?? null,
      anchorInEditor: selection?.anchorNode ? element.contains(selection.anchorNode) : false,
      serializedText: element.textContent ?? '',
    };
  });
  writeFileSync(join(EVIDENCE_DIR, 'browser-trace.json'), `${JSON.stringify(trace, null, 2)}\n`);
  console.log(`MENTION_EDITABILITY_TRACE ${JSON.stringify(trace)}`);

  expect(trace.keydownCount).toBeGreaterThan(0);
  expect(trace.beforeinputCount).toBeGreaterThan(0);
  await expect(editor).toHaveText(`${MENTION}${SUFFIX}`);
  await expect(
    editor.locator('[data-lexical-text="true"][contenteditable="false"]'),
  ).toHaveCount(0);

  await editor.evaluate((element, suffix) => {
    const textNode = Array.from(element.querySelectorAll('[data-lexical-text="true"]'))
      .map((leaf) => leaf.firstChild)
      .find((node) => node?.nodeType === Node.TEXT_NODE && node.textContent === suffix);
    if (!textNode) throw new Error('Typed suffix text node was not found');
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, SUFFIX);
  await editor.press('Backspace');
  await expect(editor).toHaveText(MENTION);
  await expect(page.locator(PILL)).toHaveCount(1);

  await editor.press('Backspace');
  await expect(page.locator(PILL)).toHaveCount(0);
  await expect(editor).toBeEmpty();
});
