// The Hub-chrome `저사양 모드` control. One pressed-state button that mirrors
// `AppConfig.performanceProfile`; the Settings > Appearance switch writes the
// same field, so the two never disagree. Never a checkbox.

import { ToggleButton } from '@readable-studio/components';

import { useT } from '../../i18n';
import { Icon } from '../Icon';
import styles from './HubPerformanceToggle.module.css';

export type PerformanceProfile = 'full' | 'low';

interface Props {
  profile: PerformanceProfile;
  onProfileChange: (profile: PerformanceProfile) => void;
}

export function HubPerformanceToggle({ profile, onProfileChange }: Props) {
  const t = useT();
  const low = profile === 'low';
  return (
    <ToggleButton
      className={styles.toggle}
      data-testid="hub-low-spec-toggle"
      pressed={low}
      onPressedChange={(pressed) => onProfileChange(pressed ? 'low' : 'full')}
      title={t('hub.lowSpecModeHint')}
    >
      <span className={styles.glyph} aria-hidden="true">
        <Icon name="sparkles" size={13} strokeWidth={1.7} />
      </span>
      <span className={styles.label}>{t('hub.lowSpecMode')}</span>
    </ToggleButton>
  );
}
