/** Stable ids for the product prompt bodies users may override. */
export type EditableSystemPromptId =
  | 'designer-charter'
  | 'discovery-workflow'
  | 'deck-framework';

export interface EditableSystemPrompt {
  id: EditableSystemPromptId;
  label: string;
  description: string;
  /** Current template content: the user override when present, otherwise the shipped default. */
  content: string;
  /** The immutable product default shipped with this version. */
  defaultContent: string;
  overridden: boolean;
  /** Slots that must occur exactly once in any override. */
  requiredPlaceholders: string[];
}

export interface SystemPromptsResponse {
  prompts: EditableSystemPrompt[];
}

export interface SystemPromptResponse {
  prompt: EditableSystemPrompt;
}

export interface UpdateSystemPromptRequest {
  content: string;
}

export interface SystemPromptValidationError {
  error: {
    code: 'INVALID_SYSTEM_PROMPT';
    message: string;
    missingPlaceholders: string[];
    duplicatePlaceholders: string[];
  };
}
