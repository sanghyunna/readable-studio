// @vitest-environment node

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { FileViewer } from '../../src/components/FileViewer';
import type { ProjectFile } from '../../src/types';

function htmlFile(): ProjectFile {
  return {
    name: 'index.html',
    path: 'index.html',
    type: 'file',
    size: 128,
    mtime: 1710000000,
    kind: 'html',
    mime: 'text/html',
    artifactManifest: {
      schema: 'readable-studio.artifact-manifest.v1',
      kind: 'html',
      title: 'Preview',
      entry: 'index.html',
      renderer: 'html',
      exports: ['html'],
    },
  };
}

describe('FileViewer server rendering', () => {
  it('renders an HTML preview through the server entry point', () => {
    const markup = renderToStaticMarkup(
      <FileViewer
        projectId="project-1"
        projectKind="prototype"
        file={htmlFile()}
        liveHtml="<html><body>Preview</body></html>"
      />,
    );

    expect(markup).toContain('data-testid="artifact-preview-frame"');
    expect(markup).toContain('data-readable-render-mode="url-load"');
  });
});
