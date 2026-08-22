// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  isManualEditNudgeBlocked,
  isManualEditNudgeKey,
  isManualEditNudgeNetZero,
  manualEditMoveAnnouncementSegments,
  manualEditNudgeDelta,
  manualEditNudgeDeltaFromDirection,
} from '../../src/edit-mode/keyboard-move';

describe('keyboard-move helpers', () => {
  describe('isManualEditNudgeKey', () => {
    it.each(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'] as const)(
      'accepts %s as a nudge key',
      (key) => {
        expect(isManualEditNudgeKey(key)).toBe(true);
      },
    );

    it.each(['Enter', 'Escape', 'a', 'Tab', 'ArrowLeftAlt'])('rejects %s', (key) => {
      expect(isManualEditNudgeKey(key)).toBe(false);
    });
  });

  describe('manualEditNudgeDelta', () => {
    it.each([
      ['ArrowLeft', { x: -1, y: 0 }],
      ['ArrowRight', { x: 1, y: 0 }],
      ['ArrowUp', { x: 0, y: -1 }],
      ['ArrowDown', { x: 0, y: 1 }],
    ] as const)('maps %s to %o', (key, expected) => {
      expect(manualEditNudgeDelta(key)).toEqual(expected);
    });
  });

  describe('manualEditNudgeDeltaFromDirection', () => {
    it.each([
      ['left', { x: -1, y: 0 }],
      ['right', { x: 1, y: 0 }],
      ['up', { x: 0, y: -1 }],
      ['down', { x: 0, y: 1 }],
    ] as const)('maps %s to %o', (direction, expected) => {
      expect(manualEditNudgeDeltaFromDirection(direction)).toEqual(expected);
    });
  });

  describe('isManualEditNudgeBlocked', () => {
    it('blocks native text/form controls', () => {
      const input = document.createElement('input');
      const textarea = document.createElement('textarea');
      const select = document.createElement('select');
      expect(isManualEditNudgeBlocked(input)).toBe(true);
      expect(isManualEditNudgeBlocked(textarea)).toBe(true);
      expect(isManualEditNudgeBlocked(select)).toBe(true);
    });

    it('blocks contenteditable elements', () => {
      const editable = document.createElement('div');
      editable.setAttribute('contenteditable', 'true');
      expect(isManualEditNudgeBlocked(editable)).toBe(true);

      const plaintext = document.createElement('div');
      plaintext.setAttribute('contenteditable', 'plaintext-only');
      expect(isManualEditNudgeBlocked(plaintext)).toBe(true);
    });

    it('blocks children inside a contenteditable ancestor', () => {
      const host = document.createElement('div');
      host.setAttribute('contenteditable', 'true');
      const child = document.createElement('span');
      host.appendChild(child);
      expect(isManualEditNudgeBlocked(child)).toBe(true);
    });

    it('blocks ARIA widget roles and their descendants', () => {
      const slider = document.createElement('div');
      slider.setAttribute('role', 'slider');
      expect(isManualEditNudgeBlocked(slider)).toBe(true);

      for (const role of ['textbox', 'searchbox', 'scrollbar']) {
        const el = document.createElement('div');
        el.setAttribute('role', role);
        expect(isManualEditNudgeBlocked(el)).toBe(true);
      }

      const listbox = document.createElement('div');
      listbox.setAttribute('role', 'listbox');
      const option = document.createElement('div');
      listbox.appendChild(option);
      expect(isManualEditNudgeBlocked(option)).toBe(true);
    });

    it('allows normal elements and the body', () => {
      expect(isManualEditNudgeBlocked(document.body)).toBe(false);
      expect(isManualEditNudgeBlocked(document.createElement('div'))).toBe(false);
      expect(isManualEditNudgeBlocked(document.createElement('button'))).toBe(false);
      expect(isManualEditNudgeBlocked(document.createElement('a'))).toBe(false);
    });

    it('blocks while IME composition is active', () => {
      const div = document.createElement('div');
      expect(isManualEditNudgeBlocked(div, { isComposing: true })).toBe(true);
    });

    it('allows null targets', () => {
      expect(isManualEditNudgeBlocked(null)).toBe(false);
    });
  });

  describe('isManualEditNudgeNetZero', () => {
    it('returns true only for a zero delta', () => {
      expect(isManualEditNudgeNetZero({ x: 0, y: 0 })).toBe(true);
      expect(isManualEditNudgeNetZero({ x: 1, y: 0 })).toBe(false);
      expect(isManualEditNudgeNetZero({ x: 0, y: -1 })).toBe(false);
      expect(isManualEditNudgeNetZero({ x: 1, y: 1 })).toBe(false);
    });
  });

  describe('manualEditMoveAnnouncementSegments', () => {
    it('describes a diagonal move as two segments', () => {
      expect(manualEditMoveAnnouncementSegments({ x: 3, y: -2 })).toEqual([
        { axis: 'x', amount: 3, key: 'manualEdit.move.right' },
        { axis: 'y', amount: 2, key: 'manualEdit.move.up' },
      ]);
    });

    it('describes a left-only move', () => {
      expect(manualEditMoveAnnouncementSegments({ x: -5, y: 0 })).toEqual([
        { axis: 'x', amount: 5, key: 'manualEdit.move.left' },
      ]);
    });

    it('returns an empty array for a net-zero move', () => {
      expect(manualEditMoveAnnouncementSegments({ x: 0, y: 0 })).toEqual([]);
    });
  });
});
