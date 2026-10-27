import { expect, test, type Frame, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { T } from '@/timeouts';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const mode = process.env.READABLE_RICHTEXT_BASELINE === '1' ? 'baseline' : 'current';
const require = createRequire(import.meta.url);
// tsx already owns the installed bundler; this browser-only harness adds no dependency.
const { build } = createRequire(require.resolve('tsx/package.json'))('esbuild');
const sourcePaths = ['bridge.ts', 'source-patches.ts'].map((name) => resolve(workspace, 'apps/web/src/edit-mode', name));
const sourceOverrides = new Map(sourcePaths.map((path) => [path, readFileSync(mode === 'baseline'
  ? resolve(workspace, '.omo/evidence/direct-edit-repair/20261027/text', path.endsWith('bridge.ts') ? 'bridge.baseline.ts' : 'source-patches.baseline.ts')
  : path, 'utf8')]));
if (mode === 'current') {
  const formatterPath = resolve(workspace, 'apps/web/src/edit-mode/rich-text-formatting.ts');
  sourceOverrides.set(formatterPath, readFileSync(formatterPath, 'utf8'));
  const srcdocPath = resolve(workspace, 'apps/web/src/runtime/srcdoc.ts');
  sourceOverrides.set(srcdocPath, readFileSync(srcdocPath, 'utf8'));
}
let browserBundle: string;
test.beforeAll(async () => {
  const result = await build({
  stdin: {
    contents: `import { buildManualEditBridge } from ${JSON.stringify(sourcePaths[0])};
      import { applyManualEditPatch } from ${JSON.stringify(sourcePaths[1])};
      import { buildSrcdoc } from ${JSON.stringify(resolve(workspace, 'apps/web/src/runtime/srcdoc.ts'))};
      window.richTextHarness = { buildManualEditBridge, applyManualEditPatch, buildSrcdoc };`,
    resolveDir: workspace, loader: 'ts',
  },
  bundle: true, write: false, platform: 'browser', format: 'iife',
  plugins: [{
    name: 'frozen-richtext-inputs',
    setup(build: { onLoad: (options: { filter: RegExp }, callback: (args: { path: string }) => unknown) => void }) {
      build.onLoad({ filter: /(?:bridge|source-patches|rich-text-formatting|srcdoc)\.ts$/ }, ({ path }) => {
        const contents = sourceOverrides.get(resolve(path));
        return contents === undefined ? undefined : { contents, loader: 'ts', resolveDir: dirname(path) };
      });
    },
  }],
  });
  browserBundle = result.outputFiles[0].text;
});

const sourceHashes = [...sourceOverrides].map(([path, content]) => ({ path, sha256: createHash('sha256').update(content).digest('hex') }));
type RunStyle = { text: string; size: string; weight: string; style: string; decoration: string; family: string; color: string; spacing: string; lineHeight: string };
type Snapshot = { text: string; html: string; editing: boolean; selection: string; runs: RunStyle[]; sibling: string };

function source(tag: string, copySize = '24px', parentSize = '64px'): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:32px;font-family:Arial,sans-serif}.shape{--copy-size:24px;display:block;width:1100px;font-size:${parentSize};font-weight:700;line-height:1.5}
    .shape b{font-size:${copySize};font-weight:400;font-family:Georgia;color:blue;letter-spacing:.1em;line-height:1.25}.shape i{font-size:20px;font-style:normal;font-weight:400;color:red}
    #sibling{font-size:18px;font-weight:400}
    </style></head><body><${tag} class="shape" data-readable-id="shape"><b>제 1막, OO를 OO합니다. 다음 문장</b><i>설명</i></${tag}>
    <p id="sibling" data-readable-id="sibling">이웃의 텍스트는 그대로</p></body></html>`;
}

async function load(page: Page, canonical: string, bridge = true, projectSourcePaths = false): Promise<void> {
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: browserBundle });
  const rendered = await page.evaluate(({ canonical, bridge, projectSourcePaths }) => {
    const runtime = (window as unknown as { richTextHarness: { buildManualEditBridge: (enabled: boolean) => string; buildSrcdoc: (source: string, options: { editBridge: boolean }) => string } }).richTextHarness;
    if (!bridge) return canonical;
    if (projectSourcePaths) return runtime.buildSrcdoc(canonical, { editBridge: true });
    const script = runtime.buildManualEditBridge(true);
    return canonical.includes('</body>') ? canonical.replace('</body>', `${script}</body>`) : `${canonical}${script}`;
  }, { canonical, bridge, projectSourcePaths });
  await page.setContent(rendered);
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate(() => {
    const state = window as unknown as { richTextMessages: { type: string; html?: string; value?: string }[] };
    state.richTextMessages = [];
    window.addEventListener('message', (event) => state.richTextMessages.push(event.data));
    window.postMessage({ type: 'readable-edit-mode', enabled: true, documentEpoch: 'font-browser' }, '*');
  });
  await expect(page.locator('.shape')).toBeVisible();
}

async function editAt(page: Page | Frame, match: string, offset: 'start' | 'end' | 'period' = 'end', id = 'shape'): Promise<void> {
  await page.evaluate((id) => window.postMessage({ type: 'readable-edit-begin-text-edit', id }, '*'), id);
  await expect(page.locator('.shape')).toHaveAttribute('contenteditable', 'true');
  await page.evaluate(({ match, offset }) => {
    const root = document.querySelector('.shape')!;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (!(node.textContent ?? '').includes(match)) continue;
      const text = node.textContent ?? '';
      const range = document.createRange();
      range.setStart(node, offset === 'start' ? 0 : offset === 'period' ? text.indexOf('.') + 1 : text.length);
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges(); selection.addRange(range);
      (root as HTMLElement).focus();
      return;
    }
    throw new Error(`Missing text run: ${match}`);
  }, { match, offset });
}

async function snapshot(page: Page | Frame): Promise<Snapshot> {
  return page.evaluate(() => {
    const root = document.querySelector('.shape') as HTMLElement;
    const runs: RunStyle[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.textContent ?? '';
      if (!text.trim()) continue;
      const style = getComputedStyle(node.parentElement!);
      runs.push({ text, size: style.fontSize, weight: style.fontWeight, style: style.fontStyle, decoration: style.textDecorationLine,
        family: style.fontFamily, color: style.color, spacing: style.letterSpacing, lineHeight: style.lineHeight });
    }
    return { text: root.innerText, html: root.innerHTML, editing: root.isContentEditable, selection: window.getSelection()?.toString() ?? '', runs,
      sibling: document.querySelector('#sibling')!.outerHTML };
  });
}

async function canonicalCommit(page: Page, canonical: string, id = 'shape'): Promise<string> {
  if (await page.locator('.shape').evaluate((node) => (node as HTMLElement).isContentEditable)) {
    await page.keyboard.press('Escape');
  }
  await expect.poll(() => page.evaluate(() => (window as unknown as { richTextMessages: { type: string }[] }).richTextMessages
    .filter((message) => message.type === 'readable-edit-html-commit' || message.type === 'readable-edit-text-commit').length), { timeout: T.short }).toBe(1);
  return page.evaluate(({ canonical, id }) => {
    const state = window as unknown as {
      richTextMessages: { type: string; html?: string; value?: string }[];
      richTextHarness: { applyManualEditPatch: (source: string, patch: unknown) => { ok: boolean; source: string; error?: string } };
    };
    const message = state.richTextMessages.find((item) => item.type === 'readable-edit-html-commit' || item.type === 'readable-edit-text-commit')!;
    const patch = message.type === 'readable-edit-html-commit'
      ? { id, kind: 'set-inner-html', html: message.html }
      : { id, kind: 'set-text', value: message.value };
    const result = state.richTextHarness.applyManualEditPatch(canonical, patch);
    if (!result.ok) throw new Error(result.error);
    return result.source;
  }, { canonical, id });
}

for (const tag of ['h1', 'p', 'span', 'div']) {
  test(`[P0] ${tag} Enter preserves mixed typography through canonical reload`, async ({ page }, testInfo) => {
    const canonical = source(tag);
    await load(page, canonical);
    const before = await snapshot(page);
    await editAt(page, '제 1막', 'period');
    await page.keyboard.type('X');
    await page.keyboard.press('Enter');
    const afterEnter = await snapshot(page);
    const persisted = await canonicalCommit(page, canonical);
    await load(page, persisted, false);
    const reloaded = await snapshot(page);
    await testInfo.attach(`${mode}-${tag}.json`, { body: JSON.stringify({ sourceHashes, before, afterEnter, reloaded, persisted }, null, 2), contentType: 'application/json' });
    await testInfo.attach(`${mode}-${tag}.png`, { body: await page.screenshot(), contentType: 'image/png' });
    expect.soft(afterEnter.editing).toBe(true);
    expect.soft(afterEnter.text).toContain('\n');
    expect.soft(reloaded.text).toContain('제 1막, OO를 OO합니다.X');
    expect.soft(reloaded.text).toContain('다음 문장');
    expect.soft(reloaded.text).toContain('설명');
    expect.soft(reloaded.sibling).toBe(before.sibling);
    expect.soft(reloaded.runs.filter((run) => run.text.includes('제 1막'))).toMatchObject([{ size: '24px', weight: '400' }]);
    expect.soft(reloaded.runs.filter((run) => run.text.includes('다음 문장'))).toMatchObject([{ size: '24px', weight: '400' }]);
    expect.soft(reloaded.runs.filter((run) => run.text.includes('설명'))).toMatchObject([{ size: '20px', style: 'normal', weight: '400' }]);
    expect(reloaded.text).toBe(afterEnter.text);
  });
}

test('[P1] Ctrl+B/I/U formats selected text without inheriting template tag typography', async ({ page }, testInfo) => {
  const canonical = source('div');
  await load(page, canonical);
  await editAt(page, '제 1막');
  await page.evaluate(() => {
    const copy = document.querySelector('[data-readable-id="shape"] b')!;
    const range = document.createRange(); range.selectNodeContents(copy);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  });
  await page.keyboard.press('Control+b');
  await page.keyboard.press('Control+i');
  await page.keyboard.press('Control+u');
  const formatted = await snapshot(page);
  const persisted = await canonicalCommit(page, canonical);
  await load(page, persisted, false);
  const reloaded = await snapshot(page);
  await testInfo.attach(`${mode}-format.json`, { body: JSON.stringify({ sourceHashes, formatted, reloaded, persisted }, null, 2), contentType: 'application/json' });
  expect(formatted.runs[0]).toMatchObject({ size: '24px', weight: '700', style: 'italic', decoration: 'underline', family: 'Georgia', color: 'rgb(0, 0, 255)', spacing: '2.4px', lineHeight: '30px' });
  expect(reloaded.runs).toEqual(formatted.runs);
});

for (const copySize of ['1.5em', 'clamp(18px, var(--copy-size), 48px)']) {
  test(`[P1] ${copySize} formatting keeps authored values and native Undo selection`, async ({ page }, testInfo) => {
    const canonical = source('div', copySize, '16px').replace('<b>', '<b data-readable-id="run">').replace('<i>', '<i data-readable-id="note">');
    await load(page, canonical);
    await editAt(page, '제 1막');
    await page.keyboard.type('X');
    await page.evaluate(() => {
      const range = document.createRange(); range.selectNodeContents(document.querySelector('[data-readable-id="run"]')!);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    });
    const before = await snapshot(page);
    for (const key of ['Control+b', 'Control+i', 'Control+u']) await page.keyboard.press(key);
    const formatted = await snapshot(page);
    for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z');
    const undone = await snapshot(page);
    expect.soft(undone.text).toBe(before.text);
    expect.soft(undone.selection).toBe(before.selection);
    expect.soft(undone.runs[0]).toMatchObject({ size: '24px', weight: '400', family: 'Georgia', color: 'rgb(0, 0, 255)', spacing: '2.4px', lineHeight: '30px' });
    for (let i = 0; i < 3; i++) await page.keyboard.press('Control+y');
    const redone = await snapshot(page);
    expect.soft(redone.runs).toEqual(formatted.runs);
    expect.soft(redone.runs[0]).toMatchObject({ size: '24px', weight: '700', style: 'italic', decoration: 'underline', family: 'Georgia', color: 'rgb(0, 0, 255)', spacing: '2.4px', lineHeight: '30px' });
    expect.soft(redone.runs.find((run) => run.text.includes('설명'))).toEqual(before.runs.find((run) => run.text.includes('설명')));
    await expect(page.locator('[data-readable-id="run"]')).toHaveCount(1);
    await expect(page.locator('[data-readable-id="note"]')).toHaveCount(1);
    const persisted = await canonicalCommit(page, canonical);
    await load(page, persisted, false);
    const reloaded = await snapshot(page);
    expect.soft(reloaded.runs).toEqual(redone.runs);
    await page.evaluate(() => {
      const root = document.querySelector('[data-readable-id="shape"]') as HTMLElement;
      root.style.fontSize = '20px'; root.style.setProperty('--copy-size', '30px');
    });
    const responsive = await snapshot(page);
    await testInfo.attach(`${mode}-${copySize.startsWith('clamp') ? 'clamp' : 'em'}-undo.json`, {
      body: JSON.stringify({ sourceHashes, before, formatted, undone, redone, persisted, reloaded, responsive }, null, 2), contentType: 'application/json',
    });
    expect(responsive.runs[0]).toMatchObject({ size: '30px', spacing: '3px', lineHeight: '37.5px' });
  });
}

test('[P1] linked CSS imports and media preserve responsive typography after formatting', async ({ page }, testInfo) => {
  const styles: Record<string, string> = {
    '/type.css': '.shape b{font-size:1.5em;font-weight:400;font-family:Georgia;color:blue;letter-spacing:.1em;line-height:1.25}',
    '/styles.css': '@import url("/type.css"); @media (min-width:700px){.shape b{font-size:clamp(18px,var(--copy-size),48px)}}',
  };
  const server = createServer((request, response) => {
    const css = styles[request.url ?? ''];
    response.setHeader('Content-Type', css === undefined ? 'text/html' : 'text/css');
    response.end(css ?? '<!doctype html><html><body></body></html>');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await page.goto(origin);
    const canonical = source('div', '24px', '16px')
      .replace('font-family:Georgia;color:blue;letter-spacing:.1em;line-height:1.25', '')
      .replace('<b>', '<b data-readable-id="run">')
      .replace('</head>', '<link rel="stylesheet" href="/styles.css"></head>');
    await load(page, canonical);
    const rules = await page.evaluate(() => [...document.styleSheets].map((sheet) => ({ href: sheet.href, count: sheet.cssRules.length })));
    expect(rules.find((sheet) => sheet.href?.endsWith('/styles.css'))?.count).toBe(2);
    await editAt(page, '제 1막');
    await page.evaluate(() => {
      const range = document.createRange(); range.selectNodeContents(document.querySelector('[data-readable-id="run"]')!);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    });
    const before = await snapshot(page);
    await page.keyboard.press('Control+b');
    const formatted = await snapshot(page);
    expect.soft(formatted.runs[0]).toMatchObject({ size: '24px', weight: '700', family: 'Georgia', color: 'rgb(0, 0, 255)', spacing: '2.4px', lineHeight: '30px' });
    const persisted = await canonicalCommit(page, canonical);
    await load(page, persisted, false);
    const reloaded = await snapshot(page);
    expect.soft(reloaded.runs).toEqual(formatted.runs);
    await page.evaluate(() => {
      const root = document.querySelector('[data-readable-id="shape"]') as HTMLElement;
      root.style.fontSize = '20px'; root.style.setProperty('--copy-size', '30px');
    });
    const responsive = await snapshot(page);
    await testInfo.attach(`${mode}-linked-css.json`, {
      body: JSON.stringify({ sourceHashes, rules, before, formatted, reloaded, responsive, persisted }, null, 2), contentType: 'application/json',
    });
    expect(responsive.runs[0]).toMatchObject({ size: '30px', spacing: '3px', lineHeight: '37.5px' });
  } finally {
    const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  }
});

test('[P0] opaque CSS preserves wrappers, media and precise native history selection', async ({ page }, testInfo) => {
  const styles: Record<string, string> = {
    '/type.css': '.shape{font:700 16px Arial}.shape>b{font-size:1.5em;font-weight:400;color:blue}.shape>i{font-size:20px;font-style:normal;font-weight:400;color:red}.shape span{font-size:40px!important;color:purple!important}',
    '/base.css': '@import url("/type.css");@media(min-width:801px){.shape>b{font-size:2em}}',
  };
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/css');
    response.end(styles[request.url ?? ''] ?? '');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const canonical = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${origin}/base.css"></head><body>
      <div class="shape" data-readable-id="shape"><span data-readable-id="prior">이전 </span><b data-readable-id="copy">앞 중간 뒤<br></b><i data-readable-id="detail">설명</i></div>
      <p id="sibling" data-readable-id="sibling">이웃의 텍스트는 그대로</p></body></html>`;
    await page.setContent('<!doctype html><html><body><input id="chat"><iframe sandbox="allow-scripts" style="width:700px;height:500px"></iframe></body></html>');
    await page.addScriptTag({ content: browserBundle });
    await page.evaluate((canonical) => {
      const runtime = window as unknown as {
        richTextHarness: { buildManualEditBridge: (enabled: boolean) => string };
        richTextMessages: { type: string; html?: string; value?: string }[];
      };
      runtime.richTextMessages = [];
      window.addEventListener('message', (event) => runtime.richTextMessages.push(event.data));
      (document.querySelector('iframe') as HTMLIFrameElement).srcdoc = canonical.replace('</body>', `${runtime.richTextHarness.buildManualEditBridge(true)}</body>`);
    }, canonical);
    const frame = page.frames().find((candidate) => candidate.parentFrame())!;
    await expect(frame.locator('[data-readable-id="copy"]')).toHaveCSS('font-size', '24px');
    const cssAccess = await frame.evaluate(() => [...document.styleSheets].map((sheet) => {
      try { return { href: sheet.href, readable: true, rules: sheet.cssRules.length, error: '' }; }
      catch (error) { return { href: sheet.href, readable: false, rules: 0, error: (error as Error).name }; }
    }));
    expect(cssAccess).toMatchObject([{ readable: false, error: 'SecurityError' }]);
    await page.evaluate(() => {
      const target = (document.querySelector('iframe') as HTMLIFrameElement).contentWindow!;
      target.postMessage({ type: 'readable-edit-mode', enabled: true, documentEpoch: 'opaque-font-browser' }, '*');
      target.postMessage({ type: 'readable-edit-begin-text-edit', id: 'shape' }, '*');
    });
    await expect(frame.locator('[data-readable-id="shape"]')).toHaveAttribute('contenteditable', 'true');
    async function select(id: string, backward = false, caret = false): Promise<void> {
      await frame.evaluate(({ id, backward, caret }) => {
        const root = document.querySelector('[data-readable-id="shape"]') as HTMLElement;
        root.focus();
        const range = document.createRange(); range.selectNodeContents(root.querySelector(`[data-readable-id="${id}"]`)!);
        if (caret) range.collapse(false);
        const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
        if (backward) selection.setBaseAndExtent(range.endContainer, range.endOffset, range.startContainer, range.startOffset);
      }, { id, backward, caret });
    }
    async function selectionState() {
      return frame.evaluate(() => {
        const selection = window.getSelection()!;
        const anchor = document.createRange(); anchor.setStart(selection.anchorNode!, selection.anchorOffset); anchor.collapse(true);
        const focus = document.createRange(); focus.setStart(selection.focusNode!, selection.focusOffset); focus.collapse(true);
        const ids = [...document.querySelectorAll('[data-readable-id="shape"] [data-readable-id]')].map((element) => element.getAttribute('data-readable-id'));
        return {
          collapsed: selection.isCollapsed,
          backward: anchor.compareBoundaryPoints(Range.START_TO_START, focus) > 0,
          selectedBreaks: selection.rangeCount ? selection.getRangeAt(0).cloneContents().querySelectorAll('br').length : 0,
          anchorOwner: selection.anchorNode?.parentElement?.closest('[data-readable-id]')?.getAttribute('data-readable-id'),
          uniqueIds: new Set(ids).size === ids.length,
        };
      });
    }
    await select('prior', false, true);
    await page.keyboard.type('X');
    await select('copy', true);
    const before = await snapshot(frame);
    const originalSelection = await selectionState();
    expect(originalSelection).toMatchObject({ backward: true, selectedBreaks: 1, uniqueIds: true });
    for (const key of ['Control+b', 'Control+i', 'Control+u']) await page.keyboard.press(key);
    const formatted = await snapshot(frame);
    expect.soft(formatted.runs.find((run) => run.text.includes('앞 중간 뒤'))).toMatchObject({ size: '24px', weight: '700', style: 'italic', decoration: 'underline', color: 'rgb(0, 0, 255)' });
    expect.soft(formatted.runs.find((run) => run.text.includes('설명'))).toEqual(before.runs.find((run) => run.text.includes('설명')));
    expect.soft(formatted.runs.find((run) => run.text.includes('이전'))).toEqual(before.runs.find((run) => run.text.includes('이전')));
    await expect(frame.locator('b[data-readable-id="copy"]')).toHaveCount(1);
    await page.locator('iframe').evaluate((iframe) => { (iframe as HTMLIFrameElement).style.width = '900px'; });
    await expect(frame.locator('[data-readable-id="copy"]')).toHaveCSS('font-size', '32px');
    const responsive = await snapshot(frame);
    expect.soft(responsive.runs.find((run) => run.text.includes('앞 중간 뒤'))).toMatchObject({ size: '32px', weight: '700', color: 'rgb(0, 0, 255)' });
    await select('detail', false, true);
    await page.keyboard.type('Z');
    await page.keyboard.press('Control+z');
    const unrelatedUndo = await snapshot(frame);
    const unrelatedSelection = await selectionState();
    expect.soft(unrelatedUndo.text).toBe(before.text);
    expect.soft(unrelatedSelection).toMatchObject({ collapsed: true, anchorOwner: 'detail', uniqueIds: true });
    for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z');
    const undone = await snapshot(frame);
    const undoneSelection = await selectionState();
    expect.soft(undone.text).toBe(before.text);
    expect.soft(undone.selection).toBe(before.selection);
    expect.soft(undoneSelection).toMatchObject({ backward: true, selectedBreaks: 1, uniqueIds: true });
    expect.soft(undone.runs.find((run) => run.text.includes('앞 중간 뒤'))).toMatchObject({ size: '32px', weight: '400', style: 'normal', color: 'rgb(0, 0, 255)' });
    for (let i = 0; i < 3; i++) await page.keyboard.press('Control+y');
    const redone = await snapshot(frame);
    expect.soft(await selectionState()).toMatchObject({ backward: true, selectedBreaks: 1, uniqueIds: true });
    expect.soft(redone.runs.find((run) => run.text.includes('앞 중간 뒤'))).toMatchObject({ size: '32px', weight: '700', style: 'italic', decoration: 'underline', color: 'rgb(0, 0, 255)' });
    await testInfo.attach(`${mode}-opaque-before-typing.json`, {
      body: JSON.stringify({ sourceHashes, cssAccess, before, originalSelection, formatted, responsive, unrelatedUndo, unrelatedSelection,
        undone, undoneSelection, redone }, null, 2), contentType: 'application/json',
    });
    await page.keyboard.press('Control+z');
    // Native boundary affinity has a separate control; move into the restored text run.
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowRight');
    expect.soft((await selectionState()).collapsed).toBe(true);
    expect.soft((await selectionState()).anchorOwner).toBe('copy');
    await page.keyboard.type('Q');
    const typedAfterUndo = await snapshot(frame);
    expect.soft(await frame.locator('[data-readable-id="prior"]').textContent()).toBe('이전 X');
    expect.soft(await frame.locator('[data-readable-id="detail"]').textContent()).toBe('설명');
    expect.soft(await frame.locator('[data-readable-id="copy"]').textContent()).toBe('앞Q 중간 뒤');
    expect.soft(await frame.locator('[data-readable-id="copy"] br').count()).toBe(1);
    expect.soft(typedAfterUndo.runs.find((run) => run.text.startsWith('앞Q'))).toMatchObject({ size: '32px', color: 'rgb(0, 0, 255)' });
    expect.soft((await selectionState()).uniqueIds).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => (window as unknown as { richTextMessages: { type: string }[] }).richTextMessages
      .filter((message) => message.type === 'readable-edit-html-commit').length), { timeout: T.short }).toBe(1);
    const persisted = await page.evaluate((canonical) => {
      const runtime = window as unknown as {
        richTextMessages: { type: string; html?: string }[];
        richTextHarness: { applyManualEditPatch: (source: string, patch: unknown) => { ok: boolean; source: string; error?: string } };
      };
      const message = runtime.richTextMessages.find((message) => message.type === 'readable-edit-html-commit')!;
      const result = runtime.richTextHarness.applyManualEditPatch(canonical, { id: 'shape', kind: 'set-inner-html', html: message.html });
      if (!result.ok) throw new Error(result.error);
      (document.querySelector('iframe') as HTMLIFrameElement).srcdoc = result.source;
      return result.source;
    }, canonical);
    await expect(frame.locator('b[data-readable-id="copy"]')).toHaveText('앞Q 중간 뒤');
    await expect(frame.locator('[data-readable-id="copy"]')).toHaveCSS('font-size', '32px');
    const reloaded = await snapshot(frame);
    expect.soft(reloaded.runs).toEqual(typedAfterUndo.runs);
    expect.soft(reloaded.sibling).toBe(before.sibling);
    await testInfo.attach(`${mode}-opaque-native-history.json`, {
      body: JSON.stringify({ sourceHashes, cssAccess, before, originalSelection, formatted, responsive, unrelatedUndo, unrelatedSelection,
        undone, undoneSelection, redone, typedAfterUndo, reloaded, persisted }, null, 2), contentType: 'application/json',
    });
    await testInfo.attach(`${mode}-opaque-native-history.png`, { body: await page.screenshot(), contentType: 'image/png' });
  } finally {
    const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  }
});

for (const partial of [false, true]) {
  test(`[P1] ${partial ? 'partial' : 'full'} authored underline off preserves other typography`, async ({ page }, testInfo) => {
    const content = partial ? '<u data-readable-id="underline">앞<b data-readable-id="copy">A</b>뒤</u>' : '<u data-readable-id="copy">A</u>';
    const canonical = `<!doctype html><html><head><style>.shape{font:700 64px Arial}.shape b,.shape u{font-size:24px;font-weight:400;color:blue}.shape i{font-size:20px;font-weight:400;font-style:normal;color:red}.shape span{font-size:40px!important;color:purple!important}</style></head><body>
      <div class="shape" data-readable-id="shape">${content}<i data-readable-id="detail">C</i></div><p id="sibling">이웃의 텍스트는 그대로</p></body></html>`;
    await load(page, canonical);
    await editAt(page, 'A');
    await page.evaluate(() => {
      const range = document.createRange(); range.selectNodeContents(document.querySelector('[data-readable-id="copy"]')!);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    });
    const before = await snapshot(page);
    await page.keyboard.press('Control+u');
    const formatted = await snapshot(page);
    async function effectiveDecorations() {
      return page.evaluate(() => {
        const walker = document.createTreeWalker(document.querySelector('[data-readable-id="shape"]')!, NodeFilter.SHOW_TEXT);
        const values: { text: string; underline: boolean }[] = []; let node: Node | null;
        while ((node = walker.nextNode())) {
          let underline = false;
          for (let element = node.parentElement; element; element = element.parentElement) underline ||= getComputedStyle(element).textDecorationLine.includes('underline');
          values.push({ text: node.textContent ?? '', underline });
        }
        return values;
      });
    }
    const decorations = await effectiveDecorations();
    expect.soft(formatted.runs.find((run) => run.text === 'A')).toMatchObject({ size: '24px', weight: '400', color: 'rgb(0, 0, 255)' });
    expect.soft(decorations.find((run) => run.text === 'A')?.underline).toBe(false);
    for (const text of partial ? ['앞', '뒤'] : []) {
      expect.soft(formatted.runs.find((run) => run.text === text)).toMatchObject({ size: '24px', weight: '400', color: 'rgb(0, 0, 255)' });
      expect.soft(decorations.find((run) => run.text === text)?.underline).toBe(true);
    }
    expect.soft(formatted.runs.find((run) => run.text === 'C')).toEqual(before.runs.find((run) => run.text === 'C'));
    await page.keyboard.press('Control+z');
    const undone = await snapshot(page);
    expect.soft(undone.runs).toEqual(before.runs);
    expect.soft(undone.selection).toBe(before.selection);
    await page.keyboard.press('Control+y');
    const redone = await snapshot(page);
    expect.soft(redone.runs).toEqual(formatted.runs);
    const persisted = await canonicalCommit(page, canonical);
    await load(page, persisted, false);
    const reloaded = await snapshot(page);
    expect.soft(reloaded.runs).toEqual(formatted.runs);
    expect.soft(await effectiveDecorations()).toEqual(decorations);
    await expect(page.locator('u')).toHaveCount(1);
    expect(persisted.length - canonical.length).toBeLessThan(2_000);
    await testInfo.attach(`${mode}-${partial ? 'partial' : 'full'}-underline.json`, {
      body: JSON.stringify({ sourceHashes, before, formatted, decorations, undone, redone, reloaded, persisted }, null, 2), contentType: 'application/json',
    });
  });
}

test('[P0] Enter at the end of an authored text run keeps the next typed line typography', async ({ page }, testInfo) => {
  const snapshots: { tag: string; before: Snapshot; typed: Snapshot; reloaded: Snapshot; persisted: string }[] = [];
  for (const tag of ['h1', 'p', 'span', 'div']) {
    const canonical = source(tag).replace(' 다음 문장', '').replace('<i>설명</i>', '');
    await load(page, canonical);
    const before = await snapshot(page);
    await editAt(page, '제 1막');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Q');
    const typed = await snapshot(page);
    const persisted = await canonicalCommit(page, canonical);
    await load(page, persisted, false);
    const reloaded = await snapshot(page);
    snapshots.push({ tag, before, typed, reloaded, persisted });
    expect.soft(typed.editing).toBe(true);
    expect.soft(typed.text).toContain('\n');
    expect.soft(typed.runs.find((run) => run.text.includes('Q'))).toMatchObject({ size: '24px', weight: '400', color: 'rgb(0, 0, 255)' });
    expect.soft(reloaded.runs.find((run) => run.text.includes('제 1막'))).toMatchObject({ size: '24px', weight: '400' });
    expect.soft(reloaded.runs).toEqual(typed.runs);
    expect.soft(reloaded.text).toBe(typed.text);
    expect.soft(reloaded.sibling).toBe(before.sibling);
  }
  await testInfo.attach(`${mode}-end-run-enter.json`, { body: JSON.stringify({ sourceHashes, snapshots }, null, 2), contentType: 'application/json' });
});

test('[P0] full HTML and fragment formatting retain authored important layer typography after canonical reload', async ({ page }, testInfo) => {
  const snapshots = [];
  for (const fragment of [false, true]) for (const command of ['bold', 'underline']) {
    const tag = command === 'bold' ? 'b' : 'u';
    const styles = '<style>@layer author{.shape span{font-size:40px!important;color:purple!important}.shape u{text-decoration-line:underline!important}}.shape{font:700 64px Arial;display:block;width:1100px}.shape b,.shape u{font:400 24px Georgia;color:blue}.shape i{font:400 20px Arial;color:red}</style>';
    const body = `<div class="shape"${fragment ? '' : ' data-readable-id="shape"'}><${tag} data-readable-id="copy">A</${tag}><i data-readable-id="detail">C</i></div><p id="sibling" data-readable-id="sibling">Unchanged sibling</p>`;
    const canonical = fragment ? `<p id="sentinel">Before authored stylesheet</p>${styles}${body}`
      : `<!doctype html><html><head>${styles}</head><body>${body}</body></html>`;
    await load(page, canonical, true, fragment);
    const targetId = await page.locator('.shape').getAttribute('data-readable-id');
    expect(targetId).toBeTruthy();
    if (fragment) expect(targetId).toMatch(/^path-/);
    const before = await snapshot(page);
    const detailHtml = await page.locator('[data-readable-id="detail"]').evaluate((node) => {
      const state = window as unknown as { layerDetail: Element; layerClicks: number };
      state.layerDetail = node; state.layerClicks = 0;
      node.addEventListener('click', () => { state.layerClicks++; });
      return node.outerHTML;
    });
    const listenerChecks: Array<{ step: string; sameNode: boolean; clicks: number; html: string }> = [];
    async function checkDetail(step: string): Promise<void> {
      const check = await page.evaluate((step) => {
        const state = window as unknown as { layerDetail: Element; layerClicks: number };
        const detail = document.querySelector('[data-readable-id="detail"]')!;
        detail.dispatchEvent(new MouseEvent('click'));
        return { step, sameNode: state.layerDetail === detail, clicks: state.layerClicks, html: detail.outerHTML };
      }, step);
      listenerChecks.push(check);
      expect.soft(check.sameNode).toBe(true);
      expect.soft(check.clicks).toBe(listenerChecks.length);
      expect.soft(check.html).toBe(detailHtml);
    }
    await editAt(page, 'A', 'end', targetId!);
    await page.evaluate(() => {
      const range = document.createRange(); range.selectNodeContents(document.querySelector('[data-readable-id="copy"]')!);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    });
    await page.keyboard.press(command === 'bold' ? 'Control+b' : 'Control+u');
    const formatted = await snapshot(page);
    await checkDetail('formatted');
    const identity = await page.locator('[data-readable-id="copy"]').evaluate((node) => node.tagName);
    expect.soft(identity).toBe(tag.toUpperCase());
    expect.soft(formatted.runs.find((run) => run.text === 'A')).toMatchObject({ size: '24px', weight: command === 'bold' ? '700' : '400', color: 'rgb(0, 0, 255)' });
    await page.keyboard.press('Control+z');
    const undone = await snapshot(page);
    await checkDetail('undone');
    expect.soft(undone.runs).toEqual(before.runs);
    expect.soft(undone.selection).toBe('A');
    await page.keyboard.press('Control+y');
    const redone = await snapshot(page);
    await checkDetail('redone');
    expect.soft(redone.runs).toEqual(formatted.runs);
    const persisted = await canonicalCommit(page, canonical, targetId!);
    await load(page, persisted, fragment, fragment);
    const reloaded = await snapshot(page);
    expect.soft(reloaded.runs).toEqual(formatted.runs);
    expect.soft(reloaded.sibling).toBe(before.sibling);
    expect.soft(await page.locator('[data-readable-id="copy"]').evaluate((node) => node.tagName)).toBe(tag.toUpperCase());
    const decorations = await page.locator('[data-readable-id="copy"]').evaluate((node) => {
      const selected = node.querySelector('span') ?? node;
      const lines = [];
      for (let element: Element | null = selected; element; element = element.parentElement) {
        const line = getComputedStyle(element).textDecorationLine;
        if (line !== 'none') lines.push(line);
      }
      return lines;
    });
    if (command === 'underline') expect.soft(decorations).not.toContain('underline');
    const secondSave = await page.evaluate(({ persisted, targetId }) => {
      const runtime = (window as unknown as { richTextHarness: { applyManualEditPatch: (source: string, patch: unknown) => { ok: boolean; source: string; error?: string } } }).richTextHarness;
      const result = runtime.applyManualEditPatch(persisted, { id: targetId, kind: 'set-attributes', attributes: { title: 'ordinary second save' } });
      if (!result.ok) throw new Error(result.error);
      return result.source;
    }, { persisted, targetId });
    await load(page, secondSave, fragment, fragment);
    const secondReload = await snapshot(page);
    expect.soft(secondReload.runs).toEqual(formatted.runs);
    expect.soft(secondReload.sibling).toBe(before.sibling);
    await expect(page.locator('.shape')).toHaveAttribute('title', 'ordinary second save');
    expect.soft(await page.locator('style[data-readable-text-format-style="1"]').count()).toBe(1);
    snapshots.push({ fragment, command, targetId, before, formatted, undone, redone, listenerChecks, reloaded, persisted, decorations, secondSave, secondReload });
  }
  await testInfo.attach(`${mode}-layered-fragment.json`, { body: JSON.stringify({ sourceHashes, snapshots }, null, 2), contentType: 'application/json' });
});
