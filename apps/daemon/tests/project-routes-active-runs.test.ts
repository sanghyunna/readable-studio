import { describe, expect, it, vi } from 'vitest';

import {
  cancelActiveConversationRuns,
  createFileChangedCoalescer,
} from '../src/project-routes.js';

describe('project rollback active run handling', () => {
  it('cancels active conversation runs instead of blocking rollback', () => {
    const activeRun = { id: 'run-1', status: 'running' };
    const cancel = vi.fn();
    const list = vi.fn(() => [activeRun]);

    const count = cancelActiveConversationRuns(
      { runs: { list, cancel } },
      'project-1',
      'conversation-1',
    );

    expect(count).toBe(1);
    expect(list).toHaveBeenCalledWith({
      projectId: 'project-1',
      conversationId: 'conversation-1',
      status: 'active',
    });
    expect(cancel).toHaveBeenCalledWith(activeRun);
  });
});

describe('project file event coalescing', () => {
  it('sends only the latest file-changed event per path in a short window', () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn();
      const coalescer = createFileChangedCoalescer(send, 100);

      coalescer.push({ path: 'index.html', version: 1 });
      coalescer.push({ path: 'index.html', version: 2 });
      coalescer.push({ path: 'style.css', version: 1 });

      vi.advanceTimersByTime(99);
      expect(send).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenNthCalledWith(1, { path: 'index.html', version: 2 });
      expect(send).toHaveBeenNthCalledWith(2, { path: 'style.css', version: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops pending file-changed events on cleanup', () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn();
      const coalescer = createFileChangedCoalescer(send, 100);

      coalescer.push({ path: 'index.html', version: 1 });
      coalescer.cleanup();
      vi.runAllTimers();

      expect(send).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
