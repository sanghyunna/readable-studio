// Horizontal docked shape toolbar. A thin layout wrapper around the shared
// ManualEditShapeControls (bar layout); kept for the in-preview docked surface
// and any non-inspector use. The vertical inspector renders the same controls
// with `layout="stack"`.
import { ManualEditShapeControls, type ManualEditShapeControlsProps } from './ManualEditShapeControls';
import styles from './ManualEditShapeToolbar.module.css';

export function ManualEditShapeToolbar(props: Omit<ManualEditShapeControlsProps, 'layout'>) {
  return (
    <div className={styles.toolbar} data-testid="manual-edit-shape-toolbar">
      <ManualEditShapeControls layout="bar" {...props} />
    </div>
  );
}
