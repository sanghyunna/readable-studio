import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { projectSplitStyle } from '../../src/components/ProjectView';

const projectViewSource = readFileSync(
  new URL('../../src/components/ProjectView.tsx', import.meta.url),
  'utf8',
);

/**
 * Contract: entering 직접 편집 (manual-edit inspector) or the comment inspector
 * swaps the CONTENT of the left slot only. The split divider must not move.
 *
 * The regression this pins: the left track used to be sized from per-inspector
 * constants (`MANUAL_EDIT_INSPECTOR_PANEL_WIDTH = 404`,
 * `COMMENT_INSPECTOR_PANEL_WIDTH = 320`) instead of the persisted chat width,
 * which shoved the divider by 56px at the 460px default and by 216px at a
 * user-resized 620px, and discarded the user's width on the way back out.
 */
describe('project split position across the left-panel mode swap', () => {
  it('places the divider at the persisted width, independent of which pane renders', () => {
    // Given: a persisted left-panel width. When: the slot swaps to an inspector,
    // the component feeds the SAME `chatPanelWidth` through (see the source
    // guard below), so the track is a pure function of the saved width.
    // Then: the divider's left edge is the saved width for every mode.
    const track = 'minmax(400px, 1fr)';
    for (const width of [460, 620, 345, 720]) {
      const style = projectSplitStyle(false, width, track);
      expect(style?.gridTemplateColumns).toBe(`${width}px 8px ${track}`);
      expect(style?.['--project-chat-panel-width']).toBe(`${width}px`);
      // The legacy inspector constants must never reappear as the left track.
      expect(style?.gridTemplateColumns).not.toMatch(/^(404|320)px /);
    }
  });

  it('sizes the left track from the persisted chat width, never a per-inspector constant', () => {
    // A source-level guard: reintroducing a fixed inspector width is the exact
    // shape of the divider-jump bug, and it cannot be caught by rendering the
    // style helper alone.
    expect(projectViewSource).not.toMatch(/MANUAL_EDIT_INSPECTOR_PANEL_WIDTH/);
    expect(projectViewSource).not.toMatch(/COMMENT_INSPECTOR_PANEL_WIDTH/);
    expect(projectViewSource).toMatch(/const splitLeftPanelWidth = chatPanelWidth;/);
  });

  it('keeps the divider inert but identically sized in inspector mode', () => {
    // `.split-edit-divider` replaces `.split-resize-handle` while an inspector
    // owns the slot; both are 8px so the swap cannot shift the boundary.
    const shellCss = readFileSync(
      new URL('../../src/styles/shell.css', import.meta.url),
      'utf8',
    );
    const widthOf = (selector: string): string[] => {
      const block = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(shellCss)?.[1] ?? '';
      return [...block.matchAll(/(?:^|;)\s*(?:min-)?width:\s*([^;]+)/g)].map((m) => (m[1] ?? '').trim());
    };
    expect(widthOf('.split-edit-divider')).toEqual(['8px', '8px']);
    expect(widthOf('.split-resize-handle')).toEqual(['8px', '8px']);
  });
});
