// @vitest-environment jsdom

/**
 * Chat-log declutter contract:
 *   (a) consecutive tool calls with no prose between them render as ONE
 *       merged group; prose between calls keeps the groups apart,
 *   (b) tool-call errors never surface in the collapsed row (no red ✕, no
 *       error label), while a failed RUN keeps its failure status,
 *   (c) lifecycle / protocol status events are not chat content.
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AssistantMessage } from '../../src/components/AssistantMessage';
import { I18nProvider } from '../../src/i18n';
import { getKo } from '../../src/i18n/locales/ko';
import { getEn } from '../../src/i18n/locales/en';
import type { AgentEvent, ChatMessage } from '../../src/types';

const ko = getKo();
const en = getEn();

function message(events: AgentEvent[], overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: '',
    events,
    startedAt: 1_000,
    endedAt: 3_000,
    runStatus: 'succeeded',
    ...overrides,
  };
}

function bash(id: string, isError = false): AgentEvent[] {
  return [
    { kind: 'tool_use', id, name: 'Bash', input: { command: `echo ${id}` } },
    { kind: 'tool_result', toolUseId: id, content: isError ? 'boom' : 'ok', isError },
  ];
}

function read(id: string): AgentEvent[] {
  return [
    { kind: 'tool_use', id, name: 'Read', input: { file_path: `${id}.ts` } },
    { kind: 'tool_result', toolUseId: id, content: 'contents', isError: false },
  ];
}

function renderKo(msg: ChatMessage) {
  return render(
    <I18nProvider initial="ko">
      <AssistantMessage message={msg} streaming={false} projectId="project-1" conversationId="conv-1" />
    </I18nProvider>,
  );
}

afterEach(cleanup);

describe('AssistantMessage chat-log declutter', () => {
  it('merges consecutive tool calls of different families into one group when no prose sits between them', () => {
    // Given: Bash ×2, Read ×2, Bash ×2 back to back
    const { container } = renderKo(
      message([...bash('b1'), ...bash('b2'), ...read('r1'), ...read('r2'), ...bash('b3'), ...bash('b4')]),
    );
    // Then: exactly one collapsed group row
    expect(container.querySelectorAll('.action-card').length).toBe(1);
    // and expanding it exposes every call
    expect(container.querySelectorAll('.action-card .op-card').length).toBe(6);
  });

  it('keeps tool groups apart when prose sits between them', () => {
    const { container } = renderKo(
      message([
        ...bash('b1'),
        ...bash('b2'),
        { kind: 'text', text: 'Now reading the files.' },
        ...read('r1'),
        ...read('r2'),
      ]),
    );
    expect(container.querySelectorAll('.action-card').length).toBe(2);
  });

  it('labels a completed group as a past-tense summary rather than "in progress ×n, done"', () => {
    const { container } = renderKo(message([...bash('b1'), ...bash('b2'), ...read('r1')]));
    const label = container.querySelector('.action-card-toggle .summary')?.textContent ?? '';
    // Then: no in-progress verb in a settled row; the settled summary counts each family
    expect(label).not.toContain(ko['assistant.verbRunning']);
    expect(label).not.toContain(ko['assistant.verbReading']);
    expect(label).toBe(
      ko['assistant.toolGroupDone'].replace(
        '{parts}',
        `${ko['assistant.toolDoneRan'].replace('{n}', '2')}, ${ko['assistant.toolDoneRead'].replace('{n}', '1')}`,
      ),
    );
  });

  it('shows no error label or ✕ on a collapsed group whose calls errored', () => {
    const { container } = renderKo(message([...bash('b1', true), ...bash('b2', true), ...bash('b3')]));
    const toggle = container.querySelector('.action-card-toggle');
    expect(toggle).not.toBeNull();
    expect(toggle?.querySelector('.op-status-error')).toBeNull();
    expect(toggle?.textContent).not.toContain(ko['tool.error']);
    expect(toggle?.textContent).not.toContain(en['tool.error']);
    expect(toggle?.querySelector('.op-status-ok')).not.toBeNull();
  });

  it('shows no ✕ on a lone errored tool card in the log', () => {
    const { container } = renderKo(message([...bash('b1', true)]));
    expect(container.querySelector('.op-status-error')).toBeNull();
  });

  it('still surfaces a failed run as failed even though its tool errors are silent', () => {
    const { container } = renderKo(
      message(
        [
          ...bash('b1', true),
          ...bash('b2', true),
          { kind: 'status', label: 'error', detail: 'Agent exited with code 1' },
        ],
        { runStatus: 'failed' },
      ),
    );
    expect(container.querySelector('.action-card-toggle .op-status-error')).toBeNull();
    expect(container.querySelector('.status-pill.is-error')).not.toBeNull();
    expect(container.querySelector('.assistant-label')?.textContent).toBe(ko['designs.status.failed']);
  });

  it.each<[string, AgentEvent]>([
    ['codex thread_started', { kind: 'status', label: 'thread_started', detail: 'thr_123' }],
    ['kimi available_commands_update', { kind: 'status', label: 'available_commands_update' }],
    ['kimi config_option_update', { kind: 'status', label: 'config_option_update' }],
    ['bare model line', { kind: 'status', label: 'model', detail: 'kimi-code/kimi-for-coding-highspeed' }],
    [
      'codex sandbox_isolation_unavailable',
      {
        kind: 'status',
        label: 'sandbox_isolation_unavailable',
        detail: 'Running WITHOUT sandbox isolation: AppContainer unavailable',
      },
    ],
  ])('renders no row for lifecycle status %s', (_name, event) => {
    const { container } = renderKo(message([event, { kind: 'text', text: 'Hello' }]));
    expect(container.querySelector('.status-pill')).toBeNull();
    expect(container.textContent).not.toContain(event.kind === 'status' ? event.label : '');
    if (event.kind === 'status' && event.detail) expect(container.textContent).not.toContain(event.detail);
  });

  it.each<[string, keyof typeof ko, string]>([
    ['rollback_request_failed', 'status.rollbackRequestFailed', 'checkpoint missing'],
    ['rollback_request_ignored', 'status.rollbackRequestIgnored', 'agent rollback already requested for this run'],
  ])('keeps the outcome of a rollback request visible with natural copy (%s)', (label, key, detail) => {
    // Given: the daemon reports the outcome of a rollback the user asked for
    const { container } = renderKo(message([{ kind: 'status', label, detail }, { kind: 'text', text: 'Hello' }]));
    // Then: it renders as a notice with translated copy, never the raw event name
    const pill = container.querySelector('.status-pill');
    expect(pill).not.toBeNull();
    expect(pill?.querySelector('.status-label')?.textContent).toBe(ko[key]);
    expect(pill?.textContent).toContain(detail);
    expect(container.textContent).not.toContain(label);
  });

  it('keeps warning notices as chat content', () => {
    const { container } = renderKo(
      message([{ kind: 'status', label: 'warning', detail: 'Model emitted fabricated role marker' }]),
    );
    expect(container.querySelector('.status-pill.is-warning')).not.toBeNull();
  });
});
