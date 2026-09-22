import { renderMarkdownToSafeHtml } from './markdown';

const MAX_ENTRIES = 8;
const MAX_CHARACTERS = 2_000_000;
// Derived output only: callers still read the current file before using this
// cache. Exact source keys cannot alias across projects, mtimes, or edits.
const previews = new Map<string, string>();
let retainedCharacters = 0;

export function renderMarkdownPreview(source: string): string {
  const cached = previews.get(source);
  if (cached !== undefined) {
    previews.delete(source);
    previews.set(source, cached);
    return cached;
  }
  const html = renderMarkdownToSafeHtml(source);
  const characters = source.length + html.length;
  if (characters > MAX_CHARACTERS) return html;
  while (previews.size >= MAX_ENTRIES || retainedCharacters + characters > MAX_CHARACTERS) {
    const oldest = previews.entries().next().value;
    if (!oldest) break;
    previews.delete(oldest[0]);
    retainedCharacters -= oldest[0].length + oldest[1].length;
  }
  previews.set(source, html);
  retainedCharacters += characters;
  return html;
}
