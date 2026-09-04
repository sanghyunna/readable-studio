import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { applyStandardMocks } from '@/playwright/mock-factory';

const EVIDENCE_DIR = fileURLToPath(
  new URL('../../.omo/evidence/mention-caret-2/', import.meta.url),
);
const EDITOR = '[data-testid="home-hero-input"]';
const PILL = '.composer-inline-mention--plugin';
const SUFFIX = ' 후속입력';

type SelectionTrace = {
  readonly anchor: string | null;
  readonly offset: number | null;
  readonly inPill: boolean;
  readonly lexicalAnchorType: string | null;
  readonly lexicalAnchorNodeType: string | null;
  readonly lexicalOffset: number | null;
  readonly lexicalInsideMention: boolean;
};

async function readSelection(page: Page): Promise<SelectionTrace> {
  return page.evaluate(() => {
    const selection = window.getSelection();
    const anchor = selection?.anchorNode ?? null;
    const pill = anchor instanceof Element
      ? anchor.closest('.composer-inline-mention')
      : anchor?.parentElement?.closest('.composer-inline-mention');
    const root = document.querySelector<HTMLElement>('[data-testid="home-hero-input"]');
    const editor = (root as (HTMLElement & { __lexicalEditor?: {
      _editorState?: { _selection?: { anchor?: { key?: string; type?: string; offset?: number } }; _nodeMap?: Map<string, { __type?: string; __parent?: string }> };
    } }) | null)?.__lexicalEditor;
    const lexicalSelection = editor?._editorState?._selection;
    const anchorKey = lexicalSelection?.anchor?.key;
    const nodeMap = editor?._editorState?._nodeMap;
    let node = anchorKey ? nodeMap?.get(anchorKey) : undefined;
    let lexicalInsideMention = false;
    while (node) {
      if (node.__type === 'composer-mention') lexicalInsideMention = true;
      node = node.__parent ? nodeMap?.get(node.__parent) : undefined;
    }
    return {
      anchor: anchor?.nodeType === Node.TEXT_NODE
        ? `#text:${anchor.textContent ?? ''}`
        : anchor instanceof Element
          ? `${anchor.tagName.toLowerCase()}.${anchor.className}`
          : null,
      offset: selection?.anchorOffset ?? null,
      inPill: pill !== null,
      lexicalAnchorType: lexicalSelection?.anchor?.type ?? null,
      lexicalAnchorNodeType: anchorKey ? nodeMap?.get(anchorKey)?.__type ?? null : null,
      lexicalOffset: lexicalSelection?.anchor?.offset ?? null,
      lexicalInsideMention,
    };
  });
}

test.beforeEach(async ({ page }) => {
  await applyStandardMocks(page);
});

test('Hub context mention keeps the caret outside and remains atomically deletable', async ({ page }) => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  await page.goto('/');
  await expect(page.locator(EDITOR)).toBeVisible();

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
  await page.getByTestId('home-hero-context-control').click();
  const option = page
    .getByTestId('home-hero-plugin-picker')
    .getByRole('option')
    .first();
  await expect(option).toBeVisible();
  await option.click();
  await expect(page.locator(PILL)).toHaveCount(1);
  const mentionText = await page.locator(PILL).textContent();
  if (!mentionText) throw new Error('Mention pill has no text');

  const inserted = await readSelection(page);
  expect(inserted.inPill).toBe(false);
  expect(inserted.lexicalInsideMention).toBe(false);
  expect(inserted.lexicalAnchorNodeType).not.toBe('composer-mention');
  await page.screenshot({ path: join(EVIDENCE_DIR, 'after-light.png') });
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.setAttribute('data-theme-scheme', 'dark');
  });
  await page.screenshot({ path: join(EVIDENCE_DIR, 'after-dark.png') });
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'light');
    document.documentElement.setAttribute('data-theme-scheme', 'light');
  });

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
  expect(click.lexicalInsideMention).toBe(false);

  await editor.press('ArrowLeft');
  const arrowLeft = await readSelection(page);
  expect(arrowLeft.inPill).toBe(false);
  expect(arrowLeft.lexicalInsideMention).toBe(false);
  await editor.press('ArrowRight');
  const arrowRight = await readSelection(page);
  expect(arrowRight.inPill).toBe(false);
  expect(arrowRight.lexicalInsideMention).toBe(false);

  await editor.press('Home');
  const home = await readSelection(page);
  expect(home.inPill).toBe(false);
  expect(home.lexicalInsideMention).toBe(false);
  await editor.press('End');
  const end = await readSelection(page);
  expect(end.inPill).toBe(false);
  expect(end.lexicalInsideMention).toBe(false);

  const editorBox = await editor.boundingBox();
  if (!editorBox) throw new Error('Composer has no browser geometry');
  await page.mouse.click(editorBox.x + editorBox.width - 4, box.y + box.height / 2);
  const beyondEnd = await readSelection(page);
  expect(beyondEnd.inPill).toBe(false);
  expect(beyondEnd.lexicalInsideMention).toBe(false);

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
  await expect(editor).toHaveText(`${mentionText}${SUFFIX}`);
  await expect(editor.locator('[data-lexical-decorator="true"]')).toHaveCount(1);
  await expect(page.locator(PILL)).toHaveAttribute('contenteditable', 'false');

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
  await expect(editor).toHaveText(mentionText);
  await expect(page.locator(PILL)).toHaveCount(1);
  const backspaceBoundary = await readSelection(page);

  await editor.press('Backspace');
  await expect(page.locator(PILL)).toHaveCount(0);
  await expect(editor).toBeEmpty();
  const backspace = await readSelection(page);
  const interactionTrace = {
    inserted,
    click,
    arrowLeft,
    arrowRight,
    home,
    end,
    beyondEnd,
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
