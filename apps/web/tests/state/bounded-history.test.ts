import { afterEach, expect, it, vi } from 'vitest';
import { listMessages, loadMessagePage } from '../../src/state/projects';

afterEach(() => vi.unstubAllGlobals());

it('loads every history page through advancing cursors instead of the whole-history route', async () => {
  // Given: three pages whose cursor is not the number of returned messages.
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async input => {
    const url = String(input);
    requests.push(url);
    const cursor = new URL(url, 'http://localhost').searchParams.get('afterPosition');
    if (!url.includes('/messages/page')) return new Response('legacy forbidden', { status: 410 });
    const index = cursor === '-1' ? 0 : cursor === '7' ? 1 : 2;
    return Response.json({ messages: [{ id: `m${index}`, role: 'user', content: `${index}` }], nextPosition: [7, 19, null][index] });
  }));
  // When: the existing live conversation loader is called.
  const messages = await listMessages('p', 'c');
  // Then: all rows are retained, in order, without the legacy request.
  expect(messages.map(message => message.id)).toEqual(['m0', 'm1', 'm2']);
  expect(requests).toHaveLength(3);
  expect(requests[2]).toContain('afterPosition=19');
});

it('restores oversized UTF-8 bodies, metadata and partial streamed text before continuing history', async () => {
  // Given: the wire splits a multibyte character across two bounded fragments.
  const content = Buffer.from('한글🙂');
  const parts = [
    { field: 'role', encoding: 'text', data: Buffer.from('user').toString('base64'), endField: true },
    { field: 'content', encoding: 'text', data: content.subarray(0, 2).toString('base64'), endField: false },
    { field: 'content', encoding: 'text', data: content.subarray(2).toString('base64'), endField: true },
    { field: 'event', encoding: 'json', data: Buffer.from(JSON.stringify({ kind: 'text', text: ' partial' })).toString('base64'), endField: true },
    { field: 'attachments', encoding: 'json', data: Buffer.from(JSON.stringify([{ name: 'file.html' }])).toString('base64'), endField: true },
  ];
  let index = 0;
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async input => {
    if (String(input).includes('/parts?')) {
      const part = parts[index++];
      return Response.json({ ...part, nextCursor: index < parts.length ? `${index}:0:0` : null });
    }
    return Response.json({ messages: [], oversizedMessageId: 'huge', nextPosition: null });
  }));
  // When: the same live history loader encounters an oversized row.
  const messages = await listMessages('p', 'c');
  // Then: no body, attachment, role or streamed text is replaced with a placeholder.
  expect(messages).toEqual([{ id: 'huge', role: 'user', content: '한글🙂 partial',
    events: [{ kind: 'text', text: ' partial' }], attachments: [{ name: 'file.html' }] }]);
});

it('requests older pages using the server position rather than array length', async () => {
  // Given: the newest visible page starts at position 701.
  const request = vi.fn<typeof fetch>(async () => Response.json({ messages: [], nextPosition: 600 }));
  vi.stubGlobal('fetch', request);
  // When: the scroll consumer asks for its preceding page.
  const page = await loadMessagePage('p', 'c', { beforePosition: 701 });
  // Then: the exact server cursor is sent and retained for the next prepend.
  expect(request).toHaveBeenCalledWith('/api/projects/p/conversations/c/messages/page?beforePosition=701');
  expect(page.nextPosition).toBe(600);
});

it('rejects a failed page rather than silently losing the rest of the conversation', async () => {
  // Given: an unavailable history endpoint.
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('unavailable', { status: 503 })));
  // When / Then: the caller receives a visible failure, not an empty conversation.
  await expect(listMessages('p', 'c')).rejects.toThrow();
});
