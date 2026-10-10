import { load } from 'cheerio';

/** Only the current user-authored suffix supplies facts, never template context. */
export function documentFactRequest(text: string, boundary?: number): string {
  const marker = '<readable-user-content-source/>';
  const start = text.indexOf(marker);
  if (start >= 0) return text.slice(start + marker.length);
  if (typeof boundary === 'number' && Number.isInteger(boundary) && boundary >= 0 && boundary <= text.length) return text.slice(boundary);
  return text;
}

export function missingDocumentYears(request: string, html: string): string[] {
  const years = [...new Set(request.match(/\b(?:19|20)\d{2}\b/g) ?? [])];
  if (!years.length) return [];
  const $ = load(html);
  $('script, style').remove();
  const visibleYears = new Set($('body').text().match(/\b(?:19|20)\d{2}\b/g) ?? []);
  return years.filter(year => !visibleYears.has(year));
}

export function documentYearRecoveryPrompt(artifact: string, years: string[]): string {
  return `The saved document at ${artifact} omits these years supplied by the user: ${years.join(', ')}. Include every missing year verbatim in the visible document text where its date appears. Preserve all other supplied facts and the document design. Save and verify index.html before completing.`;
}
