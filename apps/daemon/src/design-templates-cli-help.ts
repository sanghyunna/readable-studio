// Help surface for `readable design-templates` (user-imported templates and
// the Hub upload wizard).
// Kept pure and separate from cli.ts so a test can assert the advertised
// subcommands without spawning the CLI. Not to be confused with
// `readable templates`, which manages project snapshot templates.

export const DESIGN_TEMPLATES_USAGE = `Usage:
  readable design-templates import <zip> [--type deck|report] [--name <name>] [--cover <zip-relative-html>]
                                                     Import a template ZIP (HTML pages + PROMPT.md) in one step.
                                                     Without options: suggested name/cover, detected type.
  readable design-templates import <bundle.zip> --all [--type deck|report]
                                                     Import every template of a bundle (a ZIP of template ZIPs)
                                                     with its suggested name/cover and detected type. Prints
                                                     Imported/Failed lines (--json: {imported,failed});
                                                     exits 1 if any template failed.
  readable design-templates analyse <zip>            Upload wizard step 1: extract the ZIP into a 60-minute session
                                                     and list every HTML page (id, file, preview/thumbnail state)
                                                     and the detected type. A bundle lists each template with
                                                     its own session id, detected type and page count.
  readable design-templates inspect-upload <sessionId>
                                                     Re-read a session with current page thumbnail states.
  readable design-templates finalize <sessionId> [--type deck|report] --name <name> --cover-page <pageId>
                                                     Register the session (or one bundle template) as a template
                                                     (exactly once).
  readable design-templates cancel-upload <sessionId>
                                                     Discard an upload session (idempotent).
  readable design-templates cancel-bundle <bundleId>
                                                     Discard every unsaved template of a bundle (idempotent);
                                                     templates already finalized are kept.
  readable design-templates list [--user]            List design templates (--user: only user-imported).
  readable design-templates rename <id> <name>       Rename a user-imported template (id is kept).
  readable design-templates remove <id>              Delete a user-imported template.
  readable design-templates thumbnails <id>          Regenerate a user-imported template's thumbnails.

Common options:
  --daemon-url <url>   Readable Studio daemon HTTP base.
  --json               Emit raw JSON.
  --type deck|report   Optional: overrides the type the daemon detects from the template.
  --prompt-file <path|->
                       JSON options instead of flags: finalize {type?,name,coverPageId},
                       import {type?,name?,cover?}. Repeating a field as a flag is an error.`;

export function isDesignTemplatesHelpArg(arg: string | undefined): boolean {
  return arg === 'help' || arg === '--help' || arg === '-h';
}
