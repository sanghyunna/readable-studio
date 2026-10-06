// Hub template card -> hidden brief composition.
//
// Picking a template card no longer pastes the template's brief into the
// composer; the brief rides along invisibly and is prepended to the user's
// own words when the message is sent. The project remembers the split
// (`ProjectMetadata.templateRef.boundary`) so the chat bubble can show the
// template chip plus only the user's text after a reload.

import type { ProjectTemplateRef } from '@readable-studio/contracts';

export interface HiddenTemplate {
  id: string;
  name: string;
  text: string;
}

const TEMPLATE_USER_SEPARATOR = '\n\n';

/** Naming surfaces must never use the hidden brief, even for a chip-only send. */
export function visiblePromptForNaming(
  content: string,
  ref: ProjectTemplateRef | null | undefined,
): string {
  if (!ref) return content;
  return userTextFromTemplateMessage(content, ref)?.trim() || ref.name;
}

/** The sent prompt: template brief, then the user's words (when any). */
export function composeTemplatePrompt(templateText: string, userText: string): string {
  const trimmedUser = userText.trim();
  if (!trimmedUser) return templateText;
  return `${templateText}${TEMPLATE_USER_SEPARATOR}${trimmedUser}`;
}

/** Character offset where the user's own words start inside the sent prompt. */
export function templatePromptBoundary(templateText: string, userText: string): number {
  return userText.trim()
    ? templateText.length + TEMPLATE_USER_SEPARATOR.length
    : templateText.length;
}

/**
 * The user-visible part of a stored message that was sent with a template.
 * Returns null when the ref does not fit the content (older or foreign
 * messages), in which case the bubble renders the full content as before.
 */
export function userTextFromTemplateMessage(
  content: string,
  ref: ProjectTemplateRef | null | undefined,
): string | null {
  if (!ref) return null;
  if (!Number.isInteger(ref.boundary) || ref.boundary < 0 || ref.boundary > content.length) {
    return null;
  }
  return content.slice(ref.boundary);
}
