// Compact last-activity labels for the rail.
//
// The rail rows are ~13px wide-constrained, so they carry the short form the
// mockup uses ("4m", "2h", "3d") rather than the long "N minutes ago" phrasing
// the chat transcript uses. Anything past a week degrades to a locale date,
// because "63d" stops being a time a human can read at a glance.

import type { Dict } from '../../i18n/types';

type TranslateFn = (key: keyof Dict, vars?: Record<string, string | number>) => string;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export function relativeTimeShort(ts: number, t: TranslateFn): string {
  const diff = Math.max(0, Date.now() - ts);
  if (diff < MINUTE) return t('common.now');
  if (diff < HOUR) return t('common.minutesShort', { n: Math.floor(diff / MINUTE) });
  if (diff < DAY) return t('common.hoursShort', { n: Math.floor(diff / HOUR) });
  if (diff < WEEK) return t('common.daysShort', { n: Math.floor(diff / DAY) });
  if (diff < 4 * WEEK) return t('common.weeksShort', { n: Math.floor(diff / WEEK) });
  return new Date(ts).toLocaleDateString();
}
