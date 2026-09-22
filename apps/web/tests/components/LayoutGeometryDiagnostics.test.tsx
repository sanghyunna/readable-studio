// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LayoutGeometryDiagnostics, requestLayoutGeometry } from '../../src/components/LayoutGeometryDiagnostics';
import { QuestionsPanel } from '../../src/components/QuestionsPanel';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture() {
  vi.useFakeTimers();
  const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, -98, 1280, 1152));
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 1152 });
  return info;
}
it.each(['resize', 'maximize', 'unmaximize', 'restore', 'display-metrics-changed'] as const)(
  'records numeric renderer geometry when %s occurs', reason => {
    // Given a mounted shell and diagnostics.
    const info = fixture();
    render(<div className="workspace-shell"><LayoutGeometryDiagnostics /></div>);
    // When native resize or the desktop bridge signals a geometry event.
    act(() => {
      if (reason === 'resize') window.dispatchEvent(new Event('resize'));
      else requestLayoutGeometry(reason);
      vi.advanceTimersByTime(250);
    });
    // Then the existing console log path receives serializable numbers, not DOM objects.
    expect(info).toHaveBeenCalledTimes(1);
    const line = info.mock.calls[0]?.[0];
    expect(typeof line).toBe('string');
    const fields = JSON.parse(String(line).slice('layout geometry '.length));
    expect(fields).toMatchObject({ source: 'renderer', reasons: [reason],
      innerWidth: window.innerWidth, innerHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio,
      clientHeight: 1152, shell: { top: -98, height: 1152, scrollTop: 0 }, bodyScrollTop: 0, rootScrollTop: 0,
    });
  },
);

it('samples the real question card on mount and answer without duplicate logs on rerender', () => {
  // Given diagnostics and a real pending card.
  const info = fixture();
  const form = { id: 'private-id', title: 'private-title', questions: [{ id: 'choice', type: 'text' as const, label: 'private-label' }] };
  const tree = (answered: boolean) => <div className="workspace-shell"><LayoutGeometryDiagnostics />
    <QuestionsPanel form={form} interactive generating={false} onSubmit={() => undefined}
      submittedAnswers={answered ? { choice: 'private-answer' } : undefined} />
  </div>;
  const view = render(tree(false));
  act(() => vi.advanceTimersByTime(250));
  // When the card becomes answered and is rerendered unchanged.
  view.rerender(tree(true));
  act(() => vi.advanceTimersByTime(250));
  view.rerender(tree(true));
  act(() => vi.advanceTimersByTime(250));
  // Then each transition is sampled exactly once, without any content/IDs.
  const samples = info.mock.calls.map(call => JSON.parse(String(call[0]).slice('layout geometry '.length)));
  expect(samples.map(sample => sample.reasons)).toEqual([['question-mounted'], ['question-answered']]);
  expect(JSON.stringify(samples)).not.toContain('private-');
});

it('bounds resize bursts and cancels pending samples when unmounted', () => {
  // Given a mounted diagnostics emitter.
  const info = fixture();
  const view = render(<div className="workspace-shell"><LayoutGeometryDiagnostics /></div>);
  // When repeated identical resize batches occur, followed by unmount.
  act(() => {
    for (let i = 0; i < 100; i++) window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(250);
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(250);
    requestLayoutGeometry('restore');
  });
  view.unmount();
  act(() => vi.advanceTimersByTime(250));
  // Then only the first geometry is written.
  expect(info).toHaveBeenCalledTimes(1);
});
