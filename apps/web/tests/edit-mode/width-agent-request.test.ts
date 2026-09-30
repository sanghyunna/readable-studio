import { describe, expect, it } from 'vitest';
import { buildWidthAgentRequest, formatWidthAgentRequest } from '../../src/edit-mode/width-agent-request';
import { emptyManualEditStyles } from '../../src/edit-mode/types';

describe('width agent context', () => {
  it('serializes measured fields and provenance without manufacturing absent facts', () => {
    const request = buildWidthAgentRequest({ filePath: 'report.html', sourceSha256: 'abc',
      target: { id: 'path-0-1', tagName: 'p', kind: 'text', label: 'Copy', text: 'Copy', className: '', rect: { x: 0, y: 0, width: 200, height: 40 }, fields: {}, attributes: {}, styles: emptyManualEditStyles(), outerHtml: '<p>Copy</p>', isLayoutContainer: false, parentId: 'row' },
      outcome: { announce: true, constraints: [], requested: { width: 360, height: 40 }, actual: { x: 0, y: 0, width: 200, height: 40 }, availableContentWidth: 600, confidence: 'confirmed', causes: [{ code: 'parent-flex-allocation', axis: 'width', confidence: 'confirmed', facts: { basis: '0px', direction: 'row' }, declaration: { property: 'flex', value: '1 1 0', priority: '', origin: 'stylesheet', conditions: ['@media (min-width: 700px)'], complete: true } }] } });
    const parsed = JSON.parse(formatWidthAgentRequest(request).split('<readable-width-request>')[1]!.split('</readable-width-request>')[0]!);
    expect(parsed).toMatchObject({ schema: 'readable.width-request.v1', filePath: 'report.html', sourceSha256: 'abc', target: { sourcePath: 'path-0-1', tag: 'p' }, requestedRectWidth: 360, actualRectWidth: 200, availableContentWidth: 600, parent: { id: 'row', basis: '0px', direction: 'row' }, confidence: 'confirmed' });
    expect(parsed.target.id).toBeUndefined();
    expect(parsed.viewport).toBeUndefined();
    expect(parsed.causes[0].declaration.conditions).toEqual(['@media (min-width: 700px)']);
  });
});
