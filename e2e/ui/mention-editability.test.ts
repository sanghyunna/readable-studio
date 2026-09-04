import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { applyStandardMocks } from '@/playwright/mock-factory';

const EVIDENCE_DIR = fileURLToPath(
  new URL('../../.omo/evidence/mention-caret-spacing/', import.meta.url),
);
const EDITOR = '[data-testid="chat-composer-input"]';
const PILL = '.composer-inline-mention--file';
const MENTION = '@reference.txt';
const SUFFIX = ' 후속입력';

type SelectionTrace = {
  readonly anchor: string | null;
  readonly offset: number | null;
  readonly inPill: boolean;
};

async function readSelection(page: Page): Promise<SelectionTrace> {
  return page.evaluate(() => {
    const selection = window.getSelection();
    const anchor = selection?.anchorNode ?? null;
    const pill = anchor instanceof Element
      ? anchor.closest('.composer-inline-mention')
      : anchor?.parentElement?.closest('.composer-inline-mention');
    return {
      anchor: anchor?.nodeType === Node.TEXT_NODE
        ? `#text:${anchor.textContent ?? ''}`
        : anchor instanceof Element
          ? `${anchor.tagName.toLowerCase()}.${anchor.className}`
          : null,
      offset: selection?.anchorOffset ?? null,
      inPill: pill !== null,
    };
  });
}

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

  const pill = page.locator(PILL);
  const box = await pill.boundingBox();
  if (!box) throw new Error('Mention pill has no browser geometry');
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
  const click = await readSelection(page);
  expect(click.inPill).toBe(false);
  await page.screenshot({ path: join(EVIDENCE_DIR, 'pill-caret-after.png') });

  await editor.press('ArrowLeft');
  const arrowLeft = await readSelection(page);
  expect(arrowLeft.inPill).toBe(false);
  await editor.press('ArrowRight');
  const arrowRight = await readSelection(page);
  expect(arrowRight.inPill).toBe(false);

  await editor.pressSequentially(SUFFIX);
  const typed = await readSelection(page);
  expect(typed.inPill).toBe(false);
  await page.screenshot({ path: join(EVIDENCE_DIR, 'typed-adjacent-light.png') });
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.setAttribute('data-theme-scheme', 'dark');
  });
  await page.screenshot({ path: join(EVIDENCE_DIR, 'typed-adjacent-dark.png') });

  const trace = await editor.evaluate((element) => {
    const selection = window.getSelection();
    const mention = element.querySelector('.composer-inline-mention');
    if (!mention) throw new Error('Mention pill missing during style inspection');
    const style = getComputedStyle(mention);
    return {
      keydownCount: Number(element.getAttribute('data-keydown-count') ?? '0'),
      beforeinputCount: Number(element.getAttribute('data-beforeinput-count') ?? '0'),
      execCommand: document.execCommand('insertText', false, ''),
      activeElementIsEditor: document.activeElement === element,
      rangeCount: selection?.rangeCount ?? 0,
      anchorNode: selection?.anchorNode?.nodeName ?? null,
      anchorInEditor: selection?.anchorNode ? element.contains(selection.anchorNode) : false,
      serializedText: element.textContent ?? '',
      mentionMarginInlineStart: style.marginInlineStart,
      mentionMarginInlineEnd: style.marginInlineEnd,
    };
  });
  expect(trace.keydownCount).toBeGreaterThan(0);
  expect(trace.beforeinputCount).toBeGreaterThan(0);
  expect(trace.mentionMarginInlineStart).toBe('4px');
  expect(trace.mentionMarginInlineEnd).toBe('4px');
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
  const backspaceBoundary = await readSelection(page);

  await editor.press('Backspace');
  await expect(page.locator(PILL)).toHaveCount(0);
  await expect(editor).toBeEmpty();
  const backspace = await readSelection(page);
  const interactionTrace = {
    click,
    arrowLeft,
    arrowRight,
    typed,
    backspaceBoundary,
    backspace,
    afterTyping: trace,
  };
  writeFileSync(
    join(EVIDENCE_DIR, 'browser-trace.json'),
    `${JSON.stringify(interactionTrace, null, 2)}\n`,
  );
  console.log(`MENTION_EDITABILITY_TRACE ${JSON.stringify(interactionTrace)}`);
});
