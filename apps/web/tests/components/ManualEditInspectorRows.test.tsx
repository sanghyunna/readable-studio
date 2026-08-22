// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DisclosureSection, NumberRow, QuadField, Section } from '../../src/components/ManualEditInspectorRows';

afterEach(cleanup);

describe('manual edit inspector rows', () => {
  it('keeps precision controls folded until the user opens them', () => {
    render(
      <DisclosureSection title="Spacing" summary="Inside 12 · Outside 0" icon="box-3-line">
        <button type="button">Inside spacing</button>
      </DisclosureSection>,
    );

    const toggle = screen.getByRole('button', { name: /Spacing/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps control help visible beside the property name', () => {
    render(
      <Section title="Shape" description="Change the selected element's appearance and box model.">
        <NumberRow
          label="Width"
          description="Horizontal size. CSS units are supported."
          value="320px"
          unit="px"
          onChange={vi.fn()}
        />
      </Section>,
    );

    expect(screen.getByText("Change the selected element's appearance and box model.")).toBeTruthy();
    expect(screen.getByText('Horizontal size. CSS units are supported.')).toBeTruthy();
  });

  it('shows which side each box-model input changes', () => {
    render(
      <QuadField
        label="Padding"
        description="Space between the content and border."
        sideLabels={{ t: 'Top', r: 'Right', b: 'Bottom', l: 'Left' }}
        values={{ t: '1px', r: '2px', b: '3px', l: '4px' }}
        onChange={vi.fn()}
      />,
    );

    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      expect(screen.getByText(side)).toBeTruthy();
    }
  });

  it('steps percentage controls in familiar whole-percent increments', () => {
    const onChange = vi.fn();
    render(
      <NumberRow
        label="Opacity"
        value="50"
        unit="%"
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Opacity increase' }));
    expect(onChange).toHaveBeenCalledWith('51');
  });
});
