// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BriefCard } from '../../src/components/BriefCard';
import { formatBriefSteering, persistProjectBrief, type ProjectBrief } from '../../src/components/brief-state';

const brief: ProjectBrief = {
  updatedAt: 1,
  assumptions: [
    { id: 'audience', label: 'Audience', value: 'dev-tools buyers', provenance: 'inferred' },
    { id: 'scale', label: 'Scale', value: '8 slides', provenance: 'default' },
    { id: 'brand', label: 'Brand', value: 'Acme', provenance: 'stated' },
  ],
};

afterEach(cleanup);

describe('BriefCard', () => {
  it('renders stated, inferred, and default provenance on assumption chips', () => {
    render(<BriefCard brief={brief} onChange={() => {}} onSteer={() => {}} />);
    expect(screen.getByRole('listitem', { name: 'Audience: dev-tools buyers (inferred)' }).dataset.provenance).toBe('inferred');
    expect(screen.getByRole('listitem', { name: 'Scale: 8 slides (default)' }).dataset.provenance).toBe('default');
    expect(screen.getByRole('listitem', { name: 'Brand: Acme (stated)' }).dataset.provenance).toBe('stated');
  });

  it('uses the field control and sends one sibling-format steering payload', () => {
    const onChange = vi.fn();
    const onSteer = vi.fn();
    const onTrackEdit = vi.fn();
    render(<BriefCard brief={brief} onChange={onChange} onSteer={onSteer} onTrackEdit={onTrackEdit} />);

    fireEvent.click(screen.getByRole('listitem', { name: 'Audience: dev-tools buyers (inferred)' }));
    const input = screen.getByRole('textbox', { name: 'Who is this for?' });
    fireEvent.change(input, { target: { value: 'security leaders' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply correction' }));

    expect(onSteer).toHaveBeenCalledOnce();
    expect(onSteer).toHaveBeenCalledWith('[brief correction — audience]\n- Who is this for?: security leaders');
    expect(onChange.mock.calls[0]?.[0].assumptions[0]).toMatchObject({ value: 'security leaders', provenance: 'stated' });
    expect(onTrackEdit).toHaveBeenCalledOnce();
  });

  it('serializes option values exactly like form answers', () => {
    expect(formatBriefSteering(
      { id: 'brand', label: 'Brand', value: 'pick_direction', displayValue: 'Pick a direction for me', provenance: 'default' },
      'brand_spec',
    )).toBe('[brief correction — brand]\n- Brand context: I have a brand spec - I will share it [value: brand_spec]');
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
