import { Script } from 'node:vm';
import { load } from 'cheerio';

export type DocumentScriptIssue = { kind: 'script-syntax' | 'shell-escape'; line: number; snippet: string; message: string };
type LocatedNode = { sourceCodeLocation?: { startOffset: number; startTag?: { endOffset: number } } };

/** Static syntax/escape lint only: never evaluates generated JavaScript. */
export function lintDocumentScripts(html: string): DocumentScriptIssue[] {
  const $ = load(html, { sourceCodeLocationInfo: true });
  const issues: DocumentScriptIssue[] = [];
  const context = (offset: number) => {
    const line = html.slice(0, offset).split('\n').length;
    const start = html.lastIndexOf('\n', offset - 1) + 1;
    const sourceLine = html.split('\n')[line - 1] ?? '';
    const from = Math.max(0, offset - start - 140);
    return { line, snippet: `${from ? '...' : ''}${sourceLine.slice(from, from + 300).trim()}${sourceLine.length > from + 300 ? '...' : ''}` };
  };
  const escapes = (text: string, offset: number, script = false) => {
    // A legitimate template literal such as `translate(...)` is not shell debris.
    const templateStarts = new Set<number>();
    if (script) {
      for (const token of text.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/g)) {
        if (token[0].startsWith('`')) templateStarts.add(token.index);
      }
    }
    for (const match of text.matchAll(/`r`n|`[nt]/g)) {
      if (templateStarts.has(match.index)) continue;
      issues.push({ kind: 'shell-escape', ...context(offset + match.index), message: `Literal PowerShell escape ${match[0]}` });
    }
  };
  $('script').each((index, element) => {
    const code = $(element).text();
    const offset = (element as LocatedNode).sourceCodeLocation?.startTag?.endOffset ?? 0;
    escapes(code, offset, true);
    const type = ($(element).attr('type') ?? '').trim().toLowerCase();
    // JSON/import maps and modules are not classic JavaScript scripts.
    if ($(element).attr('src') !== undefined || (type && !/^(?:text|application)\/(?:java|ecma)script$/.test(type))) return;
    const filename = `inline-script-${index + 1}.js`;
    try {
      new Script(code, { filename });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack ?? '' : '';
      const scriptLine = Number(stack.match(new RegExp(`${filename.replace('.', '\\.')}:(\\d+)`))?.[1] ?? 1);
      const preceding = code.split('\n').slice(0, scriptLine - 1).join('\n');
      const lineOffset = scriptLine > 1 ? preceding.length + 1 : 0;
      const stackLines = stack.split('\n');
      const locationIndex = stackLines.findIndex(line => line.startsWith(`${filename}:`));
      const column = Math.max(0, (stackLines[locationIndex + 2] ?? '').indexOf('^'));
      issues.push({ kind: 'script-syntax', ...context(offset + lineOffset + column), message });
    }
  });
  $('body, body *').each((_, element) => {
    if ($(element).closest('script, style, noscript, template, [hidden], [aria-hidden="true"]').length) return;
    for (const child of element.children) {
      if (child.type !== 'text') continue;
      escapes(child.data, (child as LocatedNode).sourceCodeLocation?.startOffset ?? 0);
    }
  });
  return issues;
}

export function documentScriptRecoveryPrompt(artifact: string, issues: DocumentScriptIssue[]): string {
  return `The saved document at ${artifact} contains broken inline JavaScript or shell-escape debris:\n${issues.map(issue => `- ${issue.kind} at line ${issue.line}: ${issue.message}\n  ${issue.snippet}`).join('\n')}\nFix every reported issue. Use apply_patch or the Write/Edit file tool, preserving literal JavaScript quotes and real newlines/tabs. Save and syntax-check index.html without executing scripts before completing.`;
}
