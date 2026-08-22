// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BoardComposerPopover } from '../../src/components/BoardComposerPopover';
import type { PreviewCommentSnapshot } from '../../src/comments';

afterEach(() => {
  cleanup();
});

const target: PreviewCommentSnapshot = {
  filePath: 'index.html',
  elementId: 'hero-title',
  selector: '#hero-title',
  label: 'Hero title',
  text: '',
  position: { x: 0, y: 0, width: 100, height: 24 },
  htmlHint: '',
  selectionKind: 'element',
};

function renderPopover({
  onSaveComment = () => {},
  onSendBatch = () => {},
  onAttachImages,
  sending = false,
  selectionKind = 'element',
  targetOverride = {},
  draft = 'Tighten this heading',
  existingImages = [],
  bounds,
}: {
  onSaveComment?: () => void;
  onSendBatch?: () => void;
  onAttachImages?: (files: File[]) => void;
  sending?: boolean;
  selectionKind?: PreviewCommentSnapshot['selectionKind'];
  targetOverride?: Partial<PreviewCommentSnapshot>;
  draft?: string;
  existingImages?: { url: string; name: string }[];
  bounds?: { width: number; height: number; scrollLeft?: number; scrollTop?: number };
} = {}) {
  return render(
    <BoardComposerPopover
      target={{ ...target, ...targetOverride, selectionKind }}
      existing={null}
      draft={draft}
      notes={[]}
      onDraft={() => {}}
      onAddDraft={() => {}}
      onRemoveQueuedNote={() => {}}
      onClose={() => {}}
      onSaveComment={onSaveComment}
      onSendBatch={onSendBatch}
      onAttachImages={onAttachImages}
      onRemoveMember={() => {}}
      existingImages={existingImages}
      sending={sending}
      t={((key: string) => String(key)) as never}
      bounds={bounds}
    />,
  );
}

describe('BoardComposerPopover keyboard submit', () => {
  it('sends an element comment to chat with Enter and keeps Shift+Enter for multiline text', () => {
    const onSaveComment = vi.fn();
    const onSendBatch = vi.fn();
    renderPopover({ onSaveComment, onSendBatch });

    fireEvent.keyDown(screen.getByTestId('comment-popover-input'), { key: 'Enter' });

    expect(onSendBatch).toHaveBeenCalledTimes(1);
    expect(onSaveComment).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByTestId('comment-popover-input'), { key: 'Enter', shiftKey: true });
    expect(onSendBatch).toHaveBeenCalledTimes(1);
  });

  it('sends a pod comment with Enter', () => {
    const onSendBatch = vi.fn();
    renderPopover({ onSendBatch, selectionKind: 'pod' });

    fireEvent.keyDown(screen.getByTestId('comment-popover-input'), { key: 'Enter' });

    expect(onSendBatch).toHaveBeenCalledTimes(1);
  });

  it('allows existing saved images to submit without typed text', () => {
    const onSaveComment = vi.fn();
    const onSendBatch = vi.fn();
    renderPopover({
      draft: '',
      existingImages: [{ url: '/api/projects/project-1/raw/uploads/ref.png', name: 'ref.png' }],
      onSaveComment,
      onSendBatch,
    });

    fireEvent.keyDown(screen.getByTestId('comment-popover-input'), { key: 'Enter' });
    expect(onSendBatch).toHaveBeenCalledTimes(1);
    expect(onSaveComment).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('comment-add-send'));
    expect(onSendBatch).toHaveBeenCalledTimes(2);
  });

  it('does not submit while disabled or while IME text is composing', () => {
    const onSendBatch = vi.fn();
    const { rerender } = renderPopover({ onSendBatch, sending: true });
    const input = screen.getByTestId('comment-popover-input');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSendBatch).not.toHaveBeenCalled();

    rerender(
      <BoardComposerPopover
        target={target}
        existing={null}
        draft="Tighten this heading"
        notes={[]}
        onDraft={() => {}}
        onAddDraft={() => {}}
        onRemoveQueuedNote={() => {}}
        onClose={() => {}}
        onSaveComment={() => {}}
        onSendBatch={onSendBatch}
        onRemoveMember={() => {}}
        sending={false}
        t={((key: string) => String(key)) as never}
      />,
    );

    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSendBatch).not.toHaveBeenCalled();
  });

  it('hides the element attachment picker without changing pod controls', () => {
    const onAttachImages = vi.fn();
    const { unmount } = renderPopover({ onAttachImages });

    expect(screen.queryByLabelText('chat.annotationAttachImage')).toBeNull();
    expect(document.querySelector('.comment-popover-actions-element')).toBeTruthy();

    const image = new File(['image'], 'reference.png', { type: 'image/png' });
    fireEvent.paste(screen.getByTestId('comment-popover-input'), {
      clipboardData: { files: [image] },
    });

    expect(onAttachImages).toHaveBeenCalledWith([image]);

    unmount();
    renderPopover({ onAttachImages, selectionKind: 'pod' });

    expect(screen.getByLabelText('chat.annotationAttachImage')).toBeTruthy();
    expect(document.querySelector('.comment-popover-actions-element')).toBeNull();
  });

  it('keeps the full composer inside the visible preview bounds for low targets', () => {
    renderPopover({
      targetOverride: {
        position: { x: 24, y: 560, width: 120, height: 40 },
      },
      bounds: { width: 800, height: 600 },
    });

    const popover = screen.getByTestId('comment-popover');
    const top = Number.parseInt(popover.style.top, 10);

    expect(top).toBeLessThanOrEqual(266);
    expect(Number.parseInt(popover.style.maxHeight, 10)).toBeGreaterThan(0);
  });
});
