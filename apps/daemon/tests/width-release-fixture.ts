import { editWidthRelease, type WidthReleaseSuccess } from '@readable-studio/html-edit';

export function releasedFixture(source = '<p data-readable-id="copy" style="color:red; max-width:30ch !important">Text</p>', targetId = 'copy'): WidthReleaseSuccess {
  const result = editWidthRelease(source, {
    kind: 'apply', expectedSource: source, target: { targetId }, preferredCssPx: 720,
    causes: ['own-max-width'], declarations: [
      { property: 'width', value: 'min(720px, 100%)', priority: '' },
      { property: 'max-width', value: 'stretch', priority: '' },
    ],
    provenance: [{ property: 'max-width', value: '30ch', priority: 'important', selector: '[title="a&b"] </script>', conditions: ['(width < 800px)'] }],
  });
  if (!result.ok) throw new Error(result.conflict.reason);
  return result;
}
