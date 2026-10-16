// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss from 'postcss';
import { afterEach, expect, it, vi } from 'vitest';
import { UpdateLaunchBanner, UpdateSection } from '../../src/components/UpdateSection';
import { I18nProvider } from '../../src/i18n';
import { getKo } from '../../src/i18n/locales/ko';
import { getEn } from '../../src/i18n/locales/en';
import styles from '../../src/components/UpdateSection.module.css';
import buttonStyles from '../../../../packages/components/src/button.module.css';
import controlStyles from '../../../../packages/components/src/form-controls.module.css';
import selectionStyles from '../../../../packages/components/src/selection-primitives.module.css';

vi.mock('../../src/components/databricks/DatabricksLoginButton', () => ({ DatabricksLoginButton: () => null }));
const offer = { current: '1.3.3', latest: '1.3.4', isNewer: true, sha256: 'a'.repeat(64), releaseUrl: 'https://updates.databricksapps.com', assetSize: 10 };
const ready = { state: 'ready', version: offer.latest, releaseUrl: offer.releaseUrl, notes: '업데이트 화면 확인', received: 10, total: 10, error: null };
class Events {
  static current: Events;
  onmessage?: (event: { data: string }) => void;
  constructor() { Events.current = this; }
  close() {}
  send(status: object) { this.onmessage?.({ data: JSON.stringify(status) }); }
}
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}
function setup(enabled = true) {
  const fetcher = vi.fn(async (url: string, _options?: RequestInit): Promise<Response> => Response.json(
    url === '/api/version' ? { version: { version: offer.current } }
      : url === '/api/update/status' ? ready
      : url === '/api/app-config' ? { config: { autoUpdate: { enabled, serverUrl: offer.releaseUrl } } }
      : url.startsWith('/api/update/check') ? offer : {}));
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('EventSource', Events);
  return fetcher;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
function capture(name: string) {
  const directory = process.env.F36_RENDER_DIR ?? process.env.F28_SCREENSHOT_DIR;
  if (!directory) return;
  const sources = [
    ['src/components/UpdateSection.module.css', styles],
    ['../../packages/components/src/button.module.css', buttonStyles],
    ['../../packages/components/src/form-controls.module.css', controlStyles],
    ['../../packages/components/src/selection-primitives.module.css', selectionStyles],
  ] as const;
  const css = sources.map(([path, names]) => readFileSync(resolve(path), 'utf8').replace(/\.([a-zA-Z][\w-]*)/g, (match, key: string) => names[key] ? `.${names[key]}` : match)).join('\n');
  mkdirSync(directory, { recursive: true });
  const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><style>${readFileSync(resolve('src/styles/tokens.css'), 'utf8')}\n${readFileSync(resolve('src/styles/base.css'), 'utf8')}\n${css}\nsection{padding:var(--radius-surface);max-width:64ch}</style>${document.body.innerHTML}</html>`;
  writeFileSync(resolve(directory, `${name}.${process.env.F36_RENDER_DIR ? 'json' : 'html'}`), process.env.F36_RENDER_DIR ? JSON.stringify({ html }) : html);
}

it('keeps both Korean cards finishing when CLI apply clears extraction', async () => {
  setup();
  await act(async () => render(<I18nProvider initial="ko"><UpdateLaunchBanner ready /><UpdateSection currentVersion={offer.current} /></I18nProvider>));
  act(() => Events.current.send({ ...ready, extraction: { completed: 10, total: 10, completedBytes: 100, totalBytes: 100 } }));
  act(() => Events.current.send(ready));
  expect(screen.getAllByRole('progressbar')).toHaveLength(2);
  capture('f37-observers-finishing');
});

it.each(['hub', 'settings'])('keeps active progress from apply click through finishing in %s', async (surface) => {
  setup();
  await act(async () => render(<I18nProvider initial="ko">{surface === 'hub' ? <UpdateLaunchBanner ready /> : <UpdateSection currentVersion={offer.current} />}</I18nProvider>));
  const restart = screen.getByRole('button', { name: getKo()['update.restart'] });
  await act(async () => fireEvent.click(restart));
  const initial = screen.getByRole('progressbar');
  expect(initial.hasAttribute('value')).toBe(false);
  expect(document.querySelector('[data-applying]')).toBeTruthy();
  capture(`${surface}-applying`);
  act(() => Events.current.send({ ...ready, extraction: { completed: 1, total: 10 } }));
  expect(screen.getByRole('progressbar').getAttribute('value')).toBe('1');
  expect(screen.getByRole('progressbar').parentElement?.querySelector('span')).toBeTruthy();
  capture(`${surface}-counted`);
  act(() => Events.current.send({ ...ready, extraction: { completed: 10, total: 10 } }));
  expect(screen.getByRole('progressbar').getAttribute('value')).toBe('10');
  expect(screen.getByRole('progressbar').parentElement?.getAttribute('data-phase')).toBe('finishing');
  act(() => Events.current.send(ready));
  expect(screen.getByRole('progressbar').getAttribute('value')).toBe('10');
  expect(screen.getByRole('progressbar').parentElement?.getAttribute('data-phase')).toBe('finishing');
  capture(`${surface}-finishing`);
});

it('groups extraction with the same separated progress layout as downloads', () => {
  const css = postcss.parse(readFileSync(resolve('src/components/UpdateSection.module.css'), 'utf8'));
  const rules = css.nodes.filter(node => node.type === 'rule');
  const progress = rules.find(node => node.type === 'rule' && node.selector === '.progress')!;
  expect(progress.toString()).toMatch(/padding/);
  expect(progress.toString()).toMatch(/background:\s*var\(/);
  expect(rules.some(node => node.type === 'rule' && node.selector === '.banner .extraction progress')).toBe(false);
});

it.each([true, false])('optimistically toggles while save is pending and handles success=%s', async (success) => {
  const fetcher = setup(false);
  const save = deferred();
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url, options) => url === '/api/app-config' && options?.method === 'PUT' ? save.promise : original(url, options));
  await act(async () => render(<I18nProvider initial="ko"><UpdateSection currentVersion={offer.current} /></I18nProvider>));
  fireEvent.click(screen.getByRole('switch'));
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('button', { name: getKo()['update.check'] })).toBeTruthy();
  await act(async () => save.resolve(Response.json({}, { status: success ? 200 : 500 })));
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe(String(success));
  if (success) capture('settings-saved');
  if (!success) expect(screen.getByRole('alert')).toBeTruthy();
});

it('keeps automatic enable checking separate from the manual button', async () => {
  const fetcher = setup(false);
  const health = deferred();
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url, options) => url === '/api/update/health' ? health.promise : original(url, options));
  await act(async () => render(<I18nProvider initial="ko"><UpdateSection currentVersion={offer.current} /></I18nProvider>));
  fireEvent.click(screen.getByRole('switch'));
  expect(screen.getByRole('button', { name: getKo()['update.check'] })).toBeTruthy();
  expect(document.querySelector('[data-update-automatic-status]')).toBeTruthy();
  await act(async () => health.resolve(Response.json({})));
  expect(document.querySelector('[data-update-automatic-status]')).toBeNull();
  expect(screen.queryByText(getKo()['update.automaticChecking'])).toBeNull();
});

it('Q11-01 advances the bar and percentage while a large entry keeps the file count unchanged', async () => {
  setup();
  await act(async () => render(<I18nProvider initial="ko"><UpdateLaunchBanner ready /></I18nProvider>));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: getKo()['update.restart'] })));
  for (const completedBytes of [100, 200]) {
    act(() => Events.current.send({ ...ready, extraction: { completed: 11, total: 24642, completedBytes, totalBytes: 1000 } }));
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('value')).toBe(String(completedBytes));
    expect(bar.getAttribute('max')).toBe('1000');
    expect(bar.parentElement?.textContent).toContain(`${completedBytes / 10}%`);
    expect(bar.parentElement?.textContent).not.toContain('11 / 24,642');
  }
  capture('hub-byte-progress');
  act(() => Events.current.send({ ...ready, extraction: { completed: 24641, total: 24642, completedBytes: 9996, totalBytes: 10000 } }));
  expect(screen.getByRole('progressbar').getAttribute('aria-label')).toBe(screen.getByRole('progressbar').parentElement?.textContent);
  expect(screen.getByRole('progressbar').parentElement?.textContent).toContain('99.9%');
  capture('f39-hub-near-complete');
  act(() => Events.current.send({ ...ready, extraction: { completed: 24642, total: 24642, completedBytes: 1000, totalBytes: 1000 } }));
  act(() => Events.current.send(ready));
  expect(screen.getByRole('progressbar').getAttribute('value')).toBe('1000');
  expect(screen.getByRole('progressbar').parentElement?.textContent).toContain('24,642개 압축 해제 완료');
  capture('hub-byte-finishing');
});

it.each(['ko', 'en'] as const)('includes the running version in the %s current result', async (locale) => {
  const fetcher = setup();
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url, options) => url === '/api/update/status' ? Promise.resolve(Response.json({ state: 'idle', received: 0, total: 0, version: null, error: null }))
    : url.startsWith('/api/update/check') ? Promise.resolve(Response.json({ ...offer, isNewer: false })) : original(url, options));
  await act(async () => render(<I18nProvider initial={locale}><UpdateSection currentVersion="1.3.4" /></I18nProvider>));
  const check = screen.getByRole('button', { name: (locale === 'ko' ? getKo() : getEn())['update.check'] });
  await act(async () => fireEvent.click(check));
  expect(screen.getByRole('status').textContent).toContain('1.3.4');
});
