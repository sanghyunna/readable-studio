// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectActionsToolbar } from '../../src/components/ProjectActionsToolbar';
import { useDesignMdState } from '../../src/hooks/useDesignMdState';
import { deferred } from '../helpers/deferred';

function ProjectActions() {
  const state = useDesignMdState('toolbar');
  return <ProjectActionsToolbar designMdState={state} finalizeStatus="idle"
    onFinalize={vi.fn()} onCancelFinalize={vi.fn()} onContinueInCli={vi.fn()} />;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each([{ status: 200, enabled: true }, { status: 503, enabled: false }])(
  'publishes the toolbar only after the design response when its HTTP status is $status', async ({ status, enabled }) => {
    // Given: conversations is available but the design body is not.
    const body = deferred<Response>();
    const bodyStarted = deferred<void>();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/files')) return Response.json({ files: [
        { name: 'DESIGN.md', size: 1, mtime: 1, kind: 'text', mime: 'text/markdown' },
      ] });
      if (url.endsWith('/conversations')) return Response.json({ conversations: [] });
      bodyStarted.resolve();
      return body.promise;
    });
    render(<ProjectActions />);
    await act(async () => { await bodyStarted.promise; });
    const pendingDisabled = screen.getByRole('button', { name: 'Continue in CLI' }).hasAttribute('disabled');

    // When: the design response completes (success or failure).
    await act(async () => {
      body.resolve(new Response('## Provenance\n- Generated UTC timestamp: 2026-05-08T12:00:00Z\n', { status }));
    });

    // Then: the real toolbar never enables CLI continuation on partial/error data.
    expect(pendingDisabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Continue in CLI' }).hasAttribute('disabled')).toBe(!enabled);
  },
);
