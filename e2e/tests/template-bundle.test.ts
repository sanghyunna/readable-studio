import type {
  DesignTemplateUploadAnalysisResponse as Single,
  DesignTemplateUploadBundleAnalysisResponse as Bundle,
} from '@readable-studio/contracts';
import { expect, test } from 'vitest';

import { buildBundle, buildZip, cp949Name } from '@/template-zip';
import { createSmokeSuite } from '@/smoke-suite';

const deckPrompt = (name: string) => `---\nname: ${name}\ncover: slide-1.html\ndescription: Fixed-size slides\npages:\n  - file: slide-1.html\n    use: cover\n  - file: slide-2.html\n  - file: slide-3.html\n---\nUse these slide layouts.\n`;
const slide = (n: number) => `<!doctype html><html><head><link rel="stylesheet" href="assets/deck.css"></head><body><h1>Slide ${n}</h1></body></html>`;
const deckZip = (name: string) => buildZip([
  { name: 'PROMPT.md', body: deckPrompt(name) },
  { name: 'assets/deck.css', body: 'html,body{margin:0;width:1280px;height:720px}h1{padding:100px}' },
  ...[1, 2, 3].map((n) => ({ name: `slide-${n}.html`, body: slide(n) })),
]);
const reportPrompt = (name: string) => `---\nname: ${name}\ncover: report/cover.html\ndescription: Pages for an annual report\npages:\n  - file: report/body.html\n    use: Body section\n---\nKeep the cover sober.\n`;
const doc = (title: string) => `<!doctype html><html><head><link rel="stylesheet" href="../assets/doc.css"></head><body><h1>${title}</h1><p>${'Long form body text. '.repeat(40)}</p></body></html>`;
const reportZip = (name: string) => buildZip([
  { name: 'PROMPT.md', body: reportPrompt(name) },
  { name: 'assets/doc.css', body: '@page{size:A4 portrait;margin:20mm}body{max-width:720px;margin:0 auto;font:16px/1.6 serif}' },
  { name: 'report/cover.html', body: doc('Cover') },
  { name: 'report/body.html', body: doc('Body') },
  { name: 'report/detail.html', body: doc('Detail') },
]);

type Api = (path: string, init?: RequestInit) => Promise<{ status: number; body: any }>;

function makeApi(base: string): Api {
  return async (path, init) => {
    const response = await fetch(`${base}${path}`, init);
    const text = await response.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* non-JSON body is asserted as text */ }
    return { status: response.status, body };
  };
}

const upload = (api: Api, name: string, zip: Buffer) => {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(zip)], { type: 'application/zip' }), name);
  return api('/api/design-template-uploads/analyse', { method: 'POST', body: form });
};
const post = (api: Api, path: string, body: unknown) => api(path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('[P1] template bundle upload with deterministic type detection over HTTP', async () => {
  const suite = await createSmokeSuite('template-bundle');
  await suite.with.toolsDev(async ({ webUrl }) => {
    const api = makeApi(webUrl);

    // 1. Bundle: deck + report + invalid inner zip.
    const analysed = await upload(api, 'pack.zip', buildBundle([
      { name: 'a-deck.zip', zip: deckZip('Colliding Name') },
      { name: 'b-report.zip', zip: reportZip('Colliding Name') },
      { name: 'c-broken.zip', zip: buildZip([{ name: 'notes.txt', body: 'no PROMPT.md here' }]) },
    ]));
    expect(analysed.status).toBe(201);
    const bundle = analysed.body as Bundle;
    expect(bundle.kind).toBe('bundle');
    expect(bundle.templates.map((t) => [t.index, t.entryName, t.ok])).toEqual([
      [0, 'a-deck.zip', true], [1, 'b-report.zip', true], [2, 'c-broken.zip', false],
    ]);
    const [deck, report, broken] = bundle.templates;
    if (!deck?.ok || !report?.ok || !broken || broken.ok) throw new Error(JSON.stringify(bundle));
    expect(broken.reason.length).toBeGreaterThan(0);
    expect(deck.analysis.detectedType).toBe('deck');
    expect(report.analysis.detectedType).toBe('report');
    expect(deck.analysis.sessionId).not.toBe(report.analysis.sessionId);
    expect(deck.analysis.bundleId).toBe(bundle.bundleId);

    // 2. A child is readable on its own.
    const child = await api(`/api/design-template-uploads/${deck.analysis.sessionId}`);
    expect(child.status).toBe(200);
    expect((child.body as Single).bundleId).toBe(bundle.bundleId);

    // 3. Finalize both without a type, with colliding names.
    const finalize = (item: typeof deck) => post(api,
      `/api/design-template-uploads/${item.analysis.sessionId}/finalize`,
      { name: 'Same Name', coverPageId: item.analysis.suggestedCoverPageId });
    const savedDeck = await finalize(deck);
    const savedReport = await finalize(report);
    expect([savedDeck.status, savedReport.status]).toEqual([201, 201]);
    expect(savedDeck.body.template.id).not.toBe(savedReport.body.template.id);

    // 4. Both are listed with the detected types.
    const listing = await api('/api/design-templates');
    const mine = (listing.body.designTemplates as Array<{ id: string; userImported?: boolean; templateType?: string }>)
      .filter((t) => t.userImported === true);
    expect(mine).toHaveLength(2);
    expect(Object.fromEntries(mine.map((t) => [t.id, t.templateType]))).toEqual({
      [savedDeck.body.template.id]: 'deck', [savedReport.body.template.id]: 'report',
    });

    // 5. Cancel a fresh bundle: children 404 afterwards; the first bundle (fully finalized) cancels nothing.
    const second = await upload(api, 'pack2.zip', buildBundle([
      { name: 'x.zip', zip: deckZip('X') }, { name: 'y.zip', zip: reportZip('Y') },
    ]));
    const pending = (second.body as Bundle).templates.flatMap((t) => (t.ok ? [t.analysis] : []));
    expect(pending).toHaveLength(2);
    const cancelled = await api(`/api/design-template-uploads/bundles/${(second.body as Bundle).bundleId}`, { method: 'DELETE' });
    expect(cancelled.status).toBe(200);
    expect([...cancelled.body.cancelledSessionIds].sort()).toEqual(pending.map((p) => p.sessionId).sort());
    expect((await api(`/api/design-template-uploads/${pending[0]!.sessionId}`)).status).toBe(404);
    const again = await api(`/api/design-template-uploads/bundles/${bundle.bundleId}`, { method: 'DELETE' });
    expect(again.body.cancelledSessionIds).toEqual([]);

    // 6. A single ZIP finalized with no type gets the detected type; website is rejected.
    const single = await upload(api, 'single.zip', reportZip('Single Report'));
    expect(single.status).toBe(201);
    const s = single.body as Single;
    expect(s.kind).toBe('single');
    expect(s.detectedType).toBe('report');
    const website = await post(api, `/api/design-template-uploads/${s.sessionId}/finalize`,
      { type: 'website', name: 'Nope', coverPageId: s.suggestedCoverPageId });
    expect(website.status).toBe(400);
    expect(JSON.stringify(website.body)).toContain('website templates can no longer be uploaded; use deck or report');
    const done = await post(api, `/api/design-template-uploads/${s.sessionId}/finalize`,
      { name: 'Single Report', coverPageId: s.suggestedCoverPageId });
    expect(done.status).toBe(201);
    const after = await api('/api/design-templates');
    expect((after.body.designTemplates as Array<{ id: string; templateType?: string }>)
      .find((t) => t.id === done.body.template.id)?.templateType).toBe('report');

    // 7. Mixed bundle (zip + loose file) is rejected.
    const mixed = await upload(api, 'mixed.zip', buildBundle(
      [{ name: 'a.zip', zip: deckZip('A') }], [{ name: 'README.md', body: 'hi' }]));
    expect(mixed.status).toBe(400);
    expect(JSON.stringify(mixed.body)).toContain('README.md');

    // 8. CP949 names (no UTF-8 flag) are decoded: bundle entry and page path.
    const cp = await upload(api, 'cp.zip', buildBundle([{ name: cp949Name('가나다.zip'), zip: deckZip('Korean') }]));
    expect(cp.status).toBe(201);
    expect((cp.body as Bundle).templates[0]?.entryName).toBe('가나다.zip');
    const cpPage = await upload(api, 'cp-page.zip', buildZip([
      { name: 'PROMPT.md', body: '---\nname: Korean Page\ncover: 표지.html\n---\nbody\n' },
      { name: cp949Name('표지.html'), body: slide(1) },
    ]));
    expect(cpPage.status).toBe(201);
    expect((cpPage.body as Single).pages.map((p) => p.file)).toContain('표지.html');
  });
}, 300_000);
