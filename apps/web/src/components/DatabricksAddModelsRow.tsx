// The trailing "Add models" row of the Databricks model dropdown.
//
// It closes every Databricks model list, in the Hub and in the workspace, and
// it is an action rather than an option: no `role="option"`, no model id in
// any callback, nothing that could be stored as a selection. The row is
// visually quiet on purpose so it reads as "manage the catalogue" below the
// real model rows instead of competing with them.

import { useT } from '../i18n';
import { DATABRICKS_ADD_MODELS_ACTION_ID } from './databricksModels';
import { Icon } from './Icon';
import styles from './DatabricksAddModelsRow.module.css';

interface Props {
  onActivate: () => void;
  /** Visual separator above the row; omit when the row is the only row. */
  separated?: boolean;
  disabled?: boolean;
  'data-testid'?: string;
}

export function DatabricksAddModelsRow({
  onActivate,
  separated = true,
  disabled = false,
  'data-testid': testId = 'inline-model-switcher-model-action-add-databricks-models',
}: Props) {
  const t = useT();
  return (
    <button
      type="button"
      className={separated ? styles.rowSeparated : styles.row}
      data-model-action={DATABRICKS_ADD_MODELS_ACTION_ID}
      data-testid={testId}
      disabled={disabled}
      onClick={(event) => {
        event.preventDefault();
        onActivate();
      }}
    >
      <span className={styles.glyph} aria-hidden="true">
        <Icon name="plus" size={12} strokeWidth={2} />
      </span>
      <span className={styles.label}>{t('databricks.addModels')}</span>
    </button>
  );
}
