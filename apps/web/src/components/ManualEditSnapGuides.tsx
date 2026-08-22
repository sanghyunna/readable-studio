import type { ManualEditSnapGuide } from '../edit-mode/movement-session';
import styles from './ManualEditSnapGuides.module.css';

export type ManualEditSnapGuidesProps = {
  guides: { vertical: ManualEditSnapGuide | null; horizontal: ManualEditSnapGuide | null };
  /** Host px per rect px. */
  scale: number;
  /** Canvas offset in host px. */
  offsetX?: number;
  offsetY?: number;
};

// rect space -> host px: host = offset + rect * scale.
function guideStyle(
  guide: ManualEditSnapGuide,
  scale: number,
  offsetX: number,
  offsetY: number,
): { left: number; top: number; width: number; height: number } {
  if (guide.axis === 'x') {
    const top = Math.min(guide.y1, guide.y2);
    return {
      left: offsetX + guide.x1 * scale,
      top: offsetY + top * scale,
      width: 1,
      height: Math.max(1, Math.abs(guide.y2 - guide.y1) * scale),
    };
  }
  const left = Math.min(guide.x1, guide.x2);
  return {
    left: offsetX + left * scale,
    top: offsetY + guide.y1 * scale,
    width: Math.max(1, Math.abs(guide.x2 - guide.x1) * scale),
    height: 1,
  };
}

export function ManualEditSnapGuides({ guides, scale, offsetX = 0, offsetY = 0 }: ManualEditSnapGuidesProps) {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const active = [guides.vertical, guides.horizontal].filter(
    (guide): guide is ManualEditSnapGuide => guide !== null,
  );
  if (active.length === 0) return null;

  return (
    <>
      {active.map((guide) => (
        <div
          key={guide.axis}
          data-testid="manual-edit-snap-guide"
          data-axis={guide.axis}
          className={styles.guide}
          style={guideStyle(guide, safeScale, offsetX, offsetY)}
          aria-hidden="true"
        />
      ))}
    </>
  );
}
