import { expect, type Page, type Request } from '@playwright/test';
import type { ChatMessage, ProjectMetadata } from '@readable-studio/contracts';
import { PNG } from 'pngjs';
import { HELD_QUESTION_RUN } from '@/fake-agents';
import { anchoredPosition, assertIndicatorContrast, assertVeilComposite, assertVeilContract, bundledThemes, dismissQuestionsOutside } from '@/playwright/questions-inline-topbar';
import { checked, isApi, test } from '@/playwright/ui-batch';
import { T } from '@/timeouts';

// Run through Playwright's compiler, NOT tsx: serialized browser functions must
// not acquire tsx's external __name helper. No browser callback imports helpers.
test.describe.configure({ retries: 0, timeout: T.xlong });
test.use({ contextOptions: { reducedMotion: 'reduce' } });

const metadata: ProjectMetadata = { kind: 'prototype', brief: { updatedAt: 1, assumptions: [
  { id: 'delivery-format', label: 'Delivery format', value: 'html', provenance: 'stated', question: {
    id: 'delivery-format', label: 'Delivery format', type: 'select', options: [
      { value: 'html', label: 'HTML' }, { value: 'markdown', label: 'Markdown' }, { value: 'slides', label: 'Slides' },
    ],
  } },
  { id: 'audience', label: 'Audience', value: 'Reviewers', provenance: 'inferred' },
  { id: 'scale', label: 'Scale', value: '8 slides', provenance: 'default' },
  { id: 'constraints', label: 'Constraints', value: 'Use real copy', provenance: 'default' },
] } };

function field(page: Page, id: string) {
  return page.getByTestId('questions-panel').locator(`.questions-panel__row[id$="-${id}"]`);
}
function popover(page: Page) { return page.locator('body > .questions-panel__popover'); }
async function anchored(page: Page, fieldId: string) {
  const layer = popover(page);
  await expect(layer).toBeVisible();
  // Resolve the CURRENT owner after regrouping/switching. The listbox owns
  // an inner ID; the text editor owns the portal ID. Measure in one DOM task.
  const measure = () => layer.evaluate(node => {
    const owners = [...document.querySelectorAll('.questions-panel__row[aria-expanded="true"][aria-controls]')]
      .filter(trigger => {
        const controlled = document.getElementById(trigger.getAttribute('aria-controls')!);
        return controlled !== null && (controlled === node || node.contains(controlled));
      });
    if (owners.length !== 1) throw new Error(`Expected one current popover owner, got ${owners.length}`);
    const anchor = owners[0]!;
    const panel = node as HTMLElement;
    const style = getComputedStyle(panel);
    return { a: anchor.getBoundingClientRect().toJSON(), p: panel.getBoundingClientRect().toJSON(), anchorId: anchor.id,
      size: { width: panel.offsetWidth, height: panel.offsetHeight },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      placementStyle: { inline: panel.getAttribute('style'), left: style.left, top: style.top,
        position: style.position, margin: style.margin, transform: style.transform } };
  });
  await expect.poll(async () => {
    const { a, p, size, viewport } = await measure();
    const expected = anchoredPosition(a, size, viewport);
    return Math.max(Math.abs(p.x - expected.x), Math.abs(p.y - expected.y));
  }, { timeout: T.short }).toBeLessThanOrEqual(1);
  const { a, p, size, viewport, placementStyle, anchorId } = await measure();
  expect(anchorId).toBe(await field(page, fieldId).getAttribute('id'));
  const position = anchoredPosition(a, size, viewport);
  const evidence = JSON.stringify({ fieldId, a, p, size, viewport, placementStyle, expected: position,
    delta: { x: p.x - position.x, y: p.y - position.y } });
  expect(Math.abs(p.x - position.x), evidence).toBeLessThanOrEqual(1);
  expect(Math.abs(p.y - position.y), evidence).toBeLessThanOrEqual(1);
  expect(p.x).toBeGreaterThanOrEqual(11);
  expect(p.x + p.width).toBeLessThanOrEqual(viewport.width - 11);
  expect(p.y).toBeGreaterThanOrEqual(11);
  expect(p.y + p.height).toBeLessThanOrEqual(viewport.height - 11);
}
async function noPageOverflow(page: Page) {
  expect(await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.documentElement.clientWidth,
  }))).toEqual({ page: 0, body: 0 });
}

for (const width of [375, 768, 1280]) for (const theme of ['light', 'dark'] as const) {
  test(`[P1] Questions inline ${width}px ${theme}: anchored edits preserve the summary and drafts`, async ({ page, request, batch }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await batch.configure({ theme });
    const { id, conversationId } = await batch.create(metadata);
    await page.goto(`/projects/${id}/conversations/${conversationId}`);
    // An actual held CLI run makes corrections queue normally. Persistence,
    // hydration and send arbitration are not mocked out of this integration.
    await page.getByTestId('chat-composer-input').fill(HELD_QUESTION_RUN.prompt);
    const [started, saved] = await Promise.all([
      page.waitForResponse(response => isApi(response, 'POST', '/api/runs'), { timeout: T.long }),
      page.waitForResponse(response => response.request().method() === 'PUT'
        && new URL(response.url()).pathname.startsWith(`/api/projects/${id}/conversations/${conversationId}/messages/`)
        && (response.request().postDataJSON() as ChatMessage).content.includes(`id="${HELD_QUESTION_RUN.formId}"`), { timeout: T.long }),
      page.getByTestId('chat-send').click(),
    ]);
    await checked(started); await checked(saved);
    await page.getByTestId('questions-tab').click();
    const panel = page.getByTestId('questions-panel');
    const form = panel.locator(`[data-form-id="${HELD_QUESTION_RUN.formId}"]`);
    const primaryDraft = form.getByRole('textbox', { name: 'Audience details', exact: true });
    await expect(primaryDraft).toBeEditable();
    await primaryDraft.fill('Keep the primary form draft\nSecond line');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(panel.locator('.questions-skip')).toBeEnabled(); // hydration barrier
    const originalPanel = await panel.elementHandle();
    const originalForm = await form.elementHandle();
    const summary = panel.locator('.questions-panel__groups');
    const originalSummary = await summary.elementHandle();
    const mounted = async () => {
      expect(await originalPanel!.evaluate(node => node.isConnected && node.getAttribute('data-step') === 'summary')).toBe(true);
      expect(await originalForm!.evaluate(node => node.isConnected)).toBe(true);
      expect(await originalSummary!.evaluate(node => node.isConnected)).toBe(true);
      await expect(page.locator('[data-step="correct"]')).toHaveCount(0);
      await expect(primaryDraft).toHaveValue('Keep the primary form draft\nSecond line');
      await noPageOverflow(page);
    };
    // Observe transient replacement too, not just the eventual end state.
    await panel.evaluate(node => {
      const observer = new MutationObserver(records => {
        for (const record of records) {
          if (record.type === 'attributes' && record.attributeName === 'data-step'
            && (record.oldValue === 'correct' || (record.target as Element).getAttribute('data-step') === 'correct')) {
            node.setAttribute('data-e2e-replaced', 'true');
          }
          for (const removed of record.removedNodes) {
            if (removed === node || removed.contains(node)) node.setAttribute('data-e2e-replaced', 'true');
          }
        }
      });
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-step'], attributeOldValue: true });
    });
    expect(await panel.locator('.questions-panel__editor--primary').evaluate(node => {
      const groups = node.parentElement!.querySelector('.questions-panel__groups')!;
      return Boolean(node.compareDocumentPosition(groups) & Node.DOCUMENT_POSITION_FOLLOWING)
        && node.getBoundingClientRect().bottom <= groups.getBoundingClientRect().top;
    })).toBe(true);
    const influence = panel.getByTestId('questions-influence');
    await expect(influence).toHaveAttribute('data-count', '4');
    await expect(influence).toHaveAttribute('data-confirmed', '1');

    const patches: unknown[] = [];
    const observe = (incoming: Request) => {
      if (incoming.method() === 'PATCH' && new URL(incoming.url()).pathname === `/api/projects/${id}`) patches.push(incoming.postDataJSON());
    };
    page.on('request', observe);
    const delivery = field(page, 'delivery-format');
    await delivery.scrollIntoViewIfNeeded();
    await delivery.focus(); await delivery.press('Enter');
    const list = page.getByRole('listbox', { name: 'Delivery format', exact: true });
    await expect(list).toBeVisible();
    await expect(delivery).toHaveAttribute('aria-controls', await list.getAttribute('id') as string);
    await expect(popover(page)).toHaveClass(/inline-switcher__popover--model/);
    await expect(panel.locator('select')).toHaveCount(0);
    await anchored(page, 'delivery-format'); await mounted();
    const html = list.getByRole('option', { name: 'HTML', exact: true });
    const markdown = list.getByRole('option', { name: 'Markdown', exact: true });
    const slides = list.getByRole('option', { name: 'Slides', exact: true });
    await expect(html).toBeFocused();
    await page.keyboard.press('End'); await expect(slides).toBeFocused();
    await page.keyboard.press('Home'); await expect(html).toBeFocused();
    await page.keyboard.press('ArrowDown'); await expect(markdown).toBeFocused();
    await page.keyboard.press('ArrowUp'); await expect(html).toBeFocused();
    await page.keyboard.press('m'); await expect(markdown).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0); await expect(delivery).toBeFocused();
    expect(patches).toHaveLength(0);
    await delivery.press('Enter'); await page.keyboard.press('m');
    const [enumSave] = await Promise.all([
      page.waitForResponse(response => isApi(response, 'PATCH', `/api/projects/${id}`), { timeout: T.long }),
      page.keyboard.press('Enter'),
    ]);
    await checked(enumSave);
    await expect(list).toHaveCount(0); await expect(delivery).toBeFocused();
    await expect(delivery.locator('.questions-panel__value')).toHaveText('markdown');
    expect(patches).toHaveLength(1);
    await mounted();

    const audience = field(page, 'audience');
    const editor = page.getByRole('textbox', { name: 'Who is this for?', exact: true });
    await audience.scrollIntoViewIfNeeded(); await audience.click();
    await expect(editor).toBeFocused(); await anchored(page, 'audience'); await mounted();
    await editor.fill('Security leaders');
    await dismissQuestionsOutside(page, testInfo, 'audience-draft');
    await expect(editor).toHaveCount(0);
    await audience.click(); await expect(editor).toHaveValue('Security leaders');
    // Deliberately dismiss before switching: the portal can cover the next
    // field at 375px. Normal clicks retain Playwright's real hit testing.
    const scale = field(page, 'scale');
    await dismissQuestionsOutside(page, testInfo, 'audience-before-scale'); await expect(editor).toHaveCount(0);
    await scale.scrollIntoViewIfNeeded(); await scale.click();
    await expect(popover(page).getByRole('textbox')).toHaveValue('8 slides');
    await anchored(page, 'scale'); await mounted();
    await dismissQuestionsOutside(page, testInfo, 'scale-before-audience');
    await audience.scrollIntoViewIfNeeded(); await audience.click();
    await expect(editor).toHaveValue('Security leaders');
    await anchored(page, 'audience');
    await page.keyboard.press('Escape'); await expect(audience).toBeFocused();
    await audience.click(); await expect(editor).toHaveValue('Security leaders');
    await popover(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(editor).toHaveCount(0); await expect(audience).toBeFocused();
    await audience.click(); await expect(editor).toHaveValue('Reviewers');
    expect(patches).toHaveLength(1);
    await editor.fill('Final security reviewers');
    const save = popover(page).getByRole('button', { name: 'Apply correction', exact: true });
    const [textSave] = await Promise.all([
      page.waitForResponse(response => isApi(response, 'PATCH', `/api/projects/${id}`), { timeout: T.long }),
      // Same-task burst exercises the in-flight ref, not timing between clicks.
      save.evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); }),
    ]);
    await checked(textSave);
    await expect(editor).toHaveCount(0);
    await expect(audience).toBeFocused(); // row moved from inferred to stated
    await expect(audience).toHaveAttribute('data-provenance', 'stated');
    await expect(audience.locator('.questions-panel__value')).toHaveText('Final security reviewers');
    await audience.click(); await expect(editor).toHaveValue('Final security reviewers');
    await anchored(page, 'audience'); // resolve the newly mounted stated-group trigger
    await page.keyboard.press('Escape'); await expect(audience).toBeFocused();
    await expect(influence).toHaveAttribute('data-confirmed', '2');
    await expect(influence).toHaveAttribute('data-count', '4');
    await mounted();
    expect(await originalPanel!.getAttribute('data-e2e-replaced')).toBeNull();
    expect(patches).toHaveLength(2);
    const stored = await checked(await request.get(`/api/projects/${id}`));
    expect((await stored.json() as { project: { metadata: ProjectMetadata } }).project.metadata.brief!.assumptions)
      .toContainEqual(expect.objectContaining({ id: 'audience', value: 'Final security reviewers', provenance: 'stated' }));
    const queue = await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '[]') as Array<{ prompt: string }>, `readable:chat-queued-sends:${id}:v1`);
    expect(queue).toHaveLength(2);
    expect(queue.filter(item => item.prompt.includes('Final security reviewers'))).toHaveLength(1);
    expect(batch.runs).toHaveLength(1);
    page.off('request', observe);
  });
}

/** All parsing, alpha compositing and WCAG math live INSIDE this callback. */
async function contrastSamples(page: Page) {
  return page.evaluate(() => {
    type Color = [number, number, number, number];
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    function color(css: string): Color {
      if (!CSS.supports('color', css)) throw new Error(`Unsupported color: ${css}`);
      context.clearRect(0, 0, 1, 1); context.fillStyle = css; context.fillRect(0, 0, 1, 1);
      const p = context.getImageData(0, 0, 1, 1).data;
      return [p[0]! / 255, p[1]! / 255, p[2]! / 255, p[3]! / 255];
    }
    function over(a: Color, b: Color): Color {
      const alpha = a[3] + b[3] * (1 - a[3]);
      return [0, 1, 2].map(i => alpha ? (a[i]! * a[3] + b[i]! * b[3] * (1 - a[3])) / alpha : 0).concat(alpha) as Color;
    }
    function background(node: Element): Color {
      const style = getComputedStyle(node);
      let result = color(style.backgroundColor);
      if (style.backgroundImage !== 'none') {
        const colors = style.backgroundImage.match(/(?:rgba?\([^)]*\)|color\([^)]*\))/g) ?? [];
        if (!style.backgroundImage.startsWith('linear-gradient(') || colors.length !== 2 || colors[0] !== colors[1]) {
          throw new Error(`Unmeasured nonuniform background on ${node.className}: ${style.backgroundImage}`);
        }
        result = over(color(colors[0]!), result);
      }
      if (result[3] < 1) {
        if (!node.parentElement) throw new Error('No opaque backing for contrast sample');
        result = over(result, background(node.parentElement));
      }
      return result;
    }
    function luminance(c: Color) {
      return c.slice(0, 3).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
    }
    function ratio(ink: Color, bg: Color) {
      const a = luminance(over(ink, bg)), b = luminance(bg);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    }
    function identity(node: Element): string {
      if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
        return `textbox:${[...node.labels ?? []].map(label => label.textContent!.trim()).join(' ')}`;
      }
      const list = node.closest('[role="listbox"]');
      return `${node.getAttribute('role') ?? node.tagName.toLowerCase()}:${list ? `${list.getAttribute('aria-label')}:` : ''}${node.getAttribute('aria-label') ?? node.textContent!.trim()}`;
    }
    const samples: Array<{ selector: string; kind: 'text' | 'indicator'; ratio: number }> = [];
    for (const node of document.querySelectorAll('.questions-panel__content *, .questions-panel__popover *')) {
      if (!node.getClientRects().length || node instanceof SVGElement) continue;
      const style = getComputedStyle(node);
      if (style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      if ([...node.childNodes].some(child => child.nodeType === Node.TEXT_NODE && child.textContent!.trim())
        || node.matches('input, textarea')) {
        const ink = color(style.color); ink[3] *= Number(style.opacity);
        samples.push({ selector: String(node.className), kind: 'text', ratio: ratio(ink, background(node)) });
      }
      if (node.matches('input[placeholder], textarea[placeholder]')) {
        const placeholder = getComputedStyle(node, '::placeholder');
        const ink = color(placeholder.color); ink[3] *= Number(placeholder.opacity);
        samples.push({ selector: `${node.className}::placeholder`, kind: 'text', ratio: ratio(ink, background(node)) });
      }
      if (node.matches(':focus-visible')) {
        if (style.outlineStyle === 'none' || parseFloat(style.outlineWidth) < 2) throw new Error('Missing focus indicator');
        samples.push({ selector: `focus:${identity(node)}`, kind: 'indicator', ratio: ratio(color(style.outlineColor), background(node)) });
      }
      if (node.matches('.inline-switcher__model-option-check') && node.querySelector('svg')) {
        samples.push({ selector: `selected-check:${identity(node.closest('[role="option"]')!)}`, kind: 'indicator', ratio: ratio(color(style.color), background(node)) });
      }
      if (node.matches('.qf-chip-on')) {
        const ink = style.boxShadow.match(/(?:rgba?\([^)]*\)|color\([^)]*\))/)?.[0];
        if (!ink || !style.boxShadow.includes('-2px')) throw new Error('Missing selected underline');
        samples.push({ selector: 'selected-underline', kind: 'indicator', ratio: ratio(color(ink), background(node)) });
      }
    }
    return samples;
  });
}

for (const theme of bundledThemes()) {
  test(`[P1] Questions ${theme.id}: rendered text >=4.5 and selection/focus >=3`, async ({ page, batch }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await batch.configure({ theme: theme.scheme });
    const { id, conversationId } = await batch.create(metadata);
    await batch.seedForm(id, conversationId);
    await page.goto(`/projects/${id}/conversations/${conversationId}`);
    await page.getByTestId('questions-tab').click();
    await expect(page.getByTestId('questions-panel')).toBeVisible();
    // Route CSS is loaded before any computed-style sampling or theme change.
    await page.evaluate(value => {
      document.documentElement.setAttribute('data-theme', value.id);
      document.documentElement.setAttribute('data-theme-scheme', value.scheme);
    }, theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.id);
    await field(page, 'audience').click();
    await expect(page.getByRole('textbox', { name: 'Who is this for?', exact: true })).toBeFocused();
    const text = await contrastSamples(page);
    await page.keyboard.press('Escape');
    await field(page, 'delivery-format').click();
    await expect(page.getByRole('option', { name: 'HTML', exact: true })).toBeFocused();
    const options = await contrastSamples(page);
    const samples = [...text, ...options];
    expect(samples.filter(sample => sample.kind === 'text').length).toBeGreaterThan(10);
    expect(samples.some(sample => sample.selector.includes('::placeholder'))).toBe(true);
    await testInfo.attach('rendered-contrast', { contentType: 'application/json', body: JSON.stringify({ theme, samples }) });
    // Pointer-opened options need not be :focus-visible. Require the actual
    // textbox focus and selected option, and check EVERY present indicator.
    assertIndicatorContrast(samples, ['focus:textbox:Who is this for?', 'selected-check:option:Delivery format:HTML']);
    for (const sample of samples) expect(sample.ratio, `${theme.id} ${sample.selector}`).toBeGreaterThanOrEqual(sample.kind === 'text' ? 4.5 : 3);
  });
}

for (const theme of ['light', 'dark'] as const) for (const reduced of [false, true]) {
  test(`[P1] topbar ${theme} ${reduced ? 'reduced-transparency' : 'veil'}: shared canvas and hit regions`, async ({ page, context, batch }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await batch.configure({ theme });
    // Renderer-only preload seam: real traffic-light components and click
    // handlers, without starting Electron or allowing minimize/close side effects.
    await page.addInitScript(() => {
      let maximized = false;
      const calls: string[] = [];
      const listeners = new Set<(state: { maximized: boolean }) => void>();
      Object.defineProperty(window, '__e2eWindowCalls', { value: calls });
      Object.defineProperty(window, 'readableStudioDesktop', { value: { window: {
        getState: async () => ({ maximized }),
        minimize: async () => { calls.push('minimize'); },
        close: async () => { calls.push('close'); },
        toggleMaximize: async () => {
          calls.push('maximize'); maximized = !maximized;
          for (const listener of listeners) listener({ maximized });
          return { maximized };
        },
        onStateChange: (listener: (state: { maximized: boolean }) => void) => {
          listeners.add(listener); return () => { listeners.delete(listener); };
        },
      } } });
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', { features: [
      { name: 'prefers-reduced-transparency', value: reduced ? 'reduce' : 'no-preference' },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ] });
    const project = await batch.create();
    for (const route of ['/', `/projects/${project.id}/conversations/${project.conversationId}`]) {
      await page.goto(route);
      await expect(route === '/' ? page.getByTestId('home-hero-input') : page.getByTestId('chat-composer-input')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const chrome = page.getByTestId('app-window-chrome');
      await expect(chrome).toBeVisible();
      const measured = await page.evaluate(() => {
        const shell = document.querySelector('.workspace-shell')!;
        const bar = document.querySelector('.app-window-chrome')!;
        const drag = bar.querySelector('.app-window-chrome__drag')!;
        const style = getComputedStyle(bar), shellStyle = getComputedStyle(shell);
        const probe = document.createElement('div');
        // Declaration oracle only. Keep this probe out of layout and prevent
        // transitions from turning sequential style reads into timed samples.
        probe.style.cssText = 'position: absolute; visibility: hidden; transition: none; animation: none;';
        bar.append(probe);
        // Independent recipe, not the production chrome custom properties:
        // dark endpoints gain 12% theme ink; light and outer alpha are unchanged.
        const dark = style.colorScheme === 'dark';
        const endpoint = (name: string) => dark
          ? `color-mix(in srgb, var(--hub-canvas-${name}) 88%, var(--text))`
          : `var(--hub-canvas-${name})`;
        const veil = `linear-gradient(90deg, color-mix(in srgb, ${endpoint('blue')} 30%, transparent) 10%, color-mix(in srgb, ${endpoint('pink')} 30%, transparent) 92%)`;
        probe.style.background = veil;
        const expectedVeil = getComputedStyle(probe).backgroundImage;
        const negativeVeils = [
          veil.replace(/--hub-canvas-(blue|pink)/g, (_, name: string) => `--hub-canvas-${name === 'blue' ? 'pink' : 'blue'}`),
          veil.replaceAll('30%', '29%'),
          veil.replaceAll('30%', '30.01%'),
          ...(dark ? [veil.replaceAll('88%', '100%')] : []),
        ].map(css => { probe.style.background = css; return getComputedStyle(probe).backgroundImage; });
        probe.style.background = 'var(--hub-canvas)'; const fallback = getComputedStyle(probe).backgroundColor;
        const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
        const ctx = canvas.getContext('2d')!;
        function rgba(css: string) {
          if (!CSS.supports('color', css)) throw new Error(`Unsupported veil color: ${css}`);
          ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1);
          return Array.from(ctx.getImageData(0, 0, 1, 1).data);
        }
        // background-color is only the color UNDER the image, not veil alpha.
        // Do not resolve translucent mixes through a background-color probe:
        // Chromium returned `oklab(0 0 0 / 0)` there, not the painted veil.
        const opaqueVeil = veil.replaceAll('30%', '100%');
        probe.remove();
        const barBox = bar.getBoundingClientRect(), dragBox = drag.getBoundingClientRect();
        const dragHit = document.elementFromPoint(dragBox.x + dragBox.width / 2, dragBox.y + dragBox.height / 2);
        const controls = [...bar.querySelectorAll<HTMLButtonElement>('.window-controls__light')].map(button => {
          const rect = button.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return { hit: hit === button || button.contains(hit), region: getComputedStyle(button).getPropertyValue('-webkit-app-region'),
            inside: rect.top >= barBox.top && rect.bottom <= barBox.bottom,
            glyphOpacity: Number(getComputedStyle(button.querySelector('.window-controls__glyph')!).opacity) };
        });
        const toggle = document.querySelector('[data-project-rail-toggle]')!;
        const toggleBox = toggle.getBoundingClientRect();
        const toggleHit = document.elementFromPoint(toggleBox.x + toggleBox.width / 2, toggleBox.y + toggleBox.height / 2);
        return { image: style.backgroundImage, expectedVeil, negativeVeils, opaqueVeil, background: style.backgroundColor, fallback,
          alpha: rgba(style.backgroundColor)[3], shellImage: shellStyle.backgroundImage,
          shellBackground: shellStyle.backgroundColor, height: barBox.height, width: barBox.width,
          bodyTop: document.querySelector('.workspace-shell__body')!.getBoundingClientRect().top,
          dragRegion: getComputedStyle(drag).getPropertyValue('-webkit-app-region'), dragHit: dragHit === drag || drag.contains(dragHit),
          controls, toggleClear: toggleBox.top >= barBox.bottom && (toggleHit === toggle || toggle.contains(toggleHit)),
          reduced: matchMedia('(prefers-reduced-transparency: reduce)').matches };
      });
      await testInfo.attach(`topbar-css-${route === '/' ? 'home' : 'workspace'}`, { contentType: 'application/json', body: JSON.stringify(measured) });
      expect(measured.reduced).toBe(reduced);
      expect(measured.height).toBe(36); expect(measured.width).toBe(1280); expect(measured.bodyTop).toBe(36);
      expect(measured.dragRegion).toBe('drag'); expect(measured.dragHit).toBe(true); expect(measured.toggleClear).toBe(true);
      expect(measured.controls).toHaveLength(3);
      for (const control of measured.controls) {
        expect(control.hit).toBe(true); expect(control.inside).toBe(true); expect(control.region).toBe('no-drag');
        expect(control.glyphOpacity).toBeGreaterThan(0);
      }
      if (reduced) {
        expect(measured.image).toBe('none'); expect(measured.background).toBe(measured.fallback); expect(measured.alpha).toBe(255);
        expect(measured.shellImage).toBe('none'); expect(measured.shellBackground).toBe(measured.fallback);
      } else {
        assertVeilContract(measured.image, measured.expectedVeil);
        for (const mutation of measured.negativeVeils) expect(() => assertVeilContract(mutation, measured.expectedVeil)).toThrow();
        expect(measured.alpha).toBe(0);
        expect(measured.shellImage).toMatch(/radial-gradient\(1100px 640px at 10% -8%/);
        expect(measured.shellImage).toMatch(/radial-gradient\(880px 560px at 92% -4%/);
        // Paint evidence: only the background-image changes, so layout,
        // controls and the shared canvas stay identical in all three captures.
        // Screenshot paint synchronization, not sleeps, supplies the barrier.
        const clip = { x: 0, y: 0, width: 1280, height: 36 };
        const paintedBytes = await page.screenshot({ clip, scale: 'css' });
        const previousImage = await chrome.evaluate(node => {
          const value = node.style.getPropertyValue('background-image');
          const priority = node.style.getPropertyPriority('background-image');
          node.style.setProperty('background-image', 'none', 'important');
          return { value, priority };
        });
        let backingBytes: Buffer, opaqueBytes: Buffer;
        try {
          expect(await chrome.evaluate(node => getComputedStyle(node).backgroundImage)).toBe('none');
          backingBytes = await page.screenshot({ clip, scale: 'css' });
          await chrome.evaluate((node, image) => { node.style.setProperty('background-image', image, 'important'); }, measured.opaqueVeil);
          opaqueBytes = await page.screenshot({ clip, scale: 'css' });
        } finally {
          await chrome.evaluate((node, previous) => {
            if (previous.value) node.style.setProperty('background-image', previous.value, previous.priority);
            else node.style.removeProperty('background-image');
          }, previousImage);
        }
        expect(await chrome.evaluate(node => getComputedStyle(node).backgroundImage)).toBe(measured.image);
        const painted = PNG.sync.read(paintedBytes), backing = PNG.sync.read(backingBytes), opaque = PNG.sync.read(opaqueBytes);
        const surface = route === '/' ? 'home' : 'workspace';
        for (const [name, body] of [['painted', paintedBytes], ['backing', backingBytes], ['opaque', opaqueBytes]] as const) {
          await testInfo.attach(`topbar-${surface}-${name}`, { contentType: 'image/png', body });
        }
        // Pure endpoints outside 10% / 92%, away from the traffic lights.
        // Opaque canonical paint resolves nested theme mixes through the real
        // renderer. Its RGB can be composited at 30% without unpremultiplying
        // a transparent readback or parsing browser color serialization.
        const samples = [120, 1184].map(x => {
          const offset = (18 * painted.width + x) * 4;
          return { x, y: 18, painted: [...painted.data.subarray(offset, offset + 4)],
            backing: [...backing.data.subarray(offset, offset + 4)], opaque: [...opaque.data.subarray(offset, offset + 4)] };
        });
        await testInfo.attach(`topbar-composite-${surface}`, { contentType: 'application/json', body: JSON.stringify({
          image: measured.image, expectedVeil: measured.expectedVeil, opaqueVeil: measured.opaqueVeil,
          alpha: 0.3, tolerance: 2, samples,
        }) });
        for (const sample of samples) assertVeilComposite(sample.painted, sample.backing, sample.opaque);
        expect(Math.max(...samples[0]!.painted.slice(0, 3).map((value, i) => Math.abs(value - samples[1]!.painted[i]!)))).toBeGreaterThan(3);
      }
      for (const action of ['minimize', 'maximize', 'close']) await page.getByTestId(`window-control-${action}`).click();
      await expect(page.getByTestId('window-control-maximize')).toHaveAttribute('aria-pressed', 'true');
      expect(await page.evaluate(() => (window as unknown as { __e2eWindowCalls: string[] }).__e2eWindowCalls)).toEqual(['minimize', 'maximize', 'close']);
      await noPageOverflow(page);
    }
    await cdp.detach();
  });
}
