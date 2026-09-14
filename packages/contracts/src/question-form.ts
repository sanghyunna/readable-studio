// Shared question-form wire syntax. A form starts a line (up to three spaces
// of indentation), outside Markdown code. Attributes are optional: the UI
// supports body metadata and defaults. JSON may immediately follow the tag.
export const QUESTION_FORM_OPEN_RE = /<(question-form|ask-question)(?=[\s>])([^>]*)>/i;

export function parseQuestionFormBody(body: string): Record<string, unknown> | null {
  const stripped = body.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  let data: unknown;
  try {
    data = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  return Array.isArray(obj.questions) && obj.questions.some((q) => q && typeof q === 'object')
    ? obj : null;
}

export function questionFormBodyIsRenderable(body: string): boolean {
  return parseQuestionFormBody(body) !== null;
}

// Preserve original offsets even for Unicode whose lowercase expands (e.g. İ).
export function findQuestionFormCloseTag(text: string, from: number, closeTag: string): number {
  const closeLower = closeTag.toLowerCase();
  for (let i = from; i <= text.length - closeTag.length; i++) {
    if (text.slice(i, i + closeTag.length).toLowerCase() === closeLower) return i;
  }
  return -1;
}

export interface QuestionFormBlock {
  openStart: number;
  openEnd: number;
  closeStart: number;
  end: number;
  attrs: string;
  body: string;
  data: Record<string, unknown> | null;
}

// Scan the original message, never a sliced suffix: slicing loses Markdown
// context and can turn a mid-sentence mention into an apparent line start.
export function* scanQuestionFormBlocks(input: string): Generator<QuestionFormBlock> {
  let fence: { marker: string; length: number } | null = null;
  let codeSpan = 0;
  let i = 0;
  while (i < input.length) {
    const lineStart = input.lastIndexOf('\n', i - 1) + 1;
    if (i === lineStart) {
      const nextNewline = input.indexOf('\n', i);
      const lineEnd = nextNewline === -1 ? input.length : nextNewline;
      const line = input.slice(i, lineEnd).replace(/\r$/, '');
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (marker && marker[1]?.[0] === fence.marker &&
            marker[1].length >= fence.length && !marker[2]?.trim()) fence = null;
        i = lineEnd + 1;
        continue;
      }
      if (!codeSpan && marker &&
          (marker[1]?.[0] === '~' || !marker[2]?.includes('`'))) {
        fence = { marker: marker[1]![0]!, length: marker[1]!.length };
        i = lineEnd + 1;
        continue;
      }
    }
    if (input[i] === '\\' && !codeSpan && input[i + 1] !== '\n') {
      i += 2;
      continue;
    }
    if (input[i] === '`') {
      let end = i + 1;
      while (input[end] === '`') end++;
      const length = end - i;
      if (codeSpan === length) codeSpan = 0;
      else if (!codeSpan) {
        // An unmatched backtick is literal prose, not an unbounded code span.
        const runs = /`+/g;
        runs.lastIndex = end;
        let closing: RegExpExecArray | null;
        while ((closing = runs.exec(input))) {
          if (closing[0].length === length) { codeSpan = length; break; }
        }
      }
      i = end;
      continue;
    }
    if (!codeSpan && input[i] === '<' && /^ {0,3}$/.test(input.slice(lineStart, i))) {
      const open = QUESTION_FORM_OPEN_RE.exec(input.slice(i));
      if (open?.index === 0) {
        const openEnd = i + open[0].length;
        // A standalone tag can stream before its body. Same-line prose after
        // a tag is a mention, not a block; compact JSON/fenced bodies are valid.
        if (/^[\t ]*(?:\r?\n|\{|```(?:json)?(?:\s|$)|$)/i.test(input.slice(openEnd))) {
          const closeTag = `</${open[1]!.toLowerCase()}>`;
          const closeStart = findQuestionFormCloseTag(input, openEnd, closeTag);
          const end = closeStart === -1 ? input.length : closeStart + closeTag.length;
          const body = input.slice(openEnd, closeStart === -1 ? input.length : closeStart);
          const data = parseQuestionFormBody(body);
          yield { openStart: i, openEnd, closeStart, end, attrs: open[2] ?? '', body, data };
          // Only a renderable body owns its closing tag. A bare mention or
          // malformed candidate must not consume a later genuine form.
          i = data ? end : openEnd;
          continue;
        }
      }
    }
    i++;
  }
}

export function emittedRenderableQuestionForm(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  for (const block of scanQuestionFormBlocks(text)) {
    if (block.data) return true;
  }
  return false;
}
