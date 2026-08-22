// Horizontal docked typography toolbar. A thin layout wrapper around the shared
// ManualEditTextControls (bar layout); kept for the in-preview docked surface
// and any non-inspector use. The vertical inspector renders the same controls
// with `layout="stack"`.
import type { ManualEditStyles, ManualEditTarget } from '../edit-mode/types';
import { ManualEditTextControls, type ManualEditRichFormatState } from './ManualEditTextControls';
import styles from './ManualEditTypographyToolbar.module.css';

export type { ManualEditRichFormatState };
export { filterFontOptions, fontValueFromComboboxInput } from './ManualEditTextControls';

export function ManualEditTypographyToolbar(props: {
  target: ManualEditTarget;
  styles: ManualEditStyles;
  richFormat: ManualEditRichFormatState;
  onStyleField: (key: keyof ManualEditStyles, value: string) => void;
  onRichFormat: (command: 'bold' | 'italic' | 'underline') => void;
}) {
  return (
    <div className={styles.toolbar}>
      <ManualEditTextControls layout="bar" {...props} />
    </div>
  );
}
