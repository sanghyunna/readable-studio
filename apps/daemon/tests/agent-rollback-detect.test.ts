import { describe, expect, it } from 'vitest';
import {
  detectAgentRollbackRequest,
  RollingAgentRollbackDetector,
  stripAgentRollbackRequestMarkers,
} from '../src/agent-rollback-detect.js';

describe('agent rollback marker detection', () => {
  it('detects a valid self-closing marker with mode and reason', () => {
    const result = detectAgentRollbackRequest(
      '<readable-rollback-request mode="files_only" reason="I accidentally deleted the hero section" />',
    );
    expect(result).toEqual({
      mode: 'files_only',
      reason: 'I accidentally deleted the hero section',
    });
  });

  it('detects a closed </readable-rollback-request> variant', () => {
    const result = detectAgentRollbackRequest(
      '<readable-rollback-request mode="chat_only" reason="Wrong answer">-extra-</readable-rollback-request>',
    );
    expect(result).toEqual({
      mode: 'chat_only',
      reason: 'Wrong answer',
    });
  });

  it('returns null for no marker', () => {
    expect(detectAgentRollbackRequest('Nothing to see here.')).toBeNull();
    expect(detectAgentRollbackRequest('')).toBeNull();
  });

  it('returns null for invalid mode', () => {
    expect(
      detectAgentRollbackRequest('<readable-rollback-request mode="everything" reason="oops" />'),
    ).toBeNull();
  });

  it('strips one or multiple markers while preserving surrounding text', () => {
    expect(
      stripAgentRollbackRequestMarkers(
        'Before <readable-rollback-request mode="files_only" reason="x" /> after',
      ),
    ).toBe('Before  after');

    expect(
      stripAgentRollbackRequestMarkers(
        'A <readable-rollback-request mode="chat_only" /> B <readable-rollback-request mode="files_and_chat"></readable-rollback-request> C',
      ),
    ).toBe('A  B  C');
  });

  it('handles XML attribute order variations', () => {
    const result = detectAgentRollbackRequest(
      '<readable-rollback-request reason="out of order" mode="files_and_chat" />',
    );
    expect(result).toEqual({
      mode: 'files_and_chat',
      reason: 'out of order',
    });
  });

  it('preserves double quotes inside a single-quoted reason', () => {
    const result = detectAgentRollbackRequest(
      `<readable-rollback-request mode="files_only" reason='I overwrote the "main" file' />`,
    );
    expect(result).toEqual({
      mode: 'files_only',
      reason: 'I overwrote the "main" file',
    });
  });

  it('parses and strips a greater-than sign inside a quoted reason', () => {
    const text = 'Before <readable-rollback-request mode="files_only" reason="expected > actual" /> after';
    expect(detectAgentRollbackRequest(text)).toEqual({
      mode: 'files_only',
      reason: 'expected > actual',
    });
    expect(stripAgentRollbackRequestMarkers(text)).toBe('Before  after');

    const detector = new RollingAgentRollbackDetector();
    expect(detector.process(text)).toEqual({
      visible: 'Before  after',
      requests: [{ mode: 'files_only', reason: 'expected > actual' }],
    });
  });

  it('returns an empty reason when the attribute is omitted', () => {
    const result = detectAgentRollbackRequest('<readable-rollback-request mode="files_only" />');
    expect(result).toEqual({
      mode: 'files_only',
      reason: '',
    });
  });

  describe('RollingAgentRollbackDetector', () => {
    it('detects a marker split across multiple chunks', () => {
      const detector = new RollingAgentRollbackDetector();
      const r1 = detector.process('Before <readable-rollback');
      expect(r1.visible).toBe('Before ');
      expect(r1.requests).toHaveLength(0);

      const r2 = detector.process('-request mode="files_only" reason="split" /> after');
      expect(r2.requests).toEqual([{ mode: 'files_only', reason: 'split' }]);
      expect(r2.visible).toBe(' after');
    });

    it('emits trailing text only after a marker completes', () => {
      const detector = new RollingAgentRollbackDetector();
      const r1 = detector.process('Start <readable-rollback-request mode="chat_only"');
      expect(r1.visible).toBe('Start ');
      expect(r1.requests).toHaveLength(0);

      const r2 = detector.process(' reason="x" /> End');
      expect(r2.requests).toEqual([{ mode: 'chat_only', reason: 'x' }]);
      expect(r2.visible).toBe(' End');
    });

    it('strips markers from visible output and preserves surrounding text', () => {
      const detector = new RollingAgentRollbackDetector();
      const r = detector.process('Hello <readable-rollback-request mode="files_only" /> world');
      expect(r.requests).toEqual([{ mode: 'files_only', reason: '' }]);
      expect(r.visible).toBe('Hello  world');
    });

    it('detects a marker in each independent chunk (one per process call)', () => {
      const detector = new RollingAgentRollbackDetector();
      const r1 = detector.process('<readable-rollback-request mode="files_only" />');
      expect(r1.requests).toHaveLength(1);
      const r2 = detector.process('<readable-rollback-request mode="chat_only" />');
      expect(r2.requests).toHaveLength(1);
    });

    it('flushes remaining text without leaking an incomplete marker', () => {
      const detector = new RollingAgentRollbackDetector();
      const r = detector.process('Before <readable-rollback-request mode="files_only"');
      expect(r.visible).toBe('Before ');
      expect(detector.flush()).toBe('');
    });

    it('flushes a normal terminal tail that only looks like a marker prefix', () => {
      const detector = new RollingAgentRollbackDetector();
      expect(detector.process('comparison: 1 <').visible).toBe('comparison: 1 ');
      expect(detector.flush()).toBe('<');
    });

    it('handles multiple markers in one chunk', () => {
      const detector = new RollingAgentRollbackDetector();
      const r = detector.process(
        'A <readable-rollback-request mode="files_only" /> B <readable-rollback-request mode="chat_only" /> C',
      );
      expect(r.requests).toEqual([
        { mode: 'files_only', reason: '' },
        { mode: 'chat_only', reason: '' },
      ]);
      expect(r.visible).toBe('A  B  C');
    });
  });
});
