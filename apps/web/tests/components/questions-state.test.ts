import { describe, expect, it, vi } from 'vitest';
import { formatBriefSteering, mergeBriefAssumptions, persistProjectBrief, type ProjectBrief } from '../../src/components/brief-state';
const brief: ProjectBrief = { assumptions: [], updatedAt: 1 };
describe('Questions persistence compatibility', () => {
  it('serializes option values exactly like form answers', () => {
    expect(formatBriefSteering(
      { id: 'brand', label: 'Brand', value: 'pick_direction', provenance: 'default', question: { id: 'brand', label: 'Brand', type: 'radio', options: [{ label: 'Brand spec', value: 'brand_spec' }] } },
      'brand_spec',
    )).toContain('[value: brand_spec]');
  });

  it('preserves the model-authored editor schema even for previously hardcoded ids', () => {
    const merged = mergeBriefAssumptions(null, [{
      id: 'brand',
      label: 'Brand',
      value: 'pick_direction',
      displayValue: 'Pick a direction for me',
      provenance: 'default',
      question: {
        id: 'brand',
        label: 'Brand context',
        type: 'radio',
        options: [{ label: 'Pick a direction for me', value: 'pick_direction' }],
      },
    }], 2);

    expect(merged.assumptions[0]).toMatchObject({
      id: 'brand',
      label: 'Brand',
      question: {
        type: 'radio',
        options: [{ value: 'pick_direction' }],
      },
    });
    expect(merged.assumptions[0]?.question?.id).toBe('brand');
  });

  it('persists the brief alongside existing project metadata', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      project: { id: 'p1', metadata: { kind: 'deck', slideCount: '8', brief } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await expect(persistProjectBrief('p1', { kind: 'deck', slideCount: '8' }, brief)).resolves.toBe(true);
    const request = fetchMock.mock.calls[0];
    expect(request?.[0]).toBe('/api/projects/p1');
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
      metadata: { kind: 'deck', slideCount: '8', brief },
    });
    fetchMock.mockRestore();
  });
});
