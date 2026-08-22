// Agent-initiated rollback request marker detection.
//
// The agent requests a self-rollback by emitting a marker in its streamed text:
//
//   <readable-rollback-request mode="files_only" reason="I accidentally deleted the hero section" />
//
// The marker is stripped from user-visible output and converted into a structured
// `rollback_request` SSE event. The actual restore still requires explicit user
// confirmation; the marker is only a request.

import type { RollbackMode } from '@readable-studio/contracts';

export interface DetectedRollbackRequest {
  mode: RollbackMode;
  reason: string;
}

const ROLLBACK_MODE_VALUES = new Set<RollbackMode>([
  'files_only',
  'chat_only',
  'files_and_chat',
]);

const ROLLBACK_REQUEST_OPEN_RE = /<readable-rollback-request\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/i;
const ROLLBACK_REQUEST_CLOSE_RE = /<\/readable-rollback-request>/i;
const ROLLBACK_REQUEST_OPEN_RE_G = /<readable-rollback-request\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
const ROLLBACK_REQUEST_CLOSE_RE_G = /<\/readable-rollback-request>/gi;
const ROLLBACK_REQUEST_OPEN_START_RE = /<readable-rollback-request\b/i;
const MODE_DQ_RE = /\bmode\s*=\s*"([^"]+)"/i;
const MODE_SQ_RE = /\bmode\s*=\s*'([^']+)'/i;
const REASON_DQ_RE = /\breason\s*=\s*"([^"]*)"/i;
const REASON_SQ_RE = /\breason\s*=\s*'([^']*)'/i;

/** Maximum bytes to buffer while waiting for a marker that spans chunks. */
const MAX_ROLLBACK_BUFFER_BYTES = 64 * 1024;

function parseRollbackMode(value: string): RollbackMode | null {
  const candidate = value.trim() as RollbackMode;
  return ROLLBACK_MODE_VALUES.has(candidate) ? candidate : null;
}

/**
 * Detect the first well-formed `<readable-rollback-request>` marker in `text`.
 * Returns the requested mode and reason, or `null` if no valid marker is found.
 */
export function detectAgentRollbackRequest(text: string): DetectedRollbackRequest | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const openMatch = ROLLBACK_REQUEST_OPEN_RE.exec(text);
  if (!openMatch) return null;
  const openTag = openMatch[0] ?? '';
  const modeMatch = MODE_DQ_RE.exec(openTag) ?? MODE_SQ_RE.exec(openTag);
  const mode = modeMatch?.[1] ? parseRollbackMode(modeMatch[1]) : null;
  if (!mode) return null;
  const reasonMatch = REASON_DQ_RE.exec(openTag) ?? REASON_SQ_RE.exec(openTag);
  const reason = reasonMatch?.[1] ?? '';
  return { mode, reason };
}

/**
 * Remove all `<readable-rollback-request>` markers (self-closing or with an explicit
 * close tag) from `text` so they never reach the user-visible chat buffer.
 */
export function stripAgentRollbackRequestMarkers(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text
    .replace(ROLLBACK_REQUEST_OPEN_RE_G, '')
    .replace(ROLLBACK_REQUEST_CLOSE_RE_G, '');
}

export interface StreamingRollbackResult {
  /** Text that is safe to emit to the user (no incomplete marker prefix). */
  visible: string;
  /** Newly detected rollback requests found in this chunk. */
  requests: DetectedRollbackRequest[];
}

/**
 * Stateful detector that handles `<readable-rollback-request>` markers split across
 * stream chunks. It buffers a small amount of trailing text so a marker that
 * starts near a chunk boundary is still detected, and it never emits text that
 * is part of an incomplete marker.
 */
export class RollingAgentRollbackDetector {
  private buffer = '';

  /**
   * Process a new text chunk. Returns visible text (with any complete markers
   * stripped) and any newly detected requests. The caller should emit only the
   * returned `visible` text, not the original chunk.
   */
  process(chunk: string): StreamingRollbackResult {
    if (typeof chunk !== 'string') return { visible: '', requests: [] };
    this.buffer += chunk;

    // Prevent unbounded buffering if a marker is never completed.
    if (this.buffer.length > MAX_ROLLBACK_BUFFER_BYTES) {
      const flushed = this.flush();
      return { visible: flushed, requests: [] };
    }

    const requests: DetectedRollbackRequest[] = [];
    let cursor = 0;
    while (true) {
      const slice = this.buffer.slice(cursor);
      const match = ROLLBACK_REQUEST_OPEN_RE.exec(slice);
      if (!match) break;
      const tag = match[0] ?? '';
      const modeMatch = MODE_DQ_RE.exec(tag) ?? MODE_SQ_RE.exec(tag);
      const mode = modeMatch?.[1] ? parseRollbackMode(modeMatch[1]) : null;
      if (mode) {
        const reasonMatch = REASON_DQ_RE.exec(tag) ?? REASON_SQ_RE.exec(tag);
        requests.push({ mode, reason: reasonMatch?.[1] ?? '' });
      }
      cursor += match.index + match[0].length;
    }
    this.buffer = stripAgentRollbackRequestMarkers(this.buffer);

    const visible = this.flushSafePrefix();
    return { visible, requests };
  }

  /**
   * Flush any remaining buffered text at the end of the stream. Any incomplete
   * marker prefix is stripped so it never reaches the user.
   */
  flush(): string {
    const openIdx = this.buffer.search(ROLLBACK_REQUEST_OPEN_START_RE);
    const result = openIdx === -1
      ? this.buffer
      : this.buffer.slice(0, openIdx);
    this.buffer = '';
    return result;
  }

  private flushSafePrefix(): string {
    const openMatch = ROLLBACK_REQUEST_OPEN_START_RE.exec(this.buffer);
    if (!openMatch) {
      // No potential marker start. Keep a trailing '<' in case the next chunk
      // starts a marker, but only if it is close to the end.
      const lastLt = this.buffer.lastIndexOf('<');
      if (lastLt !== -1 && lastLt >= this.buffer.length - 200) {
        const visible = this.buffer.slice(0, lastLt);
        this.buffer = this.buffer.slice(lastLt);
        return visible;
      }
      const visible = this.buffer;
      this.buffer = '';
      return visible;
    }

    // There is a potential marker start; emit only the text before it.
    const visible = this.buffer.slice(0, openMatch.index);
    this.buffer = this.buffer.slice(openMatch.index);
    return visible;
  }
}
