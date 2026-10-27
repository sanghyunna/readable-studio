import { expect, test } from 'vitest';
import { nativeMessagesRequest } from '../../src/databricks/gateway-surfaces.js';
import { messagesRequest, messagesResponse, MessagesChatStream } from '../../src/databricks/messages.js';

test('Messages recovery retains reading lessons and tool results through subsequent steers', () => {
  const history = [
    { role: 'developer', content: 'Use the attached MD and deck template.' },
    { role: 'user', content: 'Create the deck.' },
    { role: 'assistant', content: 'Read the source.', reasoning_content: 'POWERSHELL_WARNING: use read for UTF-8.',
      tool_calls: [{ id: 'call_read', type: 'function', function: { name: 'read', arguments: '{"path":"source.md"}' } }] },
    { role: 'tool', tool_call_id: 'call_read', content: 'READ_UTF8_SUCCESS: 한글 원문' },
    { role: 'assistant', content: 'The source has been read.' },
    { role: 'user', content: 'STEER_1: Continue.' },
    { role: 'assistant', content: 'Continuing the deck.' },
    { role: 'user', content: 'STEER_2: Revise the deck.' },
  ];
  for (const length of [5, 6, 8]) {
    const wire = messagesRequest({ model: 'fixture', messages: history.slice(0, length) });
    expect(wire.system).toEqual([{ type: 'text', text: 'Use the attached MD and deck template.' }]);
    const messages = wire.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages[1]?.content).toEqual([
      { type: 'text', text: 'POWERSHELL_WARNING: use read for UTF-8.' },
      { type: 'text', text: 'Read the source.' },
      { type: 'tool_use', id: 'call_read', name: 'read', input: { path: 'source.md' } },
    ]);
    expect(messages[2]?.content).toEqual([{ type: 'tool_result', tool_use_id: 'call_read', content: 'READ_UTF8_SUCCESS: 한글 원문' }]);
    expect(JSON.stringify(wire).split('READ_UTF8_SUCCESS')).toHaveLength(2);
  }
});

test('Messages recovery round-trips readable thinking without inventing or reusing signatures', () => {
  const response = messagesResponse({ type: 'message', id: 'msg_fixture', model: 'fixture', stop_reason: 'tool_use', content: [
    { type: 'thinking', thinking: 'Use the successfully read source.', signature: 'native-signature' },
    { type: 'tool_use', id: 'call_read', name: 'read', input: { path: 'source.md' } },
  ] });
  const message = (response.choices as Array<{ message: unknown }>)[0]!.message;
  const wire = messagesRequest({ model: 'fixture', messages: [message] });
  expect(wire.messages).toEqual([{ role: 'assistant', content: [
    { type: 'text', text: 'Use the successfully read source.' },
    { type: 'tool_use', id: 'call_read', name: 'read', input: { path: 'source.md' } },
  ] }]);
  expect(JSON.stringify(wire)).not.toContain('native-signature');
});

test('native Messages preserves supplied thinking signatures and tool history', () => {
  const messages = [
    { role: 'assistant', content: [
      { type: 'thinking', thinking: 'The source is already read.', signature: 'native-signature' },
      { type: 'tool_use', id: 'call_read', name: 'read', input: { path: 'source.md' } },
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_read', content: '한글 원문' }] },
  ];
  expect(nativeMessagesRequest({ model: 'fixture', messages }).messages).toEqual(messages);
});

test.each(['reasoning_content', 'reasoning', 'reasoning_text'])('Messages recovery preserves the Pi-supported %s field once', field => {
  const wire = messagesRequest({ model: 'fixture', messages: [{ role: 'assistant', content: null, [field]: 'READ_LESSON' }] });
  expect(wire.messages).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'READ_LESSON' }] }]);
});

test('Messages recovery uses the first non-empty reasoning alias without duplication', () => {
  const wire = messagesRequest({ model: 'fixture', messages: [{ role: 'assistant', content: null,
    reasoning_content: '', reasoning: 'READ_LESSON', reasoning_text: 'READ_LESSON' }] });
  expect(wire.messages).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'READ_LESSON' }] }]);
});

test('translated streaming thinking remains readable when sent back through Messages recovery', () => {
  const stream = new MessagesChatStream();
  const chunks = [
    { type: 'message_start', message: { id: 'msg_fixture', model: 'fixture' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Read UTF-8 successfully.' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'native-signature' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ].flatMap(frame => stream.push(frame));
  const reasoning = chunks.filter((chunk): chunk is Record<string, unknown> => chunk !== '[DONE]')
    .flatMap(chunk => (chunk.choices as Array<{ delta: { reasoning_content?: string } }>).map(choice => choice.delta.reasoning_content ?? '')).join('');
  const wire = messagesRequest({ model: 'fixture', messages: [{ role: 'assistant', content: null, reasoning_content: reasoning }] });
  expect(wire.messages).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'Read UTF-8 successfully.' }] }]);
  expect(JSON.stringify(wire)).not.toContain('native-signature');
});
