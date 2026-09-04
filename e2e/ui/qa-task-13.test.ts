import { expect, test, type APIRequestContext, type CDPSession, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { gotoEntryHome } from '../lib/playwright/amr.ts';
import { captureCanonical, describeMotionOffenders, evidenceDir, flushReport, maxCssTimeMilliseconds, recordRegion, type MotionOffender } from '../lib/qa-task-13-helpers.ts';

const HOME_CONFIG = {
  mode: 'daemon', apiKey: '', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5',
  agentId: 'codex', skillId: null, designSystemId: null, onboardingCompleted: false,
  agentModels: { codex: { model: 'default', reasoning: 'default' } }, agentCliEnv: {},
  privacyDecisionAt: 1, telemetry: { metrics: false, content: false, artifactManifest: false },
} as const;
const PROJECT_NAMES = ['분기 보고서', '온보딩 덱', '가격 페이지', '브랜드 리뉴얼', '문서 포털', '클라이언트 마이크로사이트', '투자자 원페이저'] as const;
const ONBOARDING_SELECTORS = ['.onboarding-view', '.entry-onboarding-modal', '.entry-shell--onboarding'] as const;

interface SeededProject { readonly id: string; readonly sessions: readonly { id: string; title: string }[] }
declare global { interface Window { __task13TransparencyReady?: Promise<void> } }
let projects: SeededProject[] = [];

test.use({ locale: 'ko-KR', deviceScaleFactor: 2, colorScheme: 'light' });
test.describe.configure({ retries: 0 });

async function putFirstRunConfig(request: APIRequestContext): Promise<void> {
  const current = await request.get('/api/app-config');
  expect(current.ok(), await current.text()).toBeTruthy();
  const body = (await current.json()) as { config?: Record<string, unknown> };
  const response = await request.put('/api/app-config', {
    data: { ...body.config, ...HOME_CONFIG, onboardingCompleted: false },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function seed(request: APIRequestContext): Promise<SeededProject[]> {
  const run = `${Date.now().toString(36)}-${process.pid}`;
  const seeded: SeededProject[] = [];
  for (const [creationIndex, name] of PROJECT_NAMES.slice().reverse().entries()) {
    const created = await request.post('/api/projects', { data: {
      id: `task-13-${run}-${creationIndex}`, name, skillId: null, designSystemId: null,
      pendingPrompt: null, metadata: { kind: 'prototype', nameSource: 'user' },
    } });
    expect(created.ok(), await created.text()).toBeTruthy();
    const project = ((await created.json()) as { project: { id: string } }).project;
    const sessions: { id: string; title: string }[] = [];
    const count = name === PROJECT_NAMES[0] ? 11 : 1;
    for (let index = 0; index < count; index += 1) {
      const title = name === PROJECT_NAMES[0] ? `보고서 작업 ${index + 1}` : `${name} 시작`;
      const response = await request.post(`/api/projects/${project.id}/conversations`, { data: { title } });
      expect(response.ok(), await response.text()).toBeTruthy();
      const session = ((await response.json()) as { conversation: { id: string; title: string } }).conversation;
      await request.patch(`/api/projects/${project.id}/conversations/${session.id}`, { data: { title } });
      sessions.push({ id: session.id, title });
    }
    seeded.unshift({ id: project.id, sessions });
  }
  return seeded;
}

async function setRunState(request: APIRequestContext, project: SeededProject, index: number, status: 'running' | 'failed'): Promise<void> {
  const session = project.sessions.at(index);
  if (!session) throw new RangeError(`Missing seeded session at index ${index}`);
  const startedAt = Date.now() - 125_000;
  for (const message of [
    { id: `u-${session.id}`, role: 'user', content: '색상과 레이아웃을 정리해 주세요.', createdAt: startedAt - 1_000 },
    { id: `a-${session.id}`, role: 'assistant', content: '', agentId: 'codex', runId: `task-13-${session.id}`, runStatus: status, createdAt: startedAt, startedAt, ...(status === 'failed' ? { endedAt: startedAt + 1_000 } : {}), events: [] },
  ]) {
    const response = await request.put(`/api/projects/${project.id}/conversations/${session.id}/messages/${message.id}`, { data: message });
    expect(response.ok(), await response.text()).toBeTruthy();
  }
}

async function sequenceSessionsByRecency(
  request: APIRequestContext,
  project: SeededProject,
): Promise<void> {
  for (const session of project.sessions.slice().reverse()) {
    const response = await request.patch(
      `/api/projects/${project.id}/conversations/${session.id}`,
      { data: { title: session.title } },
    );
    expect(response.ok(), await response.text()).toBeTruthy();
  }
}

async function emulatePreferences(
  page: Page,
  transparency: 'no-preference' | 'reduce',
  motion: 'no-preference' | 'reduce',
): Promise<CDPSession> {
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setEmulatedMedia', {
    media: 'screen',
    features: [
      { name: 'prefers-reduced-transparency', value: transparency },
      { name: 'prefers-reduced-motion', value: motion },
    ],
  });
  return session;
}

async function openHub(page: Page, request: APIRequestContext, viewport = { width: 1440, height: 900 }): Promise<void> {
  await page.setViewportSize(viewport);
  await page.addInitScript((config) => {
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('readable-studio:locale', 'ko');
    localStorage.setItem('readable-studio:locale-source', 'manual');
    localStorage.setItem('readable-studio:config', JSON.stringify(config));
  }, HOME_CONFIG);
  await putFirstRunConfig(request);
  await page.route('**/api/design-systems', (route) => route.fulfill({ json: { designSystems: [] } }));
  await page.route('**/api/plugins', (route) => route.fulfill({ json: { plugins: [] } }));
  const preferencesSession = await emulatePreferences(page, 'no-preference', 'no-preference');
  try {
    await page.goto('/');
    await expect(page.getByTestId('hub-nav')).toBeVisible();
    await expect(page.getByTestId('hub-composer')).toBeVisible();
    expect(await page.evaluate(() => ({
      transparency: matchMedia('(prefers-reduced-transparency: reduce)').matches,
      motion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    }))).toEqual({ transparency: false, motion: false });
    for (const selector of ONBOARDING_SELECTORS) await expect(page.locator(selector)).toHaveCount(0);
  } finally {
    await preferencesSession.detach();
  }
}

async function geometry(locator: Locator) {
  return locator.evaluate((node) => {
    const box = node.getBoundingClientRect(); const style = getComputedStyle(node);
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height,
      radius: style.borderRadius, background: style.backgroundImage, border: style.borderColor,
      shadow: style.boxShadow, backdrop: style.backdropFilter, transform: style.transform };
  });
}

async function compositeContrast(locator: Locator): Promise<{
  readonly ratio: number;
  readonly foreground: readonly [number, number, number, number];
  readonly background: readonly [number, number, number, number];
}> {
  return locator.evaluate((node) => {
    type Rgba = readonly [number, number, number, number];
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('2d canvas unavailable');
    const parseColor = (value: string): Rgba => {
      if (!CSS.supports('color', value)) throw new TypeError(`Unsupported CSS color: ${value}`);
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const sample = context.getImageData(0, 0, 1, 1).data;
      return [sample[0] ?? 0, sample[1] ?? 0, sample[2] ?? 0, sample[3] ?? 0];
    };
    const composite = (source: Rgba, destination: Rgba): Rgba => {
      const sourceAlpha = source[3] / 255;
      const destinationAlpha = destination[3] / 255;
      const alpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
      if (alpha === 0) return [0, 0, 0, 0];
      return [
        (source[0] * sourceAlpha + destination[0] * destinationAlpha * (1 - sourceAlpha)) / alpha,
        (source[1] * sourceAlpha + destination[1] * destinationAlpha * (1 - sourceAlpha)) / alpha,
        (source[2] * sourceAlpha + destination[2] * destinationAlpha * (1 - sourceAlpha)) / alpha,
        alpha * 255,
      ];
    };
    const chain: Element[] = [];
    for (let current: Element | null = node; current; current = current.parentElement) chain.unshift(current);
    const effectiveBackground = chain.reduce<Rgba>(
      (background, current) => composite(parseColor(getComputedStyle(current).backgroundColor), background),
      [255, 255, 255, 255],
    );
    const displayedForeground = composite(parseColor(getComputedStyle(node).color), effectiveBackground);
    const luminance = (rgba: Rgba) => {
      const channel = (value: number) => { const v = value / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * channel(rgba[0]) + 0.7152 * channel(rgba[1]) + 0.0722 * channel(rgba[2]);
    };
    const [high = 0, low = 0] = [luminance(displayedForeground), luminance(effectiveBackground)].sort((a, b) => b - a);
    const bytes = (rgba: Rgba): Rgba => [
      Math.round(rgba[0]),
      Math.round(rgba[1]),
      Math.round(rgba[2]),
      Math.round(rgba[3]),
    ];
    return {
      ratio: (high + 0.05) / (low + 0.05),
      foreground: bytes(displayedForeground),
      background: bytes(effectiveBackground),
    };
  });
}

async function screenshotMotion(page: Page, slug: string, locator: Locator, action: () => Promise<void>): Promise<void> {
  await locator.screenshot({ path: `${evidenceDir}/13-${slug}-rest.png`, animations: 'allow' });
  await action();
  const running = await locator.evaluate((node) =>
    node.getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running').length,
  );
  expect(running, `${slug} must have a meaningful transition`).toBeGreaterThan(0);
  await locator.screenshot({ path: `${evidenceDir}/13-${slug}-mid.png`, animations: 'allow' });
  await locator.evaluate((node) =>
    Promise.allSettled(node.getAnimations({ subtree: true }).map((animation) => animation.finished)),
  );
  await locator.screenshot({ path: `${evidenceDir}/13-${slug}-settled.png`, animations: 'allow' });
}

test.beforeAll(async ({ request }) => {
  mkdirSync(evidenceDir, { recursive: true });
  projects = await seed(request);
  const primaryProject = projects.at(0);
  if (!primaryProject) throw new RangeError('Task 13 QA requires a primary seeded project');
  await setRunState(request, primaryProject, 3, 'failed');
  await setRunState(request, primaryProject, 0, 'running');
  await sequenceSessionsByRecency(request, primaryProject);
});

test.afterAll(() => flushReport());

test('canonical start proves R1-R11 and R14 from rendered paint and geometry', async ({ page, request }) => {
  await openHub(page, request);
  const primaryProject = projects.at(0);
  if (!primaryProject) throw new RangeError('Task 13 QA requires a primary seeded project');
  const canonicalMedia = await page.evaluate(() => ({
    reducedTransparency: matchMedia('(prefers-reduced-transparency: reduce)').matches,
    backdropSupported: CSS.supports('backdrop-filter', 'blur(1px)'),
  }));
  expect(canonicalMedia).toEqual({ reducedTransparency: false, backdropSupported: true });
  const hubBox = await geometry(page.locator('.hub'));
  const rail = page.getByTestId('hub-nav'); const railBox = await geometry(rail);
  const railPaint = await rail.evaluate((node) => {
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('2d canvas unavailable');
    const style = getComputedStyle(node); context.fillStyle = style.backgroundColor; context.fillRect(0, 0, 1, 1);
    return { alpha: context.getImageData(0, 0, 1, 1).data[3] ?? 0, backdrop: style.backdropFilter };
  });
  const wash = page.locator('.hub__wash'); const washPaint = await wash.evaluate((node) => {
    const styles = [getComputedStyle(node), getComputedStyle(node, '::before'), getComputedStyle(node, '::after')];
    return { display: styles[0]?.display, pointer: styles[0]?.pointerEvents, radialGradients: styles.filter((style) => style.backgroundImage.startsWith('radial-gradient(')).length };
  });
  const stage = await geometry(page.locator('.hub__stage')); const stageTrack = stage.left - hubBox.left; const stack = await geometry(page.locator('.hub__start'));
  const title = page.locator('.home-hero__title'); const titlePaint = await title.evaluate((node) => {
    const style = getComputedStyle(node);
    return { text: node.textContent?.trim(), fontSize: style.fontSize, fontWeight: style.fontWeight, textAlign: style.textAlign, letterSpacing: style.letterSpacing };
  });
  expect(hubBox.left).toBeCloseTo(0, 0); expect(railBox.left).toBeCloseTo(10, 0); expect(stageTrack).toBeCloseTo(292, 0); expect(railBox.width).toBeCloseTo(282, 0); expect(railBox.radius).toBe('12px');
  expect(railPaint.alpha).toBeGreaterThan(0); expect(railPaint.alpha).toBeLessThan(255); expect(washPaint.radialGradients).toBe(3);
  expect(railPaint.backdrop).toContain('blur(22px)'); expect(railPaint.backdrop).toContain('saturate(');
  expect(railBox.shadow).toContain('inset'); expect(washPaint.display).toBe('block'); expect(washPaint.pointer).toBe('none');
  expect(Math.abs((stack.top + stack.bottom - stage.top - stage.bottom) / 2)).toBeLessThanOrEqual(8);
  expect(titlePaint.text).toBe('무엇을 만들까요?'); expect(titlePaint.textAlign).toBe('left'); expect(titlePaint.fontWeight).toBe('640'); expect(Number.parseFloat(titlePaint.fontSize)).toBeGreaterThanOrEqual(37);
  await expect(page.locator('.home-view--hub .home-hero__brand:visible')).toHaveCount(0);

  const mark = page.locator('[data-testid="hub-brand"] img.hub__brand-mark');
  const logo = await mark.evaluate((image: HTMLImageElement) => ({ src: image.src, naturalWidth: image.naturalWidth, background: getComputedStyle(image).backgroundImage }));
  expect(logo.src).toMatch(/\/logo\.(svg|png)(?:\?.*)?$/u); expect(logo.naturalWidth).toBeGreaterThan(0); expect(logo.background).not.toContain('gradient');
  const logoResponse = await request.get(new URL(logo.src).pathname); expect(logoResponse.status()).toBe(200);
  const railBrandCount = await page.getByTestId('hub-brand').count();
  const railBrandVisible = await page.getByTestId('hub-brand').isVisible();
  const visibleDuplicateBrands = await page.locator('.home-view--hub .home-hero__brand:visible').count();
  const visibleBrandMarks = await page.locator('[data-testid="hub-brand"] img.hub__brand-mark:visible').count();

  const footerButtons = page.locator('[data-testid="hub-composer"] .home-hero__footer-options button'); await expect(footerButtons).toHaveCount(1);
  const contextControl = page.getByTestId('home-hero-context-control'); await expect(contextControl).toBeVisible();
  const modeTrigger = page.getByTestId('session-mode-trigger'); await expect(modeTrigger).toBeVisible(); await expect(modeTrigger).toBeEnabled();
  await modeTrigger.click(); await expect(page.getByRole('menuitemradio')).toHaveCount(2); await page.keyboard.press('Escape');
  const agentModel = page.getByTestId('home-hero-agent-model'); await expect(agentModel).toBeVisible();
  const agentModelChip = agentModel.getByTestId('inline-model-switcher-chip'); await expect(agentModelChip).toBeEnabled();
  await agentModelChip.click(); await expect(page.getByTestId('inline-model-switcher-popover')).toBeVisible(); await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('hub-command-palette')).toBeVisible();
  await page.getByTestId('hub-palette-item-command-create-template').click();
  const newProjectModal = page.getByTestId('new-project-modal'); await expect(newProjectModal).toBeVisible();
  await expect(newProjectModal.getByTestId('new-project-tab-template')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape'); await expect(newProjectModal).toHaveCount(0);
  const accentControlLocators = [
    page.getByTestId('home-hero-plus-trigger').locator('svg'),
    contextControl.locator('svg').first(),
    modeTrigger.locator('svg').first(),
    agentModel.locator('svg').first(),
  ] as const;
  const accentMeasurements = await Promise.all(accentControlLocators.map((locator) => compositeContrast(locator)));
  const accentColorKeys = accentMeasurements.map((measurement) => measurement.foreground.slice(0, 3).join(','));
  const minimumAccentContrast = Math.min(...accentMeasurements.map((measurement) => measurement.ratio));
  const systematicBlueAccent = new Set(accentColorKeys).size === 1
    && accentMeasurements.every((measurement) => measurement.foreground[2] > measurement.foreground[0]
      && measurement.foreground[2] > measurement.foreground[1])
    && minimumAccentContrast >= 3;
  await expect(page.getByTestId('hub-live-time')).toBeVisible(); await expect(page.getByTestId('hub-live-strip').locator('svg')).toBeVisible();
  const brandHome = page.locator('.hub__brand-home'); await expect(brandHome).toHaveCSS('opacity', '0');
  await page.getByTestId('hub-brand').hover(); await expect(brandHome).toHaveCSS('opacity', '1');
  await page.mouse.move(900, 700); await page.getByTestId('hub-brand').focus(); await expect(brandHome).toHaveCSS('opacity', '1');
  const live = page.getByTestId('hub-live-strip'); const arrow = live.locator('.hub__live-arrow');
  const liveBefore = await geometry(live); const arrowBefore = await geometry(arrow); await live.hover();
  await live.evaluate((node) =>
    Promise.allSettled(node.getAnimations({ subtree: true }).map((animation) => animation.finished)),
  );
  const liveAfter = await geometry(live); const arrowAfter = await geometry(arrow);
  const liveLift = liveBefore.top - liveAfter.top;
  const arrowShift = arrowAfter.left - arrowBefore.left;
  expect(liveLift).toBeGreaterThanOrEqual(0.75);
  expect(liveLift).toBeLessThanOrEqual(1.25);
  expect(arrowShift).toBeGreaterThanOrEqual(1.75);
  expect(arrowShift).toBeLessThanOrEqual(2.25);
  expect(liveBefore.shadow).toContain('0px 2px 10px');
  expect(liveAfter.shadow).toContain('0px 6px 18px');
  expect(liveAfter.shadow).not.toBe(liveBefore.shadow);

  const composerStart = page.getByTestId('hub-composer');
  const send = page.getByTestId('home-hero-submit');
  const composerBounds = await geometry(composerStart); const sendBounds = await geometry(send);
  const composerBackground = await composerStart.evaluate((node) => getComputedStyle(node).backgroundColor);
  const sendVisible = await send.isVisible(); const sendActionVisible = await send.locator('svg').isVisible();
  const finiteBounds = [
    composerBounds.left, composerBounds.top, composerBounds.right, composerBounds.bottom,
    composerBounds.width, composerBounds.height, sendBounds.left, sendBounds.top,
    sendBounds.right, sendBounds.bottom, sendBounds.width, sendBounds.height,
  ].every(Number.isFinite);
  const sendContained = sendBounds.left >= composerBounds.left && sendBounds.right <= composerBounds.right
    && sendBounds.top >= composerBounds.top && sendBounds.bottom <= composerBounds.bottom;
  const composerAndSendPainted = finiteBounds && composerBounds.width > 0 && composerBounds.height > 0
    && sendBounds.width > 0 && sendBounds.height > 0 && sendContained && sendVisible && sendActionVisible
    && composerBounds.shadow !== 'none' && composerBackground !== 'rgba(0, 0, 0, 0)';

  for (const [region, pass, anchor, observation] of [
    ['R1', railPaint.alpha > 0 && railPaint.alpha < 255 && washPaint.radialGradients === 3 && washPaint.pointer === 'none', `railAlpha=${railPaint.alpha}; radialGradients=${washPaint.radialGradients}; blur=${railPaint.backdrop}`, 'translucent pearl rail over three ambient radial washes'],
    ['R2', Math.abs(hubBox.left) < 1 && Math.abs(railBox.left - 10) < 1 && Math.abs(stageTrack - 292) < 1 && Math.abs(railBox.width - 282) < 1, `hubLeft=${hubBox.left}; navLeft=${railBox.left}; track=${stageTrack}; cardWidth=${railBox.width}; radius=${railBox.radius}`, 'expanded inset rail'],
    ['R3', railBox.shadow !== 'none', `railShadow=${railBox.shadow}`, 'elevation paints'],
    ['R4', Math.abs((stack.top + stack.bottom - stage.top - stage.bottom) / 2) <= 8, `centerDelta=${Math.abs((stack.top + stack.bottom - stage.top - stage.bottom) / 2).toFixed(2)}px`, 'start stack centred'],
    ['R5', titlePaint.text === '무엇을 만들까요?' && titlePaint.textAlign === 'left', `font=${titlePaint.fontSize}/${titlePaint.fontWeight}; align=${titlePaint.textAlign}`, 'Korean heading contract'],
    ['R6', railBrandCount === 1 && railBrandVisible && visibleBrandMarks === 1 && visibleDuplicateBrands === 0, `railBrands=${railBrandCount}; railBrandVisible=${railBrandVisible}; visibleMarks=${visibleBrandMarks}; visibleDuplicateBrands=${visibleDuplicateBrands}`, 'one visible rail brand and mark with the duplicate hero brand absent'],
    ['R7', systematicBlueAccent, `controls=${JSON.stringify(accentMeasurements)}; colorKeys=${accentColorKeys.join('|')}; minContrast=${minimumAccentContrast.toFixed(3)}`, 'composer control icons share one blue-dominant accent with measurable contrast'],
    ['R8', composerAndSendPainted, `composer=${JSON.stringify(composerBounds)}; background=${composerBackground}; send=${JSON.stringify(sendBounds)}; contained=${sendContained}; sendVisible=${sendVisible}; actionVisible=${sendActionVisible}`, 'finite painted composer bounds contain a visible send action'],
    ['R10', await brandHome.evaluate((node) => getComputedStyle(node).opacity) === '1', 'restOpacity=0; hover/focusOpacity=1', 'brand Home label responds to pointer and keyboard'],
    ['R11', liveLift >= 0.75 && liveLift <= 1.25 && arrowShift >= 1.75 && arrowShift <= 2.25 && liveAfter.shadow !== liveBefore.shadow && liveBefore.shadow.includes('0px 2px 10px') && liveAfter.shadow.includes('0px 6px 18px'), `liveLift=${liveLift.toFixed(2)}px; arrowShift=${arrowShift.toFixed(2)}px; restShadow=${liveBefore.shadow}; hoverShadow=${liveAfter.shadow}`, 'settled live strip lifts 1px, arrow advances 2px, and hover material strengthens'],
    ['R14', await footerButtons.count() === 1 && await modeTrigger.isVisible() && await agentModel.isVisible(), `footerButtons=${await footerButtons.count()}; modeVisible=${await modeTrigger.isVisible()}; agentModelVisible=${await agentModel.isVisible()}`, 'context, mode, and agent-model controls remain available with zero plugins'],
  ] as const) recordRegion({ region, state: 'start', pass, anchor, observation });
  // Project creation supplies one baseline conversation before this fixture's
  // 11 ordered sessions. HubSessionTree caps the resulting 12 at
  // HUB_SESSION_PAGE=5, leaving 7 hidden until one click reveals all 12.
  const primarySessions = page
    .getByTestId(`hub-project-${primaryProject.id}`)
    .locator(`[data-testid^="hub-session-"]`);
  const more = page.getByTestId(`hub-tree-more-${primaryProject.id}`);
  await expect(primarySessions).toHaveCount(5);
  await expect(more).toHaveText('세션 7개 더 보기');
  await more.click();
  await expect(primarySessions).toHaveCount(12);
  await expect(more).toHaveCount(0);
  // The reference includes open work, so open the legitimately running session
  // through the same user path rather than synthesizing rail state in HubHome.
  await page.getByTestId(`hub-session-${primaryProject.sessions[0]?.id}`).click();
  await page.goBack();
  await expect(page.getByTestId('hub-nav')).toBeVisible();
  await expect(page.getByTestId('hub-open-work')).toBeVisible();
  await captureCanonical(page, 'start');
});

test('filtered, busy, error, tooltip, toast/undo and palette are behavioral states', async ({ page, request }) => {
  await openHub(page, request);
  const primaryProject = projects.at(0);
  if (!primaryProject) throw new RangeError('Task 13 QA requires a primary seeded project');
  const search = page.getByTestId('hub-search'); await search.fill('검색 결과가 절대 없는 값'); await expect(page.getByTestId('hub-tree-empty')).toBeVisible();
  await captureCanonical(page, 'filtered'); await search.fill(''); await expect(page.getByTestId(`hub-project-${primaryProject.id}`)).toBeVisible();

  const editor = page.getByTestId('home-hero-input'); await editor.fill('abc'); await page.getByTestId('home-hero-submit').click();
  const composer = page.getByTestId('hub-composer'); await expect(composer).toHaveClass(/\bis-error\b/u);
  const alert = page.getByTestId('home-hero-error'); await expect(alert).toHaveCount(1); await expect(alert).toBeVisible();
  await expect(alert).toHaveText('무엇을 만들지 조금 더 자세히 적어 주세요.');
  await expect(editor).toHaveAttribute('aria-invalid', 'true');
  const errorPaint = await alert.evaluate((node) => {
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('2d canvas unavailable');
    const composerNode = node.parentElement?.querySelector<HTMLElement>('[data-testid="hub-composer"]');
    if (!composerNode) throw new Error('Error alert has no sibling Hub composer');
    const color = getComputedStyle(node).color; context.fillStyle = color; context.fillRect(0, 0, 1, 1);
    const [red = 0, green = 0, blue = 0, alpha = 0] = context.getImageData(0, 0, 1, 1).data;
    const composerBox = composerNode.getBoundingClientRect(); const alertBox = node.getBoundingClientRect();
    return {
      color, shadow: getComputedStyle(composerNode).boxShadow,
      rgba: { red, green, blue, alpha },
      visible: alertBox.width > 0 && alertBox.height > 0,
      below: alertBox.top >= composerBox.bottom,
      aligned: alertBox.left >= composerBox.left && alertBox.right <= composerBox.right,
    };
  });
  const dangerPaint = errorPaint.rgba.alpha === 255
    && errorPaint.rgba.red > 2 * errorPaint.rgba.green
    && errorPaint.rgba.red > 2 * errorPaint.rgba.blue;
  expect(dangerPaint).toBeTruthy(); expect(errorPaint.shadow).not.toBe('none');
  expect(errorPaint.visible).toBeTruthy(); expect(errorPaint.below).toBeTruthy(); expect(errorPaint.aligned).toBeTruthy();
  await captureCanonical(page, 'error'); await editor.fill('abcd'); await expect(editor).not.toHaveAttribute('aria-invalid', 'true'); await expect(alert).toHaveCount(0);
  recordRegion({ region: 'R13', state: 'error', pass: dangerPaint && errorPaint.visible && errorPaint.below && errorPaint.aligned && errorPaint.shadow !== 'none', anchor: `color=${errorPaint.color}; rgba=${errorPaint.rgba.red},${errorPaint.rgba.green},${errorPaint.rgba.blue},${errorPaint.rgba.alpha}; below=${errorPaint.below}; aligned=${errorPaint.aligned}; ariaInvalid=true`, observation: 'red-dominant sibling alert below the ringed composer clears on input' });

  let release: (() => void) | undefined; const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/projects', async (route) => { if (route.request().method() !== 'POST') return route.fallback(); await gate; await route.fallback(); });
  const posted = page.waitForRequest((incoming) => incoming.method() === 'POST' && new URL(incoming.url()).pathname === '/api/projects');
  await editor.fill('새로운 분기 보고서를 만들어 주세요'); await page.getByTestId('home-hero-submit').click(); await posted;
  await expect(composer).toHaveAttribute('aria-busy', 'true'); await expect(editor).toHaveAttribute('contenteditable', 'false');
  const controls = composer.locator('.home-hero__footer-options button'); for (const control of await controls.all()) await expect(control).toHaveAttribute('aria-disabled', 'true');
  const busySpinner = page.getByTestId('home-hero-submit').locator('[data-spinner]');
  await expect(busySpinner).toBeVisible(); await captureCanonical(page, 'busy');
  const busyAria = await composer.getAttribute('aria-busy');
  const editorEditable = await editor.getAttribute('contenteditable');
  const controlCount = await controls.count();
  const lockedControlCount = await controls.evaluateAll((nodes) => nodes.filter((node) => node.getAttribute('aria-disabled') === 'true').length);
  const submitDisabled = await page.getByTestId('home-hero-submit').isDisabled();
  const spinnerCount = await busySpinner.count(); const spinnerVisible = await busySpinner.isVisible();
  const busyStatePainted = busyAria === 'true' && editorEditable === 'false' && controlCount > 0
    && lockedControlCount === controlCount && submitDisabled && spinnerCount === 1 && spinnerVisible;
  if (!release) throw new Error('Busy-state request gate was not initialized');
  release();
  recordRegion({ region: 'R12', state: 'busy', pass: busyStatePainted, anchor: `ariaBusy=${busyAria}; contenteditable=${editorEditable}; lockedControls=${lockedControlCount}/${controlCount}; submitDisabled=${submitDisabled}; spinnerCount=${spinnerCount}; spinnerVisible=${spinnerVisible}`, observation: 'busy composer is read-only, locks every relevant control and send action, and paints one visible spinner' });

  await gotoEntryHome(page);
  await expect(page.getByTestId('hub-nav')).toBeVisible();
  await expect(page.getByTestId('hub-composer')).toBeVisible();
  const primaryProjectRow = page.getByTestId(`hub-project-${primaryProject.id}`);
  await expect(primaryProjectRow).toBeVisible();
  await expect(primaryProjectRow).toHaveAttribute('aria-expanded', 'false');
  // compactByDefault closes non-leading projects independently of the explicit
  // collapsed map; the first activation materializes that state, the second opens it.
  await primaryProjectRow.click();
  await expect(primaryProjectRow).toHaveAttribute('aria-expanded', 'false');
  await primaryProjectRow.click();
  await expect(primaryProjectRow).toHaveAttribute('aria-expanded', 'true');
  const hoverToggle = page.getByTestId('hub-rail-toggle'); const hoverStarted = Date.now(); await hoverToggle.hover(); const tooltip = page.locator('.readable-tooltip-layer, [role="tooltip"]'); await expect(tooltip).toBeVisible(); const hoverDelay = Date.now() - hoverStarted;
  expect(hoverDelay).toBeGreaterThanOrEqual(350); expect(await hoverToggle.getAttribute('aria-describedby')).toBeTruthy();
  await page.mouse.move(900, 700); await expect(tooltip).toHaveCount(0); const focusToggle = page.getByTestId('hub-rail-toggle'); await page.keyboard.press('Tab'); await focusToggle.focus(); await expect(tooltip).toBeVisible();
  recordRegion({ region: 'R15', state: 'tooltip', pass: hoverDelay >= 350, anchor: `hoverDelayMs=${hoverDelay}; describedBy=${await focusToggle.getAttribute('aria-describedby')}`, observation: 'delayed hover and focus tooltip' });

  const session = primaryProject.sessions.at(2);
  if (!session) throw new RangeError('Task 13 QA requires a third primary-project session');
  const sessionId = session.id;
  const sessionRow = page.getByTestId(`hub-session-${sessionId}`);
  const targetDeletePath = `/api/projects/${encodeURIComponent(primaryProject.id)}/conversations/${encodeURIComponent(sessionId)}`;
  let targetDeleteRequests = 0;
  const observeTargetDelete = (incoming: { method(): string; url(): string }) => {
    if (incoming.method() === 'DELETE' && new URL(incoming.url()).pathname === targetDeletePath) {
      targetDeleteRequests += 1;
    }
  };
  page.on('request', observeTargetDelete);
  await page.getByTestId(`hub-menu-session-${sessionId}`).click();
  await page.getByRole('menuitem', { name: /삭제|delete/i }).click();
  await expect(sessionRow).toHaveCount(0);
  const toast = page.locator('.readable-toast');
  await expect(toast).toHaveCount(1);
  await expect(toast).toBeVisible();
  await expect(toast.locator('.readable-toast-message')).toHaveText(`${session.title} 세션을 삭제했습니다`);
  const undo = toast.getByRole('button', { name: /실행 취소|undo/i });
  await expect(undo).toBeVisible();

  const toastPlacement = await toast.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return {
      position: getComputedStyle(node).position,
      left: box.left,
      right: box.right,
      bottom: box.bottom,
      width: box.width,
      height: box.height,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
    };
  });
  const toastCenterDelta = Math.abs((toastPlacement.left + toastPlacement.right) / 2 - toastPlacement.viewportWidth / 2);
  const toastBottomInset = toastPlacement.viewportHeight - toastPlacement.bottom;
  expect(toastPlacement.position).toBe('fixed');
  expect(toastPlacement.width).toBeGreaterThan(0);
  expect(toastPlacement.height).toBeGreaterThan(0);
  expect(toastCenterDelta).toBeLessThanOrEqual(1);
  expect(toastBottomInset).toBeGreaterThan(0);

  const stableLocators = [
    page.locator('.hub'),
    page.getByTestId('hub-nav'),
    page.locator('.hub__stage'),
    page.locator('.hub__start'),
    page.getByTestId('hub-composer'),
  ] as const;
  const measureStableHub = async () => ({
    boxes: await Promise.all(stableLocators.map((locator) => geometry(locator))),
    extents: await page.evaluate(() => ({
      document: {
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        clientWidth: document.documentElement.clientWidth,
        clientHeight: document.documentElement.clientHeight,
      },
      body: {
        scrollWidth: document.body.scrollWidth,
        scrollHeight: document.body.scrollHeight,
        clientWidth: document.body.clientWidth,
        clientHeight: document.body.clientHeight,
      },
    })),
  });
  const stableBeforeUndo = await measureStableHub();
  await undo.click();
  await expect(sessionRow).toBeVisible();
  await expect(toast).toHaveCount(0);
  const stableAfterUndo = await measureStableHub();
  page.off('request', observeTargetDelete);
  expect(targetDeleteRequests).toBe(0);

  const boundKeys = ['left', 'top', 'right', 'bottom', 'width', 'height'] as const;
  const extentKeys = ['scrollWidth', 'scrollHeight', 'clientWidth', 'clientHeight'] as const;
  const stableDeltas = stableBeforeUndo.boxes.flatMap((before, index) => {
    const after = stableAfterUndo.boxes.at(index);
    if (!after) throw new RangeError(`Missing stable Hub geometry at index ${index}`);
    return boundKeys.map((key) => Math.abs(before[key] - after[key]));
  });
  const stageTrackBefore = (stableBeforeUndo.boxes.at(2)?.left ?? 0) - (stableBeforeUndo.boxes.at(0)?.left ?? 0);
  const stageTrackAfter = (stableAfterUndo.boxes.at(2)?.left ?? 0) - (stableAfterUndo.boxes.at(0)?.left ?? 0);
  stableDeltas.push(Math.abs(stageTrackBefore - stageTrackAfter));
  for (const root of ['document', 'body'] as const) {
    for (const key of extentKeys) {
      stableDeltas.push(Math.abs(stableBeforeUndo.extents[root][key] - stableAfterUndo.extents[root][key]));
    }
  }
  const maxStableDelta = Math.max(...stableDeltas);
  for (const delta of stableDeltas) expect(delta).toBeLessThanOrEqual(1);
  const rowRestored = await sessionRow.isVisible();
  const toastDetached = await toast.count() === 0;
  const undoStable = rowRestored && toastDetached && targetDeleteRequests === 0 && maxStableDelta <= 1;
  recordRegion({
    region: 'R16',
    state: 'toast-undo',
    pass: undoStable,
    anchor: `rowRestored=${rowRestored}; toastDetached=${toastDetached}; targetDeleteRequests=${targetDeleteRequests}; maxStableDelta=${maxStableDelta.toFixed(2)}px; toast=${toastPlacement.position}/${toastPlacement.width.toFixed(1)}x${toastPlacement.height.toFixed(1)}/centerDelta${toastCenterDelta.toFixed(2)}/bottomInset${toastBottomInset.toFixed(1)}`,
    observation: 'Undo restores the removed row, detaches the fixed toast without DELETE, and preserves Hub, track, composer, and document geometry',
  });

  await page.keyboard.press('Control+k'); const palette = page.getByTestId('hub-command-palette'); await expect(palette).toBeVisible();
  expect((await geometry(palette)).shadow).not.toBe('none'); await captureCanonical(page, 'palette');
});

test('collapsed, narrow, reduced preferences and both-theme contrast are measurable', async ({ page, request, browserName }) => {
  await openHub(page, request); const hub = page.locator('.hub'); const stageLocator = page.locator('.hub__stage'); const rail = page.getByTestId('hub-nav'); const toggle = page.getByTestId('hub-rail-toggle');
  await screenshotMotion(page, 'brand-hover', page.getByTestId('hub-brand'), () => page.getByTestId('hub-brand').hover());
  await toggle.click(); await expect.poll(async () => (await geometry(stageLocator)).left - (await geometry(hub)).left).toBeCloseTo(78, 0); const collapsed = await geometry(rail); const collapsedTrack = (await geometry(stageLocator)).left - (await geometry(hub)).left;
  expect(collapsed.left).toBeCloseTo(10, 0); expect(collapsed.width).toBeCloseTo(60, 0); expect(collapsed.radius).toBe('12px'); await captureCanonical(page, 'collapsed');
  await page.setViewportSize({ width: 880, height: 700 }); await expect.poll(async () => (await geometry(stageLocator)).left - (await geometry(hub)).left).toBeCloseTo(78, 0); const narrow = await geometry(rail); const narrowTrack = (await geometry(stageLocator)).left - (await geometry(hub)).left; await captureCanonical(page, 'narrow');
  expect(narrow.left).toBeCloseTo(8, 0); expect(narrow.width).toBeCloseTo(62, 0);
  recordRegion({ region: 'R2', state: 'collapsed+narrow', pass: collapsedTrack === 78 && narrowTrack === 78 && collapsed.width === 60 && narrow.left === 8 && narrow.width === 62, anchor: `collapsedTrack=${collapsedTrack}; collapsedCard=${collapsed.width}; narrowTrack=${narrowTrack}; narrowLeft=${narrow.left}; narrowCard=${narrow.width}; radius=${narrow.radius}`, observation: '78px track with responsive inset card' });

  await page.setViewportSize({ width: 1440, height: 900 }); await toggle.click();
  await expect.poll(async () => (await geometry(stageLocator)).left - (await geometry(hub)).left).toBeCloseTo(292, 0);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.locator('body').evaluate((node) => Promise.allSettled(node.getAnimations({ subtree: true }).map((animation) => animation.finished)));
  const bodyText = ['.home-hero__title', '.hub-row__title', '.hub__hint', '.hub-row__state', '.home-hero__footer-options button'];
  const darkMeasurements = await Promise.all(bodyText.map((selector) => compositeContrast(page.locator(selector).first())));
  const darkContrast = Math.min(...darkMeasurements.map((measurement) => measurement.ratio));
  const darkAccent = await page.getByTestId('home-hero-submit').evaluate((node) => getComputedStyle(node).color);
  expect(darkContrast).toBeGreaterThanOrEqual(4.5); expect(darkAccent).not.toMatch(/217,\s*122,\s*86/u);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.locator('body').evaluate((node) => Promise.allSettled(node.getAnimations({ subtree: true }).map((animation) => animation.finished)));
  const lightMeasurements = await Promise.all(bodyText.map((selector) => compositeContrast(page.locator(selector).first())));
  const lightContrast = Math.min(...lightMeasurements.map((measurement) => measurement.ratio));
  expect(lightContrast).toBeGreaterThanOrEqual(4.5);
  recordRegion({ region: 'R7', state: 'light+dark', pass: darkContrast >= 4.5 && lightContrast >= 4.5, anchor: `light=${JSON.stringify(lightMeasurements)}; dark=${JSON.stringify(darkMeasurements)}; darkAccent=${darkAccent}`, observation: 'body text contrast and anti-orange accent' });

  if (browserName === 'chromium') {
    const reducedSession = await emulatePreferences(page, 'reduce', 'no-preference');
    try {
      const reducedMedia = await page.evaluate(() => ({
        transparency: matchMedia('(prefers-reduced-transparency: reduce)').matches,
        motion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      }));
      const reducedRail = await geometry(rail);
      const reducedPaint = await rail.evaluate((node) => ({
        backgroundColor: getComputedStyle(node).backgroundColor,
        backgroundImage: getComputedStyle(node).backgroundImage,
      }));
      const washDisplay = await page.locator('.hub__wash').evaluate((node) => getComputedStyle(node).display);
      expect(reducedMedia).toEqual({ transparency: true, motion: false });
      expect(reducedRail.backdrop).toBe('none');
      expect(reducedPaint.backgroundImage).toBe('none');
      expect(reducedPaint.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
      expect(washDisplay).toBe('none');
      recordRegion({ region: 'R17', state: 'reduced-transparency', pass: reducedMedia.transparency && !reducedMedia.motion && reducedRail.backdrop === 'none' && reducedPaint.backgroundImage === 'none' && reducedPaint.backgroundColor !== 'rgba(0, 0, 0, 0)' && washDisplay === 'none', anchor: `media=${JSON.stringify(reducedMedia)}; backdrop=${reducedRail.backdrop}; background=${reducedPaint.backgroundColor}/${reducedPaint.backgroundImage}; wash=${washDisplay}`, observation: 'solid fallback paints' });
    } finally {
      await reducedSession.detach();
    }

    const motionSession = await emulatePreferences(page, 'no-preference', 'reduce');
    try {
      const motionMedia = await page.evaluate(() => ({
        transparency: matchMedia('(prefers-reduced-transparency: reduce)').matches,
        motion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      }));
      const offenders = await page.locator('body').evaluate((body): MotionOffender[] => {
        const nodes = Array.from(body.querySelectorAll('*'));
        const milliseconds = (list: string): number => Math.max(...list.split(',').map((token) => {
          const value = Number.parseFloat(token);
          return token.trim().endsWith('ms') ? value : value * 1000;
        }));
        const selectorFor = (element: Element): string => {
          if (element.id) return `#${CSS.escape(element.id)}`;
          const testId = element.getAttribute('data-testid');
          if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
          const classes = Array.from(element.classList).map((name) => `.${CSS.escape(name)}`).join('');
          return `${element.tagName.toLowerCase()}${classes}`;
        };
        const owningRulesFor = (element: Element): string[] => {
          const matches: string[] = [];
          const visit = (rules: CSSRuleList, source: string): void => {
            for (const rule of Array.from(rules)) {
              if (rule instanceof CSSStyleRule) {
                if ((rule.style.animation || rule.style.animationDuration || rule.style.transition || rule.style.transitionDuration)
                  && rule.selectorText.split(',').some((selector) => {
                    try { return element.matches(selector.trim()); } catch { return false; }
                  })) matches.push(`${source}: ${rule.cssText.slice(0, 300)}`);
              } else if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) {
                visit(rule.cssRules, source);
              }
            }
          };
          for (const sheet of Array.from(document.styleSheets)) {
            try {
              visit(sheet.cssRules, sheet.href ?? '<inline>');
            } catch (error) {
              if (!(error instanceof DOMException && error.name === 'SecurityError')) throw error;
            }
          }
          return matches;
        };
        return nodes.flatMap((node) => {
          const style = getComputedStyle(node);
          const maxDurationMs = Math.max(milliseconds(style.animationDuration), milliseconds(style.transitionDuration));
          if (maxDurationMs <= 1) return [];
          const element = node as HTMLElement;
          const rect = element.getBoundingClientRect();
          return [{
            selector: selectorFor(element), tag: element.tagName.toLowerCase(), classes: Array.from(element.classList),
            snippet: element.outerHTML.slice(0, 300), visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
            animationName: style.animationName, transitionProperty: style.transitionProperty,
            animationDuration: style.animationDuration, animationDelay: style.animationDelay,
            transitionDuration: style.transitionDuration, transitionDelay: style.transitionDelay,
            maxDurationMs, owningRules: owningRulesFor(element),
          }];
        });
      });
      const shadowOffenders = await page.locator('nextjs-portal').evaluateAll((hosts) => hosts.flatMap((host) => {
        const root = host.shadowRoot;
        if (!root) return [];
        return Array.from(root.querySelectorAll('*')).flatMap((node) => {
          const style = getComputedStyle(node);
          const milliseconds = (list: string): number => Math.max(...list.split(',').map((token) => {
            const value = Number.parseFloat(token);
            return token.trim().endsWith('ms') ? value : value * 1000;
          }));
          const maxDurationMs = Math.max(milliseconds(style.animationDuration), milliseconds(style.transitionDuration));
          if (maxDurationMs <= 1) return [];
          return [{
            host: 'nextjs-portal', tag: node.tagName.toLowerCase(), snippet: node.outerHTML.slice(0, 300),
            animationDuration: style.animationDuration, transitionDuration: style.transitionDuration,
            transitionProperty: style.transitionProperty, maxDurationMs,
          }];
        });
      }));
      const motion = maxCssTimeMilliseconds(offenders.flatMap((offender) => [offender.animationDuration, offender.transitionDuration]));
      const offenderDescription = describeMotionOffenders(offenders);
      console.log(`R18_MOTION_OFFENDERS=${JSON.stringify(offenders)}`);
      console.log(`R18_NEXT_SHADOW_OFFENDERS=${JSON.stringify(shadowOffenders)}`);
      expect(motionMedia).toEqual({ transparency: false, motion: true });
      expect(offenders, offenderDescription).toEqual([]);
      expect(motion, offenderDescription).toBeLessThanOrEqual(1);
      recordRegion({ region: 'R18', state: 'reduced-motion', pass: !motionMedia.transparency && motionMedia.motion && motion <= 1 && offenders.length === 0, anchor: `media=${JSON.stringify(motionMedia)}; maxDurationMs=${motion}; offenders=${offenderDescription || 'none'}`, observation: 'all transitions and animations collapse' });
    } finally {
      await motionSession.detach();
    }
  }
});
