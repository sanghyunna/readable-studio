// Page-level style controls (background, base font, base size) for manual-edit
// mode. Extracted from ManualEditPanel so the same section renders both in the
// floating fallback card and in the left-panel inspector. Emits one changed
// field at a time through the shared normalize pipeline.
import { useState } from 'react';
import type { ManualEditStyles } from '../edit-mode/types';
import { normalizeManualEditStyles } from './ManualEditPanel';
import { ColorRow, FontSelectRow, NumberRow, Section } from './ManualEditInspectorRows';

export function ManualEditPageSection({
  title = 'PAGE',
  enabled,
  onStyleChange,
  onError,
  onInvalidStyle,
}: {
  title?: string;
  enabled: boolean;
  onStyleChange: (id: string, styles: Partial<ManualEditStyles>, label: string) => void;
  onError: (message: string) => void;
  onInvalidStyle?: (id: string, keys: Array<keyof ManualEditStyles>) => void;
}) {
  const [bg, setBg] = useState('');
  const [font, setFont] = useState('');
  const [size, setSize] = useState('');

  const emit = (styles: Partial<ManualEditStyles>) => {
    const normalized = normalizeManualEditStyles(styles, { layoutEnabled: true });
    if (!normalized.ok) {
      onError('error' in normalized ? normalized.error : 'Invalid style value.');
      onInvalidStyle?.('__body__', Object.keys(styles) as Array<keyof ManualEditStyles>);
      return;
    }
    onError('');
    onStyleChange('__body__', normalized.styles, 'Page styles');
  };

  return (
    <div className="cc-inspector">
      <Section title={title}>
        {enabled ? (
          <>
            <ColorRow
              label="Background"
              value={bg}
              onChange={(value) => {
                setBg(value);
                emit({ backgroundColor: value });
              }}
            />
            <FontSelectRow
              label="Font"
              value={font}
              onChange={(value) => {
                setFont(value);
                emit({ fontFamily: value });
              }}
            />
            <NumberRow
              label="Base size"
              value={size}
              unit="px"
              autoUnit
              onChange={(value) => {
                setSize(value);
                emit({ fontSize: value });
              }}
            />
          </>
        ) : (
          <p className="cc-section-hint">Page styles are available only for full HTML documents.</p>
        )}
      </Section>
    </div>
  );
}
