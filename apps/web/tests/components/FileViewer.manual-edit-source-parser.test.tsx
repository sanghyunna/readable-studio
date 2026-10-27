// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { emptyManualEditStyles } from '../../src/edit-mode/types';

vi.mock('../../src/components/ManualEditShapeToolbar', () => ({
  ManualEditShapeToolbar: (props: ComponentProps<typeof import('../../src/components/ManualEditShapeToolbar').ManualEditShapeToolbar>) => (
    <output data-testid="selected-source-fields">{props.styles.width}</output>
  ),
}));
import { FileViewer } from '../../src/components/FileViewer';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('reads the selected fragment path after leading authored CSS instead of its next sibling', async () => {
  const source = '<style>@layer authored{div{color:blue}}</style><div style="width:200px">Selected shape</div><p style="width:50px">Other text</p>';
  vi.stubGlobal('fetch', async () => new Response(source));
  render(<FileViewer projectId="fragment-fields" projectKind="prototype" liveHtml={source}
    file={{ name: 'fragment.html', path: 'fragment.html', type: 'file', size: source.length, mtime: 1, kind: 'html', mime: 'text/html' }} />);
  await act(async () => { fireEvent.click(screen.getByTestId('manual-edit-mode-toggle')); });
  const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: {
      type: 'readable-edit-select', target: { id: 'path-1', kind: 'text', label: 'Selected shape', tagName: 'div', className: '',
        text: 'Selected shape', rect: { x: 0, y: 0, width: 200, height: 50 }, fields: { text: 'Selected shape' }, attributes: {},
        styles: { ...emptyManualEditStyles(), width: '200px' }, isLayoutContainer: false,
        outerHtml: '<div style="width:200px">Selected shape</div>',
      },
    } }));
  });
  expect(screen.getByTestId('selected-source-fields').textContent).toBe('200px');
});
