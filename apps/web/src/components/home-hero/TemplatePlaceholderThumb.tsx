// Designed static thumb for a Hub template that has nothing to paint: no
// shipped WebP, no daemon bake, no example page in its manifest (the
// research-style report scenarios ship only a SKILL.md). Instead of a letter
// glyph or a blank iframe, the card draws the SHAPE of what the template
// produces — a paper sheet, a 16:9 slide or a browser window — with the type
// icon + label as a kicker, the template's localized title as the document's
// own heading, and faint body lines underneath. Pure CSS, no network, themed
// through the shared tokens so light and dark follow automatically.

import { Icon, type IconName } from '../Icon';
import type { HubTemplatePlaceholderFrame } from './templateCarousel';
import styles from './TemplatePlaceholderThumb.module.css';

interface Props {
  frame: HubTemplatePlaceholderFrame;
  icon: IconName;
  // Localized type label ("보고서" / "Reports") shown next to the icon.
  label: string;
  // Localized template title, rendered as the document's heading.
  title: string;
}

// Body-line widths as a fraction of the sheet, chosen so the block reads as
// justified prose with a short last line; the deck variant uses the first two.
const LINES = [100, 92, 96, 64] as const;

export function TemplatePlaceholderThumb({ frame, icon, label, title }: Props) {
  return (
    <span
      className={`${styles.root} ${styles[frame]}`}
      data-testid="hub-template-placeholder"
      data-frame={frame}
      aria-hidden
    >
      <span className={styles.sheet}>
        {frame === 'website' ? (
          <span className={styles.chrome}>
            <span className={styles.dot} />
            <span className={styles.dot} />
            <span className={styles.dot} />
            <span className={styles.address} />
          </span>
        ) : null}
        <span className={styles.page}>
          <span className={styles.kicker}>
            <Icon name={icon} size={11} />
            <span className={styles.kickerText}>{label}</span>
          </span>
          <span className={styles.heading}>{title}</span>
          <span className={styles.lines}>
            {LINES.map((width, index) => (
              <span key={index} className={styles.line} style={{ width: `${width}%` }} />
            ))}
          </span>
        </span>
      </span>
    </span>
  );
}
