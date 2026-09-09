import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { routeAgents } from '@/playwright/mock-factory';
import { DEFAULT_UNSELECTED_SCENARIO_PLUGIN_ID } from '@readable-studio/contracts';

import { addStorageInitScript } from '@/playwright/storage-init';

const STORAGE_KEY = 'readable-studio:config';
const CONFIG = {
  mode: 'daemon', apiKey: '', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5',
  agentId: 'codex', skillId: null, designSystemId: null, onboardingCompleted: true,
  agentModels: { codex: { model: 'default', reasoning: 'default' } }, privacyDecisionAt: 1,
  telemetry: { metrics: false, content: false, artifactManifest: false },
};

const PROTOTYPE_INPUTS = [
  { name: 'artifactKind', type: 'string', required: true, default: 'web prototype', label: 'Artifact kind' },
  { name: 'audience', type: 'string', required: true, default: 'product evaluators', label: 'Audience' },
];
const REQUIRED_INPUTS = [
  { name: 'brief', type: 'string', required: true, label: 'Audience brief', placeholder: 'Describe the audience' },
];

// Keep the complete InstalledPluginRecord shape. isVisiblePlugin filters partial
// records before HomeView can render them.
const HOME_PLUGINS = [
  {
    id: 'example-web-prototype', title: 'Web Prototype', version: '1.0.0', trust: 'bundled',
    marketplaceTrust: 'trusted', sourceKind: 'bundled', source: '/tmp/web-prototype', fsPath: '/tmp/web-prototype',
    capabilitiesGranted: ['prompt:inject'], installedAt: 0, updatedAt: 0,
    manifest: {
      name: 'example-web-prototype', title: 'Web Prototype', version: '1.0.0',
      description: 'A visual web prototype preset.', tags: ['prototype'], readable: {
        kind: 'scenario', taskKind: 'new-generation',
        preview: { type: 'image', poster: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E' },
        useCase: { query: 'Build a {{artifactKind}} for {{audience}}.' }, inputs: PROTOTYPE_INPUTS,
      },
    },
  },
  {
    id: 'example-dashboard-prototype', title: 'Dashboard Prototype', version: '1.0.0', trust: 'bundled',
    marketplaceTrust: 'trusted', sourceKind: 'bundled', source: '/tmp/dashboard-prototype', fsPath: '/tmp/dashboard-prototype',
    capabilitiesGranted: ['prompt:inject'], installedAt: 0, updatedAt: 0,
    manifest: {
      name: 'example-dashboard-prototype', title: 'Dashboard Prototype', version: '1.0.0',
      description: 'A dashboard requiring an audience brief.', tags: ['prototype'], readable: {
        kind: 'scenario', taskKind: 'new-generation',
        preview: { type: 'image', poster: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E' },
        useCase: { query: 'Build a dashboard for {{brief}}.' }, inputs: REQUIRED_INPUTS,
      },
    },
  },
];
const PRIMARY_PLUGIN = HOME_PLUGINS[0]!;
const REQUIRED_PLUGIN = HOME_PLUGINS[1]!;

const SKILL = {
  id: 'qa-layout-skill', name: 'QA Layout Skill', description: 'Routes a layout run through a skill.',
  triggers: ['layout'], mode: 'prototype', previewType: 'html', designSystemRequired: false,
  defaultFor: [], upstream: null, hasBody: true, examplePrompt: 'Create a layout.', aggregatesExamples: false,
};

type ProjectPayload = Record<string, unknown>;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function applyResponse(pluginId: string, inputs: Record<string, unknown>, sequence: number) {
  const fields = pluginId === REQUIRED_PLUGIN.id ? REQUIRED_INPUTS : PROTOTYPE_INPUTS;
  return {
    query: pluginId === REQUIRED_PLUGIN.id ? 'Build a dashboard.' : 'Build a web prototype.',
    contextItems: [], inputs: fields, assets: [], mcpServers: [], trust: 'trusted',
    capabilitiesGranted: ['prompt:inject'], capabilitiesRequired: ['prompt:inject'],
    appliedPlugin: {
      snapshotId: `snapshot-${pluginId}-${sequence}`, pluginId, pluginVersion: '1.0.0',
      manifestSourceDigest: 'a'.repeat(64), inputs, resolvedContext: { items: [] },
      capabilitiesGranted: ['prompt:inject'], capabilitiesRequired: ['prompt:inject'], assetsStaged: [],
      taskKind: 'new-generation', appliedAt: sequence, mcpServers: [], status: 'fresh',
    },
    projectMetadata: {},
  };
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

async function choosePrototypePreset(page: Page, pluginId = PRIMARY_PLUGIN.id) {
  await page.getByTestId('home-hero-rail-prototype').click();
  const presets = page.getByTestId('home-hero-plugin-presets');
  await expect(presets).toBeVisible();
  const card = presets.locator(`[data-testid="home-hero-plugin-preset"][data-plugin-id="${pluginId}"]`);
  await expect(card).toBeVisible();
  await expect(card.locator('.plugins-home__preview')).toBeVisible();
  await card.click();
  const replacement = page.getByRole('dialog', { name: /Replace current prompt/i });
  if (await replacement.isVisible().catch(() => false)) {
    await replacement.getByRole('button', { name: 'Replace', exact: true }).click();
  }
}

async function fulfillProject(route: Route, suffix: string): Promise<ProjectPayload> {
  const body = route.request().postDataJSON() as ProjectPayload;
  await route.fulfill({ json: {
    project: {
      id: `qa-task-7-${suffix}`, name: body.name, skillId: body.skillId ?? null,
      designSystemId: body.designSystemId ?? null, metadata: body.metadata ?? { kind: 'other' },
      createdAt: Date.now(), updatedAt: Date.now(),
    },
    conversationId: `qa-task-7-conversation-${suffix}`,
    ...(body.appliedPluginSnapshotId ? { appliedPluginSnapshotId: body.appliedPluginSnapshotId } : {}),
  } });
  return body;
}

test.beforeEach(async ({ page }) => {
  await addStorageInitScript(page, ({ key, value }) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem(key, JSON.stringify(value));
  }, { key: STORAGE_KEY, value: CONFIG });
  await routeAgents(page, [{
    id: 'codex', name: 'Codex CLI', bin: 'codex', available: true, version: '1', path: 'codex',
    models: [{ id: 'default', label: 'Default' }],
  }]);
  await page.route('**/api/app-config', (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: { config: CONFIG } }) : route.continue());
  await page.route('**/api/projects', (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: { projects: [] } }) : route.fallback());
  await page.route('**/api/plugins', (route) => route.fulfill({ json: { plugins: HOME_PLUGINS } }));
  let applySequence = 0;
  await page.route('**/api/plugins/*/apply', async (route) => {
    const pluginId = decodeURIComponent(route.request().url().split('/api/plugins/')[1]?.split('/apply')[0] ?? '');
    const body = route.request().postDataJSON() as { inputs?: Record<string, unknown> };
    applySequence += 1;
    await route.fulfill({ json: applyResponse(pluginId, body.inputs ?? {}, applySequence) });
  });
  await page.route('**/api/skills', (route) => route.fulfill({ json: { skills: [SKILL] } }));
  await page.route('**/api/mcp/servers', (route) => route.fulfill({ json: { servers: [], templates: [] } }));
  await page.route('**/api/design-systems', (route) => route.fulfill({ json: { designSystems: [] } }));
});

test('preset cards render visual previews, seed the composer, and route the selected plugin snapshot', async ({ page }) => {
  let projectPayload: ProjectPayload | null = null;
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    projectPayload = await fulfillProject(route, 'preset');
  });

  await gotoHome(page);
  await choosePrototypePreset(page);
  await expect(page.getByTestId('home-hero-input')).toHaveText('Build a web prototype for product evaluators.');
  await expect(page.getByTestId('home-hero-active-plugin')).toContainText('Web Prototype');
  await page.getByTestId('home-hero-submit').click();
  await expect.poll(() => projectPayload).not.toBeNull();
  expect(projectPayload).toMatchObject({
    pluginId: PRIMARY_PLUGIN.id,
    appliedPluginSnapshotId: `snapshot-${PRIMARY_PLUGIN.id}-1`,
    pendingPrompt: 'Build a web prototype for product evaluators.',
  });
  await page.screenshot({ path: 'D:/readable-studio/.omo/evidence/task-7/preset-submit.png', fullPage: true });
});

test('plugin details open; replacement cancel is lossless; replace commits; clear restores the default route', async ({ page }) => {
  let projectPayload: ProjectPayload | null = null;
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    projectPayload = await fulfillProject(route, 'clear');
  });

  await gotoHome(page);
  await choosePrototypePreset(page);
  await page.getByTestId('home-hero-active-plugin').getByRole('button').first().click();
  const details = page.getByTestId('plugin-details-modal');
  await expect(details).toBeVisible();
  await expect(details).toHaveAttribute('data-plugin-id', PRIMARY_PLUGIN.id);
  await page.getByRole('dialog', { name: 'Web Prototype preview' })
    .getByRole('button', { name: 'Close', exact: true })
    .click();

  const editor = page.getByTestId('home-hero-input');
  await editor.fill('Keep this edited draft exactly');
  const dashboard = page.locator(`[data-testid="home-hero-plugin-preset"][data-plugin-id="${REQUIRED_PLUGIN.id}"]`);
  await dashboard.click();
  const replacement = page.getByRole('dialog', { name: /Replace current prompt/i });
  await expect(replacement).toBeVisible();
  await replacement.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(editor).toHaveText('Keep this edited draft exactly');
  await expect(page.getByTestId('home-hero-active-plugin')).toContainText('Web Prototype');
  await expect(page.getByTestId('home-hero-footer-option-brief')).toHaveCount(0);

  await dashboard.click();
  await replacement.getByRole('button', { name: 'Replace', exact: true }).click();
  await expect(page.getByTestId('home-hero-active-plugin')).toContainText('Dashboard Prototype');
  await expect(page.getByTestId('home-hero-footer-option-brief')).toBeVisible();
  await page.getByRole('button', { name: 'Clear active plugin' }).click();
  await expect(page.getByTestId('home-hero-active-plugin')).toHaveCount(0);

  await editor.fill('Use the default route after clear');
  await page.getByTestId('home-hero-submit').click();
  await expect.poll(() => projectPayload).not.toBeNull();
  expect(projectPayload).toMatchObject({ pluginId: DEFAULT_UNSELECTED_SCENARIO_PLUGIN_ID });
});

test('skill selection clears plugin routing and forwards skillId', async ({ page }) => {
  let projectPayload: ProjectPayload | null = null;
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    projectPayload = await fulfillProject(route, 'skill');
  });

  await gotoHome(page);
  const editor = page.getByTestId('home-hero-input');
  await editor.fill('@layout');
  const picker = page.getByTestId('home-hero-plugin-picker');
  await picker.getByRole('tab', { name: /Skills/i }).click();
  await picker.getByRole('option', { name: /QA Layout Skill/i }).click();
  await expect(page.getByTestId('home-hero-active-skill')).toContainText('QA Layout Skill');
  await editor.fill('Route this through the selected skill');
  await page.getByTestId('home-hero-submit').click();
  await expect.poll(() => projectPayload).not.toBeNull();
  expect(projectPayload).toMatchObject({ skillId: SKILL.id, pendingPrompt: 'Route this through the selected skill' });
  expect(projectPayload).not.toHaveProperty('pluginId');
});

test('mention-picked plugins remain context and never silently become the routed driver', async ({ page }) => {
  let projectPayload: ProjectPayload | null = null;
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    projectPayload = await fulfillProject(route, 'context');
  });

  await gotoHome(page);
  const editor = page.getByTestId('home-hero-input');
  await editor.fill('@Dashboard');
  const picker = page.getByTestId('home-hero-plugin-picker');
  await picker.getByRole('tab', { name: /Plugins/i }).click();
  await picker.getByRole('option', { name: /Dashboard Prototype/i }).click();
  await expect(editor).toContainText('@Dashboard Prototype');
  await page.getByTestId('home-hero-submit').click();
  await expect.poll(() => projectPayload).not.toBeNull();
  expect(projectPayload).toMatchObject({
    pluginId: DEFAULT_UNSELECTED_SCENARIO_PLUGIN_ID,
    metadata: { contextPlugins: [expect.objectContaining({ id: REQUIRED_PLUGIN.id })] },
  });
});

test('missing required plugin input is named visibly and blocks project creation', async ({ page }) => {
  let projectPosts = 0;
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    projectPosts += 1;
    await fulfillProject(route, 'unexpected');
  });

  await gotoHome(page);
  await choosePrototypePreset(page, REQUIRED_PLUGIN.id);
  const brief = page.getByTestId('home-hero-footer-option-brief');
  await expect(brief).toBeVisible();
  await expect(brief).toHaveValue('');
  const alert = page.locator('.home-hero__error[role="alert"]');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('Audience brief');
  await expect(page.getByTestId('home-hero-submit')).toBeDisabled();
  expect(projectPosts).toBe(0);
  await page.screenshot({ path: 'D:/readable-studio/.omo/evidence/task-7/required-input-blocked.png', fullPage: true });
});

test('changed inputs force a fresh snapshot before submission', async ({ page }) => {
  const applyBodies: Array<{ inputs?: Record<string, unknown> }> = [];
  const firstApplyStarted = deferred<void>();
  const firstApplyRelease = deferred<void>();
  let projectPayload: ProjectPayload | null = null;
  await page.unroute('**/api/plugins/*/apply');
  await page.route('**/api/plugins/*/apply', async (route) => {
    const body = route.request().postDataJSON() as { inputs?: Record<string, unknown> };
    applyBodies.push(body);
    if (applyBodies.length === 1) {
      firstApplyStarted.resolve();
      await firstApplyRelease.promise;
    }
    await route.fulfill({ json: applyResponse(PRIMARY_PLUGIN.id, body.inputs ?? {}, applyBodies.length) });
  });
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    projectPayload = await fulfillProject(route, 'fresh-snapshot');
  });

  await gotoHome(page);
  await choosePrototypePreset(page);
  const editor = page.getByTestId('home-hero-input');
  const submit = page.getByTestId('home-hero-submit');
  await expect(editor).toContainText('Build a web prototype for product evaluators.');
  await expect(submit).toBeEnabled();
  await page.getByTestId('home-hero-active-plugin').getByRole('button').first().click();
  await page.getByTestId(`plugin-details-use-${PRIMARY_PLUGIN.id}`).click();
  await firstApplyStarted.promise;
  await editor.fill('Build a web prototype for operations leaders.');
  const audience = page.getByTestId('home-hero-footer-option-audience');
  await expect(audience).toHaveValue('operations leaders');
  const firstApplyResponse = page.waitForResponse((response) => (
    response.url().includes(`/api/plugins/${PRIMARY_PLUGIN.id}/apply`)
  ));
  firstApplyRelease.resolve();
  await firstApplyResponse;
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect.poll(() => projectPayload).not.toBeNull();
  expect(applyBodies).toHaveLength(2);
  expect(applyBodies[1]?.inputs).toMatchObject({ audience: 'operations leaders' });
  expect(projectPayload).toMatchObject({ appliedPluginSnapshotId: `snapshot-${PRIMARY_PLUGIN.id}-2` });
});

test('selection is rejected during submit and apply failure retains the draft with an actionable error', async ({ page }) => {
  const applyStarted = deferred<void>();
  const applyRelease = deferred<void>();
  let failApply = false;
  let projectPayload: ProjectPayload | null = null;
  await page.unroute('**/api/plugins/*/apply');
  await page.route('**/api/plugins/*/apply', async (route) => {
    if (failApply) {
      await route.fulfill({ status: 500, json: { error: 'forced apply failure' } });
      return;
    }
    applyStarted.resolve();
    await applyRelease.promise;
    const body = route.request().postDataJSON() as { inputs?: Record<string, unknown> };
    await route.fulfill({ json: applyResponse(PRIMARY_PLUGIN.id, body.inputs ?? {}, 1) });
  });
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    projectPayload = await fulfillProject(route, 'locked');
  });

  await gotoHome(page);
  await choosePrototypePreset(page);
  const editor = page.getByTestId('home-hero-input');
  const frozenDraft = await editor.textContent();
  await page.getByTestId('home-hero-submit').click();
  await applyStarted.promise;
  const dashboard = page.locator(`[data-testid="home-hero-plugin-preset"][data-plugin-id="${REQUIRED_PLUGIN.id}"]`);
  await expect(dashboard).toBeDisabled();
  await expect(editor).toHaveAttribute('contenteditable', 'false');
  applyRelease.resolve();
  await expect.poll(() => projectPayload).not.toBeNull();
  expect(projectPayload).toMatchObject({ pluginId: PRIMARY_PLUGIN.id });

  await page.goto('/');
  await expect(page.getByTestId('home-hero-input')).toBeVisible();
  failApply = true;
  await choosePrototypePreset(page);
  await expect(editor).toHaveText(frozenDraft ?? '');
  await page.getByTestId('home-hero-submit').click();
  const alert = page.locator('.home-hero__error[role="alert"]');
  await expect(alert).toContainText('select the plugin again to retry');
  await expect(page.getByTestId('home-hero-input')).toHaveText(frozenDraft ?? '');
});
