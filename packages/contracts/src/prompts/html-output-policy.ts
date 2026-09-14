/** Byte-synced with packages/contracts/src/prompts/html-output-policy.ts. */
export const HTML_OUTPUT_POLICY = {
  version: 1,
  entryFile: 'index.html',
  artifactIdentifier: 'index',
  editMode: 'in-place',
  additionalHtml: 'explicit-user-approval',
  fileBackedHandoff: 'summary-only',
} as const;

export function renderHtmlOutputDirective(streamFormat?: string): string {
  const fileTools = streamFormat !== 'plain';
  const delivery = { ...HTML_OUTPUT_POLICY, fileTools, delivery: fileTools ? 'file' : 'artifact' };
  return `## HTML delivery
<readable-html-output-policy>${JSON.stringify(delivery)}</readable-html-output-policy>

The stable entry is index.html; the user's topic belongs in the document title. Revisions edit the entry in place. Ask for approval when a genuinely separate HTML page is needed.

${fileTools
    ? 'This run has file tools. Create or edit index.html in the project root, using seed contents as the starting point. The saved file is the deliverable and appears in the preview automatically. Finish with a brief plain-chat reference to index.html and a summary of the change. This completes delivery for both new documents and revisions.'
    : `This API/BYOK run has no file tools. The chat artifact is the sole delivery channel; compose the document directly in one final artifact. Use this shape, with the user's topic in title:

<artifact identifier="index" type="text/html" title="Human title">
<!doctype html>
<html>...complete standalone document...</html>
</artifact>

The body is the complete document, with inline CSS and scripts (or explicitly pinned dependencies). Put any short introduction before the artifact, leave it outside Markdown fences, and finish at the closing tag.`}`;
}
