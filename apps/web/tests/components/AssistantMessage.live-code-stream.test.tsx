// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AssistantMessage } from '../../src/components/AssistantMessage';
import type { ChatMessage } from '../../src/types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Frozen copy of the original whole-string scan. The live card must keep
// rendering exactly what this returns for every streamed prefix.
function referenceExtract(raw: string, field: string): string | null {
  const marker = `"${field}"`;
  const mi = raw.indexOf(marker);
  if (mi === -1) return null;
  let i = mi + marker.length;
  while (i < raw.length && raw[i] !== '"') i++;
  if (i >= raw.length) return null;
  i++;
  let out = '';
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === '\\') {
      const next = raw[i + 1];
      if (next === undefined) break;
      switch (next) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'u': {
          const hex = raw.slice(i + 2, i + 6);
          if (hex.length < 4) return out;
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        default: out += next;
      }
      i += 2;
      continue;
    }
    if (ch === '"') break;
    out += ch;
    i++;
  }
  return out;
}

function expectedCard(raw: string) {
  const file = referenceExtract(raw, 'file_path') ?? referenceExtract(raw, 'filePath') ?? referenceExtract(raw, 'path') ?? '';
  return {
    meta: file ? file.split('/').pop() ?? file : '',
    code: referenceExtract(raw, 'content') ?? referenceExtract(raw, 'new_string') ?? '',
  };
}

const streamingMessage: ChatMessage = {
  id: 'assistant-1',
  role: 'assistant',
  content: '',
  events: [],
  runStatus: 'running',
  startedAt: 1,
};

function liveCard(container: HTMLElement) {
  const box = container.querySelector('.live-code-box');
  return {
    present: box !== null,
    title: box?.querySelector('.op-title')?.textContent ?? null,
    meta: box?.querySelector('.op-meta')?.textContent ?? '',
    code: box?.querySelector('.live-code-pre code')?.textContent ?? '',
  };
}

function streamPrefixes(name: string, raw: string, step: (index: number) => number = () => 1) {
  const view = render(
    <AssistantMessage message={streamingMessage} streaming projectId={null} liveToolInput={{}} />,
  );
  const seen: Array<{ raw: string; card: ReturnType<typeof liveCard> }> = [];
  for (let end = 0, k = 0; end < raw.length; k++) {
    end = Math.min(raw.length, end + step(k));
    const prefix = raw.slice(0, end);
    view.rerender(
      <AssistantMessage
        message={streamingMessage}
        streaming
        projectId={null}
        liveToolInput={{ 'tool-1': { name, text: prefix, seq: 0 } }}
      />,
    );
    seen.push({ raw: prefix, card: liveCard(view.container) });
  }
  return { view, seen };
}

const WRITE_RAW =
  '{"file_path":"/work/site/pages/index.html","content":"<!doctype html>\\n<p class=\\"lead\\">Caf\\u00e9 \\\\ tab\\there\\r\\n' +
  '\\u0048\\u0069 \\/ \\b\\f end</p>\\n<script>const s = \\"a\\\\\\"b\\";</script>"}';

describe('LiveCodeBox streaming display', () => {
  it('renders the decoded code and file name for every streamed prefix of a Write call', () => {
    const { seen } = streamPrefixes('Write', WRITE_RAW);
    expect(seen.length).toBe(WRITE_RAW.length);
    for (const { raw, card } of seen) {
      const expected = expectedCard(raw);
      expect(card.present).toBe(true);
      expect(card.title).toBe('Write');
      expect({ raw, meta: card.meta, code: card.code }).toEqual({ raw, ...expected });
    }
    // The finished value is the full decoded document.
    expect(seen.at(-1)?.card.code).toBe(
      '<!doctype html>\n<p class="lead">Café \\ tab\there\r\nHi / \b\f end</p>\n<script>const s = "a\\"b";</script>',
    );
    expect(seen.at(-1)?.card.meta).toBe('index.html');
  });

  it('matches the whole-string scan for Edit inputs, field fallbacks and multi-char deltas', () => {
    const cases: Array<[string, string]> = [
      ['Edit', '{"filePath":"src/a.css","old_string":"x","new_string":"y\\n\\"z\\" \\u00e9 \\u00"}'],
      ['MultiEdit', '{"path":"notes.txt","content":"abc","other":"zzz"}'],
      // A value that happens to equal a later key name is matched first, as before.
      ['Write', '{"file_path":"content","content":"real body"}'],
      ['Write', '{ "file_path" :  "dir/x.html" , "content" : "spaced\\tvalue"}'],
    ];
    for (const [name, raw] of cases) {
      for (const width of [1, 2, 3, 5, 7]) {
        cleanup();
        const { seen } = streamPrefixes(name, raw, () => width);
        for (const { raw: prefix, card } of seen) {
          const expected = expectedCard(prefix);
          expect({ prefix, meta: card.meta, code: card.code }).toEqual({ prefix, ...expected });
        }
      }
    }
  });

  it('recomputes from scratch when the live input is replaced rather than extended', () => {
    const first = '{"file_path":"a.html","content":"one two three"}';
    const second = '{"file_path":"b.html","content":"uno"}';
    const view = render(
      <AssistantMessage message={streamingMessage} streaming projectId={null}
        liveToolInput={{ 'tool-1': { name: 'Write', text: first, seq: 0 } }} />,
    );
    expect(liveCard(view.container)).toMatchObject({ meta: 'a.html', code: 'one two three' });
    for (const raw of [second, second.slice(0, 20), first.slice(0, 30), first]) {
      view.rerender(
        <AssistantMessage message={streamingMessage} streaming projectId={null}
          liveToolInput={{ 'tool-1': { name: 'Write', text: raw, seq: 0 } }} />,
      );
      expect(liveCard(view.container)).toMatchObject(expectedCard(raw));
    }
  });

  it('hands the card over to the settled tool card once tool_use lands', () => {
    const view = render(
      <AssistantMessage message={streamingMessage} streaming projectId={null}
        liveToolInput={{ 'tool-1': { name: 'Write', text: WRITE_RAW, seq: 0 } }} />,
    );
    expect(liveCard(view.container).present).toBe(true);
    const settled: ChatMessage = {
      ...streamingMessage,
      events: [{ kind: 'tool_use', id: 'tool-1', name: 'Write', input: { file_path: '/work/site/pages/index.html', content: '<p>x</p>' } }],
    };
    view.rerender(
      <AssistantMessage message={settled} streaming projectId={null}
        liveToolInput={{ 'tool-1': { name: 'Write', text: WRITE_RAW, seq: 0 } }} />,
    );
    expect(liveCard(view.container).present).toBe(false);
  });

  it('decodes each streamed escape once instead of rescanning the whole value per delta', () => {
    // Cost counter: every \\uXXXX escape costs one String.fromCharCode call
    // when decoded. A whole-string rescan per delta decodes N(N+1)/2 escapes.
    const escapes = 150;
    const head = '{"file_path":"k.html","content":"';
    const view = render(
      <AssistantMessage message={streamingMessage} streaming projectId={null}
        liveToolInput={{ 'tool-1': { name: 'Write', text: head, seq: 0 } }} />,
    );
    const fromCharCode = vi.spyOn(String, 'fromCharCode');
    let raw = head;
    for (let k = 0; k < escapes; k++) {
      raw += '\\uAC00';
      view.rerender(
        <AssistantMessage message={streamingMessage} streaming projectId={null}
          liveToolInput={{ 'tool-1': { name: 'Write', text: raw, seq: 0 } }} />,
      );
    }
    expect(liveCard(view.container).code).toBe('가'.repeat(escapes));
    expect(fromCharCode.mock.calls.length).toBeLessThanOrEqual(escapes * 2);
  });
});
