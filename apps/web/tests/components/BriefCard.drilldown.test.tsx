// @vitest-environment jsdom

/**
 * The Brief correction flow is ONE surface, not two stacked layers.
 *
 * Shipped defect: opening the `Brief` trigger rendered the assumption list,
 * and picking a field rendered the correction editor as an absolutely
 * positioned overlay (`.brief-card__editor { position: absolute; inset: 8px }`)
 * ON TOP of that still-mounted list - two panels visible at once, in two
 * different visual languages, because the editor wrapped the chat-era
 * `QuestionFormView` chrome (blue circular `?` badge, its own head/foot).
 *
 * The model these tests pin: the correction is a DRILL-IN STEP of the same
 * panel. The list unmounts when the editor opens, so no second layer exists to
 * stack, occlude, or become unclickable - and the editor is built from the
 * Brief's own tokens, not a foreign palette.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BriefCard } from '../../src/components/BriefCard';
import type { ProjectBrief } from '../../src/components/brief-state';

const brief: ProjectBrief = {
  updatedAt: 1,
  assumptions: [
    { id: 'audience', label: 'Audience', value: 'dev-tools buyers', provenance: 'inferred' },
    { id: 'scale', label: 'Scale', value: '8 slides', provenance: 'default' },
    { id: 'brand', label: 'Brand', value: 'Acme', provenance: 'stated' },
  ],
};

const briefCss = readFileSync(
  resolve(__dirname, '../../src/components/BriefCard.css'),
  'utf8',
);

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(340);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function openPanel(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: /Brief/ }));
  return screen.getByTestId('brief-card-panel');
}

function openEditor(): HTMLElement {
  fireEvent.click(screen.getByRole('listitem', { name: 'Audience: dev-tools buyers (Inferred)' }));
  return screen.getByTestId('brief-card-panel');
}

/** Every declaration block whose selector list mentions `selector`. */
function rulesFor(selector: string): string[] {
  const blocks: string[] = [];
  const pattern = new RegExp(`([^{}]*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^{}]*)\\{([^{}]*)\\}`, 'g');
  for (const match of briefCss.matchAll(pattern)) {
    const selectorList = match[1] ?? '';
    // Skip @media prelude noise; we only want real selector lists.
    if (selectorList.includes('@')) continue;
    blocks.push(match[2] ?? '');
  }
  return blocks;
}

describe('BriefCard correction is a drill-in, not a second panel', () => {
  it('unmounts the assumption list when the correction step opens', () => {
    render(<BriefCard brief={brief} onChange={() => {}} onSteer={() => {}} />);
    openPanel();

    expect(screen.getByRole('group', { name: 'Project assumptions' })).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);

    openEditor();

    // The summary list is GONE, not merely covered: nothing can stack on it.
    expect(screen.queryByRole('group', { name: 'Project assumptions' })).toBeNull();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(screen.getByText('Correct Audience')).toBeTruthy();
  });

  it('keeps exactly one Brief surface mounted in either step', () => {
    render(<BriefCard brief={brief} onChange={() => {}} onSteer={() => {}} />);
    openPanel();
    expect(screen.getAllByTestId('brief-card-panel')).toHaveLength(1);

    openEditor();
    expect(screen.getAllByTestId('brief-card-panel')).toHaveLength(1);
    // No nested dialog layer inside the panel - the panel IS the dialog.
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('marks which step the single panel is showing', () => {
    render(<BriefCard brief={brief} onChange={() => {}} onSteer={() => {}} />);
    expect(openPanel().dataset.step).toBe('summary');
    expect(openEditor().dataset.step).toBe('correct');
  });

  it('returns to the summary step from the correction step', () => {
    render(<BriefCard brief={brief} onChange={() => {}} onSteer={() => {}} />);
    openPanel();
    openEditor();

    fireEvent.click(screen.getByRole('button', { name: 'Back to project brief' }));

    expect(screen.getByTestId('brief-card-panel').dataset.step).toBe('summary');
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByText('Correct Audience')).toBeNull();
  });

  it('never positions the correction step as an overlay layer', () => {
    // The defect was structural: an absolutely positioned, z-indexed box inset
    // over the list. A drill-in step must be in normal flow.
    for (const block of rulesFor('.brief-card__editor')) {
      expect(block).not.toMatch(/position\s*:\s*(absolute|fixed)/);
      expect(block).not.toMatch(/z-index\s*:/);
      expect(block).not.toMatch(/inset\s*:/);
    }
  });
});

describe('BriefCard shares one visual contract across both steps', () => {
  it('renders no foreign question-form chrome inside the panel', () => {
    render(<BriefCard brief={brief} onChange={() => {}} onSteer={() => {}} />);
    openPanel();
    const panel = openEditor();

    // The chat-era header (blue circular `?` badge + its own title/desc) is a
    // different product's language, and it duplicated the panel's own title.
    // It must not appear in the Brief.
    expect(panel.querySelector('.question-form-head')).toBeNull();
    expect(panel.querySelector('.question-form-icon')).toBeNull();
    // No standalone `?` badge element (question copy legitimately ends in one,
    // so this targets a lone-glyph node rather than the text as a whole).
    const loneGlyphs = [...panel.querySelectorAll('span, div')]
      .filter((node) => node.textContent?.trim() === '?');
    expect(loneGlyphs).toEqual([]);
    // Exactly one title for the step, owned by the Brief panel itself.
    expect(screen.getAllByText('Correct Audience')).toHaveLength(1);
    expect(panel.querySelector('#brief-card-title')?.textContent).toBe('Correct Audience');
    // The submit row that remains is re-materialised by the Brief, not left in
    // the chat surface's borders-and-panel-fill styling.
    const footCss = rulesFor('.question-form-foot').join('\n');
    expect(footCss).toMatch(/border:\s*0/);
    expect(footCss).toMatch(/background:\s*transparent/);
    expect(footCss).toMatch(/box-shadow:\s*none/);
  });

  it('uses only design tokens - no invented palette, no raw color literals', () => {
    const literals = briefCss.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) ?? [];
    expect(literals).toEqual([]);
    // Every color surface is expressed through the token layer.
    expect(briefCss).toMatch(/var\(--/);
  });

  it('keeps the borderless house style: fills, shadows and inset highlights, no 1px lines', () => {
    // `border: 0` is the idiom here; a drawn line of any width is not.
    const declarations = briefCss.match(/^[^\S\n]*border(-(top|right|bottom|left))?[^\S\n]*:[^;]+;/gm) ?? [];
    const drawnLines = declarations.filter((line) => !/:\s*0\s*;/.test(line));
    expect(drawnLines).toEqual([]);
    // Depth comes from inset highlights and soft shadows instead.
    expect(briefCss).toMatch(/box-shadow:\s*inset/);
  });

  it('styles the correction step with the same radius/shadow/typography tokens as the summary step', () => {
    const editorCss = rulesFor('.brief-card__editor').join('\n');
    expect(editorCss).toMatch(/var\(--radius-/);
    // Same motion vocabulary as the chips it drills in from.
    const chipCss = rulesFor('.brief-card__chip').join('\n');
    expect(chipCss).toMatch(/var\(--dur-quick\)/);
    expect(chipCss).toMatch(/var\(--ease-out\)/);
  });

  it('keeps the correction step reachable: no pointer-events lockout on the live panel', () => {
    render(<BriefCard brief={brief} onChange={() => {}} onSteer={() => {}} />);
    openPanel();
    const panel = openEditor();

    // Eleven 'visible but unclickable' defects have shipped here. Once placed,
    // the panel must be hit-testable and its primary action clickable.
    expect(panel.style.pointerEvents).not.toBe('none');
    expect(panel.style.visibility).not.toBe('hidden');
    const apply = screen.getByRole('button', { name: 'Apply correction' });
    expect(apply.hasAttribute('disabled')).toBe(false);
  });

  it('applies a correction from the drill-in and returns to the summary', async () => {
    const onChange = vi.fn();
    let signalSteered: (() => void) | undefined;
    const steered = new Promise<void>((resolve) => {
      signalSteered = resolve;
    });
    const onSteer = vi.fn(() => signalSteered?.());
    render(<BriefCard brief={brief} onChange={onChange} onSteer={onSteer} />);
    openPanel();
    openEditor();

    fireEvent.change(screen.getByRole('textbox', { name: 'Who is this for?' }), {
      target: { value: 'security leaders' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply correction' }));
    await act(async () => {
      await steered;
    });

    expect(onSteer).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0]?.[0].assumptions[0]).toMatchObject({
      value: 'security leaders',
      provenance: 'stated',
    });
    expect(screen.getByTestId('brief-card-panel').dataset.step).toBe('summary');
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });
});
