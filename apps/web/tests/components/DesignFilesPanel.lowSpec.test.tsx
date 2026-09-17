// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignFilesPanel } from '../../src/components/DesignFilesPanel';
import { en } from '../../src/i18n/locales/en';
import { applyPerformanceProfileToDocument, PERFORMANCE_PROFILE_ATTRIBUTE } from '../../src/state/config';

function renderPanel() {
  return render(
    <DesignFilesPanel
      projectId="low-spec-tips" running files={[]}
      onRefreshFiles={vi.fn()} onOpenFile={vi.fn()} onRenameFile={() => null}
      onDeleteFile={vi.fn()} onDeleteFiles={vi.fn()} onUpload={vi.fn()}
      onUploadFiles={vi.fn()} onPaste={vi.fn()} onNewSketch={vi.fn()}
    />,
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.documentElement.removeAttribute(PERFORMANCE_PROFILE_ATTRIBUTE);
});

describe('design file tips profile', () => {
  it('shows the complete first tip without typing or hold timers when low', () => {
    // Given a low-profile document.
    document.documentElement.setAttribute(PERFORMANCE_PROFILE_ATTRIBUTE, 'low');
    // When the running panel mounts.
    const { container } = renderPanel();
    // Then the shipped information is readable immediately with no producers.
    expect(container.querySelector('.df-useful-info-tip')?.textContent).toBe(en['designFiles.usefulInfoTip']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('types character by character when full', () => {
    // Given a full-profile running panel.
    document.documentElement.setAttribute(PERFORMANCE_PROFILE_ATTRIBUTE, 'full');
    const { container } = renderPanel();
    expect(container.querySelector('.df-useful-info-tip')?.textContent).toBe('');
    expect(vi.getTimerCount()).toBe(1);
    // When one typing interval elapses.
    act(() => vi.advanceTimersByTime(32));
    // Then exactly the first character has appeared.
    expect(container.querySelector('.df-useful-info-tip')?.textContent).toBe(en['designFiles.usefulInfoTip'].slice(0, 1));
  });

  it('rotates after the hold when full with reduced motion', () => {
    // Given reduced motion without low mode: typing is skipped, rotation remains.
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    vi.spyOn(window, 'matchMedia').mockReturnValue({ ...media, matches: true });
    const { container } = renderPanel();
    expect(container.querySelector('.df-useful-info-tip')?.textContent).toBe(en['designFiles.usefulInfoTip']);
    // When the hold finishes.
    act(() => vi.advanceTimersByTime(3800));
    // Then the second complete tip is displayed and rotation continues.
    expect(container.querySelector('.df-useful-info-tip')?.textContent).toBe(en['designFiles.usefulInfoTip2']);
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each([false, true])('stops the mounted producer and resumes it when toggled (reduced motion: %s)', async (reducedMotion) => {
    // Given either an active typing interval or a reduced-motion hold timeout.
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    vi.spyOn(window, 'matchMedia').mockReturnValue({ ...media, matches: reducedMotion });
    const { container } = renderPanel();
    act(() => vi.advanceTimersByTime(32));
    // When low mode is applied to the mounted panel.
    await act(async () => { applyPerformanceProfileToDocument('low'); });
    // Then the current tip is complete and every producer is cancelled.
    expect(vi.getTimerCount()).toBe(0);
    expect(container.querySelector('.df-useful-info-tip')?.textContent).toBe(en['designFiles.usefulInfoTip']);
    act(() => vi.advanceTimersByTime(10_000));
    expect(container.querySelector('.df-useful-info-tip')?.textContent).toBe(en['designFiles.usefulInfoTip']);
    // When full mode returns on that same panel.
    await act(async () => { applyPerformanceProfileToDocument('full'); });
    // Then the original typing or rotation cadence resumes.
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(reducedMotion ? 3800 : 32));
    expect(container.querySelector('.df-useful-info-tip')?.textContent).toBe(
      reducedMotion ? en['designFiles.usefulInfoTip2'] : en['designFiles.usefulInfoTip'].slice(0, 1),
    );
  });

  it('cancels the normal hold timeout when low is enabled after typing completes', async () => {
    // Given a fully typed tip waiting to rotate.
    const { container } = renderPanel();
    act(() => vi.advanceTimersByTime(en['designFiles.usefulInfoTip'].length * 32));
    // When low mode interrupts the hold rather than the typewriter.
    await act(async () => { applyPerformanceProfileToDocument('low'); });
    // Then the hold is cancelled and the complete tip remains visible.
    expect(vi.getTimerCount()).toBe(0);
    expect(container.querySelector('.df-useful-info-tip')?.textContent).toBe(en['designFiles.usefulInfoTip']);
  });

  it('releases the typing timer when the panel unmounts', () => {
    // Given the full-mode typewriter.
    const { unmount } = renderPanel();
    // When the panel closes.
    unmount();
    // Then it leaves no producer behind.
    expect(vi.getTimerCount()).toBe(0);
  });
});
