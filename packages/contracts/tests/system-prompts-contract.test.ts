import { describe, expect, it } from 'vitest';
import type {
  EditableSystemPrompt,
  SystemPromptResponse,
  SystemPromptsResponse,
  UpdateSystemPromptRequest,
} from '../src/api/system-prompts.js';

describe('system prompt API contracts', () => {
  it('models list, detail, update, and reset response shapes', () => {
    const prompt = {
      id: 'discovery-workflow',
      label: 'Discovery and artifact workflow',
      description: 'Controls discovery.',
      content: 'custom {{DIRECTION_LIBRARY}}',
      defaultContent: 'default {{DIRECTION_LIBRARY}}',
      overridden: true,
      requiredPlaceholders: ['{{DIRECTION_LIBRARY}}'],
    } satisfies EditableSystemPrompt;
    const list = { prompts: [prompt] } satisfies SystemPromptsResponse;
    const detail = { prompt } satisfies SystemPromptResponse;
    const update = { content: prompt.content } satisfies UpdateSystemPromptRequest;

    expect(list.prompts[0]).toBe(detail.prompt);
    expect(update.content).toContain(prompt.requiredPlaceholders[0]);
  });
});
