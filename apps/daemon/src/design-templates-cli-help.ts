// Help surface for `readable design-templates` (user-imported templates and
// the Hub upload wizard).
// Kept pure and separate from cli.ts so a test can assert the advertised
// subcommands without spawning the CLI. Not to be confused with
// `readable templates`, which manages project snapshot templates.

export const DESIGN_TEMPLATES_USAGE = `Usage:
  readable design-templates import <zip> [--type deck|report|website] [--name <name>] [--cover <zip-relative-html>]
                                                     Import a template ZIP (HTML pages + PROMPT.md) in one step.
                                                     Without options: suggested name/cover, deck type.
  readable design-templates analyse <zip>            Upload wizard step 1: extract the ZIP into a 60-minute session
                                                     and list every HTML page (id, file, preview/thumbnail state).
  readable design-templates inspect-upload <sessionId>
                                                     Re-read a session with current page thumbnail states.
  readable design-templates finalize <sessionId> --type deck|report|website --name <name> --cover-page <pageId>
                                                     Register the session as a template (exactly once).
  readable design-templates cancel-upload <sessionId>
                                                     Discard an upload session (idempotent).
  readable design-templates list [--user]            List design templates (--user: only user-imported).
  readable design-templates rename <id> <name>       Rename a user-imported template (id is kept).
  readable design-templates remove <id>              Delete a user-imported template.
  readable design-templates thumbnails <id>          Regenerate a user-imported template's thumbnails.

Common options:
  --daemon-url <url>   Readable Studio daemon HTTP base.
  --json               Emit raw JSON.
  --prompt-file <path|->
                       JSON options instead of flags: finalize {type,name,coverPageId},
                       import {type?,name?,cover?}. Repeating a field as a flag is an error.`;

export function isDesignTemplatesHelpArg(arg: string | undefined): boolean {
  return arg === 'help' || arg === '--help' || arg === '-h';
}
