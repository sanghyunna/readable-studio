import { useT } from '../i18n';
import type { AgentInfo } from '../types';
import { Icon } from './Icon';
import styles from './ModelSourceNote.module.css';

/**
 * Quiet caption under a model list telling the user that the entries are
 * Readable Studio's own built-in defaults, not a catalogue the agent's CLI
 * actually reported. Renders nothing for a live catalogue so verified lists
 * stay clean. The daemon always sets `modelsSource`; an absent value is a
 * web-side fixture, which we treat as live rather than inventing a warning.
 */
export function ModelSourceNote({
  agent,
  id,
  testId,
}: {
  readonly agent: Pick<AgentInfo, 'name' | 'modelsSource'>;
  readonly id: string;
  readonly testId: string;
}) {
  const t = useT();
  if (agent.modelsSource !== 'fallback') return null;
  return (
    <p id={id} className={styles.note} data-testid={testId}>
      <Icon name="info" size={12} className={styles.icon} aria-hidden="true" />
      <span>{t('modelSource.builtInDefaults', { agent: agent.name })}</span>
    </p>
  );
}
