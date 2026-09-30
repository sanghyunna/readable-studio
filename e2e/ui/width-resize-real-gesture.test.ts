import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { addStorageInitScript } from '@/playwright/storage-init';
import { waitForSaveResponse } from '@/playwright/manual-edit-events';

// Run the installed user browser as well as the suite's older bundled engine.
// No routes, bridge commands, synthetic DOM events or seeded release records.
test.use({ channel: 'chrome', locale: 'ko-KR', viewport: { width: 1920, height: 1080 } });
const active = 'iframe[data-readable-active="true"]';
const source = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>
body{margin:0;padding:32px;font:16px/1.7 Arial;color:#18312d;background:#f5f8f5}
section{padding:24px;background:white;border:1px solid #ccd8d5;border-radius:12px}
p{margin:16px 0}.shared{max-width:28ch!important}.grid{display:grid;grid-template-columns:240px 1fr;gap:24px}
</style></head><body><h1>2026년 3분기 사업 실행 보고서</h1><p>시장 확장과 운영 효율을 함께 검토합니다.</p><section><h2>핵심 성과 요약</h2>
<p data-readable-id="own" style="width:240px;max-width:240px">이번 분기에는 고객 경험을 개선하고 새로운 시장에서 안정적인 성장을 이루었습니다.</p>
<p data-readable-id="measure" style="max-width:65ch">이번 보고서는 제품 사용 현황과 고객 의견을 바탕으로 작성했습니다. 팀은 실행 가능한 개선 과제를 정리하고 다음 분기에 필요한 자원을 검토합니다. 운영 성과를 꾸준히 확인하면서 고객이 실제로 체감하는 변화를 만듭니다.</p>
<div class="grid"><p data-readable-id="track">부모 그리드가 이 문단의 너비를 결정합니다. 협업 과제와 고객 지원 계획을 함께 확인합니다.</p><p>팀별 담당 과제를 나누고 매주 진행 상황을 검토합니다.</p></div>
<p data-readable-id="shared" class="shared">공통 스타일 규칙이 이 문단과 다른 문단의 최대 너비를 고정합니다.</p><p class="shared">공통 스타일을 사용하는 두 번째 문단입니다.</p>
</section></body></html>`;

async function open(page: Page, id: string) {
  await addStorageInitScript(page, () => localStorage.setItem('readable-studio:welcome-modal-shown', '1'), undefined);
  expect((await page.request.post('/api/projects', { data: { id, name: '너비 조절 실제 동작 검증', metadata: { kind: 'prototype' }, skipDiscoveryBrief: true } })).ok()).toBe(true);
  expect((await page.request.post(`/api/projects/${id}/files`, { data: { name: 'report.html', content: source,
    artifactManifest: { schema: 'readable-studio.artifact-manifest.v1', kind: 'html', title: '분기 보고서', entry: 'report.html', renderer: 'html', exports: ['html'] } } })).ok()).toBe(true);
  await page.goto(`/projects/${id}/files/report.html`);
  await enterEdit(page);
}
async function enterEdit(page: Page) {
  await page.getByTestId('manual-edit-mode-toggle').click();
  await expect(page.frameLocator(active).locator('html[data-readable-edit-mode]')).toHaveCount(1);
}
async function drag(page: Page, targetId: string, info: TestInfo) {
  const target = page.frameLocator(active).locator(`[data-readable-id="${targetId}"]`);
  await target.click();
  const handle = page.locator('button[data-direction="e"]');
  await expect(handle).toBeVisible();
  const box = (await handle.boundingBox())!;
  const before = (await target.boundingBox())!;
  await page.screenshot({ path: info.outputPath(`${targetId}-before.png`) });
  // Observe actual trusted input and the final ACK; never manufacture either.
  await page.evaluate(() => {
    const events: { type: string; trusted: boolean; x: number }[] = [];
    const record = (event: PointerEvent) => { events.push({ type: event.type, trusted: event.isTrusted, x: event.clientX }); };
    const types = ['pointerdown', 'pointermove', 'pointerup'] as const;
    for (const type of types) document.addEventListener(type, record, true);
    const final = new Promise<unknown>(resolve => {
      const finish = (value: unknown) => {
        clearTimeout(timer);
        window.removeEventListener('message', receive);
        for (const type of types) document.removeEventListener(type, record, true);
        resolve({ value, events });
      };
      const receive = (event: MessageEvent) => {
        if (event.source === document.querySelector<HTMLIFrameElement>('iframe[data-readable-active="true"]')?.contentWindow
          && event.data?.type === 'readable-edit-preview-style-applied' && event.data.stage === 'finalize') finish(event.data.resize);
      };
      const timer = setTimeout(() => finish(null), 8000);
      window.addEventListener('message', receive);
    });
    Reflect.set(window, 'realWidthFinal', final);
  });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 110, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  const observed = await page.evaluate(() => Reflect.get(window, 'realWidthFinal'));
  await page.screenshot({ path: info.outputPath(`${targetId}-after.png`) });
  const after = (await target.boundingBox())!;
  await writeFile(info.outputPath(`${targetId}-gesture.json`), JSON.stringify({ before, after, observed }, null, 2));
  expect(observed.value, 'Genuine handle gesture must reach finalization').not.toBeNull();
  expect(observed.events.every((event: { trusted: boolean }) => event.trusted)).toBe(true);
  expect(observed.events.map((event: { type: string }) => event.type)).toContain('pointerup');
  return { target, before, after };
}

for (const targetId of ['own', 'measure', 'track', 'shared']) {
  test(`[P0] real Korean document ${targetId}: trusted drag, persistence or unsent handoff`, async ({ page, browser }, info) => {
    const id = `real-width-${randomUUID()}`;
    await open(page, id);
    await page.evaluate(() => {
      const messages: unknown[] = [];
      Reflect.set(window, 'widthRepairMessages', messages);
      window.addEventListener('message', event => {
        if (String(event.data?.type).startsWith('readable-edit-duplicate')) messages.push(event.data);
      });
    });
    let writes = 0, sends = 0;
    page.on('request', request => {
      if (request.method() !== 'POST') return;
      const path = new URL(request.url()).pathname;
      if (path === `/api/projects/${id}/files`) writes++;
      if (path === '/api/runs') sends++;
    });
    try {
      const { target, before } = await drag(page, targetId, info);
      if (targetId === 'track' || targetId === 'shared') {
        await expect(page.getByTestId('manual-edit-resize-callout')).toBeVisible();
        await expect(page.getByTestId('manual-edit-resize-callout')).toContainText(/[가-힣]/);
        expect((await target.boundingBox())!.width).toBe(before.width);
        await expect(target).not.toHaveAttribute('data-readable-width-release');
        await page.getByRole('button', { name: '너비를 조절할 수 있게 요청', exact: true }).click();
        const composer = page.getByTestId('chat-composer-input');
        await expect(composer).toContainText('<readable-width-request>');
        const text = await composer.innerText();
        const request = JSON.parse(text.split('<readable-width-request>')[1]!.split('</readable-width-request>')[0]!);
        expect(request.causes).toContainEqual(expect.objectContaining({ code: targetId === 'track' ? 'parent-grid-allocation' : 'shared-style-width' }));
        expect(writes).toBe(0);
        expect(sends).toBe(0);
        expect(await (await page.request.get(`/api/projects/${id}/files/report.html`)).text()).toBe(source);
        await page.screenshot({ path: info.outputPath(`${targetId}-unsent-handoff.png`) });
        await writeFile(info.outputPath(`${targetId}-handoff.json`), JSON.stringify({ request, writes, sends, browser: browser.version() }, null, 2));
        return;
      }
      await expect(target).toHaveAttribute('data-readable-width-release', /readable.width-release.v1/);
      const widened = (await target.boundingBox())!.width;
      expect(widened).toBeCloseTo(before.width + 110, 0);
      expect(writes).toBe(0);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      if (targetId === 'own') {
        const move = (await page.locator('[data-readable-edit-primary-surface] [data-region="interior"]').boundingBox())!;
        await page.mouse.move(move.x + move.width / 2, move.y + move.height / 2);
        await page.keyboard.down('Control');
        await page.mouse.down();
        await page.mouse.move(move.x + move.width / 2, move.y + move.height / 2 + 100, { steps: 5 });
        await page.mouse.up();
        await page.keyboard.up('Control');
        const clone = page.frameLocator(active).locator('[data-readable-id="own-copy"]');
        await expect(clone).toHaveAttribute('data-readable-width-release', /"targetId":"own-copy"/);
        expect((await clone.boundingBox())!.width).toBeCloseTo(widened, 0);
        const originalRecord = JSON.parse((await target.getAttribute('data-readable-width-release'))!);
        const cloneRecord = JSON.parse((await clone.getAttribute('data-readable-width-release'))!);
        expect(cloneRecord.id).not.toBe(originalRecord.id);
        await writeFile(info.outputPath('clone-identities.json'), JSON.stringify({ originalRecord, cloneRecord }, null, 2));
      }
      const save = waitForSaveResponse(page, id);
      await page.getByRole('button', { name: '저장하기', exact: true }).click();
      const savedResponse = await save;
      expect(savedResponse.ok(), await savedResponse.text()).toBe(true);
      await page.reload();
      await enterEdit(page);
      await expect(target).toHaveAttribute('data-readable-width-release', /readable.width-release.v1/);
      expect((await target.boundingBox())!.width).toBeCloseTo(widened, 0);
      await page.screenshot({ path: info.outputPath(`${targetId}-reloaded.png`) });
      await target.click();
      await page.getByRole('button', { name: '원래 크기 설정으로 복원', exact: true }).click();
      await expect(target).not.toHaveAttribute('data-readable-width-release');
      expect((await target.boundingBox())!.width).toBeCloseTo(before.width, 0);
      if (targetId === 'own') {
        const clone = page.frameLocator(active).locator('[data-readable-id="own-copy"]');
        await expect(clone).toHaveAttribute('data-readable-width-release', /readable.width-release.v1/);
        expect((await clone.boundingBox())!.width).toBeCloseTo(widened, 0);
        await clone.click();
        await page.getByRole('button', { name: '원래 크기 설정으로 복원', exact: true }).click();
        await expect(clone).not.toHaveAttribute('data-readable-width-release');
        expect((await clone.boundingBox())!.width).toBeCloseTo(before.width, 0);
      }
      const restoredSave = waitForSaveResponse(page, id);
      await page.getByRole('button', { name: '저장하기', exact: true }).click();
      const restoredResponse = await restoredSave;
      expect(restoredResponse.ok(), await restoredResponse.text()).toBe(true);
      expect(await (await page.request.get(`/api/projects/${id}/files/report.html`)).text()).not.toContain('data-readable-width-release');
      await page.screenshot({ path: info.outputPath(`${targetId}-restored.png`) });
      await writeFile(info.outputPath(`${targetId}-lifecycle.json`), JSON.stringify({ before: before.width, widened, restored: (await target.boundingBox())!.width, writes, sends, browser: browser.version() }, null, 2));
    } finally {
      await writeFile(info.outputPath('duplicate-events.json'), JSON.stringify(await page.evaluate(() => Reflect.get(window, 'widthRepairMessages') ?? []), null, 2));
      expect((await page.request.delete(`/api/projects/${id}`)).ok()).toBe(true);
    }
  });
}
