// Help surface for `readable design-templates` (user-imported deck templates).
// Kept pure and separate from cli.ts so a test can assert the advertised
// subcommands without spawning the CLI. Not to be confused with
// `readable templates`, which manages project snapshot templates.

export const DESIGN_TEMPLATES_USAGE = `Usage:
  readable design-templates import <zip>             Import a deck template ZIP (HTML pages + PROMPT.md).
  readable design-templates list [--user]            List design templates (--user: only user-imported).
  readable design-templates rename <id> <name>       Rename a user-imported template (id is kept).
  readable design-templates remove <id>              Delete a user-imported template.
  readable design-templates thumbnails <id>          Regenerate a user-imported template's thumbnails.

Common options:
  --daemon-url <url>   Readable Studio daemon HTTP base.
  --json               Emit raw JSON.`;

export function isDesignTemplatesHelpArg(arg: string | undefined): boolean {
  return arg === 'help' || arg === '--help' || arg === '-h';
}
