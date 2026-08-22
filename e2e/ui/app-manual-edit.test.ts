import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ensureRailOpen } from '@/playwright/rail';
import { routeAgents } from '@/playwright/mock-factory';
import type { Locator, Page, Response } from '@playwright/test';
import { T } from '@/timeouts';
import { issue41SelectionPaintHtml, magneticEdgeAlignmentHtml, semanticSvgDeckVisualHtml } from '../resources/manual-edit.ts';

const STORAGE_KEY = 'readable-studio:config';
const ACTIVE_ARTIFACT_PREVIEW_SELECTOR = '[data-testid="artifact-preview-frame"]:visible, [data-testid="artifact-preview-frame-url-load"]:visible, [data-testid="artifact-preview-frame-srcdoc"]:visible';

test.describe.configure({ timeout: 30_000 });

function artifactPreview(page: Page) {
  return page.locator(ACTIVE_ARTIFACT_PREVIEW_SELECTOR).first();
}

function artifactPreviewFrame(page: Page) {
  return page.frameLocator(ACTIVE_ARTIFACT_PREVIEW_SELECTOR);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => {
    window.localStorage.setItem(
      key,
      JSON.stringify({
        mode: 'daemon',
        apiKey: '',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-5',
        agentId: 'mock',
        skillId: null,
        designSystemId: null,
        onboardingCompleted: true,
        agentModels: {},
        privacyDecisionAt: 1,
        telemetry: { metrics: false, content: false, artifactManifest: false },
      }),
    );
  }, STORAGE_KEY);

  await page.route('**/api/app-config', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      json: {
        config: {
          onboardingCompleted: true,
          agentId: 'mock',
          skillId: null,
          designSystemId: null,
          agentModels: {},
          privacyDecisionAt: 1,
          telemetry: { metrics: false, content: false, artifactManifest: false },
        },
      },
    });
  });
});

test('[P0] manual edit left inspector previews and persists page and selected element styles', async ({ page }) => {
  await routeMockAgents(page);
  const projectId = await createEmptyProject(page, 'Manual edit smoke');
  await seedHtmlArtifact(page, projectId, 'manual-edit.html', manualEditHtml());
  await page.goto(`/projects/${projectId}/files/manual-edit.html`);
  await openDesignFile(page, 'manual-edit.html');

  await expect(artifactPreview(page)).toBeVisible();
  const frame = artifactPreviewFrame(page);
  await expect(frame.getByRole('heading', { name: 'Original Hero' })).toBeVisible();

  // Enter edit mode: the left chat panel becomes the manual-edit inspector.
  // With nothing selected the inspector shows the Page section, and the docked
  // toolbars no longer render above the preview canvas.
  await page.getByTestId('manual-edit-mode-toggle').click();
  await expect(frame.locator('html[data-readable-edit-mode]')).toHaveCount(1);
  const inspector = page.locator('.manual-edit-left-inspector');
  await expect(inspector).toBeVisible();
  await expect(inspectorSection(page, 'Page')).toBeVisible();
  await expect(inspector).toContainText('Background');
  await expect(page.locator('[data-testid="manual-edit-shape-toolbar"]')).toHaveCount(0);

  // Page edits round-trip through the inspector rows.
  await inspectorRow(page, 'Background').locator('input:not([type="color"])').fill('#eef2ff');
  await inspectorRow(page, 'Font').locator('select').selectOption('Georgia, serif');
  await inspectorRow(page, 'Base size').locator('input').fill('18');
  await expect(inspectorRow(page, 'Background').locator('input:not([type="color"])')).toHaveValue('#eef2ff');
  await expect(inspectorRow(page, 'Font').locator('select')).toHaveValue('Georgia, serif');
  await expect(inspectorRow(page, 'Base size').locator('input')).toHaveValue('18');

  // Selecting a text element swaps Page controls for always-visible quick
  // formatting plus folded precision controls.
  await selectPreviewElementThroughBridge(page, frame, '[data-readable-id="hero-title"]', 'Text');
  await expect(inspectorSurface(page, 'Shape')).toBeVisible();
  await expect(inspectorSection(page, 'Page')).toHaveCount(0);

  const fontSizeInput = inspector.getByLabel('Font size', { exact: true });
  await fontSizeInput.fill('48');
  await inspector.getByLabel('Text color value', { exact: true }).fill('#ef4444');
  await expect(fontSizeInput).toHaveValue('48');

  // Edits preview live on the selected element.
  const title = frame.getByRole('heading', { name: 'Original Hero' });
  await expect.poll(async () => title.evaluate((el) => getComputedStyle(el).fontSize)).toBe('48px');
  await expect(title).toHaveCSS('color', 'rgb(239, 68, 68)');

  // Computed px is still Auto until the user pins it. Switching to Fill must
  // live-apply through the production style validator, not just toggle the UI.
  await inspector.getByRole('button', { name: /Size & position/ }).click();
  await expect(inspector.getByRole('button', { name: 'Auto Width' })).toHaveAttribute('aria-pressed', 'true');
  await inspector.getByRole('button', { name: 'Fill Width' }).click();
  await expect.poll(async () => title.evaluate((el) => (el as HTMLElement).style.width)).toBe('100%');

  // Exiting edit mode flushes staged edits to the file and restores chat.
  await page.getByTestId('manual-edit-mode-toggle').click();
  await expect(page.locator('.manual-edit-left-inspector')).toHaveCount(0);
  await expectFileSource(page, projectId, 'manual-edit.html', [
    // Element edits (selected hero title): the browser serializes the applied
    // color as rgb() when the style attribute round-trips.
    'font-size: 48px',
    'rgb(239, 68, 68)',
    'width: 100%',
    // Page edits (body) flushed when the element selection took over.
    'background-color: rgb(238, 242, 255)',
  ]);
  await expectFileSourceExcludes(page, projectId, 'manual-edit.html', ['data-readable-edit-selected']);
  await expect(page.locator('.manual-edit-error')).toHaveCount(0);

  await expect(page.getByRole('button', { name: /^Share$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Download$/ })).toBeVisible();
});

test('[P0] manual edit direct text typing persists text-only elements', async ({ page }) => {
  await routeMockAgents(page);
  const projectId = await createEmptyProject(page, 'Manual edit text typing');
  await seedHtmlArtifact(page, projectId, 'manual-edit.html', manualEditHtml());
  await page.goto(`/projects/${projectId}/files/manual-edit.html`);
  await openDesignFile(page, 'manual-edit.html');

  const frame = artifactPreviewFrame(page);
  const textOnlyDiv = frame.locator('[data-readable-id="pair-a"]');
  await expect(textOnlyDiv).toHaveText('Left panel');

  await page.getByTestId('manual-edit-mode-toggle').click();
  await expect(frame.locator('html[data-readable-edit-mode]')).toHaveCount(1);
  await textOnlyDiv.click();
  // Text-only elements open a formatting-capable (rich) contenteditable so
  // B/I/U can emit markup; only links/non-text leaves get plaintext-only.
  await expect(textOnlyDiv).toHaveAttribute('contenteditable', 'true');

  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Edited left panel');
  await page.keyboard.press('Enter');

  await expectFileSource(page, projectId, 'manual-edit.html', ['Edited left panel']);
  await expect(frame.getByText('Edited left panel')).toBeVisible();
});

test('[P0] manual edit selects and persists semantic SVG visualization roots', async ({ page }) => {
  await routeMockAgents(page);
  const projectId = await createEmptyProject(page, 'Manual edit semantic SVG deck');
  const template = readFileSync(new URL('../../templates/deck-framework.html', import.meta.url), 'utf8');
  const deckHtml = template
    .replace('<!-- SLOT: deck title -->', 'Semantic SVG deck')
    .replace('<!-- SLOT: slide 1 content -->', '<h1>Slide One</h1>')
    .replace('<!-- SLOT: slide 2 content -->', semanticSvgDeckVisualHtml());
  const seedResp = await page.request.post(
    `/api/projects/${projectId}/files`,
    {
      data: {
        name: 'semantic-svg-deck.html',
        content: deckHtml,
        artifactManifest: {
          schema: 'readable-studio.artifact-manifest.v1',
          kind: 'deck',
          title: 'Semantic SVG deck',
          entry: 'semantic-svg-deck.html',
          renderer: 'deck-html',
          exports: ['html', 'pptx'],
        },
      },
      timeout: T.medium,
    },
  );
  expect(seedResp.ok()).toBeTruthy();
  await page.goto(`/projects/${projectId}/files/semantic-svg-deck.html`);
  await openDesignFile(page, 'semantic-svg-deck.html');

  const frame = artifactPreviewFrame(page);
  await expect(frame.locator('#deck-cur')).toHaveText('01');
  await page.getByLabel('Next slide').click();
  await expect(frame.locator('#deck-cur')).toHaveText('02');
  const diagram = frame.locator('svg[role="img"][aria-label="Diagram"]');
  await expect(diagram).toBeVisible();
  const diagramText = diagram.locator('text');

  await page.getByTestId('manual-edit-mode-toggle').click();
  await expect(frame.locator('html[data-readable-edit-mode]')).toHaveCount(1);
  await diagramText.click();
  await expect(frame.locator('svg[role="img"][aria-label="Diagram"][data-readable-edit-selected="true"]')).toHaveCount(1);
  await expect(diagram).not.toHaveAttribute('contenteditable');
  await expect(inspectorSurface(page, 'Shape')).toBeVisible();

  await page.keyboard.press('ArrowRight');

  await expect.poll(async () => {
    const resp = await page.request.get(`/api/projects/${projectId}/files/semantic-svg-deck.html`);
    if (!resp.ok()) return '';
    const source = await resp.text();
    return source.match(/<svg\b[^>]*aria-label="Diagram"[^>]*>/)?.[0] ?? '';
  }).toMatch(/translate:/);
  await expect.poll(async () => {
    const resp = await page.request.get(`/api/projects/${projectId}/files/semantic-svg-deck.html`);
    if (!resp.ok()) return '';
    const source = await resp.text();
    return source.match(/<svg\b[^>]*aria-label="Diagram"[^>]*>/)?.[0] ?? '';
  }).not.toMatch(/data-readable-(?:source-path|runtime-id|edit-selected)/);
});

test('[P1] issue 33 manual edit history preserves preview identity and focus', async ({ page }) => {
  await routeMockAgents(page);
  const projectId = await createEmptyProject(page, 'Issue 33 manual edit history');
  await seedHtmlArtifact(page, projectId, 'manual-edit.html', manualEditHtml());
  await page.goto(`/projects/${projectId}/files/manual-edit.html`);
  await openDesignFile(page, 'manual-edit.html');

  const frame = artifactPreviewFrame(page);
  const textOnlyDiv = frame.locator('[data-readable-id="pair-a"]');
  await expect(textOnlyDiv).toHaveText('Left panel');

  await page.getByTestId('manual-edit-mode-toggle').click();
  await expect(frame.locator('html[data-readable-edit-mode]')).toHaveCount(1);

  const moveSurface = page.getByRole('group', { name: 'Move element' }).locator('[data-region="interior"]');
  const armFrameLoad = async () => {
    await artifactPreview(page).evaluate((node) => {
      const frameNode = node as HTMLIFrameElement & { __readableStudioIssue33NextLoad?: Promise<void> };
      frameNode.__readableStudioIssue33NextLoad = new Promise((resolve) => {
        frameNode.addEventListener('load', () => resolve(), { once: true });
      });
    });
  };
  const waitForFrameLoad = () => artifactPreview(page).evaluate((node) => {
    const frameNode = node as HTMLIFrameElement & { __readableStudioIssue33NextLoad?: Promise<void> };
    return frameNode.__readableStudioIssue33NextLoad;
  });
  const commitText = async (text: string, beginInlineEdit: () => Promise<void>) => {
    const previousElement = await textOnlyDiv.elementHandle();
    if (!previousElement) throw new Error('pair-a has no element handle before inline edit');
    await beginInlineEdit();
    await expect(textOnlyDiv).toHaveAttribute('contenteditable', 'true');
    await expect.poll(() => textOnlyDiv.evaluate((node) => document.activeElement === node)).toBe(true);
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type(text);
    await expect(textOnlyDiv).toHaveText(text);
    await armFrameLoad();
    await page.keyboard.press('Enter');
    await waitForFrameLoad();
    await expectFileSource(page, projectId, 'manual-edit.html', [text]);
    await expect(textOnlyDiv).toHaveText(text);
    await expect.poll(async () => {
      try {
        return await previousElement.evaluate((node) => node.isConnected);
      } catch {
        return false;
      }
    }).toBe(false);
    await expect(frame.locator('[data-readable-id="pair-a"][data-readable-edit-selected="true"]')).toHaveCount(1);
    await expect(moveSurface).toBeVisible();
  };

  await commitText('First edit', () => textOnlyDiv.click());
  await commitText('Second edit', async () => {
    await moveSurface.click();
    await textOnlyDiv.click();
  });

  const originalFrame = await artifactPreview(page).elementHandle();
  if (!originalFrame) throw new Error('active preview iframe has no element handle');

  const expectHistoryState = async (text: string, excludedText: string[]) => {
    await expectFileSource(page, projectId, 'manual-edit.html', [text]);
    await expectFileSourceExcludes(page, projectId, 'manual-edit.html', excludedText);
    await expect(frame.locator('[data-readable-id="pair-a"]')).toHaveText(text);
    await expect(frame.locator('[data-readable-id="pair-a"][data-readable-edit-selected="true"]')).toHaveCount(1);
    await expect(page.getByRole('group', { name: 'Move element' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Resize bottom-right corner' })).toBeVisible();
    await expect.poll(() => originalFrame.evaluate((node) => node.isConnected)).toBe(true);
    await expect.poll(() => artifactPreview(page).evaluate((node, expected) => node === expected, originalFrame)).toBe(true);
    await expect.poll(() => page.evaluate((expected) => document.activeElement === expected, originalFrame)).toBe(true);
  };

  await expectHistoryState('Second edit', ['First edit', 'Left panel']);

  await armFrameLoad();
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+z');
  await waitForFrameLoad();
  await expectHistoryState('Left panel', ['First edit', 'Second edit']);

  await armFrameLoad();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await waitForFrameLoad();
  await expectHistoryState('Second edit', ['First edit', 'Left panel']);

  const beforeNudge = await textOnlyDiv.boundingBox();
  if (!beforeNudge) throw new Error('selected element has no bounding box before keyboard nudge');
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(async () => {
      const resp = await page.request.get(`/api/projects/${projectId}/files/manual-edit.html`);
      if (!resp.ok()) return '';
      return resp.text();
    })
    .toMatch(/data-readable-id="pair-a"[^>]*style="[^"]*translate:\s*1px(?:\s+0px)?/);
  await expect
    .poll(async () => {
      const afterNudge = await textOnlyDiv.boundingBox();
      return afterNudge ? Math.abs((afterNudge.x - beforeNudge.x) - 1) < 0.5 : false;
    })
    .toBe(true);
  await expect.poll(() => page.evaluate((expected) => document.activeElement === expected, originalFrame)).toBe(true);
  await expect(frame.locator('[data-readable-id="pair-a"][data-readable-edit-selected="true"]')).toHaveCount(1);

  const resizeHandle = page.getByRole('button', { name: 'Resize bottom-right corner' });
  const resizeBox = await resizeHandle.boundingBox();
  if (!resizeBox) throw new Error('resize handle has no bounding box after history');
  const resizeX = resizeBox.x + resizeBox.width / 2;
  const resizeY = resizeBox.y + resizeBox.height / 2;
  await page.mouse.move(resizeX, resizeY);
  await page.mouse.down();
  await page.mouse.move(resizeX + 20, resizeY + 20, { steps: 4 });
  await page.mouse.up();
  await expect
    .poll(async () => {
      const resp = await page.request.get(`/api/projects/${projectId}/files/manual-edit.html`);
      if (!resp.ok()) return '';
      const source = await resp.text();
      return source.match(/data-readable-id="pair-a"[^>]*style="([^"]*)"/)?.[1] ?? '';
    })
    .toMatch(/width:\s*\d+px;.*height:\s*\d+px/);
});

test('[P0] manual edit mode preserves preview actions after style edits', async ({ page }) => {
  await routeMockAgents(page);
  const projectId = await createEmptyProject(page, 'Manual edit smoke');
  await seedHtmlArtifact(page, projectId, 'manual-edit.html', manualEditHtml());
  await page.goto(`/projects/${projectId}/files/manual-edit.html`);
  await openDesignFile(page, 'manual-edit.html');

  await expect(artifactPreview(page)).toBeVisible();
  const frame = artifactPreviewFrame(page);
  await expect(frame.getByRole('heading', { name: 'Original Hero' })).toBeVisible();

  await page.getByTestId('manual-edit-mode-toggle').click();
  await selectPreviewElementThroughBridge(page, frame, '[data-readable-id="hero-title"]', 'Text');
  const fontSizeInput = await selectStyleRowInput(page, frame, '[data-readable-id="hero-title"]', 'Text', 'Font size');
  await fontSizeInput.fill('48');

  // Exit edit mode to flush the staged style edit to the file.
  await page.getByTestId('manual-edit-mode-toggle').click();
  await expectFileSource(page, projectId, 'manual-edit.html', ['font-size: 48px']);
  await expect(frame.getByRole('heading', { name: 'Original Hero' })).toBeVisible();

  await page.getByTestId('board-mode-toggle').click();
  await expect(page.getByRole('button', { name: /^Comment$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Share$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Download$/ })).toBeVisible();
});

test('[P1] manual edit resize handle drag grows selected element and persists width/height', async ({ page }) => {
  await routeMockAgents(page);
  const projectId = await createEmptyProject(page, 'Manual edit resize smoke');
  await seedHtmlArtifact(page, projectId, 'manual-edit.html', manualEditHtml());
  await page.goto(`/projects/${projectId}/files/manual-edit.html`);
  await openDesignFile(page, 'manual-edit.html');

  const frame = artifactPreviewFrame(page);
  await expect(frame.getByRole('heading', { name: 'Original Hero' })).toBeVisible();

  await page.getByTestId('manual-edit-mode-toggle').click();
  // The Shape section carries sizing controls; the resize handles overlay the
  // preview element itself, independent of where the controls are docked.
  await selectPreviewElementThroughBridge(page, frame, '[data-readable-id="hero-title"]', 'Shape');

  const heroTitle = frame.locator('[data-readable-id="hero-title"]');
  const before = await heroTitle.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });

  const handle = page.getByRole('button', { name: 'Resize bottom-right corner' });
  await expect(handle).toBeVisible();
  const box = await handle.boundingBox();
  if (!box) throw new Error('resize handle has no bounding box');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 80, startY + 80, { steps: 8 });
  await expect
    .poll(async () => heroTitle.evaluate((el) => (el as HTMLElement).style.width))
    .not.toBe('');
  await page.mouse.up();

  await expect
    .poll(async () => {
      const resp = await page.request.get(`/api/projects/${projectId}/files/manual-edit.html`);
      if (!resp.ok()) return false;
      const source = await resp.text();
      const match = source.match(/data-readable-id="hero-title"[^>]*style="([^"]*)"/);
      const style = match?.[1];
      if (!style) return false;
      const widthMatch = style.match(/width:\s*(\d+)px/);
      const heightMatch = style.match(/height:\s*(\d+)px/);
      const width = widthMatch?.[1];
      const height = heightMatch?.[1];
      if (!width || !height) return false;
      return Number(width) > Math.round(before.width) && Number(height) > Math.round(before.height);
    })
    .toBe(true);
  await expect(page.locator('.manual-edit-error')).toHaveCount(0);
});

test('[P1] constrained resize explains the applied max-width while preserving the authored request', async ({ page }) => {
  await routeMockAgents(page);
  const projectId = await createEmptyProject(page, 'Manual edit constrained resize');
  await seedHtmlArtifact(page, projectId, 'manual-edit.html', manualEditHtml());
  await page.goto(`/projects/${projectId}/files/manual-edit.html`);
  await openDesignFile(page, 'manual-edit.html');

  const frame = artifactPreviewFrame(page);
  const constrainedCopy = frame.locator('[data-readable-id="constrained-copy"]');
  await expect(constrainedCopy).toBeVisible();
  await page.getByTestId('manual-edit-mode-toggle').click();
  await selectPreviewElementThroughBridge(page, frame, '[data-readable-id="constrained-copy"]', 'Shape');

  const before = await constrainedCopy.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, maxWidth: getComputedStyle(element).maxWidth };
  });
  expect(Math.abs(before.width - Number.parseFloat(before.maxWidth))).toBeLessThan(1);

  const eastHandle = page.getByRole('button', { name: 'Resize right edge' });
  const handleBox = await eastHandle.boundingBox();
  if (!handleBox) throw new Error('resize handle has no bounding box');
  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  const requestedWidth = Math.round(before.width + 160);

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 160, startY, { steps: 8 });

  await expect
    .poll(async () => {
      const current = await constrainedCopy.boundingBox();
      return current ? Math.abs(current.width - before.width) : Number.POSITIVE_INFINITY;
    })
    .toBeLessThan(2);
  await expect
    .poll(async () => {
      const handle = await eastHandle.boundingBox();
      const element = await constrainedCopy.boundingBox();
      if (!handle || !element) return Number.POSITIVE_INFINITY;
      return Math.abs((handle.x + handle.width / 2) - (element.x + element.width));
    })
    .toBeLessThan(4);

  await page.mouse.up();

  const status = page.getByRole('status');
  await expect(status).toContainText('Width limited by max-width: 30ch');
  await expect(status).toContainText(`${requestedWidth}px requested`);
  await expect(status).toContainText(`${Math.round(before.width)}px rendered`);

  await expect
    .poll(async () => {
      const resp = await page.request.get(`/api/projects/${projectId}/files/manual-edit.html`);
      if (!resp.ok()) return '';
      const source = await resp.text();
      const inlineStyle = source.match(/data-readable-id="constrained-copy"[^>]*style="([^"]*)"/)?.[1] ?? '';
      return `${inlineStyle}\n${source.includes('max-width: 30ch')}`;
    })
    .toMatch(new RegExp(`width:\\s*${requestedWidth}px[\\s\\S]*true`));
  await expect(constrainedCopy).toHaveCSS('max-width', before.maxWidth);
});

test('[P1] constrained resize callout remains readable on an 8px target', async ({ page }) => {
  await routeMockAgents(page);
  const projectId = await createEmptyProject(page, 'Tiny constrained resize feedback');
  await seedHtmlArtifact(
    page,
    projectId,
    'manual-edit.html',
    manualEditHtml().replace(
      'width: 420px; max-width: 30ch;',
      'position: fixed; top: 120px; right: 0; margin: 0; width: 8px; height: 8px; max-width: 8px; overflow: hidden;',
    ),
  );
  await page.goto(`/projects/${projectId}/files/manual-edit.html`);
  await openDesignFile(page, 'manual-edit.html');

  const frame = artifactPreviewFrame(page);
  const constrainedCopy = frame.locator('[data-readable-id="constrained-copy"]');
  await page.getByTestId('manual-edit-mode-toggle').click();
  await selectPreviewElementThroughBridge(page, frame, '[data-readable-id="constrained-copy"]', 'Shape');

  const westHandle = page.getByRole('button', { name: 'Resize left edge' });
  const handleBox = await westHandle.boundingBox();
  if (!handleBox) throw new Error('resize handle has no bounding box');
  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  await westHandle.dispatchEvent('pointerdown', {
    pointerId: 1, clientX: startX, clientY: startY, button: 0,
  });
  await westHandle.dispatchEvent('pointermove', {
    pointerId: 1, clientX: startX - 160, clientY: startY, buttons: 1,
  });

  const callout = page.getByTestId('manual-edit-resize-callout');
  await expect(callout).toBeVisible();
  const calloutBox = await callout.boundingBox();
  const constrainedBox = await constrainedCopy.boundingBox();
  const workspaceBox = await page.locator('.manual-edit-workspace').boundingBox();
  if (!calloutBox || !constrainedBox || !workspaceBox) {
    throw new Error('constraint feedback was not measurable');
  }
  expect(constrainedBox.width).toBeLessThanOrEqual(8);
  expect(constrainedBox.height).toBeLessThanOrEqual(8);
  expect(calloutBox.width).toBeGreaterThan(120);
  expect(calloutBox.x).toBeGreaterThanOrEqual(workspaceBox.x + 12);
  expect(calloutBox.y).toBeGreaterThanOrEqual(workspaceBox.y + 12);
  expect(calloutBox.x + calloutBox.width).toBeLessThanOrEqual(
    workspaceBox.x + workspaceBox.width - 12,
  );
  expect(calloutBox.y + calloutBox.height).toBeLessThanOrEqual(
    workspaceBox.y + workspaceBox.height - 12,
  );

  await westHandle.dispatchEvent('pointerup', {
    pointerId: 1, clientX: startX - 160, clientY: startY, button: 0,
  });
});

test('[P1] Desktop manual edit iframe follows the live canvas width', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await routeMockAgents(page);
  const projectId = await createEmptyProject(page, 'Manual edit live Desktop viewport');
  await seedHtmlArtifact(page, projectId, 'manual-edit.html', manualEditHtml());
  await page.goto(`/projects/${projectId}/files/manual-edit.html`);
  await openDesignFile(page, 'manual-edit.html');

  const frame = artifactPreviewFrame(page);
  await page.getByTestId('manual-edit-mode-toggle').click();
  await selectPreviewElementThroughBridge(page, frame, '[data-readable-id="hero-title"]', 'Shape');

  const canvas = page.locator('.manual-edit-canvas');
  const beforeCanvas = await canvas.boundingBox();
  const beforeInner = await frame.locator('html').evaluate(() => window.innerWidth);
  if (!beforeCanvas || !beforeInner) throw new Error('Desktop edit preview was not measurable');
  const beforeGap = beforeCanvas.width - beforeInner;

  await page.setViewportSize({ width: 1300, height: 900 });

  await expect
    .poll(async () => (await canvas.boundingBox())?.width ?? beforeCanvas.width)
    .toBeLessThan(beforeCanvas.width - 100);
  await expect
    .poll(async () => frame.locator('html').evaluate(() => window.innerWidth))
    .toBeLessThan(beforeInner - 100);
  await expect
    .poll(async () => {
      const canvasBox = await canvas.boundingBox();
      const iframeInner = await frame.locator('html').evaluate(() => window.innerWidth);
      if (!canvasBox || !iframeInner) return Number.POSITIVE_INFINITY;
      return Math.abs((canvasBox.width - iframeInner) - beforeGap);
    })
    .toBeLessThan(4);

  const heroTitle = frame.locator('[data-readable-id="hero-title"]');
  const eastHandle = page.getByRole('button', { name: 'Resize right edge' });
  await expect
    .poll(async () => {
      const handle = await eastHandle.boundingBox();
      const element = await heroTitle.boundingBox();
      if (!handle || !element) return Number.POSITIVE_INFINITY;
      return Math.abs((handle.x + handle.width / 2) - (element.x + element.width));
    })
    .toBeLessThan(4);
});

test('[P1] issue 16 move browser verification', async ({ page }) => {
  await routeMockAgents(page);
  const projectId = await createEmptyProject(page, 'Issue 16 move browser verification');
  const transformedSource = manualEditHtml().replace(
    'style="display:flex;gap:8px;align-items:center;"',
    'style="display:flex;gap:8px;align-items:center;transform:scale(1.25);transform-origin:top left;"',
  );
  await seedHtmlArtifact(page, projectId, 'manual-edit.html', transformedSource);
  await page.goto(`/projects/${projectId}/files/manual-edit.html`);
  await openDesignFile(page, 'manual-edit.html');

  const frame = artifactPreviewFrame(page);
  const image = frame.locator('[data-readable-id="hero-image"]');
  await expect(image).toBeVisible();
  await page.getByRole('button', { name: '100%' }).click();
  await page.getByRole('menuitem', { name: '50%', exact: true }).click();
  await page.getByTestId('manual-edit-mode-toggle').click();
  await expect(frame.locator('html[data-readable-edit-mode]')).toHaveCount(1);
  await image.click();
  await expect(frame.locator('[data-readable-id="hero-image"][data-readable-edit-selected="true"]')).toHaveCount(1);

  const before = await image.boundingBox();
  if (!before) throw new Error('image has no bounding box before move');
  const moveSurface = page.getByRole('group', { name: 'Move element' }).locator('[data-region="interior"]');
  await expect(moveSurface).toBeVisible();
  const moveBox = await moveSurface.boundingBox();
  if (!moveBox) throw new Error('move surface has no bounding box');
  const startX = moveBox.x + moveBox.width / 2;
  const startY = moveBox.y + moveBox.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 80, startY + 40, { steps: 8 });
  await expect
    .poll(async () => {
      const current = await image.boundingBox();
      return current
        ? Math.abs((current.x - before.x) - 80) < 4
          && Math.abs((current.y - before.y) - 40) < 4
        : false;
    })
    .toBe(true);
  await page.mouse.up();

  await expect
    .poll(async () => {
      const resp = await page.request.get(`/api/projects/${projectId}/files/manual-edit.html`);
      if (!resp.ok()) return '';
      const source = await resp.text();
      return source.match(/data-readable-id="hero-image"[^>]*style="([^"]*)"/)?.[1] ?? '';
    })
    .toMatch(/translate:\s*128px\s+64px/);
  const moved = await image.boundingBox();
  if (!moved) throw new Error('image has no bounding box after move');
  expect(Math.abs((moved.x - before.x) - 80)).toBeLessThan(2);
  expect(Math.abs((moved.y - before.y) - 40)).toBeLessThan(2);

  await page.keyboard.press('Control+z');

  await expect
    .poll(async () => {
      const resp = await page.request.get(`/api/projects/${projectId}/files/manual-edit.html`);
      if (!resp.ok()) return false;
      const source = await resp.text();
      const style = source.match(/data-readable-id="hero-image"[^>]*style="([^"]*)"/)?.[1] ?? '';
      return !/\btranslate:/.test(style);
    })
    .toBe(true);
  await expect
    .poll(async () => {
      const undone = await image.boundingBox();
      return undone
        ? Math.abs(undone.x - before.x) < 1 && Math.abs(undone.y - before.y) < 1
        : false;
    })
    .toBe(true);
});

test('[P1] issue 48 Ctrl-drag duplicates a source object with stable preview and history', async ({ page }) => {
  await routeMockAgents(page);
  const projectId = await createEmptyProject(page, 'Issue 48 Ctrl-drag duplication');
  await seedHtmlArtifact(page, projectId, 'manual-edit.html', duplicateManualEditHtml());
  await page.goto(`/projects/${projectId}/files/manual-edit.html`);
  await openDesignFile(page, 'manual-edit.html');

  const frame = artifactPreviewFrame(page);
  const original = frame.locator('[data-readable-id="duplicate-card"]');
  await expect(original).toBeVisible();
  await page.getByTestId('manual-edit-mode-toggle').click();
  await frame.locator('[data-readable-id="duplicate-card"]').click({ position: { x: 4, y: 4 } });
  await expect(inspectorSurface(page, 'Shape')).toBeVisible();
  await expect(frame.locator('[data-readable-id="duplicate-card"][data-readable-edit-selected="true"]')).toHaveCount(1);

  const moveSurface = page.getByRole('group', { name: 'Move element' }).locator('[data-region="interior"]');
  const moveBox = await moveSurface.boundingBox();
  const before = await original.boundingBox();
  if (!moveBox || !before) throw new Error('duplicate target has no move geometry');
  const startX = moveBox.x + moveBox.width / 2;
  const startY = moveBox.y + moveBox.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // First move without Ctrl so the next key transition proves that the
  // original is restored before the transient clone takes over.
  await page.mouse.move(startX + 12, startY, { steps: 2 });
  await expect.poll(async () => {
    const current = await original.boundingBox();
    return current ? Math.abs(current.x - before.x) > 4 : false;
  }).toBe(true);

  await page.keyboard.down('Control');
  const transient = frame.locator('[data-readable-id="duplicate-card-copy"][data-readable-edit-transient="true"]');
  await expect(transient).toHaveCount(1);
  await expect.poll(async () => {
    const current = await original.boundingBox();
    return current
      ? Math.abs(current.x - before.x) < 1 && Math.abs(current.y - before.y) < 1
      : false;
  }).toBe(true);

  await page.mouse.move(startX + 72, startY + 40, { steps: 6 });
  await expect.poll(async () => {
    const current = await transient.boundingBox();
    return current
      ? Math.abs((current.x - before.x) - 72) < 4 && Math.abs((current.y - before.y) - 40) < 4
      : false;
  }).toBe(true);
  await page.mouse.up();
  await page.keyboard.up('Control');

  const readSource = async () => {
    const response = await page.request.get(`/api/projects/${projectId}/files/manual-edit.html`);
    return response.ok() ? response.text() : '';
  };
  const tagFor = (source: string, id: string) =>
    source.match(new RegExp(`<div[^>]*data-readable-id="${id}"[^>]*>`))?.[0] ?? '';
  await expect.poll(async () => {
    const source = await readSource();
    const originalTag = tagFor(source, 'duplicate-card');
    const cloneTag = tagFor(source, 'duplicate-card-copy');
    return cloneTag.includes('id="card-root-copy"')
      && cloneTag.includes('translate:')
      && !originalTag.includes('translate:')
      && source.includes('href="#card-title-copy"');
  }).toBe(true);
  await expect(frame.locator('[data-readable-id="duplicate-card-copy"][data-readable-edit-selected="true"]')).toHaveCount(1);
  const committedCloneTag = tagFor(await readSource(), 'duplicate-card-copy');

  await page.keyboard.press('Control+z');
  await expectFileSourceExcludes(page, projectId, 'manual-edit.html', [
    'data-readable-id="duplicate-card-copy"',
    'id="card-root-copy"',
  ]);
  await expect(frame.locator('[data-readable-id="duplicate-card"][data-readable-edit-selected="true"]')).toHaveCount(1);

  await page.keyboard.press('Control+Shift+z');
  await expect.poll(async () => tagFor(await readSource(), 'duplicate-card-copy')).toBe(committedCloneTag);
  await expect(frame.locator('[data-readable-id="duplicate-card-copy"][data-readable-edit-selected="true"]')).toHaveCount(1);
});

test('[P1] issue 34 selects a nested child through the selected parent move surface', async ({ page }) => {
  await routeMockAgents(page);
  const fileName = 'issue-34-nested-child.html';
  const projectId = await createEmptyProject(page, 'Issue 34 nested child selection');
  await seedHtmlArtifact(page, projectId, fileName, issue34NestedChildHtml());
  await page.goto(`/projects/${projectId}/files/${fileName}`);
  await openDesignFile(page, fileName);

  const frame = artifactPreviewFrame(page);
  const parent = frame.locator('[data-readable-id="issue-34-parent"]');
  const child = frame.locator('[data-readable-id="issue-34-child"]');
  await expect(parent).toBeVisible();
  await expect(child).toBeVisible();

  await page.getByTestId('manual-edit-mode-toggle').click();
  await expect(frame.locator('html[data-readable-edit-mode]')).toHaveCount(1);
  await child.click();
  await expect(child).toHaveAttribute('data-readable-edit-selected', 'true');
  await page.keyboard.press('Escape');
  await parent.click({ position: { x: 20, y: 20 } });
  await expect(parent).toHaveAttribute('data-readable-edit-selected', 'true');
  await expect(parent).toHaveAttribute('contenteditable', 'true');
  await page.keyboard.press('Escape');
  await expect(parent).not.toHaveAttribute('contenteditable', 'true');
  await expect(
    page.getByRole('group', { name: 'Move element' }).locator('[data-region="interior"]'),
  ).toBeVisible();

  const childBox = await child.boundingBox();
  if (!childBox) throw new Error('nested child has no bounding box');
  const startX = childBox.x + childBox.width / 2;
  const startY = childBox.y + childBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 4, startY + 4);
  await page.mouse.up();

  await expect(child).toHaveAttribute('data-readable-edit-selected', 'true');
  await expect(parent).not.toHaveAttribute('contenteditable', 'true');

  await page.getByTestId('manual-edit-mode-toggle').click();
  const response = await page.request.get(`/api/projects/${projectId}/files/${fileName}`);
  expect(response.ok()).toBeTruthy();
  const source = await response.text();
  const parentStyle = source.match(/data-readable-id="issue-34-parent"[^>]*style="([^"]*)"/)?.[1] ?? '';
  expect(parentStyle).not.toMatch(/\btranslate\s*:/);
});

test('[P1] issue 34 keeps dragging the selected parent when the drag starts over its nested child', async ({ page }) => {
  await routeMockAgents(page);
  const fileName = 'issue-34-nested-child-drag.html';
  const projectId = await createEmptyProject(page, 'Issue 34 nested child drag');
  await seedHtmlArtifact(page, projectId, fileName, issue34NestedChildHtml());
  await page.goto(`/projects/${projectId}/files/${fileName}`);
  await openDesignFile(page, fileName);

  const frame = artifactPreviewFrame(page);
  const parent = frame.locator('[data-readable-id="issue-34-parent"]');
  const child = frame.locator('[data-readable-id="issue-34-child"]');
  await page.getByTestId('manual-edit-mode-toggle').click();
  await expect(frame.locator('html[data-readable-edit-mode]')).toHaveCount(1);
  await parent.click({ position: { x: 40, y: 20 } });
  await expect(parent).toHaveAttribute('contenteditable', 'true');
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('group', { name: 'Move element' }).locator('[data-region="interior"]'),
  ).toBeVisible();

  const parentBefore = await parent.boundingBox();
  const childBox = await child.boundingBox();
  if (!parentBefore || !childBox) throw new Error('issue 34 drag fixture has no bounding box');
  const startX = childBox.x + childBox.width / 2;
  const startY = childBox.y + childBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 40, startY + 32);
  await page.mouse.up();

  await expect(parent).toHaveAttribute('data-readable-edit-selected', 'true');
  await expect(child).not.toHaveAttribute('data-readable-edit-selected', 'true');
  await expect.poll(async () => (await parent.boundingBox())?.x ?? 0).toBeGreaterThan(parentBefore.x + 30);

  await page.getByTestId('manual-edit-mode-toggle').click();
  const response = await page.request.get(`/api/projects/${projectId}/files/${fileName}`);
  expect(response.ok()).toBeTruthy();
  const source = await response.text();
  const parentStyle = source.match(/data-readable-id="issue-34-parent"[^>]*style="([^"]*)"/)?.[1] ?? '';
  expect(parentStyle).toMatch(/\btranslate\s*:\s*40px 32px/);
});

test('[P1] issue 34 selects a nested child whose center is inside the selected ring band', async ({ page }) => {
  await routeMockAgents(page);
  const fileName = 'issue-34-ring-child.html';
  const projectId = await createEmptyProject(page, 'Issue 34 ring child selection');
  await seedHtmlArtifact(page, projectId, fileName, issue34NestedChildHtml());
  await page.goto(`/projects/${projectId}/files/${fileName}`);
  await openDesignFile(page, fileName);

  const frame = artifactPreviewFrame(page);
  const parent = frame.locator('[data-readable-id="issue-34-parent"]');
  const ringChild = frame.locator('[data-readable-id="issue-34-ring-child"]');
  await page.getByTestId('manual-edit-mode-toggle').click();
  await expect(frame.locator('html[data-readable-edit-mode]')).toHaveCount(1);
  await parent.click({ position: { x: 40, y: 20 } });
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('group', { name: 'Move element' }).locator('[data-region="ring"]').first(),
  ).toBeVisible();

  const parentBox = await parent.boundingBox();
  const ringChildBox = await ringChild.boundingBox();
  if (!parentBox || !ringChildBox) throw new Error('issue 34 ring fixture has no bounding box');
  const childCenterX = ringChildBox.x + ringChildBox.width / 2;
  const childCenterY = ringChildBox.y + ringChildBox.height / 2;
  expect(childCenterX - parentBox.x).toBeLessThan(10);
  await page.mouse.click(childCenterX, childCenterY);

  await expect(ringChild).toHaveAttribute('data-readable-edit-selected', 'true');
});

test('[P1] issue 39 outlines only the inline-edit nested child', async ({ page }) => {
  await routeMockAgents(page);
  const fileName = 'issue-39-nested-outline.html';
  const projectId = await createEmptyProject(page, 'Issue 39 nested outline');
  await seedHtmlArtifact(page, projectId, fileName, issue34NestedChildHtml());
  await page.goto(`/projects/${projectId}/files/${fileName}`);
  await openDesignFile(page, fileName);

  const frame = artifactPreviewFrame(page);
  const parent = frame.locator('[data-readable-id="issue-34-parent"]');
  const child = frame.locator('[data-readable-id="issue-34-child"]');
  const outlinedTargetIds = () => frame.locator('[data-readable-id]').evaluateAll((nodes) => nodes
    .filter((node) => {
      const style = getComputedStyle(node);
      return style.outlineStyle === 'solid'
        && style.outlineColor === 'rgb(37, 99, 235)'
        && Number.parseFloat(style.outlineWidth) > 0;
    })
    .map((node) => node.getAttribute('data-readable-id')));
  await page.getByTestId('manual-edit-mode-toggle').click();
  await expect(frame.locator('html[data-readable-edit-mode]')).toHaveCount(1);
  await child.click();
  await expect(frame.locator('[data-readable-edit-selected="true"]')).toHaveCount(1);
  await expect(child).toHaveAttribute('data-readable-edit-selected', 'true');
  await expect(child).toHaveAttribute('data-readable-editing', 'true');
  await expect.poll(outlinedTargetIds).toEqual(['issue-34-child']);
});

test('[P1] issue 39 clears the parent outline when the selected move surface begins child inline edit', async ({ page }) => {
  await routeMockAgents(page);
  const fileName = 'issue-39-move-surface-outline.html';
  const projectId = await createEmptyProject(page, 'Issue 39 move surface outline');
  await seedHtmlArtifact(page, projectId, fileName, issue34NestedChildHtml());
  await page.goto(`/projects/${projectId}/files/${fileName}`);
  await openDesignFile(page, fileName);

  const frame = artifactPreviewFrame(page);
  const parent = frame.locator('[data-readable-id="issue-34-parent"]');
  const child = frame.locator('[data-readable-id="issue-34-child"]');
  await page.getByTestId('manual-edit-mode-toggle').click();
  await expect(frame.locator('html[data-readable-edit-mode]')).toHaveCount(1);
  await parent.click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('group', { name: 'Move element' }).locator('[data-region="interior"]'),
  ).toBeVisible();

  const childBox = await child.boundingBox();
  if (!childBox) throw new Error('nested child has no bounding box');
  const childCenterX = childBox.x + childBox.width / 2;
  const childCenterY = childBox.y + childBox.height / 2;
  await page.mouse.move(childCenterX, childCenterY);
  await page.mouse.down();
  await page.mouse.move(childCenterX + 4, childCenterY + 4);
  await page.mouse.up();

  await expect(frame.locator('[data-readable-edit-selected="true"]')).toHaveCount(1);
  await expect(child).toHaveAttribute('data-readable-edit-selected', 'true');
  await expect(child).toHaveAttribute('data-readable-editing', 'true');
  await expect
    .poll(() => frame.locator('[data-readable-id]').evaluateAll((nodes) => nodes
      .filter((node) => {
        const style = getComputedStyle(node);
        return style.outlineStyle === 'solid'
          && style.outlineColor === 'rgb(37, 99, 235)'
          && Number.parseFloat(style.outlineWidth) > 0;
      })
      .map((node) => node.getAttribute('data-readable-id'))))
    .toEqual(['issue-34-child']);
});

test('[P1] issue 41 keeps bridge paint only for hover and inline editing', async ({ page }) => {
  await routeMockAgents(page);
  const fileName = 'issue-41-selection-paint.html';
  const projectId = await createEmptyProject(page, 'Issue 41 selection paint');
  await seedHtmlArtifact(page, projectId, fileName, issue41SelectionPaintHtml());
  await page.goto(`/projects/${projectId}/files/${fileName}`);
  await openDesignFile(page, fileName);

  const frame = artifactPreviewFrame(page);
  const image = frame.locator('[data-readable-id="issue-41-image"]');
  const text = frame.locator('[data-readable-id="issue-41-text"]');
  const authoredText = frame.locator('[data-readable-id="issue-41-authored-text"]');
  const moveFrame = page.getByRole('group', { name: 'Move element' });
  const resizeHandles = page.getByRole('button', {
    name: /^Resize (?:top|right|bottom|left)/,
  });
  const paint = (selector: string) => frame.locator(selector).evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      hasBridgeOutline: style.outlineStyle === 'solid'
        && style.outlineColor === 'rgb(37, 99, 235)'
        && Number.parseFloat(style.outlineWidth) > 0,
      outlineStyle: style.outlineStyle,
      outlineColor: style.outlineColor,
      outlineWidth: style.outlineWidth,
      outlineOffset: style.outlineOffset,
      boxShadow: style.boxShadow,
      hasBridgeGlow: style.boxShadow === 'rgba(37, 99, 235, 0.16) 0px 0px 0px 4px',
    };
  });
  const authoredImagePaint = {
    hasBridgeOutline: false,
    outlineStyle: 'dashed',
    outlineColor: 'rgb(22, 163, 74)',
    outlineWidth: '3px',
    outlineOffset: '1px',
    boxShadow: 'rgb(168, 85, 247) 0px 0px 0px 3px',
    hasBridgeGlow: false,
  };

  await page.getByTestId('manual-edit-mode-toggle').click();
  await expect(frame.locator('html[data-readable-edit-mode]')).toHaveCount(1);
  await image.click();

  await expect(frame.locator('[data-readable-edit-selected="true"]')).toHaveCount(1);
  await expect(image).toHaveAttribute('data-readable-edit-selected', 'true');
  await expect(image).not.toHaveAttribute('data-readable-editing', 'true');
  await expect(moveFrame).toHaveCount(1);
  await expect(resizeHandles).toHaveCount(8);
  await expect.poll(() => paint('[data-readable-id="issue-41-image"]')).toEqual(authoredImagePaint);

  await text.hover();
  await expect(image).not.toHaveAttribute('data-readable-runtime-hovered', 'true');
  await expect(text).toHaveAttribute('data-readable-runtime-hovered', 'true');
  await expect.poll(() => paint('[data-readable-id="issue-41-image"]')).toEqual(authoredImagePaint);
  await expect
    .poll(() => paint('[data-readable-id="issue-41-text"]'))
    .toMatchObject({
      hasBridgeOutline: true,
      outlineStyle: 'solid',
      outlineColor: 'rgb(37, 99, 235)',
      outlineWidth: '2px',
      outlineOffset: '0px',
      boxShadow: 'none',
      hasBridgeGlow: false,
    });

  await text.click();
  await expect(frame.locator('[data-readable-edit-selected="true"]')).toHaveCount(1);
  await expect(text).toHaveAttribute('data-readable-edit-selected', 'true');
  await expect(text).toHaveAttribute('data-readable-editing', 'true');
  await expect(text).toHaveAttribute('contenteditable', 'true');
  await expect.poll(() => text.evaluate((node) => getComputedStyle(node).cursor)).toBe('text');
  await expect(moveFrame).toHaveCount(1);
  await expect(resizeHandles).toHaveCount(8);
  await expect.poll(() => paint('[data-readable-id="issue-41-text"]')).toMatchObject({
    hasBridgeOutline: true,
    outlineStyle: 'solid',
    outlineColor: 'rgb(37, 99, 235)',
    outlineWidth: '2px',
    outlineOffset: '4px',
    boxShadow: 'rgba(37, 99, 235, 0.16) 0px 0px 0px 4px',
    hasBridgeGlow: true,
  });

  await page.keyboard.press('Escape');
  await expect(frame.locator('[data-readable-edit-selected="true"]')).toHaveCount(1);
  await expect(text).toHaveAttribute('data-readable-edit-selected', 'true');
  await expect(text).not.toHaveAttribute('data-readable-editing', 'true');
  await expect(text).not.toHaveAttribute('contenteditable', 'true');
  await expect(moveFrame).toHaveCount(1);
  await expect(resizeHandles).toHaveCount(8);
  await expect.poll(() => paint('[data-readable-id="issue-41-text"]')).toMatchObject({
    hasBridgeOutline: false,
    boxShadow: 'none',
    hasBridgeGlow: false,
  });

  await authoredText.click();
  await expect(frame.locator('[data-readable-edit-selected="true"]')).toHaveCount(1);
  await expect(authoredText).toHaveAttribute('data-readable-edit-selected', 'true');
  await expect(authoredText).toHaveAttribute('data-readable-editing', 'true');
  await expect.poll(() => paint('[data-readable-id="issue-41-authored-text"]')).toEqual({
    hasBridgeOutline: false,
    outlineStyle: 'double',
    outlineColor: 'rgb(220, 38, 38)',
    outlineWidth: '3px',
    outlineOffset: '2px',
    boxShadow: 'rgb(14, 165, 233) 0px 0px 0px 5px',
    hasBridgeGlow: false,
  });
});

test('[P1] manual edit hover follows the actual pointer beneath the selected move surface', async ({ page }) => {
  await routeMockAgents(page);
  const fileName = 'manual-edit-hover-sync.html';
  const projectId = await createEmptyProject(page, 'Manual edit hover sync');
  await seedHtmlArtifact(page, projectId, fileName, manualEditHoverSyncHtml());
  await page.goto(`/projects/${projectId}/files/${fileName}`);
  await openDesignFile(page, fileName);

  const frame = artifactPreviewFrame(page);
  const top = frame.locator('[data-readable-id="hover-top"]');
  const middle = frame.locator('[data-readable-id="hover-middle"]');
  const child = frame.locator('[data-readable-id="hover-child"]');
  const bottom = frame.locator('[data-readable-id="hover-bottom"]');
  await page.getByTestId('manual-edit-mode-toggle').click();
  await expect(frame.locator('html[data-readable-edit-mode]')).toHaveCount(1);

  await middle.click({ position: { x: 24, y: 24 } });
  await expect(middle).toHaveAttribute('data-readable-edit-selected', 'true');
  await expect(page.getByRole('group', { name: 'Move element' }).locator('[data-region="interior"]')).toBeVisible();

  const center = async (locator: Locator) => {
    const box = await locator.boundingBox();
    if (!box) throw new Error('hover sync fixture target has no bounding box');
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const hoveredIds = () => frame.locator('[data-readable-runtime-hovered="true"]').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-readable-id')),
  );

  const topCenter = await center(top);
  await page.mouse.move(topCenter.x, topCenter.y);
  await expect.poll(hoveredIds).toEqual(['hover-top']);

  const middleBox = await middle.boundingBox();
  if (!middleBox) throw new Error('selected middle target has no bounding box');
  await page.mouse.move(middleBox.x + 24, middleBox.y + 24);
  await expect.poll(hoveredIds).toEqual([]);

  const childCenter = await center(child);
  await page.mouse.move(childCenter.x, childCenter.y);
  await expect.poll(hoveredIds).toEqual(['hover-child']);

  const bottomCenter = await center(bottom);
  await page.mouse.move(bottomCenter.x, bottomCenter.y);
  await expect.poll(hoveredIds).toEqual(['hover-bottom']);
});

test('[P1] issue 43 paints no focus outline on the pressed move surfaces', async ({ page }) => {
  await routeMockAgents(page);
  const projectId = await createEmptyProject(page, 'Issue 43 move surface focus');
  await seedHtmlArtifact(page, projectId, 'manual-edit.html', manualEditHtml());
  await page.goto(`/projects/${projectId}/files/manual-edit.html`);
  await openDesignFile(page, 'manual-edit.html');

  const frame = artifactPreviewFrame(page);
  const image = frame.locator('[data-readable-id="hero-image"]');
  await expect(image).toBeVisible();
  await page.getByTestId('manual-edit-mode-toggle').click();
  await expect(frame.locator('html[data-readable-edit-mode]')).toHaveCount(1);
  await image.click();
  await expect(frame.locator('[data-readable-id="hero-image"][data-readable-edit-selected="true"]')).toHaveCount(1);

  const moveFrame = page.getByRole('group', { name: 'Move element' });
  const interior = moveFrame.locator('[data-region="interior"]');
  const ring = moveFrame.locator('[data-region="ring"]').first();
  await expect(interior).toBeVisible();
  // The pressed surface must own focus AND match :focus-visible — that pairing
  // is what makes Chromium paint its native ring — while painting no outline.
  // Asserting focusVisible keeps the case honest: without it the expectation
  // would also hold in a browser that simply never entered the ringed state.
  const focusPaint = (surface: Locator) => surface.evaluate((node) => ({
    focused: document.activeElement === node,
    focusVisible: node.matches(':focus-visible'),
    outlineStyle: getComputedStyle(node).outlineStyle,
  }));
  const paintedNothing = { focused: true, focusVisible: true, outlineStyle: 'none' };
  // Presses land off the surface midpoints: the resize handles sit one z-index
  // above the move frame and straddle the ring band at its corners and centre.
  const pressSurface = async (surface: Locator) => {
    const box = await surface.boundingBox();
    if (!box) throw new Error('move surface has no bounding box');
    const point = { x: box.x + box.width / 4, y: box.y + box.height / 2 };
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    return point;
  };

  // An uncancelled drag writes the moved translate to the artifact on
  // pointerup; watch for that write across the whole cancel gesture.
  const commitAfterCancel = page
    .waitForRequest(
      (request) => request.method() === 'POST' && request.url().includes(`/api/projects/${projectId}/files`),
      { timeout: T.short },
    )
    .catch(() => null);

  // Escape-cancelling a drag is what flips Chromium's focus modality to
  // keyboard: from here every press would paint the UA focus ring.
  const start = await pressSurface(interior);
  await page.mouse.move(start.x + 60, start.y + 40, { steps: 6 });
  await expect
    .poll(() => image.evaluate((node) => (node as HTMLElement).style.translate))
    .not.toBe('');
  await page.keyboard.press('Escape');
  await page.mouse.move(start.x + 140, start.y + 40, { steps: 4 });
  await page.mouse.up();
  // Escape reached the focused surface and cancelled the drag.
  expect(await commitAfterCancel).toBeNull();
  await expect(moveFrame).toHaveCount(1);

  await pressSurface(interior);
  expect(await focusPaint(interior)).toEqual(paintedNothing);
  await page.mouse.up();
  expect(await focusPaint(interior)).toEqual(paintedNothing);

  await expect(ring).toBeVisible();
  await pressSurface(ring);
  expect(await focusPaint(ring)).toEqual(paintedNothing);
  await page.mouse.up();
  expect(await focusPaint(ring)).toEqual(paintedNothing);
});

test('[P1] manual edit resize handles track the selected element through layout reflows', async ({ page }) => {
  await routeMockAgents(page);
  const projectId = await createEmptyProject(page, 'Manual edit resize alignment');
  await seedHtmlArtifact(page, projectId, 'manual-edit.html', manualEditHtml());
  await page.goto(`/projects/${projectId}/files/manual-edit.html`);
  await openDesignFile(page, 'manual-edit.html');

  const frame = artifactPreviewFrame(page);
  await expect(frame.getByRole('heading', { name: 'Original Hero' })).toBeVisible();

  await page.getByTestId('manual-edit-mode-toggle').click();
  await selectPreviewElementThroughBridge(page, frame, '[data-readable-id="hero-title"]', 'Shape');

  const heroTitle = frame.locator('[data-readable-id="hero-title"]');
  // Reflow the selected element WITHOUT a window resize or scroll — the shape
  // of deck slide navigation / transition settle / media-load reflows. The
  // bridge's layout observer must re-broadcast rects or the host overlays
  // (resize handles, inspector panel, hover icon) keep the stale click-time box.
  await heroTitle.evaluate((el) => {
    (el as HTMLElement).style.padding = '40px';
  });

  const seHandle = page.getByRole('button', { name: 'Resize bottom-right corner' });
  await expect(seHandle).toBeVisible();
  await expect
    .poll(async () => {
      const handleBox = await seHandle.boundingBox();
      const elementBox = await heroTitle.boundingBox();
      if (!handleBox || !elementBox) return Number.POSITIVE_INFINITY;
      const centerX = handleBox.x + handleBox.width / 2;
      const centerY = handleBox.y + handleBox.height / 2;
      return Math.hypot(
        centerX - (elementBox.x + elementBox.width),
        centerY - (elementBox.y + elementBox.height),
      );
    })
    .toBeLessThan(4);
});

test('[P1] manual edit resize pins flex-fill items so a width drag holds and handles track the element', async ({ page }) => {
  await routeMockAgents(page);
  const projectId = await createEmptyProject(page, 'Manual edit resize flex pin');
  await seedHtmlArtifact(page, projectId, 'manual-edit.html', manualEditHtml());
  await page.goto(`/projects/${projectId}/files/manual-edit.html`);
  await openDesignFile(page, 'manual-edit.html');

  const frame = artifactPreviewFrame(page);
  await expect(frame.getByRole('heading', { name: 'Original Hero' })).toBeVisible();

  await page.getByTestId('manual-edit-mode-toggle').click();
  await selectPreviewElementThroughBridge(page, frame, '[data-readable-id="pair-b"]', 'Shape');

  const pairB = frame.locator('[data-readable-id="pair-b"]');
  const before = await pairB.boundingBox();
  if (!before) throw new Error('flex item has no bounding box');

  const eHandle = page.getByRole('button', { name: 'Resize right edge' });
  await expect(eHandle).toBeVisible();
  const box = await eHandle.boundingBox();
  if (!box) throw new Error('resize handle has no bounding box');

  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX - 60, startY, { steps: 6 });

  // `flex: 1 1 0` normally ignores a bare width; the drag preview pins the
  // item (flex: none), so the element's REAL box must follow the pointer…
  await expect
    .poll(async () => {
      const current = await pairB.boundingBox();
      return current ? Math.abs(current.width - (before.width - 60)) : Number.POSITIVE_INFINITY;
    })
    .toBeLessThan(6);
  // …and the handle must track the element's measured edge (fed back through
  // the per-frame preview acks), not the raw cursor position.
  await expect
    .poll(async () => {
      const handleBox = await eHandle.boundingBox();
      const elementBox = await pairB.boundingBox();
      if (!handleBox || !elementBox) return Number.POSITIVE_INFINITY;
      return Math.abs((handleBox.x + handleBox.width / 2) - (elementBox.x + elementBox.width));
    })
    .toBeLessThan(4);
  await page.mouse.up();

  // The commit persists the width together with the flex pin, so the saved
  // file reproduces what the user saw on release.
  await expect
    .poll(async () => {
      const resp = await page.request.get(`/api/projects/${projectId}/files/manual-edit.html`);
      if (!resp.ok()) return '';
      const source = await resp.text();
      const match = source.match(/data-readable-id="pair-b"[^>]*style="([^"]*)"/);
      return match?.[1] ?? '';
    })
    // Chromium serializes the `flex: none` shorthand as its longhand
    // equivalent `0 0 auto` when the style attribute round-trips.
    .toMatch(/width:\s*\d+px[^"]*flex:\s*(?:none|0 0 auto)|flex:\s*(?:none|0 0 auto)[^"]*width:\s*\d+px/);

  // Handles settle exactly on the element after release — no residual offset.
  await expect
    .poll(async () => {
      const handleBox = await eHandle.boundingBox();
      const elementBox = await pairB.boundingBox();
      if (!handleBox || !elementBox) return Number.POSITIVE_INFINITY;
      return Math.abs((handleBox.x + handleBox.width / 2) - (elementBox.x + elementBox.width));
    })
    .toBeLessThan(4);
  await expect(page.locator('.manual-edit-error')).toHaveCount(0);
});

test('[P1] magnetic edge alignment shows a guide while dragging and hides it with Alt', async ({ page }) => {
  await routeMockAgents(page);
  const projectId = await createEmptyProject(page, 'Magnetic edge alignment');
  await seedHtmlArtifact(page, projectId, 'magnetic-edit.html', magneticEdgeAlignmentHtml());
  await page.goto(`/projects/${projectId}/files/magnetic-edit.html`);
  await openDesignFile(page, 'magnetic-edit.html');

  const frame = artifactPreviewFrame(page);
  await expect(frame.locator('[data-readable-id="snap-source"]')).toBeVisible();

  await page.getByTestId('manual-edit-mode-toggle').click();
  await selectPreviewElementThroughBridge(page, frame, '[data-readable-id="snap-target"]', 'Shape');

  const moveSurface = page.getByRole('group', { name: 'Move element' }).locator('[data-region="interior"]');
  await expect(moveSurface).toBeVisible();
  const box = await moveSurface.boundingBox();
  if (!box) throw new Error('move surface has no bounding box');

  const sourceBox = await frame.locator('[data-readable-id="snap-source"]').boundingBox();
  const targetBox = await frame.locator('[data-readable-id="snap-target"]').boundingBox();
  if (!sourceBox || !targetBox) throw new Error('snap box has no bounding box');

  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  const guide = page.locator('[data-testid="manual-edit-snap-guide"]');
  const leftEdgeGap = () => frame.locator('[data-readable-id="snap-target"]').evaluate((el) => {
    const src = el.ownerDocument.querySelector('[data-readable-id="snap-source"]');
    return src ? Math.abs(el.getBoundingClientRect().left - src.getBoundingClientRect().left) : Number.NaN;
  });

  // Land the target's left edge 4 screen px short of the source's left edge:
  // inside the 6 screen-px acquire band, but NOT already aligned, so only a real
  // magnetic pull (not the raw cursor position) can close the remaining gap.
  const dragLeftPx = (targetBox.x - sourceBox.x) - 4;
  expect(await leftEdgeGap()).toBeGreaterThan(6);

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX - dragLeftPx, startY, { steps: 8 });
  await expect(guide).toHaveCount(1);
  await page.mouse.up();

  // After commit the guide is removed and the element has snapped onto the edge:
  // the committed (saved) translate aligns the two left edges, closing the 4 px
  // that raw movement would have left.
  await expect(guide).toHaveCount(0);
  await expect.poll(leftEdgeGap, { timeout: 5000 }).toBeLessThanOrEqual(1);

  // A second drag with Alt held should not produce a guide.
  await selectPreviewElementThroughBridge(page, frame, '[data-readable-id="snap-target"]', 'Shape');
  await expect(moveSurface).toBeVisible();
  const box2 = await moveSurface.boundingBox();
  if (!box2) throw new Error('move surface has no bounding box on second drag');
  await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
  await page.mouse.down();
  await page.keyboard.down('Alt');
  await page.mouse.move(box2.x + box2.width / 2 - 175, box2.y + box2.height / 2, { steps: 8 });
  await expect(guide).toHaveCount(0);
  await page.keyboard.up('Alt');
  await page.mouse.up();
});

async function selectPreviewElementThroughBridge(
  page: Page,
  frame: ReturnType<Page['frameLocator']>,
  selector: string,
  section: string,
) {
  await expect(frame.locator('html[data-readable-edit-mode]')).toHaveCount(1);
  await frame.locator(selector).click();
  await expect(inspectorSurface(page, section)).toBeVisible();
  await expect(frame.locator(`${selector}[data-readable-edit-selected="true"]`)).toHaveCount(1);
}

async function selectStyleRowInput(
  page: Page,
  frame: ReturnType<Page['frameLocator']>,
  selector: string,
  section: string,
  label: string,
) {
  await frame.locator(selector).evaluate((el) => {
    const element = el as HTMLElement;
    const rect = element.getBoundingClientRect();
    const styles = window.getComputedStyle(element);
    window.parent.postMessage({
      type: 'readable-edit-select',
      target: {
        id: element.dataset.readableId ?? element.id,
        kind: 'text',
        label: element.textContent?.trim() || element.tagName.toLowerCase(),
        tagName: element.tagName.toLowerCase(),
        className: typeof element.className === 'string' ? element.className : '',
        text: element.textContent?.trim() ?? '',
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        fields: { text: element.textContent?.trim() ?? '' },
        attributes: Object.fromEntries(Array.from(element.attributes).map((attr) => [attr.name, attr.value])),
        styles: {
          fontFamily: styles.fontFamily,
          fontSize: styles.fontSize,
          fontWeight: styles.fontWeight,
          color: styles.color,
          textAlign: styles.textAlign,
          lineHeight: styles.lineHeight,
          letterSpacing: styles.letterSpacing,
          width: styles.width,
          height: styles.height,
          minHeight: styles.minHeight,
          gap: styles.gap,
          flexDirection: styles.flexDirection,
          justifyContent: styles.justifyContent,
          alignItems: styles.alignItems,
          backgroundColor: styles.backgroundColor,
          opacity: styles.opacity,
          padding: styles.padding,
          paddingTop: styles.paddingTop,
          paddingRight: styles.paddingRight,
          paddingBottom: styles.paddingBottom,
          paddingLeft: styles.paddingLeft,
          margin: styles.margin,
          marginTop: styles.marginTop,
          marginRight: styles.marginRight,
          marginBottom: styles.marginBottom,
          marginLeft: styles.marginLeft,
          border: styles.border,
          borderTopWidth: styles.borderTopWidth,
          borderRightWidth: styles.borderRightWidth,
          borderBottomWidth: styles.borderBottomWidth,
          borderLeftWidth: styles.borderLeftWidth,
          borderStyle: styles.borderStyle,
          borderColor: styles.borderColor,
          borderRadius: styles.borderRadius,
        },
        isLayoutContainer: false,
        outerHtml: element.outerHTML,
      },
    }, '*');
  });
  await expect(inspectorSurface(page, section)).toBeVisible();
  const input = page.locator('.manual-edit-left-inspector').getByLabel(label, { exact: true });
  await expect(input).toBeVisible();
  return input;
}

test('[P0] manual edit mode keeps deck navigation available for deck-shaped HTML', async ({ page }) => {
  await routeMockAgents(page);
  const projectId = await createEmptyProject(page, 'Manual edit deck smoke');
  await seedDeckArtifact(page, projectId, 'manual-deck.html', 'Manual Deck', ['Slide One', 'Slide Two']);
  await page.goto(`/projects/${projectId}/files/manual-deck.html`);
  await openDesignFile(page, 'manual-deck.html');

  const frame = artifactPreviewFrame(page);
  await expect(frame.getByText('Slide One')).toBeVisible();
  await page.getByLabel('Next slide').click();
  await expect(frame.getByText('Slide Two')).toBeVisible();
});


test('[P0] simple deck keeps the active slide stable across preview mode switches', async ({ page }) => {
  await routeMockAgents(page);
  const projectId = await createEmptyProject(page, 'Simple deck navigation state');
  await seedDeckArtifact(page, projectId, 'simple-deck.html', 'Simple Deck', ['Slide One', 'Slide Two', 'Slide Three']);
  await page.goto(`/projects/${projectId}/files/simple-deck.html`);
  await openDesignFile(page, 'simple-deck.html');

  const frame = artifactPreviewFrame(page);
  const viewModeTabs = page.getByRole('tablist', { name: 'View mode' });

  await expect(frame.getByText('Slide One')).toBeVisible();
  await page.getByLabel('Next slide').click();
  await expect(frame.getByText('Slide Two')).toBeVisible();

  await viewModeTabs.getByRole('tab', { name: 'Code' }).click();
  await expect(page.locator('.viewer-source')).toContainText('Slide Three');
  await viewModeTabs.getByRole('tab', { name: 'Preview' }).click();

  await expect(frame.getByText('Slide Two')).toBeVisible();
  await page.getByLabel('Next slide').click();
  await expect(frame.getByText('Slide Three')).toBeVisible();
});

test('[P1] issue 58 manual edit resize does not reboot a deck on slide two', async ({ page }) => {
  await routeMockAgents(page);
  const projectId = await createEmptyProject(page, 'Issue 58 deck resize');
  const template = readFileSync(new URL('../../templates/deck-framework.html', import.meta.url), 'utf8');
  const deckHtml = template
    .replace('</head>', "<script>window.parent.postMessage({ type: 'readable-studio:issue-58-deck-boot' }, '*');</script></head>")
    .replace('<!-- SLOT: slide 1 content -->', '<h1>Slide One</h1>')
    .replace(
      '<!-- SLOT: slide 2 content -->',
      '<div data-readable-id="issue-58-resize-target" data-readable-label="Slide two card" style="width:320px;height:180px;background:#dbeafe;">Slide Two</div>',
    );
  expect(deckHtml).toContain('issue-58-resize-target');

  const seedResp = await page.request.post(
    `/api/projects/${projectId}/files`,
    {
      data: {
        name: 'issue-58-deck.html',
        content: deckHtml,
        artifactManifest: {
          schema: 'readable-studio.artifact-manifest.v1',
          kind: 'deck',
          title: 'Issue 58 Deck',
          entry: 'issue-58-deck.html',
          renderer: 'deck-html',
          exports: ['html', 'pptx'],
        },
      },
      timeout: 15_000,
    },
  );
  expect(seedResp.ok()).toBeTruthy();

  await page.goto(`/projects/${projectId}`);
  await waitForLoadingToClear(page);
  const bootCounterKey = '__issue58DeckBootCount';
  await page.evaluate((key) => {
    const host = window as typeof window & Record<string, number>;
    host[key] = 0;
    window.addEventListener('message', (event) => {
      if ((event.data as { type?: string } | null)?.type !== 'readable-studio:issue-58-deck-boot') return;
      host[key] = (host[key] ?? 0) + 1;
    });
  }, bootCounterKey);
  const deckBoots = () => page.evaluate(
    (key) => Number((window as typeof window & Record<string, number>)[key] ?? 0),
    bootCounterKey,
  );

  await openDesignFile(page, 'issue-58-deck.html');
  const frame = artifactPreviewFrame(page);
  const resizeTarget = frame.locator('[data-readable-id="issue-58-resize-target"]');
  await expect.poll(deckBoots).toBeGreaterThan(0);
  await expect(frame.locator('#deck-cur')).toHaveText('01');
  await page.getByLabel('Next slide').click();
  await expect(frame.locator('#deck-cur')).toHaveText('02');
  await expect(resizeTarget).toBeVisible();

  await page.getByTestId('manual-edit-mode-toggle').click();
  await expect(frame.locator('html[data-readable-edit-mode]')).toHaveCount(1);
  await expect(frame.locator('#deck-cur')).toHaveText('02');
  await resizeTarget.click();
  await expect(frame.locator('[data-readable-id="issue-58-resize-target"][data-readable-edit-selected="true"]')).toHaveCount(1);

  const bootCountBeforeSave = await deckBoots();
  expect(bootCountBeforeSave).toBeGreaterThan(0);
  const before = await resizeTarget.boundingBox();
  if (!before) throw new Error('slide two resize target has no bounding box');
  const handle = page.getByRole('button', { name: 'Resize bottom-right corner' });
  const handleBox = await handle.boundingBox();
  if (!handleBox) throw new Error('resize handle has no bounding box');
  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  const postSaveRawHtmlRefreshes: Response[] = [];
  let lastPostSaveRawHtmlRefreshAt = 0;
  const rawHtmlPath = `/api/projects/${projectId}/raw/issue-58-deck.html`;
  page.on('response', (response) => {
    const url = new URL(response.url());
    const cacheBust = url.searchParams.get('cacheBust');
    if (
      response.request().method() === 'GET'
      && url.pathname === rawHtmlPath
      // The pre-save conflict check uses Date.now(); source refreshes use the
      // `${file.mtime}-${reloadKey}-${filesRefreshKey}` form.
      && cacheBust?.includes('-')
    ) {
      postSaveRawHtmlRefreshes.push(response);
      lastPostSaveRawHtmlRefreshAt = Date.now();
    }
  });

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 80, startY + 80, { steps: 8 });
  await page.mouse.up();

  await expect
    .poll(async () => {
      const resp = await page.request.get(`/api/projects/${projectId}/files/issue-58-deck.html`);
      if (!resp.ok()) return false;
      const source = await resp.text();
      const style = source.match(/data-readable-id="issue-58-resize-target"[^>]*style="([^"]*)"/)?.[1] ?? '';
      const width = Number(style.match(/width:\s*([\d.]+)px/)?.[1]);
      return width > before.width + 1;
    })
    .toBe(true);

  // Save metadata and filesystem watchers may coalesce differently across
  // platforms. Wait for the refresh path, then allow its trailing watcher
  // batch to settle before checking that no response rebooted the deck.
  await expect.poll(() => postSaveRawHtmlRefreshes.length, { timeout: T.medium }).toBeGreaterThan(0);
  await expect
    .poll(() => Date.now() - lastPostSaveRawHtmlRefreshAt, { timeout: T.medium })
    .toBeGreaterThanOrEqual(T.short);
  await Promise.all(postSaveRawHtmlRefreshes.map(async (response) => {
    await response.finished();
    expect(response.ok()).toBeTruthy();
  }));
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  expect(await deckBoots()).toBe(bootCountBeforeSave);
  await expect(frame.locator('#deck-cur')).toHaveText('02');
  await expect(resizeTarget).toBeVisible();
});

test('[P0] @critical HTML preview stays rendered after switching from Preview to Code and back', async ({ page }) => {
  await routeMockAgents(page);
  const projectId = await createEmptyProject(page, 'HTML preview toggle regression');
  await seedHtmlArtifact(
    page,
    projectId,
    'toggle-preview.html',
    '<!doctype html><html><body><main><h1>Toggle Preview Stable</h1><p>Still visible after tab switches.</p></main></body></html>',
  );
  await page.goto(`/projects/${projectId}`);
  await openDesignFile(page, 'toggle-preview.html');

  const previewFrame = artifactPreview(page);
  await expect(previewFrame).toBeVisible();
  await expect(
    artifactPreviewFrame(page).getByRole('heading', { name: 'Toggle Preview Stable' }),
  ).toBeVisible();

  const viewModeTabs = page.getByRole('tablist', { name: 'View mode' });
  await viewModeTabs.getByRole('tab', { name: 'Code' }).click();
  await expect(page.locator('.viewer-source')).toContainText('Toggle Preview Stable');

  await viewModeTabs.getByRole('tab', { name: 'Preview' }).click();
  await expect(previewFrame).toBeVisible();
  await expect(
    artifactPreviewFrame(page).getByRole('heading', { name: 'Toggle Preview Stable' }),
  ).toBeVisible();
  await expect(
    artifactPreviewFrame(page).getByText('Still visible after tab switches.'),
  ).toBeVisible();
});

test('[P1] manual edit arrow-key nudge on a selected deck object does not advance framework deck slides', async ({ page }) => {
  await routeMockAgents(page);
  const projectId = await createEmptyProject(page, 'Manual edit deck nudge');

  // Seed a real deck-framework deck: its own capture-phase keyboard handler is
  // what raced object nudging in issue #46.
  const template = readFileSync(new URL('../../templates/deck-framework.html', import.meta.url), 'utf8');
  const deckHtml = template
    .replace(
      '<!-- SLOT: slide 1 content -->',
      '<img data-readable-id="deck-object" alt="Deck object" src="/deck-object.png" style="width:240px;height:160px;">',
    )
    .replace('<!-- SLOT: slide 2 content -->', '<h1>Second slide</h1>');
  expect(deckHtml).toContain('data-readable-id="deck-object"');
  const seedResp = await page.request.post(
    `/api/projects/${projectId}/files`,
    {
      data: {
        name: 'deck-nudge.html',
        content: deckHtml,
        artifactManifest: {
          schema: 'readable-studio.artifact-manifest.v1',
          kind: 'deck',
          title: 'Deck Nudge',
          entry: 'deck-nudge.html',
          renderer: 'deck-html',
          exports: ['html', 'pptx'],
        },
      },
      timeout: 15_000,
    },
  );
  expect(seedResp.ok()).toBeTruthy();

  await page.goto(`/projects/${projectId}/files/deck-nudge.html`);
  await openDesignFile(page, 'deck-nudge.html');
  await expect(artifactPreview(page)).toBeVisible();

  const frame = artifactPreviewFrame(page);
  const deckObject = frame.locator('[data-readable-id="deck-object"]');
  await expect(deckObject).toBeVisible();
  await expect(frame.locator('#deck-cur')).toHaveText('01');

  await page.getByTestId('manual-edit-mode-toggle').click();
  await expect(frame.locator('html[data-readable-edit-mode]')).toHaveCount(1);

  await deckObject.click();
  await expect(frame.locator('[data-readable-id="deck-object"][data-readable-edit-selected="true"]')).toHaveCount(1);

  const beforeNudge = await deckObject.boundingBox();
  if (!beforeNudge) throw new Error('deck object has no bounding box before keyboard nudge');
  await page.keyboard.press('ArrowRight');

  // While an object is selected the deck must yield trusted arrow keys to
  // object nudging: the counter stays on slide 01 and the object moves.
  await expect(frame.locator('#deck-cur')).toHaveText('01');
  await expect
    .poll(async () => {
      const afterNudge = await deckObject.boundingBox();
      return afterNudge ? afterNudge.x > beforeNudge.x : false;
    })
    .toBe(true);
  await expect
    .poll(async () => {
      const resp = await page.request.get(`/api/projects/${projectId}/files/deck-nudge.html`);
      if (!resp.ok()) return '';
      return resp.text();
    })
    // The stage is fit()-scaled, so the persisted CSS px depends on viewport
    // scale (1 rect px = 1/scale CSS px) — assert a nonzero translate landed,
    // not an exact value.
    .toMatch(/data-readable-id="deck-object"[^>]*style="[^"]*translate:\s*[1-9]/);
  // The selected slide must still be the active one afterwards.
  await expect(frame.locator('#deck-cur')).toHaveText('01');
});

test('[P1] manual edit arrow-key nudge on a selected object does not advance a legacy deck without the yield guard', async ({ page }) => {
  await routeMockAgents(page);
  const projectId = await createEmptyProject(page, 'Manual edit legacy deck nudge');

  // Decks generated before the template yield guard existed ship a capture-phase
  // onKey that bails only on defaultPrevented. The srcdoc deck injection must
  // yield trusted arrows to object nudging for them too.
  const seedResp = await page.request.post(
    `/api/projects/${projectId}/files`,
    {
      data: {
        name: 'legacy-deck.html',
        content: legacyDeckHtml(),
        artifactManifest: {
          schema: 'readable-studio.artifact-manifest.v1',
          kind: 'deck',
          title: 'Legacy Deck Nudge',
          entry: 'legacy-deck.html',
          renderer: 'deck-html',
          exports: ['html', 'pptx'],
        },
      },
      timeout: 15_000,
    },
  );
  expect(seedResp.ok()).toBeTruthy();

  await page.goto(`/projects/${projectId}/files/legacy-deck.html`);
  await openDesignFile(page, 'legacy-deck.html');
  await expect(artifactPreview(page)).toBeVisible();

  const frame = artifactPreviewFrame(page);
  const deckObject = frame.locator('[data-readable-id="deck-object"]');
  await expect(deckObject).toBeVisible();
  await expect(frame.locator('#deck-cur')).toHaveText('01');

  await page.getByTestId('manual-edit-mode-toggle').click();
  await expect(frame.locator('html[data-readable-edit-mode]')).toHaveCount(1);

  await deckObject.click();
  await expect(frame.locator('[data-readable-id="deck-object"][data-readable-edit-selected="true"]')).toHaveCount(1);

  const beforeNudge = await deckObject.boundingBox();
  if (!beforeNudge) throw new Error('deck object has no bounding box before keyboard nudge');
  await page.keyboard.press('ArrowRight');

  await expect(frame.locator('#deck-cur')).toHaveText('01');
  await expect
    .poll(async () => {
      const afterNudge = await deckObject.boundingBox();
      return afterNudge ? afterNudge.x > beforeNudge.x : false;
    })
    .toBe(true);
  await expect
    .poll(async () => {
      const resp = await page.request.get(`/api/projects/${projectId}/files/legacy-deck.html`);
      if (!resp.ok()) return '';
      return resp.text();
    })
    .toMatch(/data-readable-id="deck-object"[^>]*style="[^"]*translate:\s*[1-9]/);
  await expect(frame.locator('#deck-cur')).toHaveText('01');
});

test('[P1] manual edit held arrow key commits one nudge burst as a single undoable history entry', async ({ page }) => {
  await routeMockAgents(page);
  const projectId = await createEmptyProject(page, 'Manual edit held nudge');
  await seedHtmlArtifact(page, projectId, 'manual-edit.html', manualEditHtml());
  await page.goto(`/projects/${projectId}/files/manual-edit.html`);
  await openDesignFile(page, 'manual-edit.html');
  await expect(artifactPreview(page)).toBeVisible();

  await page.getByTestId('manual-edit-mode-toggle').click();
  const frame = artifactPreviewFrame(page);
  await expect(frame.locator('html[data-readable-edit-mode]')).toHaveCount(1);

  await frame.locator('[data-readable-id="hero-image"]').click();
  await expect(frame.locator('[data-readable-id="hero-image"][data-readable-edit-selected="true"]')).toHaveCount(1);

  for (let i = 0; i < 5; i += 1) {
    await page.keyboard.down('ArrowRight');
  }
  await page.keyboard.up('ArrowRight');

  await expect
    .poll(async () => {
      const resp = await page.request.get(`/api/projects/${projectId}/files/manual-edit.html`);
      if (!resp.ok()) return '';
      return resp.text();
    })
    .toMatch(/data-readable-id="hero-image"[^>]*style="[^"]*translate:\s*5px/);

  // The whole held burst is one history entry: a single undo removes it.
  await page.keyboard.press('ControlOrMeta+z');
  await expectFileSourceExcludes(page, projectId, 'manual-edit.html', ['translate:']);
});

async function routeMockAgents(page: Page) {
  await routeAgents(page, [
    {
      id: 'mock',
      name: 'Mock Agent',
      bin: 'mock-agent',
      available: true,
      version: 'test',
      models: [{ id: 'default', label: 'Default' }],
    },
  ]);
}

async function createEmptyProject(page: Page, name: string): Promise<string> {
  await gotoEntryHome(page);
  await openNewProjectModal(page);
  await page.getByTestId('new-project-name').fill(name);
  await page.getByTestId('create-project').click();
  await waitForLoadingToClear(page);
  await expect(page).toHaveURL(/\/projects\//);
  const current = new URL(page.url());
  const [, projects, projectId] = current.pathname.split('/');
  if (projects !== 'projects' || !projectId) throw new Error(`unexpected project route: ${current.pathname}`);
  return projectId;
}

async function gotoEntryHome(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForLoadingToClear(page);
  const privacyDialog = page.getByRole('dialog').filter({ hasText: 'Help us improve Readable Studio' });
  if (await privacyDialog.isVisible()) {
    await privacyDialog.getByRole('button', { name: /I get it|not now|got it|don't share/i }).click();
    await expect(privacyDialog).toHaveCount(0);
  }
  await expect(page.getByTestId('home-hero')).toBeVisible();
  await expect(page.getByTestId('home-hero-input')).toBeVisible();
}

async function openNewProjectModal(page: Page) {
  await ensureRailOpen(page);
  await page.getByTestId('entry-nav-new-project').click();
  await expect(page.getByTestId('new-project-modal')).toBeVisible();
  await expect(page.getByTestId('new-project-panel')).toBeVisible();
}

async function seedHtmlArtifact(page: Page, projectId: string, fileName: string, content: string) {
  const resp = await page.request.post(
    `/api/projects/${projectId}/files`,
    {
      data: {
        name: fileName,
        content,
        artifactManifest: {
          schema: 'readable-studio.artifact-manifest.v1',
          kind: 'html',
          title: fileName,
          entry: fileName,
          renderer: 'html',
          exports: ['html'],
        },
      },
      timeout: 15_000,
    },
  );
  expect(resp.ok()).toBeTruthy();
}

async function seedDeckArtifact(
  page: Page,
  projectId: string,
  fileName: string,
  title: string,
  slides: string[],
) {
  const slideHtml = slides
    .map((slide, index) => `<section class="slide" data-readable-id="slide-${index + 1}"${index === 0 ? '' : ' hidden'}><h1>${slide}</h1></section>`)
    .join('\n');
  const resp = await page.request.post(
    `/api/projects/${projectId}/files`,
    {
      data: {
        name: fileName,
        content: `<!doctype html><html><body>${slideHtml}</body></html>`,
        artifactManifest: {
          schema: 'readable-studio.artifact-manifest.v1',
          kind: 'deck',
          title,
          entry: fileName,
          renderer: 'deck-html',
          exports: ['html', 'pptx'],
        },
      },
      timeout: 15_000,
    },
  );
  expect(resp.ok()).toBeTruthy();
}

async function openDesignFile(page: Page, fileName: string) {
  const preview = artifactPreview(page);
  try {
    await preview.waitFor({ state: 'visible', timeout: 5_000 });
    return;
  } catch {
    // Not yet visible; try opening via tab or file list
  }

  const filePattern = new RegExp(fileName.replace(/\./g, '\\.'), 'i');
  const fileTabButton = page.getByRole('tab', { name: filePattern }).first();
  let tabFound = true;
  try {
    await fileTabButton.waitFor({ state: 'visible', timeout: 2_000 });
  } catch {
    tabFound = false;
  }

  if (tabFound) {
    await fileTabButton.click();
  } else {
    const fileButton = page.getByRole('button', { name: filePattern });
    await fileButton.click();
    await page.getByTestId('design-file-preview').getByRole('button', { name: 'Open' }).click();
  }
  await expect(preview).toBeVisible();
}

async function waitForLoadingToClear(page: Page) {
  await page.locator('.readable-loading-shell').waitFor({ state: 'hidden', timeout: T.medium });
}

async function expectFileSource(page: Page, projectId: string, fileName: string, snippets: string[]) {
  await expect
    .poll(async () => {
      const resp = await page.request.get(`/api/projects/${projectId}/files/${fileName}`);
      if (!resp.ok()) return false;
      const source = await resp.text();
      return snippets.every((snippet) => source.includes(snippet));
    })
    .toBe(true);
}

async function expectFileSourceExcludes(page: Page, projectId: string, fileName: string, snippets: string[]) {
  await expect
    .poll(async () => {
      const resp = await page.request.get(`/api/projects/${projectId}/files/${fileName}`);
      if (!resp.ok()) return false;
      const source = await resp.text();
      return snippets.every((snippet) => !source.includes(snippet));
    })
    .toBe(true);
}

function inspectorRow(page: Page, label: string) {
  return page.locator('.manual-edit-left-inspector .cc-row').filter({ hasText: label }).first();
}

function inspectorSection(page: Page, title: string) {
  return page.locator('.manual-edit-left-inspector .cc-section').filter({ has: page.locator('.cc-section-head', { hasText: new RegExp(`^${title}$`, 'i') }) }).first();
}

function inspectorSurface(page: Page, title: string) {
  const inspector = page.locator('.manual-edit-left-inspector');
  if (title === 'Text') return inspector.getByText('Quick format', { exact: true });
  if (title === 'Shape') return inspector.getByRole('button', { name: /^Size & position/ });
  return inspectorSection(page, title);
}

function legacyDeckHtml(): string {
  // A class-toggle deck with the pre-yield-guard keyboard contract: capture
  // listeners on window AND document, dedupe via `if (e.defaultPrevented)
  // return;`, and no manual-edit yield guard — the shape decks generated
  // before the fix still carry.
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Legacy Deck</title>
    <style>
      .slide { display: none; }
      .slide.active { display: block; }
    </style>
  </head>
  <body>
    <div class="deck-stage" id="deck-stage">
      <section class="slide active"><img data-readable-id="deck-object" alt="Deck object" src="/deck-object.png" style="width:240px;height:160px;"></section>
      <section class="slide"><h1>Slide Two</h1></section>
    </div>
    <span id="deck-cur">01</span>
    <script>
      (function () {
        var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
        var cur = document.getElementById('deck-cur');
        var idx = 0;
        function pad2(n) { return (n < 10 ? '0' : '') + n; }
        function paint() {
          slides.forEach(function (el, i) { el.classList.toggle('active', i === idx); });
          if (cur) cur.textContent = pad2(idx + 1);
        }
        function go(i) { idx = Math.max(0, Math.min(slides.length - 1, i)); paint(); }
        function onKey(e) {
          if (e.defaultPrevented) return;
          var t = e.target;
          if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
          if (e.key === 'ArrowRight') { e.preventDefault(); go(idx + 1); }
          else if (e.key === 'ArrowLeft') { e.preventDefault(); go(idx - 1); }
        }
        window.addEventListener('keydown', onKey, true);
        document.addEventListener('keydown', onKey, true);
      })();
    </script>
  </body>
</html>`;
}

function manualEditHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Manual Edit</title>
    <style>
      .responsive-pair { display: flex; gap: 24px; }
      .responsive-pair > div { flex: 1 1 0; min-height: 40px; }
      .constrained-copy { width: 420px; max-width: 30ch; }
      @media (max-width: 700px) {
        .responsive-pair { flex-direction: column; }
      }
    </style>
  </head>
  <body style="font-family: Inter, system-ui, sans-serif; font-size: 16px; letter-spacing: 0.01em;">
    <main>
      <section data-readable-id="responsive-pair" data-readable-label="Responsive pair" class="responsive-pair">
        <div data-readable-id="pair-a">Left panel</div>
        <div data-readable-id="pair-b">Right panel</div>
      </section>
      <section data-readable-id="hero" data-readable-label="Hero section" style="display:flex;gap:8px;align-items:center;">
        <h1 data-readable-id="hero-title" data-readable-label="Hero title">Original Hero</h1>
        <a data-readable-id="cta" data-readable-label="Primary CTA" href="/start">Start now</a>
        <img data-readable-id="hero-image" data-readable-label="Hero image" src="/hero.png" alt="Hero" style="width:64px;height:64px;">
      </section>
      <p data-readable-id="constrained-copy" data-readable-label="Constrained copy" class="constrained-copy">Constrained copy</p>
    </main>
  </body>
</html>`;
}

function duplicateManualEditHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Ctrl-drag duplication</title>
    <style>
      .duplicate-stage { position: relative; width: 600px; height: 300px; }
      .duplicate-card { position: absolute; left: 80px; top: 60px; width: 160px; height: 80px; padding: 12px; box-sizing: border-box; background: #dbeafe; }
    </style>
  </head>
  <body>
    <main>
      <section class="duplicate-stage" data-readable-id="duplicate-stage" data-readable-label="Duplicate stage">
        <div
          id="card-root"
          class="duplicate-card"
          data-readable-id="duplicate-card"
          data-readable-label="Duplicate card"
          aria-labelledby="card-title"
        >
          <h2 id="card-title">Card title</h2>
          <a href="#card-title">Jump to title</a>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

function issue34NestedChildHtml(): string {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Issue 34 nested child</title></head>
  <body>
    <div
      data-readable-id="issue-34-parent"
      data-readable-label="Selected text parent"
      data-readable-edit="text"
      style="position:relative;width:320px;height:180px;padding:16px;background:#eef2ff;"
    >
      Parent copy
      <button
        type="button"
        data-readable-id="issue-34-child"
        data-readable-label="Nested child"
        style="position:absolute;left:96px;top:72px;width:128px;height:48px;"
      >Nested child</button>
      <button
        type="button"
        data-readable-id="issue-34-ring-child"
        data-readable-label="Nested ring child"
        aria-label="Nested ring child"
        style="position:absolute;box-sizing:border-box;left:2px;top:32px;width:12px;height:20px;padding:0;"
      ></button>
    </div>
  </body>
</html>`;
}

function manualEditHoverSyncHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Manual edit hover sync</title>
    <style>
      main { display: grid; gap: 16px; width: 360px; padding: 24px; }
      .card { box-sizing: border-box; width: 320px; min-height: 72px; padding: 20px; background: #e0f2fe; }
      .middle { position: relative; height: 160px; background: #ffedd5; }
      .child { position: absolute; left: 136px; top: 56px; width: 136px; height: 48px; }
    </style>
  </head>
  <body>
    <main>
      <section class="card" data-readable-id="hover-top">Top card</section>
      <section class="card middle" data-readable-id="hover-middle">
        Selected middle card
        <button class="child" type="button" data-readable-id="hover-child">Nested child</button>
      </section>
      <section class="card" data-readable-id="hover-bottom">Bottom card</section>
    </main>
  </body>
</html>`;
}
