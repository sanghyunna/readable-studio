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

function templateReferencePrefix(templateText: string): string {
  // Quote source text so headings/closing tags inside a future template cannot
  // masquerade as the user's request. Keep all framing before the display split.
  const reference = JSON.stringify({ text: templateText }).replaceAll('<', '\\u003c');
  return [
    '<readable-template-reference role="structure-and-visual-style-only">',
    reference,
    '</readable-template-reference>',
    '',
    'Use the template and seeded example files only for structure and visual style. Never copy their example names, numbers, people, products, or claims. Only my request below and my attachments supply content and data. Adapt subject-specific template slots to my domain or drop them; never demand the template\'s own subject-specific inputs. Judge completeness only against my requested document, not the example subject. If my own content is insufficient, ask through <question-form> rather than inventing content.',
    '',
    '<readable-user-content-source/>',
    '',
    '',
  ].join('\n');
}

/** Naming surfaces must never use the hidden brief, even for a chip-only send. */
export function visiblePromptForNaming(
  content: string,
  ref: ProjectTemplateRef | null | undefined,
): string {
  if (!ref) return content;
  return userTextFromTemplateMessage(content, ref)?.trim() || ref.name;
}

/** Reference first, clearly separated user content last (including an empty brief). */
export function composeTemplatePrompt(templateText: string, userText: string): string {
  return `${templateReferencePrefix(templateText)}${userText.trim()}`;
}

/** Character offset where the user's own words start inside the sent prompt. */
export function templatePromptBoundary(templateText: string, _userText: string): number {
  return templateReferencePrefix(templateText).length;
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
