import { useState } from 'react';
import { Button } from '@readable-studio/components';
import { useT } from '../i18n';
import type { ManualEditStyles } from '../edit-mode/types';
import { stripPxUnit } from './ManualEditPanel';
import { RemixIcon } from './RemixIcon';
import styles from './ManualEditBoxModelControls.module.css';

type SpaceKind = 'padding' | 'margin';
type SpaceSide = 'top' | 'right' | 'bottom' | 'left';

const SIDES: readonly SpaceSide[] = ['top', 'right', 'bottom', 'left'];

export function ManualEditBoxModelControls({
  styles: elementStyles,
  onStyleField,
  onStyleFields,
}: {
  styles: ManualEditStyles;
  onStyleField: (key: keyof ManualEditStyles, value: string) => void;
  onStyleFields?: (styles: Partial<ManualEditStyles>) => void;
}) {
  const t = useT();
  const [activeKind, setActiveKind] = useState<SpaceKind>('padding');
  const [linked, setLinked] = useState<Record<SpaceKind, boolean>>(() => ({
    padding: spaceValuesEqual(elementStyles, 'padding'),
    margin: spaceValuesEqual(elementStyles, 'margin'),
  }));
  const labels = {
    padding: t('manualEdit.shape.padding'),
    margin: t('manualEdit.shape.margin'),
  };
  const descriptions = {
    padding: t('manualEdit.shape.paddingHelp'),
    margin: t('manualEdit.shape.marginHelp'),
  };
  const applyUpdates = (updates: Partial<ManualEditStyles>) => {
    if (onStyleFields) {
      onStyleFields(updates);
      return;
    }
    Object.entries(updates).forEach(([key, value]) => {
      onStyleField(key as keyof ManualEditStyles, value);
    });
  };
  const updateValue = (side: SpaceSide, raw: string) => {
    const value = emitSpaceValue(raw);
    if (linked[activeKind]) {
      applyUpdates(Object.fromEntries(
        SIDES.map((nextSide) => [spaceProperty(activeKind, nextSide), value]),
      ) as Partial<ManualEditStyles>);
      return;
    }
    onStyleField(spaceProperty(activeKind, side), value);
  };
  const resetValues = () => {
    applyUpdates(Object.fromEntries(
      SIDES.map((side) => [spaceProperty(activeKind, side), '0px']),
    ) as Partial<ManualEditStyles>);
  };

  return (
    <div className={styles.root}>
      <div className={styles.layerSwitch} role="group" aria-label={t('manualEdit.shape.spacing')}>
        {(['padding', 'margin'] as const).map((kind) => (
          <Button
            key={kind}
            variant="subtle"
            className={`${styles.kind}${activeKind === kind ? ` ${styles.kindActive}` : ''}`}
            aria-label={labels[kind]}
            aria-pressed={activeKind === kind}
            onClick={() => setActiveKind(kind)}
          >
            <span className={`${styles.kindMark} ${styles[kind]}`} />
            <span className={styles.kindCopy}>
              <strong>{labels[kind]}</strong>
              <small>{descriptions[kind]}</small>
            </span>
          </Button>
        ))}
      </div>

      <div className={`${styles.diagram} ${styles[`${activeKind}Active`]}`}>
        <Button
          variant="subtle"
          className={`${styles.ring} ${styles.marginRing}`}
          aria-label={t('manualEdit.spacing.selectMargin')}
          aria-pressed={activeKind === 'margin'}
          onClick={() => setActiveKind('margin')}
        >
          <span>{labels.margin}</span>
        </Button>
        <Button
          variant="subtle"
          className={`${styles.ring} ${styles.paddingRing}`}
          aria-label={t('manualEdit.spacing.selectPadding')}
          aria-pressed={activeKind === 'padding'}
          onClick={() => setActiveKind('padding')}
        >
          <span>{labels.padding}</span>
        </Button>
        <div className={styles.contentPreview}>
          <strong>{t('manualEdit.spacing.selectedElement')}</strong>
        </div>

        <div className={styles.values} data-space-kind={activeKind}>
          {SIDES.map((side) => {
            const property = spaceProperty(activeKind, side);
            const label = sideLabel(t, activeKind, side);
            return (
              <label key={side} className={`${styles.value} ${styles[side]}`}>
                <span className={styles.arrow}>{side === 'top' || side === 'bottom' ? '↕' : '↔'}</span>
                <input
                  aria-label={label}
                  inputMode="decimal"
                  value={stripPxUnit(elementStyles[property])}
                  onChange={(event) => updateValue(side, event.currentTarget.value)}
                />
                <em>px</em>
              </label>
            );
          })}
        </div>
      </div>
      <div className={styles.actions}>
        <span className={`${styles.activeCopy} ${styles[activeKind]}`}>
          {t('manualEdit.spacing.editing', { kind: labels[activeKind] })}
        </span>
        <Button
          variant="subtle"
          className={`${styles.action}${linked[activeKind] ? ` ${styles.actionActive}` : ''}`}
          aria-label={t('manualEdit.spacing.linkAll')}
          aria-pressed={linked[activeKind]}
          onClick={() => setLinked((current) => ({ ...current, [activeKind]: !current[activeKind] }))}
        >
          <RemixIcon name="link" size={13} />
          {t('manualEdit.spacing.linkAll')}
        </Button>
        <Button
          variant="subtle"
          className={styles.action}
          aria-label={t('manualEdit.spacing.resetAll')}
          onClick={resetValues}
        >
          {t('manualEdit.spacing.resetAll')}
        </Button>
      </div>
      <p className={styles.hint}>{t('manualEdit.spacing.diagramHint')}</p>
    </div>
  );
}

function spaceProperty(kind: SpaceKind, side: SpaceSide): keyof ManualEditStyles {
  return `${kind}${side[0]!.toUpperCase()}${side.slice(1)}` as keyof ManualEditStyles;
}

function emitSpaceValue(raw: string): string {
  const trimmed = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return `${trimmed}px`;
  if (/^-?\d+(\.\d+)?px$/i.test(trimmed)) return trimmed.toLowerCase();
  return raw;
}

function spaceValuesEqual(styles: ManualEditStyles, kind: SpaceKind): boolean {
  const values = SIDES.map((side) => styles[spaceProperty(kind, side)]);
  return values.every((value) => value === values[0]);
}

function sideLabel(
  t: ReturnType<typeof useT>,
  kind: SpaceKind,
  side: SpaceSide,
): string {
  const suffix = `${side[0]!.toUpperCase()}${side.slice(1)}` as 'Top' | 'Right' | 'Bottom' | 'Left';
  return t(`manualEdit.shape.${kind}${suffix}`);
}
