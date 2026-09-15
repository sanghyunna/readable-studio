import { renderHtmlOutputDirective } from '../prompts/html-output-policy.js';
import { API_MODE_OVERRIDE } from '../prompts/system.js';

/** Reuse the host's artifact delivery contract, including on the first negotiated retry.
 * Pi carries the composed app prompt inside user content; its own system prompt is
 * separate. Remove the obsolete delivery section there and pin the real capability
 * at system priority. Do not rewrite conversation text or tool-result history.
 */
export function artifactDeliveryRequest(body: Record<string, unknown>, anthropic: boolean): Record<string, unknown> {
  const cleanText = (text: string) => text
    .replaceAll(renderHtmlOutputDirective(), '')
    .replaceAll(renderHtmlOutputDirective('plain'), '')
    .replaceAll(API_MODE_OVERRIDE, '');
  const cleanContent = (content: unknown): unknown => typeof content === 'string' ? cleanText(content)
    : Array.isArray(content) ? content.map(part => part && typeof part === 'object' && typeof part.text === 'string'
      ? { ...part, text: cleanText(part.text) } : part) : content;
  const messages = Array.isArray(body.messages) ? body.messages.map(message => ({ ...message, content: cleanContent(message.content) })) : [];
  const directive = `${API_MODE_OVERRIDE}\n\n${renderHtmlOutputDirective('plain')}`;
  const { tools: _tools, tool_choice: _choice, parallel_tool_calls: _parallel, ...rest } = body;
  if (anthropic) {
    const system = cleanContent(body.system);
    return { ...rest, messages, system: [{ type: 'text', text: directive },
      ...(typeof system === 'string' ? [{ type: 'text', text: system }] : Array.isArray(system) ? system : [])] };
  }
  return { ...rest, messages: [{ role: 'system', content: directive }, ...messages] };
}

/** Recognize rejection of tools themselves, not a tool/effort combination with
 * an explicit route remedy (which remains handled by protocol negotiation).
 */
export function rejectsTools(message: string): boolean {
  return /(?:rejected parameter|unsupported parameter|unknown field|unrecognized (?:request )?(?:argument|field)|unexpected (?:keyword )?argument)\s*:?\s*["'`]?tools\b/i.test(message)
    || /\b(?:tools|function calling|function tools|tool calling)\b\s*["'`]?\s*(?:(?:is|are)\s+)?(?:not supported|unsupported|not allowed|disabled)/i.test(message)
    || /(?:does not support|doesn't support|cannot support)\s+(?:\w+\s+)?(?:tools|function calling|tool calling)\b/i.test(message);
}
