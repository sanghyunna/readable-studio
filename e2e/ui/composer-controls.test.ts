// Opt-in live Chromium evidence gate. No response mocks or inference calls.
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { AgentInfo } from '@readable-studio/contracts';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { addStorageInitScript } from '@/playwright/storage-init';
import { ensureRailOpen } from '@/playwright/rail';
import { T } from '@/timeouts';

const evidence = fileURLToPath(new URL('../../.omo/evidence/composer-controls/', import.meta.url));
const captures: { id: string; title: string; values: unknown }[] = [];
const errors: string[] = [];
const agentTrigger = 'inline-model-switcher-agent-trigger';
const modelTrigger = 'inline-model-switcher-model-trigger';
const effortTrigger = 'inline-model-switcher-reasoning-trigger';
const effortPopover = 'inline-model-switcher-reasoning-popover';
const optionPrefix = 'inline-model-switcher-reasoning-option-';
let stage = 'preflight';

test.use({ trace: 'on' });

async function capture(page: Page, id: string, title: string, values: unknown) {
  await page.screenshot({ path: join(evidence, `${id}.png`), animations: 'disabled' });
  await writeFile(join(evidence, `${id}.json`), JSON.stringify({
    url: page.url(), viewport: page.viewportSize(), values,
    accessibility: await page.locator('body').ariaSnapshot(),
    footerHTML: await page.locator('.home-hero__input-foot, .composer-row').evaluateAll(nodes => nodes.map(n => n.outerHTML)),
  }, null, 2));
  captures.push({ id, title, values });
}

async function geometry(footer: Locator, sendId: string) {
  return footer.evaluate((node, sendTestId) => {
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const send = node.querySelector(`[data-testid="${sendTestId}"]`)!;
    const selectors = ['inline-model-switcher-agent-trigger', 'inline-model-switcher-model-trigger', 'inline-model-switcher-reasoning-trigger', sendTestId];
    const controls = [...node.querySelectorAll(selectors.map(id => `[data-testid="${id}"]`).join(','))];
    const s = rect(send);
    const f = rect(node);
    const overlap = controls.filter(el => el !== send).map(el => {
      const r = rect(el);
      return { id: el.getAttribute('data-testid'), area: Math.max(0, Math.min(r.right, s.right) - Math.max(r.x, s.x)) * Math.max(0, Math.min(r.bottom, s.bottom) - Math.max(r.y, s.y)) };
    });
    const hits = [[0.5, 0.5], [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]].map(([x, y]) => {
      const hit = document.elementFromPoint(s.x + s.width * x!, s.y + s.height * y!);
      return { x: s.x + s.width * x!, y: s.y + s.height * y!, inSend: hit !== null && send.contains(hit), tag: hit?.tagName };
    });
    const agent = node.querySelector('[data-testid="inline-model-switcher-agent-trigger"]')!;
    const model = node.querySelector('[data-testid="inline-model-switcher-model-trigger"]')!;
    const icon = agent.querySelector('.inline-switcher__chip-icon');
    const ac = agent.querySelector('.inline-switcher__chip-chevron');
    const mc = model.querySelector('.inline-switcher__chip-chevron');
    return {
      footer: f, send: s, sendDisabled: (send as HTMLButtonElement).disabled,
      sendInsideFooter: s.x >= f.x && s.y >= f.y && s.right <= f.right && s.bottom <= f.bottom,
      sendInsideViewport: s.x >= 0 && s.y >= 0 && s.right <= innerWidth && s.bottom <= innerHeight,
      order: controls.map(el => el.getAttribute('data-testid')),
      controls: controls.map(el => ({ id: el.getAttribute('data-testid'), box: rect(el) })),
      overlap, hits,
      chevrons: {
        agentTag: ac?.tagName, modelTag: mc?.tagName,
        identicalMarkup: ac?.outerHTML === mc?.outerHTML,
        agentLastChild: agent.lastElementChild === ac,
        icon: icon ? rect(icon) : null, agent: ac ? rect(ac) : null, model: mc ? rect(mc) : null,
      },
      effortTriggerCount: node.querySelectorAll('[data-testid="inline-model-switcher-reasoning-trigger"]').length,
    };
  }, sendId);
}

function assertOrder(values: Awaited<ReturnType<typeof geometry>>, sendId: string) {
  expect(values.order).toEqual([agentTrigger, modelTrigger, effortTrigger, sendId]);
  expect(values.controls.every((item, i, items) => i === 0 || item.box.x >= items[i - 1]!.box.right)).toBe(true);
}

function assertSend(values: Awaited<ReturnType<typeof geometry>>) {
  expect(values.sendInsideFooter, JSON.stringify(values)).toBe(true);
  expect(values.sendInsideViewport, JSON.stringify(values)).toBe(true);
  expect(values.overlap.every(item => item.area === 0), JSON.stringify(values.overlap)).toBe(true);
  expect(values.hits.every(item => item.inSend), JSON.stringify(values.hits)).toBe(true);
}

async function selectAgent(page: Page, scope: Locator, id: string) {
  await scope.getByTestId(agentTrigger).click();
  const picker = page.getByTestId('inline-model-switcher-agent-popover');
  await expect(picker).toBeVisible();
  const saved = page.waitForResponse(r => new URL(r.url()).pathname === '/api/app-config' && r.request().method() === 'PUT' && r.request().postDataJSON().agentId === id, { timeout: T.long });
  await picker.getByTestId(`inline-model-switcher-agent-${id}`).click();
  expect((await saved).ok()).toBe(true);
  await expect(picker.getByTestId(`inline-model-switcher-agent-${id}`)).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
}

test('[P1] live composer controls: chevrons, ordering, narrow Send, effort persistence and absence, workspace', async ({ page, request }, testInfo) => {
  test.setTimeout(T.xlong * 6);
  expect(process.env.READABLE_E2E_NAMESPACE).toBe('composer-qa');
  expect(testInfo.project.use.baseURL).toBe('http://127.0.0.1:17962');
  await mkdir(evidence, { recursive: true });
  page.on('pageerror', error => errors.push(error.message));
  const runRequests: string[] = [];
  page.on('request', req => {
    if (req.method() === 'POST' && /\/api\/(?:chat|runs|projects\/[^/]+\/runs)(?:\?|$)/.test(req.url())) runRequests.push(req.url());
  });
  try {
    const response = await request.get('/api/agents');
    expect(response.ok()).toBe(true);
    const agents = (await response.json() as { agents: AgentInfo[] }).agents;
    const claude = agents.find(agent => agent.id === 'claude')!;
    const gemini = agents.find(agent => agent.id === 'gemini')!;
    expect(claude.available).toBe(true);
    expect(claude.reasoningOptions!.length).toBeGreaterThan(1);
    expect(gemini.available).toBe(true);
    expect(gemini.reasoningOptions ?? []).toEqual([]);
    const model = claude.models!.filter(item => item.id !== 'default').sort((a, b) => b.label.length - a.label.length)[0]!;
    const levels = model.reasoningOptions ?? claude.reasoningOptions!;
    const selected = levels.find(item => item.id === 'xhigh') ?? levels.at(-1)!;
    await writeFile(join(evidence, 'capabilities.json'), JSON.stringify({
      source: '/api/agents (unmodified real daemon response)',
      claude, gemini, selectedModel: model, expectedLevels: levels,
      databricks: agents.find(agent => agent.id === 'databricks'),
    }, null, 2));
    await addStorageInitScript(page, () => {
      localStorage.setItem('readable-studio:locale', 'en');
      localStorage.setItem('readable-studio:locale-source', 'manual');
    }, undefined);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const hub = page.getByTestId('home-hero-agent-model');
    await expect(hub).toBeVisible({ timeout: T.xlong });
    await selectAgent(page, hub, claude.id);
    await hub.getByTestId(modelTrigger).click();
    const modelPicker = page.getByTestId('inline-model-switcher-model-popover');
    const modelSaved = page.waitForResponse(r => new URL(r.url()).pathname === '/api/app-config' && r.request().method() === 'PUT' && r.request().postDataJSON().agentModels?.claude?.model === model.id, { timeout: T.long });
    await modelPicker.getByTestId(`inline-model-switcher-model-option-${model.id}`).click();
    expect((await modelSaved).ok()).toBe(true);
    await expect(modelPicker).toHaveCount(0);
    await page.getByTestId('home-hero-input').fill('Composer geometry proof - unsent draft');
    await expect(page.getByTestId('home-hero-submit')).toBeEnabled();
    const footer = page.locator('.home-hero__input-foot');
    stage = 'a-b';
    const hubValues = await geometry(footer, 'home-hero-submit');
    await capture(page, 'a-b-hub', 'a/b. Hub chevron type, icon geometry and DOM order', hubValues);
    expect(hubValues.chevrons.agentTag).toBe('svg');
    expect(hubValues.chevrons.modelTag).toBe(hubValues.chevrons.agentTag);
    expect(hubValues.chevrons.identicalMarkup).toBe(true);
    expect(hubValues.chevrons.agent!.x).toBeGreaterThanOrEqual(hubValues.chevrons.icon!.right);
    assertOrder(hubValues, 'home-hero-submit');

    stage = 'c';
    await page.setViewportSize({ width: 900, height: 600 });
    // Native trial click waits for layout stability and hit testing without sending.
    await page.getByTestId('home-hero-submit').click({ trial: true });
    const narrow = await geometry(footer, 'home-hero-submit');
    await capture(page, 'c-narrow-hub', 'c. Minimum supported 900 x 600: Send containment and five hit tests', narrow);
    assertOrder(narrow, 'home-hero-submit');
    assertSend(narrow);

    stage = 'd';
    await hub.getByTestId(effortTrigger).click();
    const picker = page.getByTestId(effortPopover);
    await expect(picker).toBeVisible();
    const rows = await picker.getByRole('option').evaluateAll(nodes => nodes.map(node => ({ id: node.getAttribute('data-testid')!.replace('inline-model-switcher-reasoning-option-', ''), selected: node.getAttribute('aria-selected'), text: node.textContent?.trim() })));
    const openGeometry = await geometry(footer, 'home-hero-submit');
    await capture(page, 'd-effort-levels', 'd. Real agent-advertised effort levels; Send while effort menu is open', { advertised: levels, rows, geometry: openGeometry });
    expect(rows.map(row => row.id)).toEqual(levels.map(item => item.id));
    assertSend(openGeometry);
    const effortSaved = page.waitForResponse(r => new URL(r.url()).pathname === '/api/app-config' && r.request().method() === 'PUT' && r.request().postDataJSON().agentModels?.claude?.reasoning === selected.id, { timeout: T.long });
    await picker.getByTestId(`${optionPrefix}${selected.id}`).click();
    expect((await effortSaved).ok()).toBe(true);
    await expect(picker).toHaveCount(0);
    const persisted = await (await request.get('/api/app-config')).json();
    expect(persisted.config.agentModels.claude).toMatchObject({ model: model.id, reasoning: selected.id });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(hub.getByTestId(effortTrigger)).toBeVisible({ timeout: T.xlong });
    await hub.getByTestId(effortTrigger).click();
    await expect(picker.getByTestId(`${optionPrefix}${selected.id}`)).toHaveAttribute('aria-selected', 'true');
    await capture(page, 'd-persisted-effort', 'd. Selected effort survives page reload and is stored by the daemon', { selectedId: selected.id, persistedChoice: persisted.config.agentModels.claude, selectedOptionCount: await picker.locator('[role="option"][aria-selected="true"]').count(), selectedDOM: await picker.getByTestId(`${optionPrefix}${selected.id}`).evaluate(node => node.outerHTML) });
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);

    stage = 'e';
    await selectAgent(page, hub, gemini.id);
    await expect(hub.getByTestId(effortTrigger)).toHaveCount(0);
    const absent = await geometry(footer, 'home-hero-submit');
    await capture(page, 'e-no-effort', 'e. Gemini advertises no levels: effort trigger is absent from DOM', { advertisedAgentLevels: gemini.reasoningOptions ?? [], ...absent });
    expect(absent.effortTriggerCount).toBe(0);
    expect(absent.order).toEqual([agentTrigger, modelTrigger, 'home-hero-submit']);

    stage = 'f';
    await page.setViewportSize({ width: 1440, height: 1000 });
    await selectAgent(page, hub, claude.id);
    await ensureRailOpen(page);
    await page.getByTestId('hub-new-project').click();
    const modal = page.getByTestId('new-project-modal');
    await expect(modal).toBeVisible();
    await modal.getByTestId('new-project-tab-other').click();
    await modal.getByTestId('new-project-name').fill('Composer controls QA - no inference');
    await modal.getByTestId('newproj-mode-chat').click();
    const created = page.waitForResponse(r => new URL(r.url()).pathname === '/api/projects' && r.request().method() === 'POST', { timeout: T.long });
    await modal.getByTestId('create-project').click();
    expect((await created).ok()).toBe(true);
    await expect(page).toHaveURL(/\/projects\//, { timeout: T.xlong });
    const workspace = page.getByTestId('chat-composer');
    await expect(workspace).toBeVisible({ timeout: T.xlong });
    await expect(workspace.getByTestId(effortTrigger)).toBeVisible();
    const workspaceValues = await geometry(page.locator('.composer-row'), 'chat-send');
    await capture(page, 'f-workspace', 'f. Workspace has the same agent/model/effort/Send cluster', { ...workspaceValues, reasoningLabel: await workspace.getByTestId('inline-model-switcher-reasoning-label').textContent() });
    assertOrder(workspaceValues, 'chat-send');
    expect(workspaceValues.chevrons.identicalMarkup).toBe(true);
    expect(runRequests).toEqual([]);
    expect(errors).toEqual([]);
  } catch (error) {
    await capture(page, `${stage}-failure`, `FAIL at ${stage}`, { error: String(error), errors });
    throw error;
  }
});

test.afterEach(async ({}, testInfo) => {
  await writeFile(join(evidence, 'gate.md'), `# Composer controls - real Chromium gate\n\nVerdict: **${testInfo.status === 'passed' ? 'PASS' : 'FAIL'}**. Runner status: ${testInfo.status}. Actual runner counts and lifecycle status are appended after execution.\n\nRuntime: composer-qa; web 17962; daemon 17862; tools root .tmp/tools-dev-composer-qa; data .tmp/tools-dev-composer-qa/data.\n\nNo API response mocks, app-config seeds, product edits, inference, or cloud writes. Locale only is seeded. Native UI actions select the real daemon-advertised Claude model/effort and Gemini agent, then create one blank local project. Databricks starts with an empty registry and is not fabricated to stand in for a no-effort ACP agent. Per-model precedence is resolved from the actual selected model, falling back to its agent list.\n\nMinimum width: 900 CSS px; minimum height: 600 CSS px, matching apps/desktop/src/main/runtime.ts:1446-1447. Measurements use Chromium getBoundingClientRect; hit tests use document.elementFromPoint. Screenshots disable animations only for capture; native trial click measures settled Send without triggering inference.\n\n[Real capability response](capabilities.json).\n\n${captures.map(item => `## ${item.title}\n\n![${item.title}](${item.id}.png)\n\n[DOM and accessibility](${item.id}.json)\n\n\`\`\`json\n${JSON.stringify(item.values, null, 2)}\n\`\`\`\n`).join('\n')}\n## Errors\n\n\`\`\`json\n${JSON.stringify({ pageErrors: errors, runnerErrors: testInfo.errors }, null, 2)}\n\`\`\`\n`);
});
