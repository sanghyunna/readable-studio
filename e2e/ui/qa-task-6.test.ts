import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { routeAgents } from '@/playwright/mock-factory';

const STORAGE_KEY = 'readable-studio:config';
const CONFIG = {
  mode: 'daemon', apiKey: '', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5',
  agentId: 'codex', skillId: null, designSystemId: null, onboardingCompleted: true,
  agentModels: { codex: { model: 'default', reasoning: 'default' } }, privacyDecisionAt: 1,
  telemetry: { metrics: false, content: false, artifactManifest: false },
};
const DESIGN_SYSTEM = {
  id: 'qa-aurora', title: 'QA Aurora', category: 'Brand', summary: 'QA submission contract',
  source: 'user', status: 'published', isEditable: true,
};
const PLUGIN_INPUTS = [
  { name: 'artifactKind', type: 'string', required: true, default: 'web prototype', label: 'Artifact kind' },
  { name: 'fidelity', type: 'select', required: true, options: ['wireframe', 'high-fidelity'], default: 'high-fidelity', label: 'Fidelity' },
  { name: 'audience', type: 'string', required: true, default: 'product evaluators', label: 'Audience' },
  { name: 'designSystem', type: 'string', default: 'the active project design system', label: 'Design system' },
  { name: 'template', type: 'string', default: 'the bundled web prototype seed', label: 'Template' },
];
const PLUGIN = {
  id: 'example-web-prototype', title: 'Web Prototype', version: '1.0.0', trust: 'bundled',
  marketplaceTrust: 'trusted', sourceKind: 'bundled', source: '/tmp/qa-plugin', fsPath: '/tmp/qa-plugin',
  capabilitiesGranted: ['prompt:inject'], installedAt: 0, updatedAt: 0,
  manifest: {
    name: 'example-web-prototype', title: 'Web Prototype', version: '1.0.0',
    description: 'QA routed scenario plugin', readable: {
      kind: 'scenario', taskKind: 'new-generation',
      useCase: { query: 'Build a {{fidelity}} {{artifactKind}} for {{audience}} using {{designSystem}} from {{template}}.' },
      inputs: PLUGIN_INPUTS,
    },
  },
};
const SKILL = {
  id: 'qa-skill', name: 'QA Skill', description: 'QA selected skill', triggers: ['qa'],
  mode: 'prototype', previewType: 'html', designSystemRequired: false, defaultFor: [],
  upstream: null, hasBody: true, examplePrompt: 'Use QA Skill', aggregatesExamples: false,
};

function createdProject(body: Record<string, unknown>, suffix: string) {
  return {
    project: {
      id: `qa-project-${suffix}`, name: body.name, skillId: body.skillId ?? null,
      designSystemId: body.designSystemId ?? null, metadata: body.metadata ?? { kind: 'other' },
      createdAt: Date.now(), updatedAt: Date.now(),
    },
    conversationId: `qa-conversation-${suffix}`,
    ...(body.appliedPluginSnapshotId ? { appliedPluginSnapshotId: body.appliedPluginSnapshotId } : {}),
  };
}

async function fulfillProject(route: Route, suffix: string) {
  const body = route.request().postDataJSON() as Record<string, unknown>;
  await route.fulfill({ status: 200, json: createdProject(body, suffix) });
  return body;
}

async function gotoHome(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.readable-loading-shell')).toHaveCount(0, { timeout: 20_000 });
  const privacy = page.getByRole('dialog').filter({ hasText: 'Help us improve Readable Studio' });
  if (await privacy.isVisible().catch(() => false)) {
    await privacy.getByRole('button', { name: /I get it|not now|got it|don't share/i }).click();
  }
  await expect(page.getByTestId('home-hero-input')).toBeVisible();
}

async function dropFile(page: Page, name: string, content: string) {
  await page.getByTestId('home-hero-input').evaluate((target, data) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([data.content], data.name, { type: 'text/plain' }));
    target.closest('.home-hero__input-card')?.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  }, { name, content });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ key, value }) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem(key, JSON.stringify(value));
  }, { key: STORAGE_KEY, value: CONFIG });
  await routeAgents(page, [{
    id: 'codex', name: 'Codex CLI', bin: 'codex', available: true, version: '1', path: 'codex',
    models: [{ id: 'default', label: 'Default' }],
  }]);
  await page.route('**/api/app-config', async (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: { config: CONFIG } }) : route.continue());
  await page.route('**/api/projects', async (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: { projects: [] } }) : route.fallback());
  await page.route('**/api/plugins', (route) => route.fulfill({ json: { plugins: [PLUGIN] } }));
  await page.route('**/api/plugins/*/apply', async (route) => {
    const request = route.request().postDataJSON() as { inputs?: Record<string, unknown> };
    await route.fulfill({ json: {
      query: 'Build the QA prototype.', contextItems: [], inputs: PLUGIN_INPUTS, assets: [], mcpServers: [],
      trust: 'trusted', capabilitiesGranted: ['prompt:inject'], capabilitiesRequired: ['prompt:inject'],
      appliedPlugin: {
        snapshotId: 'qa-plugin-snapshot', pluginId: PLUGIN.id, pluginVersion: PLUGIN.version,
        manifestSourceDigest: 'a'.repeat(64), inputs: request.inputs ?? {}, resolvedContext: { items: [] },
        capabilitiesGranted: ['prompt:inject'], capabilitiesRequired: ['prompt:inject'], assetsStaged: [],
        taskKind: 'new-generation', appliedAt: 0, mcpServers: [], status: 'fresh',
      },
      projectMetadata: {},
    } });
  });
  await page.route('**/api/skills', (route) => route.fulfill({ json: { skills: [SKILL] } }));
  await page.route('**/api/mcp/servers', (route) => route.fulfill({ json: { servers: [], templates: [] } }));
  await page.route('**/api/design-systems', (route) => route.fulfill({ json: { designSystems: [DESIGN_SYSTEM] } }));
});

test('file-only submission creates a project with an empty prompt and uploads the file', async ({ page }) => {
  let projectPayload: Record<string, unknown> | null = null;
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    projectPayload = await fulfillProject(route, 'file-only');
  });
  const upload = page.waitForRequest((request) =>
    request.method() === 'POST' && /\/api\/projects\/[^/]+\/upload$/.test(new URL(request.url()).pathname));
  await page.route('**/api/projects/*/upload', (route) => route.fulfill({ json: {
    uploaded: [{ path: 'brief.txt', name: 'brief.txt', mimeType: 'text/plain', size: 13 }], failed: [],
  } }));

  await gotoHome(page);
  await expect(page.getByTestId('home-hero-submit')).toBeDisabled();
  await dropFile(page, 'brief.txt', 'file-only-run');
  await expect(page.getByTestId('home-hero-submit')).toBeEnabled();
  await page.getByTestId('home-hero-submit').click();
  const uploadRequest = await upload;

  expect(projectPayload).toMatchObject({
    pendingPrompt: '', pluginInputs: { prompt: '' }, conversationMode: 'design',
    metadata: { kind: 'other' },
  });
  expect(uploadRequest.postData() ?? '').toContain('brief.txt');
  expect(uploadRequest.postData() ?? '').toContain('file-only-run');
  await page.screenshot({ path: 'D:/readable-studio/.omo/evidence/task-6/file-only-submit.png', fullPage: true });
});

test('selected skill routes without the hidden scenario plugin', async ({ page }) => {
  let projectPayload: Record<string, unknown> | null = null;
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    projectPayload = await fulfillProject(route, 'skill');
  });

  await gotoHome(page);
  const editor = page.getByTestId('home-hero-input');
  await editor.fill('@');
  const picker = page.getByTestId('home-hero-plugin-picker');
  await picker.getByRole('tab', { name: /Skills/i }).click();
  await picker.getByRole('option', { name: /QA Skill/i }).click();
  await expect(page.getByTestId('home-hero-active-skill')).toContainText('QA Skill');
  await editor.fill('Use the selected skill');
  await page.getByTestId('home-hero-submit').click();
  await expect.poll(() => projectPayload).not.toBeNull();

  expect(projectPayload).toMatchObject({ skillId: 'qa-skill', pendingPrompt: 'Use the selected skill' });
  expect(projectPayload).not.toHaveProperty('pluginId');
});

test('plugin, design system, conversation mode and project kind reach the project payload', async ({ page }) => {
  let projectPayload: Record<string, unknown> | null = null;
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    projectPayload = await fulfillProject(route, 'plugin');
  });

  await gotoHome(page);
  await page.getByTestId('home-hero-rail-prototype').click();
  await expect(page.getByTestId('home-hero-footer-option-designSystem')).toBeVisible();
  await page.getByTestId('home-hero-footer-option-designSystem').click();
  await page.getByTestId('project-ds-picker-option-qa-aurora').click();
  await page.getByTestId('session-mode-trigger').click();
  await page.getByRole('menuitemradio', { name: /Ask mode/i }).click();
  await page.getByTestId('home-hero-input').fill('Build the routed prototype');
  await page.getByTestId('home-hero-submit').click();
  await expect.poll(() => projectPayload).not.toBeNull();

  expect(projectPayload).toMatchObject({
    pluginId: 'example-web-prototype', appliedPluginSnapshotId: 'qa-plugin-snapshot',
    designSystemId: 'qa-aurora', conversationMode: 'chat', metadata: { kind: 'prototype' },
    pluginInputs: { designSystem: 'QA Aurora' },
  });
});

test('continue without a prompt creates a draft without auto-send state', async ({ page }) => {
  let projectPayload: Record<string, unknown> | null = null;
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    projectPayload = await fulfillProject(route, 'continue');
  });

  await gotoHome(page);
  await expect(page.getByTestId('home-hero-submit')).toBeDisabled();
  await page.getByTestId('home-hero-continue-without-prompt').click();
  await expect.poll(() => projectPayload).not.toBeNull();
  expect(projectPayload).toMatchObject({ pendingPrompt: '', pluginInputs: { prompt: '' } });
  await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('readable:auto-send-first:')))).toEqual([]);
});

test('a failed project submission renders a visible alert and stays on home', async ({ page }) => {
  await page.route('**/api/projects', async (route) => route.request().method() === 'POST'
    ? route.fulfill({ status: 500, json: { error: 'forced QA failure' } }) : route.fallback());

  await gotoHome(page);
  await page.getByTestId('home-hero-input').fill('This submission must fail');
  await page.getByTestId('home-hero-submit').click();

  const alert = page.locator('.home-hero__error[role="alert"]');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('Failed to start the project');
  await expect(page).toHaveURL(/\/$/);
  await page.screenshot({ path: 'D:/readable-studio/.omo/evidence/task-6/submit-error.png', fullPage: true });
});
