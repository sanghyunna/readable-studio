// @vitest-environment jsdom

// Open-to-edit from the Hub composer. The separate drop-to-edit zone is gone;
// the same single-document import path now hangs off the composer's submit:
// drop ONE HTML/Markdown file on the prompt box, leave the prompt empty, press
// Enter (or Send) -> the document opens for editing with no agent run and no
// model requirement. Any typed text keeps the normal agent send with the file
// attached. Refusals reuse the old zone's messages; a failed import keeps the
// old failure toast.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readConversationsFromListMock } from '../helpers/hub-conversations-mock';

const listConversations = vi.hoisted(() => vi.fn());

vi.mock('../../src/state/projects', () => ({
  listConversations,
  listPlugins: async () => [],
  readConversations: readConversationsFromListMock(listConversations),
}));

import { TestHubHome as HubHome } from '../helpers/HubTestHost';
import { I18nProvider } from '../../src/i18n';
import { getKo } from '../../src/i18n/locales/ko';
import type { Project } from '../../src/types';
import type { PluginLoopSubmit } from '../../src/components/PluginLoopHome';
import { setHomeHeroPrompt } from '../helpers/home-hero-lexical';

const ko = getKo();

afterEach(() => {
  cleanup();
  listConversations.mockReset();
});

const PROJECTS: Project[] = [
  { id: 'p1', name: '분기 보고서', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 900 },
];

function htmlFile(name = 'report.html'): File {
  return new File(['<!doctype html><title>r</title>'], name, { type: 'text/html' });
}

function renderHub(overrides: Partial<Parameters<typeof HubHome>[0]> = {}) {
  listConversations.mockResolvedValue([]);
  const { onImportFile: importOverride, modelSelectionGuard: guardOverride, ...rest } = overrides;
  const onImportFile = vi.fn(importOverride ?? (async (_file: File) => ({ ok: true as const })));
  const onSubmit = vi.fn(async (_payload: PluginLoopSubmit) => true);
  // A guard that always refuses: editing must never consult it.
  const modelSelectionGuard = vi.fn(guardOverride ?? (() => false));
  const utils = render(
    <I18nProvider initial="ko">
      <HubHome
        projects={PROJECTS}
        projectsLoading={false}
        onOpenSession={vi.fn()}
        onSubmit={onSubmit}
        onNewProject={vi.fn()}
        {...rest}
        onImportFile={onImportFile}
        modelSelectionGuard={modelSelectionGuard}
      />
    </I18nProvider>,
  );
  return { ...utils, onImportFile, onSubmit, modelSelectionGuard };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

function dropOnComposer(files: File[]) {
  fireEvent.drop(screen.getByTestId('hub-composer'), {
    dataTransfer: { files, types: ['Files'], items: [], dropEffect: 'none' },
  });
}

describe('Hub composer: empty prompt + staged document opens the editor', () => {
  it('one staged HTML + Enter opens the document with no agent run and no model check', async () => {
    const { onImportFile, onSubmit, modelSelectionGuard } = renderHub();
    await settle();
    const file = htmlFile();
    dropOnComposer([file]);
    await waitFor(() => expect(screen.getByTestId('home-hero-staged-files').textContent).toContain('report.html'));
    // The only hint that Enter opens the editor: the placeholder names the file.
    expect(screen.getByTestId('home-hero-input').getAttribute('aria-placeholder'))
      .toBe(ko['homeHero.placeholderOpenDocument'].replace('{name}', 'report.html'));

    fireEvent.keyDown(screen.getByTestId('home-hero-input'), { key: 'Enter' });
    await waitFor(() => expect(onImportFile).toHaveBeenCalledTimes(1));
    expect(onImportFile).toHaveBeenCalledWith(file);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(modelSelectionGuard).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('home-hero-staged-files')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('the Send button drives the same path and ignores repeats while the import is pending', async () => {
    let release!: (outcome: { ok: true }) => void;
    const pending = new Promise<{ ok: true }>((resolve) => { release = resolve; });
    const { onImportFile, onSubmit } = renderHub({ onImportFile: vi.fn(() => pending) });
    await settle();
    dropOnComposer([htmlFile('notes.md')]);
    await waitFor(() => expect(screen.getByTestId('home-hero-staged-files').textContent).toContain('notes.md'));

    const send = screen.getByTestId('home-hero-submit') as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    fireEvent.click(send);
    await waitFor(() => expect(onImportFile).toHaveBeenCalledTimes(1));
    await act(async () => { release({ ok: true }); await pending; });
    expect(onImportFile).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('typed text + staged file is a normal agent send with the attachment', async () => {
    const { onImportFile, onSubmit, modelSelectionGuard } = renderHub({ modelSelectionGuard: vi.fn(() => true) });
    await settle();
    const file = htmlFile();
    dropOnComposer([file]);
    await waitFor(() => expect(screen.getByTestId('home-hero-staged-files').textContent).toContain('report.html'));
    setHomeHeroPrompt('이 보고서를 요약해 줘');

    fireEvent.click(screen.getByTestId('home-hero-submit'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ attachments: [file] });
    expect(onImportFile).not.toHaveBeenCalled();
    expect(modelSelectionGuard).toHaveBeenCalled();
  });

  it('two staged files + empty Enter refuses with the one-at-a-time message', async () => {
    const { onImportFile, onSubmit } = renderHub();
    await settle();
    dropOnComposer([htmlFile('a.html'), htmlFile('b.html')]);
    await waitFor(() => expect(screen.getByTestId('home-hero-staged-files').textContent).toContain('b.html'));

    fireEvent.click(screen.getByTestId('home-hero-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('home-hero-error').textContent).toContain(
        ko['hub.dropOneAtATime'].replace('{count}', '2'),
      ));
    expect(onImportFile).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    // The files stay staged so the user can remove one or add a prompt.
    expect(screen.getByTestId('home-hero-staged-files').textContent).toContain('a.html');
  });

  it('a staged non-document + empty Enter refuses with the unsupported message', async () => {
    const { onImportFile, onSubmit } = renderHub();
    await settle();
    dropOnComposer([new File(['x'], 'photo.png', { type: 'image/png' })]);
    await waitFor(() => expect(screen.getByTestId('home-hero-staged-files').textContent).toContain('photo.png'));

    fireEvent.click(screen.getByTestId('home-hero-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('home-hero-error').textContent).toContain(
        ko['hub.dropUnsupported'].replace('{name}', 'photo.png'),
      ));
    expect(onImportFile).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('empty Enter with nothing staged is a no-op', async () => {
    const { onImportFile, onSubmit } = renderHub();
    await settle();
    fireEvent.keyDown(screen.getByTestId('home-hero-input'), { key: 'Enter' });
    fireEvent.click(screen.getByTestId('home-hero-submit'));
    await settle();
    expect(onImportFile).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByTestId('home-hero-error')).toBeNull();
  });

  it('a failed import keeps the file staged and shows the failure toast with details', async () => {
    const { onSubmit } = renderHub({
      onImportFile: vi.fn(async () => ({ ok: false as const, message: 'rollback left project p-9' })),
    });
    await settle();
    dropOnComposer([htmlFile()]);
    await waitFor(() => expect(screen.getByTestId('home-hero-staged-files').textContent).toContain('report.html'));

    fireEvent.click(screen.getByTestId('home-hero-submit'));
    const alert = await screen.findByRole('alert');
    expect(alert.querySelector('.readable-toast-message')?.textContent).toBe(ko['hub.dropImportFailed']);
    expect(alert.querySelector('.readable-toast-details')?.textContent).toContain('p-9');
    expect(screen.getByTestId('home-hero-staged-files').textContent).toContain('report.html');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
