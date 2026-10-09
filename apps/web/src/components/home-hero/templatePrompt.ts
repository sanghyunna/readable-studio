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

function templateReferencePrefix(_templateText: string): string {
  // The daemon resolves structure/style from the selected templateRef and its
  // resources. Catalogue queries are example workflows, not rendering data;
  // forwarding them inside the final user request revives their asking rules.
  const reference = JSON.stringify({ source: 'selected-template', exampleWorkflow: 'omitted' });
  return [
    '<readable-template-reference role="structure-and-visual-style-only">',
    reference,
    '</readable-template-reference>',
    '',
    'Use the template and seeded example files only for structure and visual style. Never copy their example names, numbers, people, products, or claims. Only my request below and my attachments supply content and data. Adapt subject-specific template slots to my domain or drop them; never demand the template\'s own subject-specific inputs. Judge completeness only against my requested document, not the example subject. If my own content is insufficient, ask through <question-form> rather than inventing content.',
    '',
    // Keep the decision adjacent to the actual request: CLI agents receive the
    // daemon instruction stack and this message together in a single user turn.
    '<readable-template-content-gate>{"version":1,"source":"user-content-only","askWhen":["no-substantive-content","explicitly-requested-content-missing"],"optionalFields":"omit","otherwise":"generate","output":"index.html"}</readable-template-content-gate>',
    'Before responding, apply this decision: if I supplied only a topic/title or a request to fill a template without actual text/data, ask for that real content. Otherwise, test each proposed question by deleting the unsupplied field: if my requested document can still communicate my supplied material faithfully, omit that field and do not ask. Use my subject/name as written; do not require a more formal name or permission to omit optional identifiers. Ask only for explicitly requested content that is still missing, never to enrich or confirm my material or fill example slots. In every other case, generate index.html now using every supplied fact and no template example facts; do not emit a question form or stop after a receipt. Follow the selected HTML delivery channel when file tools are unavailable.',
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
