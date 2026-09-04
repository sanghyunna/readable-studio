import { useId, useState, type ReactNode } from 'react';

import { useT } from '../i18n';
import { Icon } from './Icon';
import styles from './CollapsibleErrorText.module.css';

/**
 * Shared presentation for agent/provider error text.
 *
 * Provider failures routinely arrive as multi-paragraph JSON dumps that push
 * the whole conversation down. This component collapses only that case: the
 * leading portion stays visible, and a real button expands the rest in place.
 * It changes nothing about error handling — the error still surfaces, its
 * recovery actions still render beside it, and the full text stays selectable
 * once expanded.
 */

// Preview budget. Two visual lines of the error card at its usual width is
// roughly 220 characters; anything under that already fits, so it renders as
// plain text with no toggle. The line cap catches short-but-tall dumps (stack
// traces, JSON) that would otherwise pass the character check while still
// reflowing the log.
export const ERROR_PREVIEW_CHAR_BUDGET = 220;
export const ERROR_PREVIEW_LINE_BUDGET = 2;

/**
 * Whether `text` overflows the preview budget and therefore earns a toggle.
 * Content-based on purpose: the budget IS the preview, so the decision is
 * deterministic and identical on the server, in tests, and in the browser.
 */
export function overflowsErrorPreview(text: string): boolean {
  return (
    text.length > ERROR_PREVIEW_CHAR_BUDGET ||
    text.split('\n').length > ERROR_PREVIEW_LINE_BUDGET
  );
}

/** The leading portion shown while collapsed, with a trailing ellipsis. */
export function errorPreviewText(text: string): string {
  if (!overflowsErrorPreview(text)) return text;
  const lineClipped = text.split('\n').slice(0, ERROR_PREVIEW_LINE_BUDGET).join('\n');
  const clipped = lineClipped.slice(0, ERROR_PREVIEW_CHAR_BUDGET);
  return `${clipped.trimEnd()}…`;
}

/**
 * Linkify bare URLs inside error text so support links stay clickable in both
 * the collapsed preview and the expanded body.
 */
export function renderErrorTextSegments(detail: string): ReactNode {
  const segments: ReactNode[] = [];
  const urlRe = /(https?:\/\/[^\s)<>"}\]]+)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = urlRe.exec(detail))) {
    if (match.index > lastIndex) {
      segments.push(detail.slice(lastIndex, match.index));
    }
    const [href, suffix] = splitErrorTextUrlPunctuation(match[1]!);
    segments.push(
      <a
        key={`url-${key++}`}
        className="md-link md-link-bare"
        href={href}
        target="_blank"
        rel="noreferrer noopener"
      >
        {href}
      </a>,
    );
    if (suffix) segments.push(suffix);
    lastIndex = urlRe.lastIndex;
  }

  if (lastIndex < detail.length) {
    segments.push(detail.slice(lastIndex));
  }

  return <>{segments}</>;
}

function splitErrorTextUrlPunctuation(url: string): [string, string] {
  const match = /([.,!?;:，。！？；：、'"」』】》〉）}\]]+)$/.exec(url);
  if (!match?.[1]) return [url, ''];
  const trimmed = url.slice(0, -match[1].length);
  return trimmed ? [trimmed, match[1]] : [url, ''];
}

export function CollapsibleErrorText({
  text,
  className,
}: {
  text: string;
  className?: string | undefined;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const shellClass = className ? `${styles.shell} ${className}` : styles.shell;

  // Short errors keep their existing plain-text shape: no button, no
  // truncation, no extra landmark for a screen reader to walk past.
  if (!overflowsErrorPreview(text)) {
    return <span className={shellClass}>{renderErrorTextSegments(text)}</span>;
  }

  return (
    <span className={shellClass}>
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpanded((open) => !open)}
      >
        {/* Plain text, never linkified: an <a> inside a <button> is invalid
            interactive nesting. Links live in the expanded body below. */}
        <span className={styles.preview}>{expanded ? null : errorPreviewText(text)}</span>
        <span className={styles.affordance}>
          <span className={styles.affordanceLabel}>
            {expanded ? t('chat.errorTextCollapse') : t('chat.errorTextExpand')}
          </span>
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={11} />
        </span>
      </button>
      <span id={bodyId} className={styles.body} data-expanded={expanded ? 'true' : 'false'}>
        <span className={styles.bodyInner}>
          <span className={styles.full}>{renderErrorTextSegments(text)}</span>
        </span>
      </span>
    </span>
  );
}
