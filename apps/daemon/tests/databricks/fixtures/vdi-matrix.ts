export const fixture = {
  provenance: 'Owner-supplied corporate workspace observations, 2026-09-17. Response envelopes below are redacted reconstructions, not raw captures.',
  model: 'system.ai.claude-sonnet-5',
  control: 'system.ai.gpt-oss-120b',
  metadata404: { error_code: 'RESOURCE_DOES_NOT_EXIST', message: 'Serving endpoint does not exist' },
  rejected: { error_code: 'INVALID_PARAMETER_VALUE', message: 'Rejected parameter: tools' },
  chat: {
    id: 'chat_fixture',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  },
  messages: {
    id: 'msg_fixture',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'OK' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 11, output_tokens: 2 },
  },
} as const;
