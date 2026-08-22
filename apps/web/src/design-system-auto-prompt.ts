export const DESIGN_SYSTEM_WORKSPACE_PROMPT_PREFIX =
  'Create this project as a complete Readable Studio design system workspace.';

export const DESIGN_SYSTEM_WORKSPACE_DISPLAY_TITLE =
  'Creating design system workspace';

export const DESIGN_SYSTEM_WORKSPACE_DISPLAY_DESCRIPTION =
  'Readable Studio is using the setup sources to generate this project.';

export function isDesignSystemWorkspacePrompt(content: string): boolean {
  return content.trimStart().startsWith(DESIGN_SYSTEM_WORKSPACE_PROMPT_PREFIX);
}
