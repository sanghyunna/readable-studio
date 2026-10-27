import type { ContextUsageSnapshot } from '@readable-studio/contracts';
import { useT } from '../i18n';
import styles from './ContextUsageMeter.module.css';

const number = new Intl.NumberFormat('en', { maximumFractionDigits: 3, useGrouping: false });
const percentage = new Intl.NumberFormat('en', { maximumFractionDigits: 1, useGrouping: false });

export function ContextUsageMeter({ snapshot }: { snapshot: ContextUsageSnapshot | null }) {
  const t = useT();
  const used = snapshot?.usedTokens;
  const limit = snapshot?.limitTokens;
  const known = (snapshot?.state === 'measured' || snapshot?.state === 'estimated')
    && ['runtime', 'metadata', 'model-table'].includes(snapshot.limitSource)
    && typeof used === 'number' && Number.isSafeInteger(used) && used >= 0
    && typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0;
  const percent = known ? used / limit * 100 : null;
  const label = percent === null ? '—' : `${percentage.format(percent)}%`;
  const usage = known ? `${number.format(used / 1000)}k/${number.format(limit / 1000)}k` : '';
  const tooltip = known
    ? snapshot?.state === 'estimated' ? t('chat.contextUsage.estimated', { usage }) : usage
    : snapshot?.reason === 'compacting'
      ? t('chat.contextUsage.compacting')
      : snapshot?.reason && snapshot.reason !== 'not-reported' && snapshot.reason !== 'invalid-data'
        ? t('chat.contextUsage.refreshing')
        : t('chat.contextUsage.unknown');

  return (
    <span className={styles.slot}>
      <span
        className={`${styles.meter} readable-tooltip`}
        data-testid="context-usage-meter"
        data-tooltip={tooltip}
        tabIndex={0}
        role={known ? 'meter' : 'img'}
        aria-label={known ? t('chat.contextUsage.label') : `${t('chat.contextUsage.label')}: ${tooltip}`}
        aria-valuemin={known ? 0 : undefined}
        aria-valuemax={known ? Math.max(used, limit) : undefined}
        aria-valuenow={known ? used : undefined}
        aria-valuetext={known ? `${label} · ${tooltip}` : undefined}
      >
        <span className={styles.track} aria-hidden="true">
          <span
            className={styles.fill}
            data-testid="context-usage-fill"
            hidden={!known}
            style={percent === null ? undefined : { width: `${Math.min(100, percent)}%` }}
          />
        </span>
        <span className={styles.percent} aria-hidden="true">{label}</span>
      </span>
    </span>
  );
}
