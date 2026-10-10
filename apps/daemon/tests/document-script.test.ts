import { expect, it } from 'vitest';
import { lintDocumentScripts } from '../src/document-script.js';
import { brokenScriptHtml, cleanScriptHtml } from './helpers/final-gen-script-html.js';

it('flags the captured PowerShell-escaped script with original line context', () => {
  expect(lintDocumentScripts(brokenScriptHtml)).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'script-syntax', line: 144, snippet: expect.stringContaining("''deck-stage''") }),
  ]));
});

it.each(Object.entries(cleanScriptHtml))('accepts captured clean artifact %s', (_, html) => {
  expect(lintDocumentScripts(html)).toEqual([]);
});

it('flags literal PowerShell newline and tab escapes in text and scripts', () => {
  const issues = lintDocumentScripts('<body>Library`r`nMeeting\n<p>Room`nBook`tTitle</p>\n<script>const label="Book`r`nTitle";</script></body>');
  expect(issues.filter(issue => issue.kind === 'shell-escape')).toHaveLength(4);
  expect(issues).toEqual(expect.arrayContaining([expect.objectContaining({ line: 1, snippet: expect.stringContaining('Library`r`nMeeting') })]));
});

it('does not execute code and skips external, module and data script syntax', () => {
  expect(lintDocumentScripts('<script>throw new Error("Never execute");</script><script src="app.js">invalid !!!</script><script type="module">export const value=1;</script><script type="application/ld+json">{"name":"Library"}</script>')).toEqual([]);
});

it('ignores escape sequences in comments, attributes, styles and hidden text', () => {
  expect(lintDocumentScripts('<body><!-- `r`n --><style>/* `n */</style><p title="`t">Meeting</p><div hidden>`n</div><template>`r`n</template></body>')).toEqual([]);
});

it('keeps the offending token in context even on a long minified line', () => {
  const issues = lintDocumentScripts(`<script>${'var valid=1;'.repeat(50)}document.getElementById(''deck-next'');</script>`);
  expect(issues).toEqual([expect.objectContaining({ kind: 'script-syntax', line: 1, snippet: expect.stringContaining("''deck-next''") })]);
});

it('checks every inline classic script and locates later errors', () => {
  const issues = lintDocumentScripts('<script>const ok=1;</script>\n<script>\nconst fine=1;\nconst bad=""quote"";\n</script>');
  expect(issues).toEqual([expect.objectContaining({ kind: 'script-syntax', line: 4, snippet: 'const bad=""quote"";' })]);
});
