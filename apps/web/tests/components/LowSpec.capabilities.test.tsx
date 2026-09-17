// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readConversationsFromListMock } from '../helpers/hub-conversations-mock';
import { TestHubHome } from '../helpers/HubTestHost';
import { setHomeHeroPrompt } from '../helpers/home-hero-lexical';
import { FileViewer } from '../../src/components/FileViewer';
import { InlineModelSwitcher } from '../../src/components/InlineModelSwitcher';
import { DEFAULT_CONFIG, applyPerformanceProfileToDocument } from '../../src/state/config';
import { ManualEditResizeHandles } from '../../src/components/ManualEditResizeHandles';

const listConversations = vi.hoisted(() => vi.fn(async () => []));
vi.mock('../../src/state/projects', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/state/projects')>(),
  listConversations,
  readConversations: readConversationsFromListMock(listConversations),
}));
beforeEach(() => applyPerformanceProfileToDocument('low'));
afterEach(() => {
  cleanup();
  applyPerformanceProfileToDocument('full');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('low-profile capabilities', () => {
  it('retains navigation, project opening, agent/model selection and composer submission', async () => {
    // Given the real Hub and execution switcher with low active.
    const open = vi.fn();
    const submit = vi.fn();
    const changeAgent = vi.fn();
    await act(async () => {
      render(<TestHubHome
        projects={[{ id: 'p1', name: 'Project', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 1 }]}
        projectsLoading={false} onOpenSession={vi.fn()} onOpenProject={open}
        onSubmitPrompt={submit} onNewProject={vi.fn()} performanceProfile="low"
        executionSwitcher={<InlineModelSwitcher
          config={{ ...DEFAULT_CONFIG, mode: 'daemon', agentId: 'codex', performanceProfile: 'low' }}
          agents={[{ id: 'codex', name: 'Codex', bin: 'codex', available: true, version: '1', models: [{ id: 'default', label: 'Default' }] }]}
          daemonLive onModeChange={vi.fn()} onAgentChange={changeAgent}
          onAgentModelChange={vi.fn()} onApiProtocolChange={vi.fn()} onApiModelChange={vi.fn()} onOpenSettings={vi.fn()}
        />}
      />);
    });
    // When a prompt is entered and submitted through the actual composer.
    setHomeHeroPrompt('Create artifact');
    fireEvent.click(screen.getByTestId('home-hero-submit'));
    // Then capability surfaces remain mounted and submission reaches its owner.
    expect(screen.getByTestId('hub-nav')).toBeTruthy();
    expect(screen.getByTestId('home-hero-input')).toBeTruthy();
    expect(screen.getByTestId('home-hero-agent-model').querySelector('button')).not.toBeNull();
    expect(screen.getByTestId('inline-model-switcher-chip').getAttribute('aria-haspopup')).toBe('menu');
    expect(screen.getByTestId('hub-project-p1')).toBeTruthy();
    expect(submit).toHaveBeenCalledWith('Create artifact', { designSystemId: null });
  });

  it('retains preview, direct edit and the download menu', async () => {
    // Given the real viewer with an HTML artifact.
    const html = '<html><body><main data-readable-id="hero">Hero</main></body></html>';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(html)));
    await act(async () => {
      render(<FileViewer projectId="p1" projectKind="prototype" liveHtml={html}
        file={{ name: 'index.html', path: 'index.html', type: 'file', size: 100, mtime: 1, mime: 'text/html', kind: 'html' }} />);
    });
    // When the user opens the download entry point.
    fireEvent.click(screen.getByRole('button', { name: /download/i }));
    // Then editing and exporting remain available beside the preview.
    expect(screen.getByTestId('artifact-preview-frame')).toBeTruthy();
    expect(screen.getByTestId('manual-edit-mode-toggle').hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('menuitem', { name: /export as image/i })).toBeTruthy();
  });

  it.each(['full', 'low'] as const)('preserves handle coordinates and resize commits when %s', (profile) => {
    // Given a selected 200x100 target at half preview scale.
    applyPerformanceProfileToDocument(profile);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
    const commit = vi.fn();
    render(<ManualEditResizeHandles
      rect={{ left: 100, top: 50, width: 200, height: 100 }} startSize={{ width: 200, height: 100 }} scale={0.5}
      labels={{ nw: 'NW', n: 'N', ne: 'NE', e: 'E', se: 'SE', s: 'S', sw: 'SW', w: 'W' }} frameLabel="Resize"
      onResizePreview={vi.fn()} onResizeCommit={commit} onResizeCancel={vi.fn()} onBurstCancel={() => false}
    />);
    const handle = screen.getByLabelText('SE');
    // When the pointer moves 40x20 screen pixels and releases.
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 300, clientY: 150 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 340, clientY: 170 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 340, clientY: 170 });
    // Then scaling and hit target identity are unchanged by the profile.
    expect(handle.getAttribute('data-direction')).toBe('se');
    expect(commit).toHaveBeenCalledWith('se', { width: 280, height: 140 }, { width: 200, height: 100 });
  });
});
