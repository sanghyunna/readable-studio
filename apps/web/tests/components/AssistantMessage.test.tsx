// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssistantMessage, type InlineQuestionCardState } from '../../src/components/AssistantMessage';
import { formatFormAnswers } from '../../src/artifacts/question-form';
import type { ChatMessage, ProjectFile } from '../../src/types';

beforeAll(() => {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      clear: () => store.clear(),
      getItem: (key: string) => store.get(key) ?? null,
      removeItem: (key: string) => store.delete(key),
      setItem: (key: string, value: string) => store.set(key, value),
    },
  });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

beforeEach(() => {
  window.localStorage.clear();
});

function baseMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: 'Done.',
    runStatus: 'succeeded',
    startedAt: 1700000000,
    endedAt: 1700000005,
    events: [{ kind: 'text', text: 'Done.' } as ChatMessage['events'][number]],
    producedFiles: [],
    ...overrides,
  } as ChatMessage;
}

describe('AssistantMessage completion footer', () => {
  it('copies the raw assistant markdown from the completion footer', async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText,
      },
    });
    try {
      const message = baseMessage({
        content: '**Done.**\n\n- Keep the markdown',
        events: [
          {
            kind: 'text',
            text: '**Done.**\n\n- Keep the markdown',
          } as ChatMessage['events'][number],
        ],
      });
      render(
        <AssistantMessage
          message={message}
          streaming={false}
          projectId="proj-1"
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Copy response markdown' }));

      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith(message.content);
      });
      expect(screen.getByRole('button', { name: 'Copied!' })).toBeTruthy();
    } finally {
      if (originalClipboard) {
        Object.defineProperty(navigator, 'clipboard', originalClipboard);
      } else {
        delete (navigator as { clipboard?: Clipboard }).clipboard;
      }
    }
  });

  it('calls the fork handler from completed assistant turns', () => {
    const onForkFromMessage = vi.fn();
    render(
      <AssistantMessage
        message={baseMessage()}
        streaming={false}
        projectId="proj-1"
        onForkFromMessage={onForkFromMessage}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Fork from here' }));

    expect(onForkFromMessage).toHaveBeenCalledTimes(1);
  });

  it('does not show the fork action while the assistant is streaming', () => {
    render(
      <AssistantMessage
        message={baseMessage({
          runStatus: 'running',
          endedAt: undefined,
        })}
        streaming
        projectId="proj-1"
        onForkFromMessage={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Fork from here' })).toBeNull();
  });

  it('keeps copy, rollback, and fork actions without thumbs feedback', () => {
    render(
      <AssistantMessage
        message={baseMessage()}
        streaming={false}
        projectId="proj-1"
        conversationId="conv-1"
        onForkFromMessage={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Copy response markdown' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rollback from here' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fork from here' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Helpful' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Not helpful' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Feedback' })).toBeNull();
  });
});

describe('AssistantMessage status badge updates (Bug A)', () => {
  // Regression coverage for the model-badge stale-detail bug. ACP agents
  // emit two `status: 'model'` events per turn:
  //   1. After session/new returns — the agent's initial default model
  //      (e.g. `swe-1-6-fast` for Devin for Terminal)
  //   2. After session/set_config_option (or legacy session/set_model)
  //      succeeds — the user-selected model (e.g. `claude-opus-4-7-max`)
  //
  // The previous `buildBlocks` dedupe SKIPPED the second event and the
  // badge stayed stuck on the initial default, even though the running
  // model and the conversation header were already correct. The fix
  // updates the existing block's detail to the latest value so the badge
  // tracks the most recent model the daemon reported.
  it('renders the most recent detail when multiple status events share a label', () => {
    render(
      <AssistantMessage
        message={baseMessage({
          events: [
            { kind: 'status', label: 'model', detail: 'swe-1-6-fast' } as ChatMessage['events'][number],
            { kind: 'status', label: 'model', detail: 'claude-opus-4-7-max' } as ChatMessage['events'][number],
            { kind: 'text', text: 'Done.' } as ChatMessage['events'][number],
          ],
        })}
        streaming={false}
        projectId="proj-1"
      />,
    );

    // Latest detail should be rendered in the badge.
    expect(screen.getByText('claude-opus-4-7-max')).toBeTruthy();

    // The initial default must not be present — if it is, the stale-detail
    // bug is back.
    expect(screen.queryByText('swe-1-6-fast')).toBeNull();
  });

  it('still collapses repeated status events with the same label and detail into a single badge', () => {
    render(
      <AssistantMessage
        message={baseMessage({
          events: [
            { kind: 'status', label: 'model', detail: 'claude-opus-4-7-max' } as ChatMessage['events'][number],
            { kind: 'status', label: 'model', detail: 'claude-opus-4-7-max' } as ChatMessage['events'][number],
            { kind: 'text', text: 'Done.' } as ChatMessage['events'][number],
          ],
        })}
        streaming={false}
        projectId="proj-1"
      />,
    );

    const matches = screen.queryAllByText('claude-opus-4-7-max');
    expect(matches.length).toBe(1);
  });

  it('renders bare URLs in status details as links', () => {
    render(
      <AssistantMessage
        message={baseMessage({
          runStatus: 'failed',
          events: [
            {
              kind: 'status',
              label: 'error',
              detail:
                'AMR Cloud reported insufficient balance. Recharge at https://vela.powerformer.net/wallet, then retry.',
            } as ChatMessage['events'][number],
          ],
        })}
        streaming={false}
        projectId="proj-1"
      />,
    );

    const link = screen.getByRole('link', { name: 'https://vela.powerformer.net/wallet' });
    expect(link.getAttribute('href')).toBe('https://vela.powerformer.net/wallet');
    expect(link.classList.contains('md-link')).toBe(true);
  });
});

describe('AssistantMessage thinking blocks', () => {
  it('does not render an empty thinking block for whitespace-only thinking deltas', () => {
    const { container } = render(
      <AssistantMessage
        message={baseMessage({
          content: '',
          events: [
            { kind: 'status', label: 'thinking' } as ChatMessage['events'][number],
            { kind: 'thinking', text: '\n  \t' } as ChatMessage['events'][number],
          ],
        })}
        streaming={false}
        projectId="proj-1"
      />,
    );

    expect(container.querySelector('.thinking-block')).toBeNull();
  });

  it('keeps non-empty thinking content visible after leading whitespace deltas', () => {
    const { container } = render(
      <AssistantMessage
        message={baseMessage({
          content: '',
          events: [
            { kind: 'thinking', text: '\n  ' } as ChatMessage['events'][number],
            { kind: 'thinking', text: 'Reading the directory listing.' } as ChatMessage['events'][number],
          ],
        })}
        streaming={false}
        projectId="proj-1"
      />,
    );

    expect(container.querySelector('.thinking-block')).toBeTruthy();
    expect(screen.getByText('Reading the directory listing.')).toBeTruthy();
  });
});

describe('AssistantMessage inline question card', () => {
  const stubForm = {
    id: 'brief',
    title: 'Quick brief',
    questions: [
      { id: 'platform', label: 'Platform', type: 'radio', required: true, options: ['Mobile', 'Desktop'] },
      { id: 'features', label: 'Features', type: 'checkbox', options: ['Search', 'Export'], maxSelections: 2 },
      { id: 'tone', label: 'Tone', type: 'select', options: [{ value: 'warm', label: 'Warm' }, { value: 'crisp', label: 'Crisp' }] },
      { id: 'audience', label: 'Audience', type: 'text', placeholder: 'e.g. buyers' },
      { id: 'notes', label: 'Notes', type: 'textarea' },
      { id: 'direction', label: 'Direction', type: 'direction-cards', options: ['editorial'], cards: [
        { id: 'editorial', label: 'Editorial', mood: 'Calm', references: ['FT'], palette: ['#111'], displayFont: 'serif', bodyFont: 'sans-serif' },
      ] },
    ],
  };
  const content = `<question-form id="brief" title="Quick brief">${JSON.stringify({ questions: stubForm.questions })}</question-form>`;
  const card = (overrides: Partial<InlineQuestionCardState> = {}): InlineQuestionCardState => ({
    messageId: 'msg-1', formKey: 'conv:msg-1:brief', formPreview: null, generating: false, brief: null,
    interactive: true, submitDisabled: false, runHydrationStatus: 'ready', submissionQueued: false,
    onSubmit: vi.fn(() => true), ...overrides,
  });

  it('renders every question type as its proper control inside the assistant message', () => {
    render(<AssistantMessage message={baseMessage({ content, events: undefined })} streaming={false} projectId="proj-1" questionCard={card()} />);
    const panel = screen.getByTestId('questions-panel');
    expect(panel.getAttribute('data-pending')).toBe('true');
    expect(screen.queryByTestId('questions-banner')).toBeNull();
    expect(screen.getByRole('radiogroup', { name: 'Platform' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Mobile' })).toBeTruthy();
    // checkbox type renders as pressed toggles, never a visible checkbox.
    expect(screen.getByRole('button', { name: 'Search' }).getAttribute('aria-pressed')).toBe('false');
    expect(panel.querySelector('input[type="checkbox"]')).toBeNull();
    expect(panel.querySelector('[data-question-type="select"] .qf-select')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Audience' }).tagName).toBe('INPUT');
    expect(screen.getByRole('textbox', { name: 'Notes' }).tagName).toBe('TEXTAREA');
    expect(panel.querySelector('.qf-direction-cards .qf-card')).toBeTruthy();
    // The first control takes focus so the request is immediately answerable.
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Mobile' }));
  });

  it('does not steal focus from an in-progress composer keystroke', () => {
    const composer = document.createElement('textarea');
    document.body.appendChild(composer);
    composer.focus();
    render(<AssistantMessage message={baseMessage({ content, events: undefined })} streaming={false} projectId="proj-1" questionCard={card()} />);
    expect(document.activeElement).toBe(composer);
    composer.remove();
  });

  it('blocks submit until required answers are present, then submits through the existing answer path', async () => {
    const onSubmit = vi.fn(() => true);
    render(<AssistantMessage message={baseMessage({ content, events: undefined })} streaming={false} projectId="proj-1" questionCard={card({ onSubmit })} />);
    const submit = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: 'Desktop' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(submit.disabled).toBe(false);
    await act(async () => { fireEvent.click(submit); });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [text, answers] = onSubmit.mock.calls[0]!;
    expect(answers).toMatchObject({ platform: 'Desktop', features: ['Export'] });
    expect(text).toMatch(/^\[form answers/i);
    expect(text).toContain('Platform: Desktop');
  });

  it('settles into an answered state from the next user message and cannot double-send', () => {
    const onSubmit = vi.fn(() => true);
    const nextUserContent = formatFormAnswers(stubForm as never, { platform: 'Mobile', features: ['Search'] });
    render(<AssistantMessage message={baseMessage({ content, events: undefined })} streaming={false} projectId="proj-1"
      nextUserContent={nextUserContent} questionCard={card({ onSubmit, interactive: false, submittedAnswers: { platform: 'Mobile', features: ['Search'] } })} />);
    const panel = screen.getByTestId('questions-panel');
    expect(panel.getAttribute('data-answered')).toBe('true');
    expect(panel.getAttribute('data-pending')).toBeNull();
    expect(screen.getByRole('radio', { name: 'Mobile' }).getAttribute('aria-checked')).toBe('true');
    expect((screen.getByRole('radio', { name: 'Mobile' }) as HTMLButtonElement).disabled).toBe(true);
    const submit = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('renders a stale (non-owner) form occurrence locked, showing its historical answers', () => {
    const onSubmit = vi.fn(() => true);
    const nextUserContent = formatFormAnswers(stubForm as never, { platform: 'Desktop' });
    render(<AssistantMessage message={baseMessage({ content, events: undefined })} streaming={false} projectId="proj-1"
      nextUserContent={nextUserContent} questionCard={card({ messageId: 'msg-other', onSubmit })} />);
    expect(screen.getByTestId('questions-panel').getAttribute('data-answered')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Desktop' }).getAttribute('aria-checked')).toBe('true');
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('renders the streaming card frame instead of raw JSON while the form is still open', () => {
    const open = '<question-form id="brief" title="Quick brief">{"questions":[{"id":"platform","label":"Platform","type":"radio","options":["Mobile"]},{"id":"x"';
    const { container } = render(<AssistantMessage message={baseMessage({ content: open, events: undefined })} streaming isLast
      projectId="proj-1" questionCard={card({ generating: true, interactive: false, formPreview: { id: 'brief', title: 'Quick brief', questions: [stubForm.questions[0] as never] } })} />);
    expect(container.textContent).not.toContain('"questions"');
    expect(screen.getByTestId('questions-panel').getAttribute('aria-busy')).toBe('true');
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('AssistantMessage recovered produced files', () => {
  it('skips a malformed persisted produced-file entry without crashing the message', () => {
    const malformedProducedFiles: unknown[] = ['index.html'];
    expect((malformedProducedFiles[0] as { name?: unknown }).name).toBeUndefined();

    render(
      <AssistantMessage
        message={baseMessage({
          producedFiles: malformedProducedFiles as ProjectFile[],
        })}
        streaming={false}
        projectId="proj-1"
      />,
    );

    expect(screen.getByText('Done.')).toBeTruthy();
    expect(screen.queryByText('index.html')).toBeNull();
    expect(screen.queryByText('Files from this turn')).toBeNull();
  });

  it('shows files modified during a sparse completed assistant turn', () => {
    render(
      <AssistantMessage
        message={baseMessage({
          content: '',
          events: [
            { kind: 'status', label: 'starting', detail: 'Claude' } as ChatMessage['events'][number],
            { kind: 'status', label: 'initializing', detail: 'claude-opus' } as ChatMessage['events'][number],
          ],
          producedFiles: [],
        })}
        streaming={false}
        projectId="proj-1"
        projectFiles={[
          {
            name: 'iphone-device-reveal.mp4',
            path: 'iphone-device-reveal.mp4',
            size: 2328155,
            mtime: 1700000004,
            kind: 'video',
            mime: 'video/mp4',
          } as ProjectFile,
        ]}
      />,
    );

    expect(screen.getByText('iphone-device-reveal.mp4')).toBeTruthy();
  });


  it('does not infer user sketches as turn output files', () => {
    render(
      <AssistantMessage
        message={baseMessage({
          content: '',
          events: [
            { kind: 'status', label: 'starting', detail: 'Claude' } as ChatMessage['events'][number],
            { kind: 'status', label: 'initializing', detail: 'claude-opus' } as ChatMessage['events'][number],
          ],
          producedFiles: [],
        })}
        streaming={false}
        projectId="proj-1"
        projectFiles={[
          {
            name: 'board.sketch.json',
            path: 'board.sketch.json',
            size: 2048,
            mtime: 1700000004,
            kind: 'sketch',
            mime: 'application/json',
          } as ProjectFile,
        ]}
      />,
    );

    expect(screen.queryByText('board.sketch.json')).toBeNull();
  });

  it('still infers generated svg files classified as sketches', () => {
    render(
      <AssistantMessage
        message={baseMessage({
          content: '',
          events: [
            { kind: 'status', label: 'starting', detail: 'Claude' } as ChatMessage['events'][number],
            { kind: 'status', label: 'initializing', detail: 'claude-opus' } as ChatMessage['events'][number],
          ],
          producedFiles: [],
        })}
        streaming={false}
        projectId="proj-1"
        projectFiles={[
          {
            name: 'diagram.svg',
            path: 'diagram.svg',
            size: 2048,
            mtime: 1700000004,
            kind: 'sketch',
            mime: 'image/svg+xml',
          } as ProjectFile,
          {
            name: 'board.sketch.json',
            path: 'board.sketch.json',
            size: 2048,
            mtime: 1700000004,
            kind: 'sketch',
            mime: 'application/json',
          } as ProjectFile,
        ]}
      />,
    );

    expect(screen.getByText('diagram.svg')).toBeTruthy();
    expect(screen.queryByText('board.sketch.json')).toBeNull();
  });

  it('keeps explicitly recorded sketch outputs visible', () => {
    render(
      <AssistantMessage
        message={baseMessage({
          producedFiles: [
            {
              name: 'agent-sketch.sketch.json',
              path: 'agent-sketch.sketch.json',
              size: 2048,
              mtime: 1700000004,
              kind: 'sketch',
              mime: 'application/json',
            } as ProjectFile,
          ],
        })}
        streaming={false}
        projectId="proj-1"
      />,
    );

    expect(screen.getByText('agent-sketch.sketch.json')).toBeTruthy();
  });
});
