// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatComposer } from '../../src/components/ChatComposer';
import { I18nProvider } from '../../src/i18n';
import { getKo } from '../../src/i18n/locales/ko';
import { getEn } from '../../src/i18n/locales/en';
import type { Locale } from '../../src/i18n/types';
import { flushMounts } from '../helpers/lexical-composer';

const ko = getKo();

function composerElement(overrides: Partial<ComponentProps<typeof ChatComposer>> = {}) {
  return (
    <ChatComposer
      projectId="project-1"
      projectFiles={[]}
      streaming={false}
      onEnsureProject={async () => 'project-1'}
      onSend={vi.fn()}
      onStop={vi.fn()}
      onOpenMcpSettings={vi.fn()}
      {...overrides}
    />
  );
}

function renderComposer(
  overrides: Partial<ComponentProps<typeof ChatComposer>> = {},
  options: { locale?: Locale } = {},
) {
  const tree = composerElement(overrides);
  return options.locale
    ? render(<I18nProvider initial={options.locale}>{tree}</I18nProvider>)
    : render(tree);
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('ChatComposer active context chip qualifier', () => {
  it.each(['ko', 'en'] as const)('uses %s dictionary labels in the native current-file title', async (locale) => {
    const dict = locale === 'ko' ? getKo() : getEn();
    const fileContext = {
      id: 'file:design.html', kind: 'file' as const, label: 'design.html',
      path: 'design.html', absolutePath: 'D:/project/design.html',
      url: 'https://example.test/design.html', title: 'Design',
    };
    renderComposer({ activeWorkspaceContext: fileContext }, { locale });
    await flushMounts();
    const chip = screen.getByTestId('staged-contexts').querySelector('.staged-context--workspace-file .staged-name')!;
    expect(chip.getAttribute('title')?.split(' | ')).toEqual([
      dict['chat.contextKindFile'],
      `${dict['chat.contextPath']}: ${fileContext.path}`,
      `${dict['chat.contextAbsolutePath']}: ${fileContext.absolutePath}`,
      `${dict['chat.contextUrl']}: ${fileContext.url}`,
      `${dict['chat.contextTitle']}: ${fileContext.title}`,
    ]);
  });

  it('localizes the active workspace context qualifier in Korean', async () => {
    const fileContext = {
      id: 'file:marker.json',
      kind: 'file' as const,
      label: 'marker.json',
      path: 'marker.json',
      tabId: 'marker.json',
    };
    const designFilesContext = {
      id: 'design-files:1',
      kind: 'design-files' as const,
      label: '디자인 파일',
      tabId: 'design-files:1',
    };

    const view = renderComposer(
      { activeWorkspaceContext: fileContext },
      { locale: 'ko' },
    );
    await flushMounts();

    const staged = screen.getByTestId('staged-contexts').textContent ?? '';
    expect(staged).toContain(ko['chat.currentContext'] + ' ' + fileContext.label);
    expect(staged).not.toContain(getEn()['chat.currentContext']);

    view.rerender(
      <I18nProvider initial="ko">{composerElement({ activeWorkspaceContext: designFilesContext })}</I18nProvider>,
    );
    await flushMounts();
    expect(screen.getByTestId('staged-contexts').textContent ?? '').toContain(
      ko['chat.currentContext'] + ' ' + designFilesContext.label,
    );
    expect(screen.getByTestId('staged-contexts').textContent ?? '').not.toContain(getEn()['chat.currentContext']);
  });

  it('keeps the English active workspace context qualifier unchanged', async () => {
    const fileContext = {
      id: 'file:index.html',
      kind: 'file' as const,
      label: 'index.html',
      path: 'index.html',
      tabId: 'index.html',
    };
    renderComposer({ activeWorkspaceContext: fileContext }, { locale: 'en' });
    await flushMounts();

    expect(screen.getByTestId('staged-contexts').textContent ?? '').toContain(
      getEn()['chat.currentContext'] + ' ' + fileContext.label,
    );
  });
});
