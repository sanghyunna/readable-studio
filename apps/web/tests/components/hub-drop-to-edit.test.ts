// Pure gate in front of the Hub drop-to-edit import: exactly one document, in
// a format the workspace opens as an editable document.

import { describe, expect, it } from 'vitest';

import {
  classifyHubDrop,
  documentProjectName,
} from '../../src/components/hub/drop-to-edit';

function file(name: string): File {
  return new File(['x'], name);
}

describe('classifyHubDrop', () => {
  it('accepts exactly one HTML or Markdown document', () => {
    expect(classifyHubDrop([file('report.html')])).toEqual({ kind: 'accept', file: expect.any(File) });
    expect(classifyHubDrop([file('Report.HTM')])).toMatchObject({ kind: 'accept' });
    expect(classifyHubDrop([file('notes.md')])).toMatchObject({ kind: 'accept' });
  });

  it('rejects an empty drop', () => {
    expect(classifyHubDrop([])).toEqual({ kind: 'empty' });
  });

  it('rejects several files at once before looking at their types', () => {
    expect(classifyHubDrop([file('a.html'), file('b.png')])).toEqual({ kind: 'multiple', count: 2 });
  });

  it('rejects formats the workspace cannot open as an editable document', () => {
    for (const name of ['photo.png', 'deck.pptx', 'archive.zip', 'index.html.bak', 'README']) {
      expect(classifyHubDrop([file(name)])).toEqual({ kind: 'unsupported', name });
    }
  });
});

describe('documentProjectName', () => {
  it('names the project after the document, without its extension', () => {
    expect(documentProjectName('Quarterly report.html')).toBe('Quarterly report');
    expect(documentProjectName('분기-보고서.md')).toBe('분기-보고서');
  });

  it('never yields an empty name', () => {
    expect(documentProjectName('.html')).toBe('.html');
    expect(documentProjectName('   ')).toBe('Document');
  });
});
