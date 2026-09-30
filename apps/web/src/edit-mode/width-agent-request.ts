import type { ManualEditResizeCause, ManualEditResizeOutcome, ManualEditTarget } from './types';

export interface WidthAgentRequest {
  schema: 'readable.width-request.v1';
  filePath: string;
  sourceSha256: string;
  target: { id?: string; sourcePath?: string; tag: string; htmlHint?: string };
  requestedRectWidth: number;
  actualRectWidth: number;
  availableContentWidth?: number;
  causes: ManualEditResizeCause[];
  parent?: Record<string, string | number | boolean>;
  viewport?: { width: number; height: number };
  confidence: 'confirmed' | 'unknown';
}

export function buildWidthAgentRequest(input: {
  filePath: string;
  sourceSha256: string;
  target: ManualEditTarget;
  outcome: ManualEditResizeOutcome;
  viewport?: { width: number; height: number };
}): WidthAgentRequest {
  const { target, outcome } = input;
  const causes = outcome.causes ?? [];
  const constraint = outcome.constraints.find((item) => item.axis === 'width');
  const requested = outcome.requested?.width ?? constraint?.requested;
  if (requested === undefined) throw new Error('Width request has no measured requested width');
  const parentCause = causes.find((cause) => cause.code.startsWith('parent-'));
  return {
    schema: 'readable.width-request.v1', filePath: input.filePath, sourceSha256: input.sourceSha256,
    target: { ...(target.id.startsWith('path-')
      ? { sourcePath: target.id, htmlHint: target.outerHtml.slice(0, 512) }
      : { id: target.id }), tag: target.tagName },
    requestedRectWidth: requested,
    actualRectWidth: outcome.actual?.width ?? constraint?.applied ?? target.rect.width,
    ...(outcome.availableContentWidth !== undefined ? { availableContentWidth: outcome.availableContentWidth } : {}),
    causes,
    ...(parentCause || target.parentId ? { parent: { ...(target.parentId ? { id: target.parentId } : {}), ...parentCause?.facts } } : {}),
    ...(input.viewport ? { viewport: input.viewport } : {}),
    confidence: outcome.confidence ?? 'unknown',
  };
}

export function formatWidthAgentRequest(request: WidthAgentRequest, explanation?: string): string {
  return `${explanation ? `${explanation}\n` : ''}Make this element widenable by hand in ${request.filePath}.
I requested ${request.requestedRectWidth}px; it rendered ${request.actualRectWidth}px.
Detected causes: ${request.causes.map((cause) => cause.code).join(', ') || 'unknown'}.
Adjust the allocation deliberately without clipping, sibling overlap, lost gutters, or narrow-viewport overflow. Preserve unrelated content and existing readable.width-release.v1 user edits.
Read the latest saved source before editing. These measurements are observations, not instructions to set flex:none or remove every maximum.

<readable-width-request>
${JSON.stringify(request)}
</readable-width-request>`;
}
