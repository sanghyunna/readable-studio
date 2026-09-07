import { afterEach, describe, expect, it, vi } from 'vitest';
import { listActiveChatRuns } from '../../src/providers/daemon';

afterEach(() => { vi.unstubAllGlobals(); });

describe('active run hydration', () => {
  it('accepts an authoritative idle result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ runs: [] }))));
    await expect(listActiveChatRuns('project', 'conversation', { requireSuccess: true })).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledWith('/api/runs?projectId=project&conversationId=conversation&status=active');
  });

  it.each(['http', 'network'] as const)('does not interpret a %s failure as an idle conversation during hydration', async (failure) => {
    vi.stubGlobal('fetch', failure === 'http'
      ? vi.fn().mockResolvedValue(new Response('', { status: 503 }))
      : vi.fn().mockRejectedValue(new Error('offline')));
    await expect(listActiveChatRuns('project', 'conversation', { requireSuccess: true })).rejects.toBeInstanceOf(Error);
    // Existing non-hydration consumers retain their best-effort contract.
    await expect(listActiveChatRuns('project', 'conversation')).resolves.toEqual([]);
  });
});
