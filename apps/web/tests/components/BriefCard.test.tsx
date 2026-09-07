// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BriefCard } from '../../src/components/BriefCard';
import { formatBriefSteering, mergeBriefAssumptions, persistProjectBrief, type ProjectBrief } from '../../src/components/brief-state';
import { I18nProvider } from '../../src/i18n';
import { en } from '../../src/i18n/locales/en';
import { ko } from '../../src/i18n/locales/ko';

const brief: ProjectBrief = {
  updatedAt: 1,
  assumptions: [
    { id: 'audience', label: 'Audience', value: 'dev-tools buyers', provenance: 'inferred' },
    { id: 'scale', label: 'Scale', value: '8 slides', provenance: 'default' },
    { id: 'brand', label: 'Brand', value: 'Acme', provenance: 'stated' },
  ],
};

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(340);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function expandBrief(): void {
  const trigger = screen.getByTestId('brief-card').querySelector<HTMLButtonElement>('.brief-card__trigger');
  if (!trigger) throw new Error('Brief trigger was not rendered');
  fireEvent.click(trigger);
}

describe('BriefCard', () => {
  it('renders every card-owned label from the Korean dictionary without English fallbacks', () => {
    const { container } = render(
      <I18nProvider initial="ko">
        <BriefCard brief={brief} onChange={() => {}} onSteer={() => {}} />
      </I18nProvider>,
    );
    expandBrief();

    const visibleKeys = [
      'brief.trigger',
      'brief.title',
      'brief.description',
      'brief.provenance.stated',
      'brief.provenance.inferred',
      'brief.provenance.default',
    ] as const;
    for (const key of visibleKeys) {
      expect(ko[key]).not.toBe(en[key]);
      expect(screen.getByText(ko[key])).toBeTruthy();
      expect(screen.queryByText(en[key])).toBeNull();
    }

    expect(screen.getByRole('button', { name: ko['brief.collapse'] })).toBeTruthy();
    expect(screen.getByRole('group', { name: ko['brief.assumptions'] })).toBeTruthy();
    expect(screen.queryByRole('button', { name: en['brief.collapse'] })).toBeNull();
    expect(screen.queryByRole('group', { name: en['brief.assumptions'] })).toBeNull();

    // This fixture has the exact English labels persisted by old projects.
    // Stable ids must win at render time without mutating that payload.
    const inferredLabel = ko['brief.assumptionLabel']
      .replace('{label}', ko['brief.field.audience'])
      .replace('{value}', 'dev-tools buyers')
      .replace('{provenance}', ko['brief.provenance.inferred']);
    fireEvent.click(screen.getByRole('listitem', { name: inferredLabel }));

    const correctTitle = ko['brief.correctTitle'].replace('{label}', ko['brief.field.audience']);
    expect(screen.getByRole('dialog', { name: correctTitle })).toBeTruthy();
    expect(screen.getByText(correctTitle)).toBeTruthy();
    expect(screen.getByText(ko['brief.correctionDescription'])).toBeTruthy();
    expect(screen.getByRole('button', { name: ko['brief.applyCorrection'] })).toBeTruthy();
    expect(screen.getByRole('button', { name: ko['common.cancel'] })).toBeTruthy();

    const englishCardCopy = [
      en['brief.trigger'],
      en['brief.title'],
      en['brief.description'],
      en['brief.provenance.stated'],
      en['brief.provenance.inferred'],
      en['brief.provenance.default'],
      en['brief.correctTitle'].replace('{label}', 'Audience'),
      en['brief.correctionDescription'],
      en['brief.applyCorrection'],
      en['common.cancel'],
      'Audience',
      'Who is this for?',
      'Brand',
      'Scale',
    ];
    for (const english of englishCardCopy) {
      expect(container.textContent).not.toContain(english);
    }
    expect(screen.getByRole('textbox', { name: ko['brief.question.audience'] })).toBeTruthy();
    expect(brief.assumptions[0]?.label).toBe('Audience');
  });

  it('renders stated, inferred, and default provenance on grouped assumption controls', () => {
    render(<BriefCard brief={brief} onChange={() => {}} onSteer={() => {}} />);
    expandBrief();
    expect(screen.getByText('Stated by you')).toBeTruthy();
    expect(screen.getByText('Inferred')).toBeTruthy();
    expect(screen.getByText('Working defaults')).toBeTruthy();
    expect(screen.queryByText('Live')).toBeNull();
    expect(screen.getByRole('listitem', { name: 'Audience: dev-tools buyers (Inferred)' }).dataset.provenance).toBe('inferred');
    expect(screen.getByRole('listitem', { name: 'Scale: 8 slides (Working defaults)' }).dataset.provenance).toBe('default');
    expect(screen.getByRole('listitem', { name: 'Brand: Acme (Stated by you)' }).dataset.provenance).toBe('stated');
  });

  it('uses the field control and sends one sibling-format steering payload', async () => {
    const onChange = vi.fn();
    const onSteer = vi.fn();
    const onTrackEdit = vi.fn();
    render(<BriefCard brief={brief} onChange={onChange} onSteer={onSteer} onTrackEdit={onTrackEdit} />);
    expandBrief();

    fireEvent.click(screen.getByRole('listitem', { name: 'Audience: dev-tools buyers (Inferred)' }));
    const input = screen.getByRole('textbox', { name: 'Who is this for?' });
    fireEvent.change(input, { target: { value: 'security leaders' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply correction' }));

    await waitFor(() => expect(onSteer).toHaveBeenCalledOnce());
    expect(onSteer).toHaveBeenCalledWith('[brief correction — audience]\n- Who is this for?: security leaders');
    expect(onChange.mock.calls[0]?.[0].assumptions[0]).toMatchObject({ value: 'security leaders', provenance: 'stated' });
    expect(onChange.mock.calls[0]?.[1]).toMatchObject({
      id: 'audience', value: 'security leaders', provenance: 'stated',
    });
    expect(onTrackEdit).toHaveBeenCalledOnce();
  });

  it('waits for durable metadata persistence before steering and does not steer after failure', async () => {
    let finishPersistence: ((persisted: boolean) => void) | undefined;
    const onChange = vi.fn(() => new Promise<boolean>((resolve) => {
      finishPersistence = resolve;
    }));
    const onSteer = vi.fn();
    render(<BriefCard brief={brief} onChange={onChange} onSteer={onSteer} />);
    expandBrief();
    fireEvent.click(screen.getByRole('listitem', { name: 'Audience: dev-tools buyers (Inferred)' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Who is this for?' }), {
      target: { value: 'security leaders' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply correction' }));

    expect(onChange).toHaveBeenCalledOnce();
    expect(onSteer).not.toHaveBeenCalled();
    await act(async () => finishPersistence?.(false));
    expect(onSteer).not.toHaveBeenCalled();
  });

  it('stays collapsed on arrival and can be summoned', () => {
    render(<BriefCard brief={brief} onChange={() => {}} onSteer={() => {}} />);

    expect(screen.queryByText('Project brief')).toBeNull();
    expect(screen.getByRole('button', { name: /BriefBrandAcme3/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /BriefBrandAcme3/ }));
    expect(screen.getByText('Project brief')).toBeTruthy();
  });

  it('serializes option values exactly like form answers', () => {
    expect(formatBriefSteering(
      { id: 'brand', label: 'Brand', value: 'pick_direction', displayValue: 'Pick a direction for me', provenance: 'default' },
      'brand_spec',
    )).toBe('[brief correction — brand]\n- Brand context: I have a brand spec - I will share it [value: brand_spec]');
  });

  it('stores known incoming fields by stable id instead of persisting presentation copy', () => {
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
      label: 'brand',
      question: {
        label: 'brand',
        options: [{ label: 'pick_direction', value: 'pick_direction' }],
      },
    });
    expect(merged.assumptions[0]?.displayValue).toBeUndefined();
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
