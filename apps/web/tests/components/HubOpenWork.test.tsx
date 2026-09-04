// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HubOpenWork, type HubOpenWorkItem } from '../../src/components/hub/HubOpenWork';

afterEach(cleanup);

const LONG_OPEN_WORK: HubOpenWorkItem = {
  sessionId: 'session-long',
  projectId: 'project-long',
  projectName: '트랜스포머 논문 프로젝트',
  title: 'Apple 디자인 템플릿을 따라서 트랜스포머 논문을 정리하는 긴 작업 이름',
};

describe('HubOpenWork', () => {
  it('exposes the full row name through the portal tooltip contract', () => {
    // Given: an open-work item whose name can exceed the rail width.
    render(
      <HubOpenWork
        items={[LONG_OPEN_WORK]}
        currentSessionId={null}
        onOpen={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    // When: the open-work row renders.
    const row = screen.getByTestId('hub-open-work-session-long');

    // Then: TooltipLayer can reveal its full name without a native title popup.
    expect(row.classList.contains('readable-tooltip')).toBe(true);
    expect(row.getAttribute('data-tooltip')).toBe(
      `${LONG_OPEN_WORK.projectName} · ${LONG_OPEN_WORK.title}`,
    );
    expect(row.hasAttribute('title')).toBe(false);
  });
});
