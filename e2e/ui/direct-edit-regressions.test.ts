import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { HELD_QUESTION_RUN } from '@/fake-agents';
import { createDirectEditHeldAgent } from '@/playwright/direct-edit-held-agent';
import { addStorageInitScript } from '@/playwright/storage-init';
import { waitForSaveResponse } from '@/playwright/manual-edit-events';
import { T } from '@/timeouts';

const previewSelector = '[data-testid^="artifact-preview-frame"]:visible';
const preview = (page: Page) => page.locator(previewSelector).first();
const frame = (page: Page) => page.frameLocator(previewSelector);
const selection = { mode: 'daemon', agentId: 'codex', agentModels: { codex: { model: 'gpt-5.4-mini', reasoning: 'default' } } };
let savedConfig: Record<string, unknown>;
let config: Record<string, unknown>;

test.beforeAll(async ({ request }) => {
  const original = await request.get('/api/app-config');
  expect(original.ok(), await original.text()).toBe(true);
  savedConfig = ((await original.json()) as { config: Record<string, unknown> }).config;
  const codex = await createDirectEditHeldAgent(join(tmpdir(), `direct-edit-held-${randomUUID()}`));
  config = { ...savedConfig, ...selection, enabledAgentIds: ['codex'], skillId: null, designSystemId: null,
    onboardingCompleted: true, privacyDecisionAt: 1,
    telemetry: { metrics: false, content: false, artifactManifest: false }, agentCliEnv: { codex: codex.env } };
  const response = await request.put('/api/app-config', { data: config });
  expect(response.ok(), await response.text()).toBe(true);
});

test.beforeEach(async ({ page }) => {
  test.setTimeout(T.xlong * 2);
  await addStorageInitScript(page, value => {
    localStorage.setItem('readable-studio:config', JSON.stringify(value));
    localStorage.setItem('readable-studio:locale', 'en');
    localStorage.setItem('readable-studio:locale-source', 'manual');
    localStorage.setItem('readable-studio:welcome-modal-shown', '1');
    const messages: unknown[] = [];
    const targetMessages = { count: 0, firstAt: 0, lastAt: 0, lastEpoch: '' };
    Object.assign(window, { directEditMessages: messages, directEditTargetMessages: targetMessages });
    window.addEventListener('message', event => {
      const data = event.data;
      if (!data || typeof data.type !== 'string' || (!data.type.startsWith('readable-edit-') && data.type !== 'direct-edit-qa:native')) return;
      if (data.type === 'readable-edit-targets') {
        targetMessages.count += 1;
        targetMessages.firstAt ||= performance.now();
        targetMessages.lastAt = performance.now();
        if (typeof data.documentEpoch === 'string') targetMessages.lastEpoch = data.documentEpoch;
        return;
      }
      if (messages.length >= 300) messages.shift();
      messages.push({ at: performance.now(), epochAt: performance.timeOrigin + performance.now(), ...data });
    });
  }, config);
  await page.addInitScript(() => {
    if (window === window.top) return;
    const post = (data: Record<string, unknown>) => parent.postMessage({ type: 'direct-edit-qa:native', ...data }, '*');
    window.addEventListener('error', event => post({ event: 'error', message: event.message, stack: event.error?.stack }));
    document.addEventListener('keydown', event => {
      if (!['End', 'Escape', 'Backspace'].includes(event.key)) return;
      const target = event.target as Element | null;
      post({ event: 'editor-key', key: event.key, focused: document.hasFocus(), target: target?.tagName,
        readableId: target?.getAttribute('data-readable-id'), active: document.activeElement?.tagName, selection: getSelection()?.toString() });
    }, true);
    document.addEventListener('input', event => {
      const target = event.target as Element | null;
      if (target?.getAttribute('contenteditable') !== 'true') return;
      post({ event: 'editor-input', inputType: (event as InputEvent).inputType, target: target.tagName,
        readableId: target.getAttribute('data-readable-id'), text: target.textContent?.slice(0, 300) });
    }, true);
    document.addEventListener('keydown', event => {
      if (!(event.ctrlKey || event.metaKey) || !['b', 'i', 'u'].includes(event.key.toLowerCase())) return;
      const inspect = (phase: string) => {
        const editor = document.querySelector('[data-readable-editing="true"]');
        const selection = getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        let nativeBold: boolean | null = null;
        try { nativeBold = document.queryCommandState('bold'); } catch {}
        post({ event: 'format-key', phase, key: event.key, focused: document.hasFocus(),
          active: { tag: document.activeElement?.tagName, id: document.activeElement?.getAttribute('data-readable-id') },
          selection: selection?.toString(), within: !!editor && !!range && editor.contains(range.startContainer) && editor.contains(range.endContainer),
          nativeBold, html: editor?.innerHTML });
      };
      inspect('before'); queueMicrotask(() => inspect('after'));
    }, true);
  });
});

test.afterEach(async ({ page }, testInfo) => {
  if (page.isClosed()) return;
  const observed = await page.evaluate(() => {
    const host = window as typeof window & { directEditMessages?: unknown[]; directEditTargetMessages?: unknown };
    return { messages: host.directEditMessages ?? [], targetMessages: host.directEditTargetMessages,
      active: { tag: document.activeElement?.tagName, id: document.activeElement?.id, testId: document.activeElement?.getAttribute('data-testid') },
      caret: { text: getSelection()?.anchorNode?.textContent, offset: getSelection()?.anchorOffset } };
  }).catch(() => null);
  const documentSnapshot = await frame(page).locator('body').evaluate(body => {
    const all = Array.from(body.querySelectorAll('[data-readable-id]')).filter(element => !element.matches('script'));
    const selectedAll = Array.from(body.querySelectorAll('[data-readable-edit-selected]'));
    const shown = Array.from(new Set([...all.slice(0, 8), ...selectedAll.slice(0, 4)]));
    return {
      active: { tag: body.ownerDocument.activeElement?.tagName, id: body.ownerDocument.activeElement?.id, readableId: body.ownerDocument.activeElement?.getAttribute('data-readable-id'), focused: body.ownerDocument.hasFocus() },
      totalObjects: all.length, totalSelected: selectedAll.length,
      selected: selectedAll.slice(0, 4).map(element => element.outerHTML.slice(0, 12000)),
      legacyBoots: (window as typeof window & { legacyDirectEditBoots?: number }).legacyDirectEditBoots ?? 0,
      scripts: Array.from(body.ownerDocument.scripts).map(script => ({ src: script.getAttribute('src')?.slice(0, 200), type: script.type, code: script.textContent?.slice(0, 200) })),
      objects: shown.map(element => ({
        id: element.getAttribute('data-readable-id'), html: element.outerHTML.slice(0, 12000),
        style: ['width', 'height', 'position', 'box-sizing', 'min-width', 'max-width', 'margin-left', 'margin-top', 'left', 'right', 'transform', 'translate']
          .map(name => [name, getComputedStyle(element).getPropertyValue(name)]), rect: element.getBoundingClientRect().toJSON(),
      })),
    };
  }).catch(() => null);
  await testInfo.attach('bridge-observations', { body: JSON.stringify({ observed, document: documentSnapshot }), contentType: 'application/json' });
});

test.afterAll(async ({ request }) => {
  if (!savedConfig) return;
  const response = await request.put('/api/app-config', { data: savedConfig });
  expect(response.ok(), await response.text()).toBe(true);
});

async function createProject(request: APIRequestContext) {
  const projectId = randomUUID();
  const response = await request.post('/api/projects', { data: {
    id: projectId, name: 'Direct edit regression', skillId: null, designSystemId: null, metadata: { kind: 'prototype' },
  } });
  expect(response.ok(), await response.text()).toBe(true);
  const { conversationId } = await response.json() as { conversationId: string };
  const selected = await request.patch(`/api/projects/${projectId}/conversations/${conversationId}`, { data: { selection } });
  expect(selected.ok(), await selected.text()).toBe(true);
  const seeded = await request.put(`/api/projects/${projectId}/conversations/${conversationId}/messages/direct-edit-fixture`, { data: {
    id: 'direct-edit-fixture', role: 'assistant', agentId: 'codex', content: 'The document is ready for editing.',
    runId: 'fixture', runStatus: 'succeeded', createdAt: Date.now(), endedAt: Date.now(), events: [],
  } });
  expect(seeded.ok(), await seeded.text()).toBe(true);
  return { projectId, conversationId };
}

async function writeFile(request: APIRequestContext, projectId: string, name: string, content: string, kind: 'html' | 'deck' = 'html') {
  const response = await request.post(`/api/projects/${projectId}/files`, { data: {
    name, content, artifactManifest: { schema: 'readable-studio.artifact-manifest.v1', kind, title: name, entry: name,
      renderer: kind === 'deck' ? 'deck-html' : 'html', exports: ['html'] },
  } });
  expect(response.ok(), await response.text()).toBe(true);
}

async function openFile(page: Page, projectId: string, name: string) {
  await page.goto(`/projects/${projectId}/files/${name}`);
  await expect(preview(page)).toBeVisible({ timeout: T.long });
}

async function edit(page: Page) {
  await page.getByTestId('manual-edit-mode-toggle').click();
  await expect(frame(page).locator('html[data-readable-edit-mode]')).toHaveCount(1);
}

async function save(page: Page, projectId: string) {
  const response = waitForSaveResponse(page, projectId);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  expect((await response).ok()).toBe(true);
  await expect(page.locator('.manual-edit-left-inspector')).toHaveCount(0);
}

async function characterStyles(target: Locator) {
  return target.evaluate(element => {
    const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const styles: Array<{ text: string; size: string; weight: string; italic: string; decoration: string }> = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim() || !node.parentElement) continue;
      const css = getComputedStyle(node.parentElement);
      styles.push({ text: node.textContent, size: css.fontSize, weight: css.fontWeight, italic: css.fontStyle, decoration: css.textDecorationLine });
    }
    return styles;
  });
}

async function observeDeckFrames(page: Page) {
  await page.evaluate(() => {
    const records: Array<{ index: number; at: number; boot: string }> = [];
    Object.assign(window, { directEditDeckFrames: records });
    window.addEventListener('message', event => {
      if (event.data?.type !== 'direct-edit-qa:frame') return;
      const active = Array.from(document.querySelectorAll<HTMLIFrameElement>('[data-testid^="artifact-preview-frame"]'))
        .find(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
      if (event.source === active?.contentWindow) records.push(event.data);
    });
  });
}

function frameObservedDeck(source: string) {
  return source.replace('</body>', `<script>(function(){
    var boot=Math.random().toString(36),last=-1;
    function sample(){
      var slides=Array.from(document.querySelectorAll('.slide'));
      var index=slides.findIndex(function(slide){return slide.classList.contains('active');});
      if(index!==last){last=index;window.parent.postMessage({type:'direct-edit-qa:frame',index:index,at:Date.now(),boot:boot},'*');}
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  })();</script></body>`);
}

async function localRect(target: Locator) {
  return target.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      centerX: rect.x + rect.width / 2, centerY: rect.y + rect.height / 2 };
  });
}

test('[P0] Enter preserves authored typography and newlines through canonical save for text roots', async ({ page, request }, testInfo) => {
  const { projectId } = await createProject(request);
  const observations = [];
  for (const tag of ['p', 'h1', 'span', 'div']) {
    const name = `text-${tag}.html`;
    const source = `<!doctype html><html><head><style>
      body{margin:32px;font-family:Arial}.shape{display:block;width:700px;min-height:160px;font-size:64px;font-weight:700}
      .shape b{font-size:24px;font-weight:400}.shape i{font-style:normal}.survivor{font-size:18px;font-weight:400}
      </style></head><body><${tag} class="shape" data-readable-id="shape"><b><i>제 1막, OO를 OO합니다.</i></b></${tag}>
      <p class="survivor" data-readable-id="survivor">Unchanged sibling</p></body></html>`;
    await writeFile(request, projectId, name, source);
    await openFile(page, projectId, name);
    await edit(page);
    const target = frame(page).locator('[data-readable-id="shape"]');
    const before = await characterStyles(target);
    expect(before[0]).toMatchObject({ size: '24px', weight: '400', italic: 'normal' });
    await target.dblclick();
    await expect(target).toHaveAttribute('contenteditable', 'true');
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await expect(target).toHaveAttribute('contenteditable', 'true');
    await page.keyboard.type('두 번째 줄');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('세 번째 줄');
    await testInfo.attach(`native-${tag}-before-commit`, { body: JSON.stringify(await target.evaluate(element => ({
      root: element.outerHTML, siblings: Array.from(element.parentElement?.children ?? []).filter(node => node.tagName !== 'SCRIPT').map(node => node.outerHTML),
    }))), contentType: 'application/json' });
    await page.keyboard.press('Escape');
    await expect(target).not.toHaveAttribute('contenteditable');
    await expect(target).toContainText('두 번째 줄');
    const after = await characterStyles(target);
    expect(after.every(part => part.size === '24px' && part.weight === '400' && part.italic === 'normal')).toBe(true);
    await expect(frame(page).locator('.survivor')).toHaveCSS('font-size', '18px');
    await save(page, projectId);
    await page.reload();
    await expect(frame(page).locator('[data-readable-id="shape"]')).toContainText('세 번째 줄');
    const reloaded = frame(page).locator('[data-readable-id="shape"]');
    expect(await reloaded.innerText()).toMatch(/제 1막, OO를 OO합니다\.\n.*두 번째 줄\n.*세 번째 줄/s);
    expect((await characterStyles(reloaded)).every(part => part.size === '24px' && part.weight === '400' && part.italic === 'normal')).toBe(true);
    await expect(frame(page).locator('.survivor')).toHaveText('Unchanged sibling');
    const persisted = await request.get(`/api/projects/${projectId}/files/${name}`);
    expect(persisted.ok()).toBe(true);
    const html = await persisted.text();
    expect(html).toContain('<b>');
    expect(html).toContain('<i>');
    observations.push({ tag, before, after, reloaded: await characterStyles(reloaded), html });
  }
  await page.screenshot({ path: testInfo.outputPath('typography-persisted.png') });
  await testInfo.attach('typography-roundtrip', { body: JSON.stringify(observations), contentType: 'application/json' });
});

test('[P0] direct edits and history retain the live non-first deck document', async ({ page, request }, testInfo) => {
  const { projectId } = await createProject(request);
  const template = readFileSync(new URL('../../templates/deck-framework.html', import.meta.url), 'utf8');
  const source = frameObservedDeck(template.replace('<!-- SLOT: deck title -->', 'Direct edit live deck')
    .replace('<!-- SLOT: slide 1 content -->', '<h1>First slide must never flash</h1>')
    .replace('<!-- SLOT: slide 2 content -->', '<h1 data-readable-id="title" style="font-size:52px;padding:16px">Second slide title</h1><p data-readable-id="remove" style="font-size:34px;padding:24px;margin:24px">Remove this object</p><p data-readable-id="survivor" style="font-size:34px;padding:24px;margin:24px">Keep this sibling</p>'));
  await writeFile(request, projectId, 'live-deck.html', source, 'deck');
  await openFile(page, projectId, 'live-deck.html');
  await page.getByLabel('Next slide', { exact: true }).click();
  await expect(frame(page).locator('#deck-cur')).toHaveText('02');
  await edit(page);
  await expect(frame(page).locator('#deck-cur')).toHaveText('02');
  await observeDeckFrames(page);
  const armedAt = Date.now();
  const marker = randomUUID();
  await preview(page).evaluate(element => {
    element.setAttribute('data-qa-loads', '0');
    element.addEventListener('load', () => element.setAttribute('data-qa-loads', String(Number(element.getAttribute('data-qa-loads')) + 1)));
  });
  await frame(page).locator('html').evaluate((element, value) => element.setAttribute('data-qa-document', value), marker);
  const title = frame(page).locator('[data-readable-id="title"]');
  await title.dblclick();
  await expect(title).toHaveAttribute('contenteditable', 'true');
  await expect(title).toBeFocused();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' edited');
  await page.keyboard.press('Escape');
  await expect(title).toHaveText('Second slide title edited');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await expect(preview(page)).toHaveAttribute('data-qa-loads', '0');
  await expect(frame(page).locator('html')).toHaveAttribute('data-qa-document', marker);
  const removable = frame(page).locator('[data-readable-id="remove"]');
  const removeBox = await removable.boundingBox();
  expect(removeBox).not.toBeNull();
  await page.mouse.click(removeBox!.x + 1, removeBox!.y + removeBox!.height / 2);
  await expect(removable).toHaveAttribute('data-readable-edit-selected', 'true');
  await expect(removable).not.toHaveAttribute('contenteditable');
  await page.keyboard.press('Delete');
  await expect(removable).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(removable).toBeVisible();
  await page.keyboard.press('Control+Shift+z');
  await expect(removable).toHaveCount(0);
  await expect(frame(page).locator('#deck-cur')).toHaveText('02');
  await expect(preview(page)).toHaveAttribute('data-qa-loads', '0');
  await expect(frame(page).locator('html')).toHaveAttribute('data-qa-document', marker);
  await expect(frame(page).locator('[data-readable-id="survivor"]')).toBeVisible();
  const records = await page.evaluate(() => (window as typeof window & { directEditDeckFrames: Array<{ index: number; at: number }> }).directEditDeckFrames);
  expect(records.filter(record => record.at >= armedAt).every(record => record.index === 1)).toBe(true);
  await testInfo.attach('visible-deck-frames', { body: JSON.stringify(records), contentType: 'application/json' });
  await page.screenshot({ path: testInfo.outputPath('live-second-slide.png') });
  await save(page, projectId);
  const persisted = await request.get(`/api/projects/${projectId}/files/live-deck.html`);
  const html = await persisted.text();
  expect(html).toContain('Second slide title edited');
  expect(html).not.toContain('Remove this object');
  expect(html).not.toContain('data-qa-document');
});

test('[P0] external deck replacement restores the non-first slide before its first visible frame', async ({ page, request }, testInfo) => {
  const { projectId } = await createProject(request);
  const template = readFileSync(new URL('../../templates/deck-framework.html', import.meta.url), 'utf8');
  const source = frameObservedDeck(template.replace('<!-- SLOT: slide 1 content -->', '<h1>First must stay hidden</h1>')
    .replace('<!-- SLOT: slide 2 content -->', '<h1>Second visible slide</h1>'));
  await writeFile(request, projectId, 'replacement-deck.html', source, 'deck');
  await openFile(page, projectId, 'replacement-deck.html');
  await page.getByLabel('Next slide', { exact: true }).click();
  await expect(frame(page).locator('#deck-cur')).toHaveText('02');
  await observeDeckFrames(page);
  const composer = page.getByTestId('chat-composer-input');
  await composer.click();
  await page.keyboard.type('Preserve this draft');
  const armedAt = Date.now();
  await writeFile(request, projectId, 'replacement-deck.html', source.replace('<style>', '<style>:root{--qa-update:1}').replace('Second visible slide', 'Second updated slide'), 'deck');
  await expect(frame(page).getByText('Second updated slide', { exact: true })).toBeVisible({ timeout: T.long });
  await expect(composer).toBeFocused();
  const records = await page.evaluate(() => (window as typeof window & { directEditDeckFrames: Array<{ index: number; at: number; boot: string }> }).directEditDeckFrames);
  const replacement = records.filter(record => record.at >= armedAt);
  expect(replacement.length).toBeGreaterThan(0);
  expect(replacement.every(record => record.index === 1)).toBe(true);
  await testInfo.attach('replacement-first-frame', { body: JSON.stringify(replacement), contentType: 'application/json' });
  await page.screenshot({ path: testInfo.outputPath('restored-first-frame.png') });
});

test('[P0] opaque preview keeps linked imported typography through formatting and save', async ({ page, request }, testInfo) => {
  const { projectId } = await createProject(request);
  for (const [name, content] of [
    ['assets/base.css', '@import "type.css";body{font-family:Arial}.shape{font-size:64px;font-weight:700}'],
    ['assets/type.css', ':root{--text-size:24px}@media(min-width:100px){.shape b{font-size:clamp(20px,var(--text-size),28px);font-weight:400}}'],
  ]) {
    const result = await request.post(`/api/projects/${projectId}/files`, { data: { name, content } });
    expect(result.ok(), await result.text()).toBe(true);
  }
  await writeFile(request, projectId, 'linked-type.html', '<!doctype html><html><head><link rel="stylesheet" href="assets/base.css"></head><body><div class="shape" data-readable-id="shape"><b>Linked typography</b></div></body></html>');
  await openFile(page, projectId, 'linked-type.html');
  await edit(page);
  const target = frame(page).locator('[data-readable-id="shape"]');
  await expect(target.locator('b')).toHaveCSS('font-size', '24px');
  const sheets = await target.evaluate(element => Array.from(element.ownerDocument.styleSheets).map(sheet => {
    try { return { href: sheet.href, rules: sheet.cssRules.length, readable: true }; }
    catch (error) { return { href: sheet.href, readable: false, error: String(error) }; }
  }));
  await testInfo.attach('stylesheet-access', { body: JSON.stringify(sheets), contentType: 'application/json' });
  const formatPoint = await renderedGlyph(target, 'Linked typography', 2);
  await page.mouse.dblclick(formatPoint.x, formatPoint.y);
  await expect(target).toHaveAttribute('contenteditable', 'true');
  await expect(target).toBeFocused();
  await page.keyboard.press('Control+a');
  expect(await target.evaluate(() => getSelection()?.toString())).toBe('Linked typography');
  await page.keyboard.press('Control+b');
  const formatted = await characterStyles(target);
  await testInfo.attach('formatted-linked-text', { body: JSON.stringify(formatted), contentType: 'application/json' });
  expect(formatted.every(part => part.size === '24px' && Number(part.weight) >= 600)).toBe(true);
  await page.keyboard.press('Control+z');
  const undone = await characterStyles(target);
  expect(undone.every(part => part.size === '24px' && part.weight === '400')).toBe(true);
  expect(await target.evaluate(() => getSelection()?.toString())).toBe('Linked typography');
  await page.keyboard.press('Control+Shift+z');
  expect((await characterStyles(target)).every(part => part.size === '24px' && Number(part.weight) >= 600)).toBe(true);
  await page.keyboard.press('Escape');
  await save(page, projectId);
  const persisted = await request.get(`/api/projects/${projectId}/files/linked-type.html`);
  expect(await persisted.text()).toContain('href="assets/base.css"');
  await page.reload();
  const reloaded = await characterStyles(frame(page).locator('[data-readable-id="shape"]'));
  expect(reloaded.every(part => part.size === '24px' && Number(part.weight) >= 600)).toBe(true);
  await testInfo.attach('linked-css-formatting', { body: JSON.stringify({ sheets, formatted, undone, reloaded }), contentType: 'application/json' });
});

test('[P0] a held agent stream and file refresh preserve the draft caret', async ({ page, request }, testInfo) => {
  const { projectId } = await createProject(request);
  const html = (version: string) => `<!doctype html><html><body><h1>${version}</h1><input autofocus><script>document.querySelector('input').focus();window.focus();</script></body></html>`;
  await writeFile(request, projectId, 'held-focus.html', html('Before held update'));
  await openFile(page, projectId, 'held-focus.html');
  await edit(page);
  await page.getByTestId('manual-edit-mode-toggle').click();
  await expect(frame(page).locator('html[data-readable-edit-mode]')).toHaveCount(0);
  const composer = page.getByTestId('chat-composer-input');
  await composer.fill(HELD_QUESTION_RUN.prompt);
  const started = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/runs');
  await page.getByTestId('chat-send').click();
  const accepted = await started;
  expect(accepted.status(), await accepted.text()).toBe(202);
  const { runId } = await accepted.json() as { runId: string };
  let bodySucceeded = false;
  try {
    await expect(page.getByTestId('questions-panel')).toBeVisible({ timeout: T.long });
    await composer.fill('draft tail');
    await composer.press('Home');
    await composer.press('ArrowRight');
    await composer.press('ArrowRight');
    const before = await composer.evaluate(element => ({ text: element.textContent, offset: getSelection()?.anchorOffset }));
    await writeFile(request, projectId, 'held-focus.html', html('After held update'));
    await expect(frame(page).getByRole('heading', { name: 'After held update' })).toBeVisible({ timeout: T.long });
    await expect(composer).toBeFocused();
    const after = await composer.evaluate(element => ({ text: element.textContent, offset: getSelection()?.anchorOffset }));
    expect(after).toEqual(before);
    await page.keyboard.insertText('!');
    await expect(composer).toHaveText('dr!aft tail');
    await testInfo.attach('held-focus-caret', { body: JSON.stringify({ before, after, runId }), contentType: 'application/json' });
    bodySucceeded = true;
  } finally {
    const released = await request.post(`/api/projects/${projectId}/files`, { data: { name: HELD_QUESTION_RUN.releaseFile, content: HELD_QUESTION_RUN.releaseToken } }).catch(() => null);
    if (bodySucceeded) {
      expect(released?.ok()).toBe(true);
      await expect.poll(async () => {
        const response = await request.get(`/api/runs/${runId}`);
        return ((await response.json()) as { status: string }).status;
      }, { timeout: T.long }).toBe('succeeded');
    } else {
      const response = await request.get(`/api/runs/${runId}`).catch(() => null);
      await testInfo.attach('held-run-failure-state', { body: await response?.text().catch(() => '') ?? 'unavailable', contentType: 'application/json' });
    }
  }
});

test('[P1] object keyboard commands keep native text selection and canonical history', async ({ page, request }, testInfo) => {
  const { projectId } = await createProject(request);
  await writeFile(request, projectId, 'object-keys.html', '<!doctype html><html><body style="margin:0"><div data-readable-id="one" style="position:absolute;left:40px;top:40px;width:120px;height:80px;background:#dbeafe">Object one</div><div data-readable-id="two" style="position:absolute;left:240px;top:40px;width:120px;height:80px;background:#fef3c7">Object two</div></body></html>');
  await openFile(page, projectId, 'object-keys.html');
  await edit(page);
  const first = frame(page).locator('[data-readable-id="one"]');
  const second = frame(page).locator('[data-readable-id="two"]');
  await first.click();
  for (const key of ['Enter', 'F2']) {
    const original = await first.innerText();
    await page.keyboard.press(key);
    await expect(first).toHaveAttribute('contenteditable', 'true');
    expect(await first.evaluate(() => getSelection()?.toString())).toBe(original);
    await page.keyboard.insertText(`Edited with ${key}`);
    await page.keyboard.press('Escape');
    await expect(first).not.toHaveAttribute('contenteditable');
    await expect(first).toHaveText(`Edited with ${key}`);
  }
  await page.keyboard.press('Tab');
  await expect(second).toHaveAttribute('data-readable-edit-selected', 'true');
  await page.keyboard.press('Shift+Tab');
  await expect(first).toHaveAttribute('data-readable-edit-selected', 'true');
  const beforeFineMove = await localRect(first);
  await page.keyboard.press('Control+ArrowRight');
  await expect.poll(async () => (await localRect(first)).x).toBeGreaterThan(beforeFineMove.x);
  const beforeKeyboardResize = await localRect(first);
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => (await localRect(first)).width).toBeCloseTo(beforeKeyboardResize.width * 1.1, 0);
  const keyboardResize = await localRect(first);
  expect(keyboardResize.centerX).toBeCloseTo(beforeKeyboardResize.centerX, 0);
  expect(keyboardResize.centerY).toBeCloseTo(beforeKeyboardResize.centerY, 0);
  const before = await localRect(first);
  await page.keyboard.press('Control+d');
  const duplicate = frame(page).locator('[data-readable-id]:not([data-readable-id="one"]):not([data-readable-id="two"])');
  await expect(duplicate).toHaveCount(1);
  const copied = await localRect(duplicate);
  expect(copied.x - before.x).toBeCloseTo(16, 0);
  expect(copied.y - before.y).toBeCloseTo(16, 0);
  const duplicateId = await duplicate.getAttribute('data-readable-id');
  await page.keyboard.press('Control+z');
  await expect(duplicate).toHaveCount(0);
  await page.keyboard.press('Control+Shift+z');
  await expect(duplicate).toHaveCount(1);
  expect(await duplicate.getAttribute('data-readable-id')).toBe(duplicateId);
  const duplicateBox = await duplicate.boundingBox();
  expect(duplicateBox).not.toBeNull();
  await page.mouse.click(duplicateBox!.x + duplicateBox!.width / 4, duplicateBox!.y + 3);
  await expect(duplicate).toHaveAttribute('data-readable-edit-selected', 'true');
  await expect(duplicate).not.toHaveAttribute('contenteditable');
  await page.keyboard.press('Backspace');
  await expect(duplicate).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(duplicate).toHaveCount(1);
  await save(page, projectId);
  const persisted = await request.get(`/api/projects/${projectId}/files/object-keys.html`);
  expect((await persisted.text()).match(/data-readable-id=/g)).toHaveLength(3);
  await testInfo.attach('object-keyboard', { body: JSON.stringify({ beforeFineMove, beforeKeyboardResize, keyboardResize, before, copied, duplicateId }), contentType: 'application/json' });
});

test('[P0] external HTML refresh preserves chat focus while preview remains intentionally editable', async ({ page, request }, testInfo) => {
  const { projectId } = await createProject(request);
  const html = (version: string, dialog = false) => `<!doctype html><html><body><h1 data-readable-id="heading">${version}</h1>${dialog ? '<button onclick="document.getElementById(\'preview-dialog\').showModal()">Open preview dialog</button><dialog id="preview-dialog">' : ''}<input id="autofocus" aria-label="Preview input" autofocus>${dialog ? '<button onclick="this.closest(\'dialog\').close()">Close preview dialog</button></dialog>' : ''}
    <script>document.getElementById('autofocus').focus();window.focus();${dialog ? "document.getElementById('preview-dialog').showModal();" : ''}</script></body></html>`;
  await writeFile(request, projectId, 'focus.html', html('Before update'));
  await openFile(page, projectId, 'focus.html');
  const composer = page.getByTestId('chat-composer-input');
  await composer.click();
  await page.keyboard.type('Keep typing ');
  await expect(composer).toBeFocused();
  await writeFile(request, projectId, 'focus.html', html('After update', true));
  await expect(frame(page).locator('[data-readable-id="heading"]')).toHaveText('After update', { timeout: T.long });
  await expect(composer).toBeFocused();
  await page.keyboard.type('without clicking again');
  await expect(composer).toContainText('Keep typing without clicking again');
  const input = frame(page).getByRole('textbox', { name: 'Preview input' });
  await input.click();
  await input.pressSequentially('intentional preview entry');
  await expect(input).toHaveValue('intentional preview entry');
  await frame(page).getByRole('button', { name: 'Close preview dialog' }).click();
  await frame(page).getByRole('button', { name: 'Open preview dialog' }).click();
  await expect(input).toBeFocused();
  await composer.click();
  await composer.press('Control+End');
  const beforeClose = await composer.evaluate(element => ({ text: element.textContent, offset: getSelection()?.anchorOffset }));
  await frame(page).locator('#preview-dialog').evaluate(element => (element as HTMLDialogElement).close());
  await expect(composer).toBeFocused();
  expect(await composer.evaluate(element => ({ text: element.textContent, offset: getSelection()?.anchorOffset }))).toEqual(beforeClose);
  await writeFile(request, projectId, 'focus.html', html('Before direct edit'));
  await expect(frame(page).locator('[data-readable-id="heading"]')).toHaveText('Before direct edit');
  await edit(page);
  const heading = frame(page).locator('[data-readable-id="heading"]');
  await heading.click();
  const fontSize = page.locator('.manual-edit-left-inspector').getByLabel('Font size', { exact: true });
  await expect(fontSize).toBeVisible();
  // A clean refresh deliberately drops the selection-bound inspector (stale
  // selection/history never survive a replaced source), so focus a host
  // control that persists across the refresh to observe the focus guard.
  const toggle = page.getByTestId('manual-edit-mode-toggle');
  await toggle.focus();
  await writeFile(request, projectId, 'focus.html', html('Updated during direct edit', true));
  await expect(heading).toHaveText('Updated during direct edit', { timeout: T.long });
  await expect(frame(page).locator('#preview-dialog')).toHaveCount(1);
  await expect(toggle).toBeFocused();
  // The refreshed document opens a modal on load, which makes the heading inert.
  await frame(page).locator('#preview-dialog').evaluate(element => (element as HTMLDialogElement).close());
  await expect(toggle).toBeFocused();
  await heading.click();
  await fontSize.fill('25');
  await save(page, projectId);
  const persisted = await request.get(`/api/projects/${projectId}/files/focus.html`);
  const saved = await persisted.text();
  expect(saved).toContain('Updated during direct edit');
  expect(saved).toContain('font-size: 25px');
  await page.screenshot({ path: testInfo.outputPath('chat-focus-preserved.png') });
});

for (const method of ['svg-focus', 'selection-range', 'inert-dialog'] as const) {
  test(`[P0] background ${method} keeps the composer focused and preserves intentional preview input`, async ({ page, request }, testInfo) => {
    const { projectId } = await createProject(request);
    await writeFile(request, projectId, 'focus-edge.html', '<!doctype html><html><body><h1>Before focus edge</h1></body></html>');
    await openFile(page, projectId, 'focus-edge.html');
    if (method === 'selection-range') await frame(page).locator('h1').click();
    const composer = page.getByTestId('chat-composer-input');
    await composer.fill('Draft caret');
    const markup = method === 'svg-focus'
      ? '<svg width="120" height="80"><rect id="svg-focus" tabindex="0" width="120" height="80" fill="#dbeafe"/></svg><script>document.getElementById("svg-focus").focus();</script>'
      : method === 'selection-range'
        ? '<div id="preview-selection" contenteditable="true">Preview selection</div><script>var range=document.createRange();range.selectNodeContents(document.getElementById("preview-selection"));var selection=getSelection();selection.removeAllRanges();selection.addRange(range);</script>'
        : '<dialog id="inert-preview" inert><input autofocus></dialog><script>document.getElementById("inert-preview").showModal();</script>';
    await writeFile(request, projectId, 'focus-edge.html', `<!doctype html><html><body><h1>After focus edge</h1>${markup}</body></html>`);
    await expect(frame(page).locator('h1')).toHaveText('After focus edge');
    await expect(composer).toBeFocused();
    await page.keyboard.insertText(' kept');
    await expect(composer).toHaveText('Draft caret kept');
    if (method === 'svg-focus') {
      const svg = frame(page).locator('#svg-focus');
      await svg.click();
      await expect(svg).toBeFocused();
    } else if (method === 'selection-range') {
      const editable = frame(page).locator('#preview-selection');
      await editable.click();
      await page.keyboard.press('Control+a');
      await page.keyboard.insertText('Intentional editing');
      await expect(editable).toHaveText('Intentional editing');
    } else await expect(frame(page).locator('#inert-preview')).toHaveAttribute('inert', '');
    await testInfo.attach('background-focus-method', { body: JSON.stringify({ method }), contentType: 'application/json' });
  });
}

test('[P1] Ctrl and CtrlShift resize retain the shape center', async ({ page, request }, testInfo) => {
  const { projectId } = await createProject(request);
  const observations = [];
  type ResizePacket = { type: string; resize?: { documentEpoch: string; targetId: string; transactionId: string; stage: string; announce: boolean; decision: string } };
  const resizePackets = (epoch: string) => page.evaluate(epochValue => ((window as typeof window & { directEditMessages?: ResizePacket[] }).directEditMessages ?? [])
    .filter(message => message.type === 'readable-edit-preview-style-applied' && message.resize?.documentEpoch === epochValue && message.resize.targetId === 'rectangle'), epoch);
  for (const variant of ['left', 'right', 'right-overflow', 'flex', 'translated', 'transformed', 'capped']) {
    // The capped parent is responsive: width release is preflighted down to a
    // 320px viewport, where a fixed 400px parent would make any growth past
    // ~242px overflow the viewport and be refused by design.
    const parent = variant === 'flex' ? 'display:flex;align-items:center;justify-content:center;' : variant === 'capped' ? 'padding:40px;box-sizing:border-box;text-align:center;max-width:100%;' : '';
    const child = variant === 'right' ? 'position:absolute;right:100px;top:100px;'
      : variant === 'right-overflow' ? 'position:absolute;right:20px;top:100px;'
      : variant === 'flex' ? 'flex-shrink:0;'
        : variant === 'translated' || variant === 'transformed' ? `position:absolute;left:100px;top:100px;translate:12px 6px;${variant === 'transformed' ? 'transform:scale(2);' : ''}`
          : variant === 'capped' ? 'display:inline-block;margin:0;max-width:200px;' : 'position:absolute;left:100px;top:100px;';
    const name = `center-${variant}.html`;
    await writeFile(request, projectId, name, `<!doctype html><html><body style="margin:0"><div style="position:relative;width:400px;height:350px;${parent}${variant === 'transformed' ? 'transform:scale(.8);transform-origin:0 0;' : ''}"><div data-readable-id="rectangle" style="${child}width:${variant === 'transformed' ? 100 : 200}px;height:${variant === 'transformed' ? 50 : 100}px;background:#88b4d7"></div></div></body></html>`);
    await openFile(page, projectId, name);
    await edit(page);
    const rectangle = frame(page).locator('[data-readable-id="rectangle"]');
    await preview(page).evaluate(element => {
      element.setAttribute('data-qa-loads', '0');
      element.addEventListener('load', () => element.setAttribute('data-qa-loads', String(Number(element.getAttribute('data-qa-loads')) + 1)));
    });
    await rectangle.click();
    const readEpoch = () => page.evaluate(() => (window as typeof window & { directEditTargetMessages: { lastEpoch: string } }).directEditTargetMessages.lastEpoch);
    await expect.poll(readEpoch).toContain(name);
    const epoch = await readEpoch();
    let expectedCenter: { centerX: number; centerY: number } | undefined;
    for (const constrain of [false, true]) {
      const before = await localRect(rectangle);
      expectedCenter = before;
      const previousTransactions = (await resizePackets(epoch)).map(message => message.resize!.transactionId);
      const inlineBefore = await rectangle.evaluate(element => Array.from((element as HTMLElement).style).map(property => [property, (element as HTMLElement).style.getPropertyValue(property), (element as HTMLElement).style.getPropertyPriority(property)]));
      const box = await page.locator('button[data-direction="se"]').boundingBox();
      expect(box).not.toBeNull();
      await page.keyboard.down('Control');
      if (constrain) await page.keyboard.down('Shift');
      try {
        await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
        await page.mouse.down();
        await page.mouse.move(box!.x + box!.width / 2 + 20, box!.y + box!.height / 2 + (constrain ? 2 : 10), { steps: 5 });
        await page.mouse.up();
      } finally {
        if (constrain) await page.keyboard.up('Shift');
        await page.keyboard.up('Control');
      }
      const currentFinal = async () => (await resizePackets(epoch)).filter(message => message.resize!.stage === 'finalize'
        && message.resize!.announce && !previousTransactions.includes(message.resize!.transactionId));
      await expect.poll(async () => (await currentFinal()).length).toBeGreaterThan(0);
      const final = (await currentFinal()).at(-1)!;
      if (variant === 'right-overflow' && constrain) {
        expect(final.resize!.decision).toBe('refused');
        const unchanged = await localRect(rectangle);
        expect(unchanged).toEqual(before);
        expect(await rectangle.evaluate(element => Array.from((element as HTMLElement).style).map(property => [property, (element as HTMLElement).style.getPropertyValue(property), (element as HTMLElement).style.getPropertyPriority(property)]))).toEqual(inlineBefore);
        observations.push({ variant, constrain, before, after: unchanged, final });
        continue;
      }
      expect(['ordinary', 'release-own']).toContain(final.resize!.decision);
      await expect.poll(async () => (await localRect(rectangle)).width).toBeGreaterThan(before.width);
      const after = await localRect(rectangle);
      expect(after.centerX).toBeCloseTo(before.centerX, 0);
      expect(after.centerY).toBeCloseTo(before.centerY, 0);
      if (constrain) expect(after.width / after.height).toBeCloseTo(before.width / before.height, 1);
      observations.push({ variant, constrain, before, after, final });
    }
    const inlineBeforeCancel = await rectangle.evaluate(element => ({ present: element.hasAttribute('style'),
      declarations: Array.from((element as HTMLElement).style).map(property => [property, (element as HTMLElement).style.getPropertyValue(property), (element as HTMLElement).style.getPropertyPriority(property)]) }));
    const cancelHandle = await page.locator('button[data-direction="se"]').boundingBox();
    await page.keyboard.down('Control');
    await page.mouse.move(cancelHandle!.x + cancelHandle!.width / 2, cancelHandle!.y + cancelHandle!.height / 2);
    await page.mouse.down();
    await page.mouse.move(cancelHandle!.x + cancelHandle!.width / 2 + 12, cancelHandle!.y + cancelHandle!.height / 2 + 6, { steps: 3 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.keyboard.up('Control');
    await expect.poll(() => rectangle.evaluate(element => ({ present: element.hasAttribute('style'),
      declarations: Array.from((element as HTMLElement).style).map(property => [property, (element as HTMLElement).style.getPropertyValue(property), (element as HTMLElement).style.getPropertyPriority(property)]) }))).toEqual(inlineBeforeCancel);
    await expect(preview(page)).toHaveAttribute('data-qa-loads', '0');
    await save(page, projectId);
    await page.reload();
    const reloaded = await localRect(frame(page).locator('[data-readable-id="rectangle"]'));
    expect(reloaded.centerX).toBeCloseTo(expectedCenter!.centerX, 0);
    expect(reloaded.centerY).toBeCloseTo(expectedCenter!.centerY, 0);
  }
  await page.screenshot({ path: testInfo.outputPath('centered-resize.png') });
  await testInfo.attach('resize-centers', { body: JSON.stringify(observations), contentType: 'application/json' });
});

test('[P0] legacy standalone edit scripts use the current host bridge without changing downloaded source', async ({ page, request }, testInfo) => {
  const { projectId } = await createProject(request);
  const script = 'window.legacyDirectEditBoots=(window.legacyDirectEditBoots||0)+1;';
  const seededScript = await request.post(`/api/projects/${projectId}/files`, { data: { name: 'assets/readable-direct-edit.js', content: script } });
  expect(seededScript.ok(), await seededScript.text()).toBe(true);
  const original = '<!doctype html><html><body><h1 data-readable-id="legacy-title">Legacy title</h1><script src="./assets/readable-direct-edit.js?old=1"></script></body></html>';
  await writeFile(request, projectId, 'legacy.html', original);
  await openFile(page, projectId, 'legacy.html');
  await edit(page);
  await expect.poll(() => frame(page).locator('html').evaluate(() => (window as typeof window & { legacyDirectEditBoots?: number }).legacyDirectEditBoots ?? 0)).toBe(0);
  const readEpoch = () => page.evaluate(() => (window as typeof window & { directEditTargetMessages?: { lastEpoch?: string } }).directEditTargetMessages?.lastEpoch);
  await expect.poll(readEpoch).toContain('legacy.html');
  const epoch = await readEpoch();
  const title = frame(page).locator('[data-readable-id="legacy-title"]');
  await title.dblclick();
  await expect(title).toHaveAttribute('contenteditable', 'true');
  await expect(title).toBeFocused();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' edited');
  await page.keyboard.press('Escape');
  await expect(title).toHaveText('Legacy title edited');
  await save(page, projectId);
  const response = await request.get(`/api/projects/${projectId}/files/legacy.html`);
  const persisted = await response.text();
  expect(persisted).toContain('Legacy title edited');
  expect(persisted).toContain('src="./assets/readable-direct-edit.js?old=1"');
  expect(persisted).not.toContain('application/x-readable-disabled-script');
  expect(persisted).not.toContain('data-readable-disabled-edit-bridge');
  const unchangedScript = await request.get(`/api/projects/${projectId}/files/assets/readable-direct-edit.js`);
  expect(await unchangedScript.text()).toBe(script);
  const standalone = await page.context().newPage();
  try {
    await standalone.goto(`/api/projects/${projectId}/raw/legacy.html`);
    await expect.poll(() => standalone.evaluate(() => (window as typeof window & { legacyDirectEditBoots?: number }).legacyDirectEditBoots)).toBe(1);
  } finally { await standalone.close(); }
  await testInfo.attach('legacy-bridge-source', { body: JSON.stringify({ epoch, persisted }), contentType: 'application/json' });
});

for (const authoredIds of [true, false]) {
  test(`[P1] a large ${authoredIds ? 'authored-ID' : 'path-only'} deck stays idle and edits without rebuilding`, async ({ page, request }, testInfo) => {
    await page.addInitScript(() => {
      if (window === window.top) return;
      const counts = { rect: 0, style: 0 };
      Object.assign(window, { directEditGeometryReads: counts });
      const marks: unknown[] = [];
      Object.assign(window, { directEditProfileMarks: marks });
      const mark = (stage: string, data?: { requestId?: number }) => marks.push({ stage, at: performance.timeOrigin + performance.now(), requestId: data?.requestId });
      document.addEventListener('keydown', event => { if (event.key === 'Escape') mark('escape'); }, true);
      window.addEventListener('message', event => { if (event.data?.type === 'readable-edit-preview-source') mark('sync-received', event.data); }, true);
      document.addEventListener('DOMContentLoaded', () => window.addEventListener('message', event => {
        if (event.data?.type === 'readable-edit-preview-source') mark('sync-handler-returned', event.data);
      }));
      const rect = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function () { counts.rect += 1; return rect.call(this); };
      const computed = window.getComputedStyle.bind(window);
      window.getComputedStyle = function (element, pseudo) { counts.style += 1; return computed(element, pseudo); };
    });
    const { projectId } = await createProject(request);
    const slides = Array.from({ length: 100 }, (_, index) => `<section class="slide${index === 0 ? ' active' : ''}">${Array.from({ length: 100 }, (_, cell) =>
      `<span class="cell"${authoredIds ? ` data-readable-id="cell-${index}-${cell}"` : ''}>Cell ${index}.${cell}</span>`).join('')}</section>`).join('');
    const html = `<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}.slide{position:absolute;inset:0;display:none;grid-template-columns:repeat(10,1fr);grid-template-rows:repeat(10,1fr)}.slide.active{display:grid}.cell{font:12px Arial;overflow:hidden;background:#eef2ff}</style></head><body>${slides}<script>(function(){var slides=Array.from(document.querySelectorAll('.slide')),index=0;function go(next){index=Math.max(0,Math.min(slides.length-1,next));slides.forEach(function(slide,i){slide.classList.toggle('active',i===index);});}window.addEventListener('keydown',function(event){if(event.target.isContentEditable)return;if(event.key==='ArrowRight')go(index+1);if(event.key==='ArrowLeft')go(index-1);});})();</script></body></html>`;
    await writeFile(request, projectId, 'large-deck.html', html, 'deck');
    await openFile(page, projectId, 'large-deck.html');
    await page.getByLabel('Next slide', { exact: true }).click();
    const target = frame(page).locator('.slide.active .cell').first();
    await expect(target).toHaveText('Cell 1.0');
    await edit(page);
    await target.click();
    await expect(target).toHaveAttribute('data-readable-edit-selected', 'true');
    const cdp = await page.context().newCDPSession(page);
    const cpuRate = authoredIds ? 1 : 6;
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
    const profilers: Array<{ name: string; session: typeof cdp }> = [];
    try {
      const counts = () => page.evaluate(() => (window as typeof window & { directEditTargetMessages: { count: number } }).directEditTargetMessages.count);
      await expect.poll(async () => {
        const before = await counts();
        await page.waitForTimeout(100);
        return await counts() - before;
      }, { timeout: T.long }).toBe(0);
      const before = { targets: await counts(), geometry: await target.evaluate(() => (window as typeof window & { directEditGeometryReads: { rect: number; style: number } }).directEditGeometryReads) };
      const intervalMs = 1500;
      await page.waitForTimeout(intervalMs);
      const after = { targets: await counts(), geometry: await target.evaluate(() => (window as typeof window & { directEditGeometryReads: { rect: number; style: number } }).directEditGeometryReads) };
      expect(after.targets - before.targets).toBe(0);
      await preview(page).evaluate(element => {
        element.setAttribute('data-qa-loads', '0');
        element.addEventListener('load', () => element.setAttribute('data-qa-loads', String(Number(element.getAttribute('data-qa-loads')) + 1)));
      });
      const original = await target.innerText();
      if (!authoredIds && process.env.READABLE_DIRECT_EDIT_PROFILE === '1') {
        const hostInfo = await cdp.send('Target.getTargetInfo');
        profilers.push({ name: 'host', session: cdp });
        const child = await (await preview(page).elementHandle())?.contentFrame();
        if (child) {
          const childSession = await page.context().newCDPSession(child).catch(() => null);
          if (childSession) {
            const childInfo = await childSession.send('Target.getTargetInfo');
            if (childInfo.targetInfo.targetId !== hostInfo.targetInfo.targetId) profilers.push({ name: 'iframe', session: childSession });
            else await childSession.detach();
          }
        }
        for (const profiler of profilers) {
          await profiler.session.send('Profiler.enable');
          await profiler.session.send('Profiler.setSamplingInterval', { interval: 1000 });
          await profiler.session.send('Profiler.start');
        }
        await testInfo.attach('profiler-targets', { body: JSON.stringify({ hostInfo, targets: profilers.map(value => value.name) }), contentType: 'application/json' });
      }
      await target.dblclick();
      await expect(target).toHaveAttribute('contenteditable', 'true');
      await expect(target).toBeFocused();
      await page.keyboard.press('Control+End');
      await page.keyboard.insertText(' edited');
      const acknowledgements = () => page.evaluate(() => (window as typeof window & { directEditMessages: Array<{ type: string; ok?: boolean }> }).directEditMessages.filter(message => message.type === 'readable-edit-preview-source-applied' && message.ok).length);
      const previous = await acknowledgements();
      const startedAt = performance.now();
      await page.keyboard.press('Escape');
      await expect.poll(acknowledgements, { timeout: T.long }).toBeGreaterThan(previous);
      const editMs = performance.now() - startedAt;
      await expect(target).toHaveText(`${original} edited`);
      const undoStartedAt = performance.now();
      await page.keyboard.press('Control+z');
      await expect(target).toHaveText(original, { timeout: T.long });
      const undoMs = performance.now() - undoStartedAt;
      await expect(preview(page)).toHaveAttribute('data-qa-loads', '0');
      await testInfo.attach('large-deck-measurement', { body: JSON.stringify({ authoredIds, slides: 100, textNodes: 10000, cpuRate, intervalMs, before, after, editMs, undoMs,
        boundary: 'Headless Chromium CPU throttle is a simulation; network-drive VDI and 6GiB hardware are not measured.' }), contentType: 'application/json' });
    } finally {
      for (const profiler of profilers) {
        const result = await profiler.session.send('Profiler.stop').catch(error => ({ error: String(error) }));
        const path = testInfo.outputPath(`cpu-${profiler.name}.cpuprofile`);
        writeFileSync(path, JSON.stringify('profile' in result ? result.profile : result));
        await testInfo.attach(`cpu-${profiler.name}`, { path, contentType: 'application/json' });
        if (profiler.session !== cdp) await profiler.session.detach();
      }
      const marks = await target.evaluate(() => (window as typeof window & { directEditProfileMarks?: unknown[] }).directEditProfileMarks ?? []).catch(() => []);
      await testInfo.attach('profile-pipeline-marks', { body: JSON.stringify(marks), contentType: 'application/json' });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      await cdp.detach();
    }
  });
}

async function renderedGlyph(target: Locator, needle: string, offset: number) {
  const point = await target.evaluate((element, value) => {
    let remaining = (element.textContent ?? '').indexOf(value.needle) + value.offset;
    if (remaining < 0) throw new Error('Expected text was not rendered');
    const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0;
      if (remaining >= length) { remaining -= length; continue; }
      const range = element.ownerDocument.createRange();
      range.setStart(node, remaining); range.setEnd(node, remaining + 1);
      const glyph = range.getBoundingClientRect();
      const root = element.getBoundingClientRect();
      return { x: glyph.x - root.x + glyph.width / 4, y: glyph.y - root.y + glyph.height / 2,
        width: root.width, height: root.height };
    }
    throw new Error('Expected glyph has no text node');
  }, { needle, offset });
  const box = await target.boundingBox();
  if (!box) throw new Error('Text object is not visible');
  return { x: box.x + point.x * box.width / point.width, y: box.y + point.y * box.height / point.height };
}

test('[P0] text interior clicks place the caret, double clicks replace one word, and border drags move', async ({ page, request }, testInfo) => {
  const { projectId } = await createProject(request);
  await writeFile(request, projectId, 'mouse-text.html', '<!doctype html><html><head><style>.copy{position:absolute;left:40px;top:100px;width:360px;height:100px;padding:20px;box-sizing:border-box;border:1px solid #8fa4bd;background:#eef2ff;font:20px/30px monospace}</style></head><body style="margin:0"><div class="copy" data-readable-id="copy">Alpha Bravo Charlie</div></body></html>');
  await openFile(page, projectId, 'mouse-text.html');
  await edit(page);
  await preview(page).evaluate(element => {
    element.setAttribute('data-qa-loads', '0');
    element.addEventListener('load', () => element.setAttribute('data-qa-loads', String(Number(element.getAttribute('data-qa-loads')) + 1)));
  });
  const copy = frame(page).locator('[data-readable-id="copy"]');
  const box = await copy.boundingBox();
  if (!box) throw new Error('Text object is not visible');
  await page.mouse.click(box.x + box.width / 4, box.y + 3);
  await expect(copy).toHaveAttribute('data-readable-edit-selected', 'true');
  await expect(copy).not.toHaveAttribute('contenteditable');
  await page.keyboard.press('F2');
  await expect(copy).toHaveAttribute('contenteditable', 'true');
  expect(await copy.evaluate(() => getSelection()?.toString())).toBe('Alpha Bravo Charlie');
  await page.keyboard.press('Escape');
  await expect(copy).not.toHaveAttribute('contenteditable');
  const caret = await renderedGlyph(copy, 'Bravo', 2);
  await page.mouse.click(caret.x, caret.y);
  await expect(copy).toHaveAttribute('contenteditable', 'true');
  const collapsed = await copy.evaluate(() => ({ offset: getSelection()?.anchorOffset, selected: getSelection()?.toString() }));
  expect(collapsed).toEqual({ offset: 8, selected: '' });
  await page.keyboard.insertText('!');
  await expect(copy).toHaveText('Alpha Br!avo Charlie');
  await page.keyboard.press('Escape');
  const word = await renderedGlyph(copy, 'Charlie', 2);
  await page.mouse.dblclick(word.x, word.y);
  await expect(copy).toHaveAttribute('contenteditable', 'true');
  expect(await copy.evaluate(() => getSelection()?.toString())).toBe('Charlie');
  await page.keyboard.insertText('Delta');
  await expect(copy).toHaveText('Alpha Br!avo Delta');
  await page.keyboard.press('Escape');
  const beforeDrag = await localRect(copy);
  const dragBox = await copy.boundingBox();
  await page.mouse.move(dragBox!.x + dragBox!.width / 4, dragBox!.y + 3);
  await page.mouse.down();
  await page.mouse.move(dragBox!.x + dragBox!.width / 4 + 37, dragBox!.y + 26, { steps: 4 });
  await page.mouse.up();
  await expect(copy).not.toHaveAttribute('contenteditable');
  await expect.poll(async () => (await localRect(copy)).x).toBeCloseTo(beforeDrag.x + 37, 0);
  const afterDrag = await localRect(copy);
  expect(afterDrag.y).toBeCloseTo(beforeDrag.y + 23, 0);
  await expect(copy).toHaveText('Alpha Br!avo Delta');
  await expect(preview(page)).toHaveAttribute('data-qa-loads', '0');
  await save(page, projectId);
  const persisted = await request.get(`/api/projects/${projectId}/files/mouse-text.html`);
  expect(await persisted.text()).toContain('Alpha Br!avo Delta');
  await edit(page);
  const previewBox = await preview(page).boundingBox();
  expect(previewBox).not.toBeNull();
  await page.mouse.click(previewBox!.x + 5, previewBox!.y + 5);
  await expect(copy).not.toHaveAttribute('data-readable-edit-selected');
  const selectionStart = await renderedGlyph(copy, 'Alpha ', 0);
  const selectionEnd = await renderedGlyph(copy, 'Alpha ', 5);
  await page.mouse.move(selectionStart.x, selectionStart.y);
  await page.mouse.down();
  await page.mouse.move(selectionEnd.x, selectionEnd.y, { steps: 6 });
  await page.mouse.up();
  await expect(copy).toHaveAttribute('contenteditable', 'true');
  expect(await copy.evaluate(() => getSelection()?.toString())).toBe('Alpha');
  await page.keyboard.insertText('First');
  await expect(copy).toHaveText('First Br!avo Delta');
  await testInfo.attach('mouse-text-semantics', { body: JSON.stringify({ collapsed, beforeDrag, afterDrag }), contentType: 'application/json' });
});
