import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { addStorageInitScript } from '@/playwright/storage-init';
import { routeAgents } from '@/playwright/mock-factory';

const fileName = 'anchor-document.html';
const html = `<!doctype html><html><head><style>body{margin:0;font:18px sans-serif}section{height:780px;padding:20px}</style></head><body><nav><a href="#section-5">Jump to section 05</a> <a href="https://example.com/">External link</a></nav>${Array.from({ length: 8 }, (_, i) => `<section id="section-${i + 1}"><h2>Section 0${i + 1}</h2><p>Generated document content</p></section>`).join('')}</body></html>`;

for (const mode of ['url-load', 'srcdoc'] as const) {
  test(`[P0] growing composer and in-document anchor cannot scroll workspace shell (${mode})`, async ({ page }) => {
    await addStorageInitScript(page, (key) => window.localStorage.setItem(key, JSON.stringify({ mode: 'daemon', agentId: 'mock', onboardingCompleted: true, privacyDecisionAt: 1, telemetry: { metrics: false, content: false, artifactManifest: false } })), 'readable-studio:config');
    await routeAgents(page, [{ id: 'mock', name: 'Mock Agent', bin: 'mock-agent', available: true, version: 'test', models: [{ id: 'default', label: 'Default' }] }]);
    const id = randomUUID();
    const project = await page.request.post('/api/projects', { data: { id, name: 'Anchor shell regression', skillId: null, designSystemId: null } });
    expect(project.ok(), await project.text()).toBe(true);
    const saved = await page.request.post(`/api/projects/${id}/files`, { data: { name: fileName, content: mode === 'srcdoc' ? html.replace('</head>', '<!-- localStorage requires srcdoc --> </head>') : html, artifactManifest: { schema: 'readable-studio.artifact-manifest.v1', kind: 'html', title: fileName, entry: fileName, renderer: 'html', exports: ['html'] } } });
    expect(saved.ok(), await saved.text()).toBe(true);
    await page.setViewportSize({ width: 1280, height: 400 });
    await page.goto(`/projects/${id}/files/${fileName}`);
    const frame = page.locator('[data-testid="artifact-preview-frame"]:visible');
    await expect(frame).toBeVisible();
    await expect(frame).toHaveAttribute('data-readable-render-mode', mode);
    const documentFrame = page.frameLocator('[data-testid="artifact-preview-frame"]:visible');
    await expect(documentFrame.getByRole('link', { name: 'Jump to section 05' })).toBeVisible();
    const measure = () => page.evaluate(() => {
      const shell = document.querySelector('.workspace-shell')!;
      const body = document.querySelector('.workspace-shell__body')!;
      const rail = document.querySelector('[data-project-rail-state]')!;
      const topbar = document.querySelector('[data-testid="app-window-chrome"]')!;
      const rect = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      const root = document.scrollingElement!;
      return { url: location.href, rootHeight: root.scrollHeight, viewportHeight: root.clientHeight, rootTop: root.scrollTop, shellHeight: shell.scrollHeight, shellClientHeight: shell.clientHeight, shellTop: shell.scrollTop, shellLeft: shell.scrollLeft, bodyHeight: body.scrollHeight, bodyClientHeight: body.clientHeight, bodyTop: body.scrollTop, bodyLeft: body.scrollLeft, shell: rect(shell), rail: rect(rail), topbar: rect(topbar) }; 
    });
    const before = await measure();
    await page.screenshot({ path: `../.omo/evidence/anchor-shell-clip/${mode}-before.png` });
    const composer = page.getByRole('combobox', { name: /Describe what you want to generate/i });
    await composer.click();
    for (let i = 1; i <= 10; i++) {
      await composer.press('Shift+Enter');
      await composer.pressSequentially(`Line ${i}`);
      const growth = await measure();
      const editor = await composer.evaluate((el) => {
        const pane = el.closest('.pane')!;
        const input = el.closest('.composer-input-editor')!;
        return { contentHeight: el.scrollHeight, inputHeight: input.clientHeight, inputTop: input.scrollTop, paneHeight: pane.clientHeight };
      });
      console.log(JSON.stringify({ mode, line: i, rootHeight: growth.rootHeight, shellHeight: growth.shellHeight, shellTop: growth.shellTop, topbarY: growth.topbar.y, railY: growth.rail.y, editor }));
      expect(growth.topbar, `topbar moved after ${i} composer newlines`).toEqual(before.topbar);
      expect(growth.rail, `rail moved after ${i} composer newlines`).toEqual(before.rail);
      expect(growth.rootHeight, `document overflow after ${i} composer newlines`).toBeLessThanOrEqual(growth.viewportHeight);
      expect(growth.shellHeight, `shell overflow after ${i} composer newlines`).toBeLessThanOrEqual(growth.shellClientHeight);
    }
    await page.screenshot({ path: `../.omo/evidence/anchor-shell-clip/${mode}-composer-after.png` });
    await documentFrame.getByRole('link', { name: 'Jump to section 05' }).click();
    await expect.poll(() => documentFrame.locator('html').evaluate((el) => el.scrollTop || el.ownerDocument.scrollingElement?.scrollTop || 0)).toBeGreaterThan(0);
    const previewTop = await documentFrame.locator('html').evaluate((el) => el.ownerDocument.scrollingElement!.scrollTop);
    const after = await measure();
    await page.screenshot({ path: `../.omo/evidence/anchor-shell-clip/${mode}-after.png` });
    console.log(JSON.stringify({ mode, before, after, previewTop }));
    expect(after, 'anchor scroll moved the workspace shell').toMatchObject({ rootTop: 0, shellTop: 0, shellLeft: 0, bodyTop: 0, bodyLeft: 0, rail: before.rail, topbar: before.topbar, url: before.url });
    await page.route('https://example.com/', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>External destination</h1>' }));
    await documentFrame.getByRole('link', { name: 'External link' }).click();
    await expect(documentFrame.getByRole('heading', { name: 'External destination' })).toBeVisible();
    expect((await measure()).url).toBe(before.url);
    // Stress the shell with an oversized grid child: overflow:hidden still creates
    // a programmatically scrollable ancestor; overflow:clip must not.
    const shellScroll = await page.evaluate(() => {
      const shell = document.querySelector('.workspace-shell')!;
      const oversized = document.createElement('div');
      oversized.style.cssText = 'grid-row:3;height:1600px;width:1800px';
      shell.append(oversized);
      shell.scrollTo(100, 600);
      const result = { top: shell.scrollTop, left: shell.scrollLeft, scrollHeight: shell.scrollHeight, clientHeight: shell.clientHeight };
      oversized.remove();
      return result;
    });
    console.log(JSON.stringify({ mode, shellScroll }));
    expect(shellScroll.scrollHeight).toBeGreaterThan(shellScroll.clientHeight);
    expect(shellScroll, 'oversized content must not make workspace chrome scrollable').toMatchObject({ top: 0, left: 0 });
    const bodyScroll = await page.evaluate(() => {
      const body = document.querySelector('.workspace-shell__body')!;
      const oversized = document.createElement('div');
      oversized.style.cssText = 'grid-row:2;height:1600px;width:1800px';
      body.append(oversized);
      body.scrollTo(100, 600);
      const result = { top: body.scrollTop, left: body.scrollLeft, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight };
      oversized.remove();
      return result;
    });
    console.log(JSON.stringify({ mode, bodyScroll }));
    expect(bodyScroll.scrollHeight).toBeGreaterThan(bodyScroll.clientHeight);
    expect(bodyScroll, 'oversized content must not make the rail scrollable').toMatchObject({ top: 0, left: 0 });
  });
}
