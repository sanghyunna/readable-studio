// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ClientApp } from '../../app/[[...slug]]/client-app';
import { getEn } from '../../src/i18n/locales/en';
import { getKo } from '../../src/i18n/locales/ko';

vi.mock('next/dynamic', () => ({
  default: (_load: unknown, options: { loading: () => React.ReactNode }) => options.loading,
}));
vi.mock('../../src/analytics/error-tracking', () => ({ installErrorHandlers: vi.fn() }));
vi.mock('../../src/observability/install', () => ({ installWebObservability: vi.fn() }));

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('navigator', { language: 'en-US', languages: ['en-US'] });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

it.each(['ko', 'en'] as const)('uses the persisted %s locale before the provider mounts', (locale) => {
  localStorage.setItem('readable-studio:locale', locale);
  localStorage.setItem('readable-studio:locale-source', 'manual');
  const dict = locale === 'ko' ? getKo() : getEn();
  render(<ClientApp />);
  expect(screen.getByRole('status').textContent).toBe(dict['common.loadingApp']);
});

it('uses navigator Korean when there is no persisted selection', () => {
  vi.stubGlobal('navigator', { language: 'ko-KR', languages: ['ko-KR'] });
  render(<ClientApp />);
  const dict = getKo();
  expect(screen.getByRole('status').textContent).toBe(dict['common.loadingApp']);
});

it('hydrates the neutral server shell before selecting the browser locale', async () => {
  localStorage.setItem('readable-studio:locale', 'ko');
  localStorage.setItem('readable-studio:locale-source', 'manual');
  const container = document.createElement('div');
  container.innerHTML = renderToString(<ClientApp />);
  document.body.append(container);
  const recoverable = vi.fn();
  let root: ReturnType<typeof hydrateRoot>;
  await act(async () => { root = hydrateRoot(container, <ClientApp />, { onRecoverableError: recoverable }); });
  expect(recoverable).not.toHaveBeenCalled();
  const dict = getKo();
  expect(container.querySelector('[role="status"]')?.textContent).toBe(dict['common.loadingApp']);
  act(() => root.unmount());
  container.remove();
});
