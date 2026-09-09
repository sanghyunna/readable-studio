// @vitest-environment jsdom

// The Hub's drop-to-edit entry point. Below the composer, the old
// "everything lives in the left list / Ctrl K" hint is gone; in its place a
// dashed drop target routes ONE editable document into the existing
// import path (create project -> project-file API -> workspace with the
// file open). Keyboard users reach the same handler through the zone's
// native button + file picker, and every unhappy path speaks through the
// localized toast instead of failing silently.

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
import { en } from '../../src/i18n/locales/en';
import { ko } from '../../src/i18n/locales/ko';
import type { Project } from '../../src/types';

afterEach(() => {
  cleanup();
  listConversations.mockReset();
  vi.restoreAllMocks();
});

const PROJECTS: Project[] = [
  { id: 'p1', name: '분기 보고서', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 900 },
];

const OLD_HINT_KO = '모든 프로젝트와 세션은 왼쪽 목록에 있습니다';
const OLD_HINT_EN = 'Every project and session lives in the left list';

function htmlFile(name = 'report.html'): File {
  return new File(['<!doctype html><title>r</title>'], name, { type: 'text/html' });
}

function dataTransferFor(files: File[]) {
  return { files, types: ['Files'], items: [], dropEffect: 'none' };
}

function renderHub(
  overrides: Partial<Parameters<typeof HubHome>[0]> = {},
  locale: 'ko' | 'en' = 'ko',
) {
  listConversations.mockResolvedValue([]);
  const onImportFile = overrides.onImportFile
    ? vi.fn(overrides.onImportFile)
    : vi.fn(async () => ({ ok: true as const }));
  const utils = render(
    <I18nProvider initial={locale}>
      <HubHome
        projects={PROJECTS}
        projectsLoading={false}
        onOpenSession={vi.fn()}
        onSubmitPrompt={vi.fn()}
        onNewProject={vi.fn()}
        onImportFile={onImportFile}
        {...overrides}
      />
    </I18nProvider>,
  );
  return { ...utils, onImportFile };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('Hub drop-to-edit zone', () => {
  it('removes the left-list / Ctrl K hint line from the start surface', async () => {
    const { container } = renderHub();
    await settle();

    expect(container.querySelector('.hub__hint')).toBeNull();
    expect(container.textContent).not.toContain(OLD_HINT_KO);
    expect(container.textContent).not.toContain(OLD_HINT_EN);
    // The old copy is not relocated into the zone either.
    const zone = screen.getByTestId('hub-drop-to-edit');
    expect(zone.textContent).not.toContain('Ctrl K');
  });

  it('is a native button with a localized name, so keyboard users can open the picker', async () => {
    renderHub();
    await settle();

    const zone = screen.getByRole('button', { name: ko['hub.dropToEditLabel'] });
    expect(zone).toBe(screen.getByTestId('hub-drop-to-edit'));
    expect(zone.tagName).toBe('BUTTON');
    expect(zone.getAttribute('type')).toBe('button');
    expect(zone.tabIndex).toBeGreaterThanOrEqual(0);
    expect(zone.getAttribute('aria-describedby')).toBeTruthy();

    const input = screen.getByTestId('hub-drop-to-edit-input') as HTMLInputElement;
    expect(input.type).toBe('file');
    expect(input.multiple).toBe(false);
    const openPicker = vi.spyOn(input, 'click');
    // Enter/Space on a native button dispatch click; jsdom routes that
    // activation through the same handler as the pointer.
    fireEvent.click(zone);
    expect(openPicker).toHaveBeenCalledTimes(1);
  });

  it('shows a drag-over state and hands one dropped document to the import handler exactly once', async () => {
    const { onImportFile } = renderHub();
    await settle();

    const zone = screen.getByTestId('hub-drop-to-edit');
    const file = htmlFile();
    const dataTransfer = dataTransferFor([file]);

    fireEvent.dragEnter(zone, { dataTransfer });
    fireEvent.dragOver(zone, { dataTransfer });
    expect(zone.getAttribute('data-state')).toBe('drag-over');
    expect(zone.textContent).toContain(ko['hub.dropToEditRelease']);

    fireEvent.drop(zone, { dataTransfer });
    await waitFor(() => expect(onImportFile).toHaveBeenCalledTimes(1));
    expect(onImportFile).toHaveBeenCalledWith(file);
    await waitFor(() => expect(zone.getAttribute('data-state')).toBe('idle'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('routes the file picker through the same handler', async () => {
    const { onImportFile } = renderHub();
    await settle();

    const input = screen.getByTestId('hub-drop-to-edit-input') as HTMLInputElement;
    const file = htmlFile('notes.md');
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(onImportFile).toHaveBeenCalledTimes(1));
    expect(onImportFile).toHaveBeenCalledWith(file);
    // The input resets so picking the same file again still fires change.
    expect(input.value).toBe('');
  });

  it('rejects an unsupported file type through the localized toast and never imports it', async () => {
    const { onImportFile } = renderHub();
    await settle();

    const zone = screen.getByTestId('hub-drop-to-edit');
    const png = new File(['x'], 'photo.png', { type: 'image/png' });
    fireEvent.drop(zone, { dataTransfer: dataTransferFor([png]) });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(ko['hub.dropUnsupported'].replace('{name}', 'photo.png'));
    expect(onImportFile).not.toHaveBeenCalled();
  });

  it('rejects several files at once with a localized count', async () => {
    const { onImportFile } = renderHub();
    await settle();

    const zone = screen.getByTestId('hub-drop-to-edit');
    fireEvent.drop(zone, { dataTransfer: dataTransferFor([htmlFile('a.html'), htmlFile('b.html')]) });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(ko['hub.dropOneAtATime'].replace('{count}', '2'));
    expect(onImportFile).not.toHaveBeenCalled();
  });

  it('surfaces a failed import with the localized message and the technical detail', async () => {
    const { onImportFile } = renderHub({
      onImportFile: vi.fn(async () => ({ ok: false as const, message: 'upload failed (500)' })),
    });
    await settle();

    const zone = screen.getByTestId('hub-drop-to-edit');
    fireEvent.drop(zone, { dataTransfer: dataTransferFor([htmlFile()]) });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(ko['hub.dropImportFailed']);
    expect(alert.textContent).toContain('upload failed (500)');
    expect(onImportFile).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(zone.getAttribute('data-state')).toBe('idle'));
  });

  it('speaks English when the locale is English', async () => {
    renderHub({}, 'en');
    await settle();

    expect(screen.getByRole('button', { name: en['hub.dropToEditLabel'] })).toBeTruthy();
    fireEvent.drop(screen.getByTestId('hub-drop-to-edit'), {
      dataTransfer: dataTransferFor([new File(['x'], 'deck.pptx')]),
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(en['hub.dropUnsupported'].replace('{name}', 'deck.pptx'));
  });

  it('leaves the composer attachment path alone: a drop on the composer stages, never imports', async () => {
    const { onImportFile } = renderHub();
    await settle();

    const composer = await screen.findByTestId('hub-composer');
    fireEvent.drop(composer, { dataTransfer: dataTransferFor([htmlFile()]) });
    // The composer kept the file as its own staged attachment...
    expect(await screen.findByTestId('home-hero-staged-files')).toBeTruthy();
    // ...and the drop-to-edit handler never saw it.
    expect(onImportFile).not.toHaveBeenCalled();
  });

  it('a drop on the zone never stages a composer attachment', async () => {
    const { onImportFile } = renderHub();
    await settle();

    fireEvent.drop(screen.getByTestId('hub-drop-to-edit'), { dataTransfer: dataTransferFor([htmlFile()]) });
    await waitFor(() => expect(onImportFile).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('home-hero-staged-files')).toBeNull();
  });

  it('still offers the drop target when there are no projects yet', async () => {
    renderHub({ projects: [] });
    await settle();

    expect(screen.getByTestId('hub-empty')).toBeTruthy();
    expect(screen.getByTestId('hub-drop-to-edit')).toBeTruthy();
  });
});
