// Typography controls for a selected text/link/token element, shared between
// the horizontal docked toolbar (`layout="bar"`) and the vertical left-panel
// inspector (`layout="stack"`). Whole-element controls call onStyleField
// (validation/preview/save match the floating panel). B/I/U are selection-level
// rich text that drive the execCommand bridge via onRichFormat.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Button } from '@readable-studio/components';
import { useT } from '../i18n';
import type { ManualEditStyles, ManualEditTarget } from '../edit-mode/types';
import { RemixIcon } from './RemixIcon';
import {
  ALIGN_OPTS,
  EDITOR_SWATCH_COLORS,
  FONT_OPTS,
  WEIGHT_OPTS,
  fontFamilyLabel,
  normalizeColorForPicker,
  stripPxUnit,
} from './ManualEditPanel';
import { useSystemFonts } from './useSystemFonts';
import { quoteFontFamily, systemFontOptions, type FontOption } from './font-options';
import styles from './ManualEditTextControls.module.css';

export interface ManualEditRichFormatState {
  editing: boolean;
  hasSelection: boolean;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

export interface ManualEditTextControlsProps {
  layout: 'bar' | 'stack';
  target: ManualEditTarget;
  styles: ManualEditStyles;
  richFormat: ManualEditRichFormatState;
  onStyleField: (key: keyof ManualEditStyles, value: string) => void;
  onRichFormat: (command: 'bold' | 'italic' | 'underline') => void;
}

export function ManualEditTextControls(props: ManualEditTextControlsProps) {
  return props.layout === 'stack' ? <TextStack {...props} /> : <TextBar {...props} />;
}

// Horizontal docked bar. Markup preserved from the original
// ManualEditTypographyToolbar so its behaviour/tests round-trip unchanged.
function TextBar({
  styles: elementStyles,
  richFormat,
  onStyleField,
  onRichFormat,
}: ManualEditTextControlsProps) {
  const t = useT();
  const richDisabled = !(richFormat.editing && richFormat.hasSelection);
  const { families } = useSystemFonts();
  const systemFonts = useMemo(() => systemFontOptions(families, FONT_OPTS), [families]);
  const fontOptions = useMemo(() => [...FONT_OPTS, ...systemFonts], [systemFonts]);

  const richButton = (
    command: 'bold' | 'italic' | 'underline',
    icon: string,
    label: string,
    pressed: boolean,
  ) => (
    <Button
      variant="subtle"
      size="icon"
      className={`readable-tooltip${pressed ? ` ${styles.pressed}` : ''}`}
      aria-label={label}
      aria-pressed={pressed}
      data-tooltip={label}
      disabled={richDisabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onRichFormat(command)}
    >
      <RemixIcon name={icon} size={15} />
    </Button>
  );

  const alignButton = (value: string, icon: string, label: string) => {
    const pressed = elementStyles.textAlign === value;
    return (
      <Button
        variant="subtle"
        size="icon"
        className={`readable-tooltip${pressed ? ` ${styles.pressed}` : ''}`}
        aria-label={label}
        aria-pressed={pressed}
        data-tooltip={label}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onStyleField('textAlign', pressed ? '' : value)}
      >
        <RemixIcon name={icon} size={15} />
      </Button>
    );
  };

  return (
    <>
      <FontCombobox
        label={t('manualEdit.typography.font')}
        value={elementStyles.fontFamily}
        options={fontOptions}
        onChange={(value) => onStyleField('fontFamily', value)}
      />

      <Stepper
        label={t('manualEdit.typography.fontSize')}
        increaseLabel={`${t('manualEdit.typography.fontSize')} ${t('manualEdit.typography.increase').toLowerCase()}`}
        decreaseLabel={`${t('manualEdit.typography.fontSize')} ${t('manualEdit.typography.decrease').toLowerCase()}`}
        value={elementStyles.fontSize}
        unit="px"
        onChange={(v) => onStyleField('fontSize', v)}
      />

      <span className={styles.divider} aria-hidden="true" />

      <div className={styles.group}>
        {richButton('bold', 'bold', t('manualEdit.typography.bold'), richFormat.bold)}
        {richButton('italic', 'italic', t('manualEdit.typography.italic'), richFormat.italic)}
        {richButton('underline', 'underline', t('manualEdit.typography.underline'), richFormat.underline)}
      </div>

      <span className={styles.divider} aria-hidden="true" />

      <label className={styles.group}>
        <select
          className={styles.select}
          aria-label={t('manualEdit.typography.weight')}
          data-tooltip={t('manualEdit.typography.weight')}
          value={elementStyles.fontWeight}
          onChange={(e) => onStyleField('fontWeight', e.currentTarget.value)}
        >
          {WEIGHT_OPTS.map((opt) => (
            <option key={opt || '__'} value={opt}>{opt || '–'}</option>
          ))}
        </select>
      </label>

      <ColorControl
        label={t('manualEdit.typography.textColor')}
        value={elementStyles.color}
        onChange={(v) => onStyleField('color', v)}
      />

      <span className={styles.divider} aria-hidden="true" />

      <div className={styles.group}>
        {alignButton(ALIGN_OPTS[1]!, 'align-left', t('manualEdit.typography.alignLeft'))}
        {alignButton(ALIGN_OPTS[2]!, 'align-center', t('manualEdit.typography.alignCenter'))}
        {alignButton(ALIGN_OPTS[3]!, 'align-right', t('manualEdit.typography.alignRight'))}
        {alignButton(ALIGN_OPTS[4]!, 'align-justify', t('manualEdit.typography.alignJustify'))}
      </div>

      <span className={styles.divider} aria-hidden="true" />

      <Stepper
        label={t('manualEdit.typography.lineHeight')}
        increaseLabel={`${t('manualEdit.typography.lineHeight')} ${t('manualEdit.typography.increase').toLowerCase()}`}
        decreaseLabel={`${t('manualEdit.typography.lineHeight')} ${t('manualEdit.typography.decrease').toLowerCase()}`}
        value={elementStyles.lineHeight}
        unit=""
        onChange={(v) => onStyleField('lineHeight', v)}
      />

      <Stepper
        label={t('manualEdit.typography.letterSpacing')}
        increaseLabel={`${t('manualEdit.typography.letterSpacing')} ${t('manualEdit.typography.increase').toLowerCase()}`}
        decreaseLabel={`${t('manualEdit.typography.letterSpacing')} ${t('manualEdit.typography.decrease').toLowerCase()}`}
        value={elementStyles.letterSpacing}
        unit="px"
        onChange={(v) => onStyleField('letterSpacing', v)}
      />
    </>
  );
}

// Always-visible, Office-familiar quick formatting surface for the left inspector.
function TextStack({
  styles: elementStyles,
  richFormat,
  onStyleField,
  onRichFormat,
}: ManualEditTextControlsProps) {
  const t = useT();
  const richDisabled = !(richFormat.editing && richFormat.hasSelection);
  const { families } = useSystemFonts();
  const systemFonts = useMemo(() => systemFontOptions(families, FONT_OPTS), [families]);
  const fontOptions = useMemo(() => [...FONT_OPTS, ...systemFonts], [systemFonts]);
  const richButton = (
    command: 'bold' | 'italic' | 'underline',
    icon: string,
    label: string,
    pressed: boolean,
  ) => (
    <Button
      variant="subtle"
      size="icon"
      className={`${styles.quickIcon}${pressed ? ` ${styles.pressed}` : ''}`}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      disabled={richDisabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onRichFormat(command)}
    >
      <RemixIcon name={icon} size={15} />
    </Button>
  );
  const alignButton = (value: string, icon: string, label: string) => {
    const pressed = elementStyles.textAlign === value;
    return (
      <Button
        variant="subtle"
        size="icon"
        className={`${styles.quickIcon}${pressed ? ` ${styles.pressed}` : ''}`}
        aria-label={label}
        aria-pressed={pressed}
        title={label}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onStyleField('textAlign', pressed ? '' : value)}
      >
        <RemixIcon name={icon} size={15} />
      </Button>
    );
  };
  return (
    <section className={`${styles.quickPanel} cc-section`}>
      <header className={`${styles.quickHeader} cc-section-head`}>
        <strong>{t('manualEdit.quickFormat')}</strong>
        <span>{t('manualEdit.sectionText')}</span>
      </header>
      <div className={`${styles.quickBody} cc-section-body`}>
        <div className={`${styles.quickField} ${styles.quickFont}`}>
          <RemixIcon name="font-size-2" size={15} />
          <span className={styles.quickLabel}>{t('manualEdit.typography.font')}</span>
          <FontCombobox
            stacked
            label={t('manualEdit.typography.font')}
            value={elementStyles.fontFamily}
            options={fontOptions}
            onChange={(value) => onStyleField('fontFamily', value)}
          />
        </div>

        <div className={styles.quickGrid}>
          <div className={styles.quickField}>
            <RemixIcon name="font-size" size={15} />
            <Stepper
              label={t('manualEdit.typography.fontSize')}
              increaseLabel={`${t('manualEdit.typography.fontSize')} ${t('manualEdit.typography.increase').toLowerCase()}`}
              decreaseLabel={`${t('manualEdit.typography.fontSize')} ${t('manualEdit.typography.decrease').toLowerCase()}`}
              value={elementStyles.fontSize}
              unit="px"
              onChange={(value) => onStyleField('fontSize', value)}
            />
            <em className={styles.quickUnit}>px</em>
          </div>
          <div className={styles.quickField}>
            <RemixIcon name="palette-line" size={15} />
            <span className={styles.quickLabel}>{t('manualEdit.typography.textColor')}</span>
            <input
              className={styles.quickColorInput}
              aria-label={t('manualEdit.typography.textColorValue')}
              value={elementStyles.color}
              placeholder="—"
              onChange={(event) => onStyleField('color', event.currentTarget.value)}
            />
            <ColorControl
              label={t('manualEdit.typography.textColor')}
              value={elementStyles.color}
              onChange={(value) => onStyleField('color', value)}
            />
          </div>
        </div>

        <div className={styles.quickSplit}>
          <div className={styles.quickStrip} role="group" aria-label={t('manualEdit.typography.style')}>
            {richButton('bold', 'bold', t('manualEdit.typography.bold'), richFormat.bold)}
            {richButton('italic', 'italic', t('manualEdit.typography.italic'), richFormat.italic)}
            {richButton('underline', 'underline', t('manualEdit.typography.underline'), richFormat.underline)}
          </div>
          <div className={styles.quickStrip} role="group" aria-label={t('manualEdit.typography.alignment')}>
            {alignButton(ALIGN_OPTS[1]!, 'align-left', t('manualEdit.typography.alignLeft'))}
            {alignButton(ALIGN_OPTS[2]!, 'align-center', t('manualEdit.typography.alignCenter'))}
            {alignButton(ALIGN_OPTS[3]!, 'align-right', t('manualEdit.typography.alignRight'))}
            {alignButton(ALIGN_OPTS[4]!, 'align-justify', t('manualEdit.typography.alignJustify'))}
          </div>
        </div>

        <div className={styles.quickGrid}>
          <label className={styles.quickField}>
            <RemixIcon name="line-height" size={15} />
            <span className={styles.quickLabel}>{t('manualEdit.typography.lineHeight')}</span>
            <input
              className={styles.quickInput}
              aria-label={t('manualEdit.typography.lineHeight')}
              inputMode="decimal"
              value={elementStyles.lineHeight}
              onChange={(event) => onStyleField('lineHeight', event.currentTarget.value)}
            />
          </label>
          <label className={styles.quickField}>
            <RemixIcon name="text-spacing" size={15} />
            <span className={styles.quickLabel}>{t('manualEdit.typography.letterSpacing')}</span>
            <input
              className={styles.quickInput}
              aria-label={t('manualEdit.typography.letterSpacing')}
              inputMode="decimal"
              value={elementStyles.letterSpacing === 'normal' ? '0' : stripPxUnit(elementStyles.letterSpacing)}
              onChange={(event) => onStyleField('letterSpacing', emitStepperValue(event.currentTarget.value, 'px'))}
            />
            <em className={styles.quickUnit}>px</em>
          </label>
        </div>

        <label className={`${styles.quickField} ${styles.quickWeight}`}>
          <RemixIcon name="font-size-2" size={15} />
          <span className={styles.quickLabel}>{t('manualEdit.typography.weight')}</span>
          <select
            aria-label={t('manualEdit.typography.weight')}
            value={elementStyles.fontWeight}
            onChange={(event) => onStyleField('fontWeight', event.currentTarget.value)}
          >
            {WEIGHT_OPTS.map((option) => <option key={option || '__'} value={option}>{option || '—'}</option>)}
          </select>
        </label>
      </div>
    </section>
  );
}

function normalizedFontLabel(value: string): string {
  return value.trim().toLowerCase();
}

export function filterFontOptions(
  options: ReadonlyArray<FontOption>,
  query: string,
): FontOption[] {
  const needle = normalizedFontLabel(query);
  if (!needle) return [...options];
  const prefix: FontOption[] = [];
  const substring: FontOption[] = [];
  for (const option of options) {
    const label = normalizedFontLabel(option.label);
    if (label.startsWith(needle)) prefix.push(option);
    else if (label.includes(needle)) substring.push(option);
  }
  return [...prefix, ...substring];
}

function exactFontOption(options: ReadonlyArray<FontOption>, input: string): FontOption | undefined {
  const needle = normalizedFontLabel(input);
  return options.find((option) => normalizedFontLabel(option.label) === needle);
}

export function fontValueFromComboboxInput(
  input: string,
  options: ReadonlyArray<FontOption>,
  fallbackToTopOrCustom: boolean,
  currentValue = '',
): string | null {
  const trimmed = input.trim();
  if (!trimmed) return '';
  if (currentValue && normalizedFontLabel(trimmed) === normalizedFontLabel(fontFamilyLabel(currentValue))) {
    return currentValue;
  }
  const exact = exactFontOption(options, trimmed);
  if (exact) return exact.value;
  if (!fallbackToTopOrCustom) return null;
  return filterFontOptions(options, trimmed)[0]?.value ?? quoteFontFamily(trimmed);
}

function FontCombobox({
  label, value, options, onChange, stacked = false,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<FontOption>;
  onChange: (value: string) => void;
  stacked?: boolean;
}) {
  const listboxId = useId();
  const ref = useRef<HTMLSpanElement | null>(null);
  const skipBlurAfterOutsideMouseDownRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState(fontFamilyLabel(value));
  const [activeIndex, setActiveIndex] = useState(0);
  const filtered = useMemo(() => filterFontOptions(options, inputValue), [inputValue, options]);

  const reset = useCallback(() => {
    setInputValue(fontFamilyLabel(value));
    setOpen(false);
    setActiveIndex(0);
  }, [value]);
  const commit = useCallback((next: string) => {
    if (next !== value) onChange(next);
    setInputValue(fontFamilyLabel(next));
    setOpen(false);
    setActiveIndex(0);
  }, [onChange, value]);
  const resolveTypedInput = useCallback(() => {
    const next = fontValueFromComboboxInput(inputValue, options, false, value);
    if (next === null) reset();
    else commit(next);
  }, [commit, inputValue, options, reset, value]);

  useEffect(() => setInputValue(fontFamilyLabel(value)), [value]);
  useEffect(() => setActiveIndex(0), [inputValue, options]);
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      skipBlurAfterOutsideMouseDownRef.current = true;
      resolveTypedInput();
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open, resolveTypedInput]);

  return (
    <span className={`${styles.fontCombobox}${stacked ? ` ${styles.fontComboboxStacked}` : ''}`} ref={ref}>
      <input
        className={`${styles.fontInput}${stacked ? ` ${styles.fontInputStacked}` : ''}`}
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open && filtered[activeIndex] ? `${listboxId}-${activeIndex}` : undefined}
        data-tooltip={label}
        value={inputValue}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          skipBlurAfterOutsideMouseDownRef.current = false;
          setInputValue(event.currentTarget.value);
          setOpen(true);
        }}
        onBlur={() => {
          if (skipBlurAfterOutsideMouseDownRef.current) {
            skipBlurAfterOutsideMouseDownRef.current = false;
            return;
          }
          resolveTypedInput();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            reset();
            return;
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
            if (!filtered.length) return;
            setActiveIndex((index) => (
              event.key === 'ArrowDown'
                ? (index + 1) % filtered.length
                : (index - 1 + filtered.length) % filtered.length
            ));
            return;
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            const matched = fontValueFromComboboxInput(inputValue, options, false, value);
            commit(matched ?? filtered[activeIndex]?.value ?? fontValueFromComboboxInput(inputValue, options, true) ?? '');
          }
        }}
      />
      {open ? (
        <div className={styles.fontPopover} id={listboxId} role="listbox">
          {filtered.map((option, index) => (
            <div
              key={`${option.label}:${option.value}`}
              id={`${listboxId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className={`${styles.fontOption}${index === activeIndex ? ` ${styles.fontOptionActive}` : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => commit(option.value)}
            >
              {option.label}
            </div>
          ))}
        </div>
      ) : null}
    </span>
  );
}

// px mode strips/emits px; '' mode keeps the value unitless (line-height).
function emitStepperValue(raw: string, unit: 'px' | ''): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  if (unit === 'px') {
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return `${trimmed}px`;
    if (/^-?\d+(\.\d+)?px$/i.test(trimmed)) return trimmed.toLowerCase();
    return raw;
  }
  return raw;
}

function Stepper({
  label, increaseLabel, decreaseLabel, value, unit, onChange,
}: {
  label: string;
  increaseLabel: string;
  decreaseLabel: string;
  value: string;
  unit: 'px' | '';
  onChange: (value: string) => void;
}) {
  const display = stripPxUnit(value);
  const numeric = /^-?\d+(\.\d+)?$/.test(display.trim());
  // ponytail: buttons floor at 0; type a negative directly if a control ever needs it.
  const step = (direction: -1 | 1) => {
    if (!numeric) return;
    onChange(emitStepperValue(String(Math.max(0, Number(display) + direction)), unit));
  };
  return (
    <span className={styles.stepper}>
      <button
        type="button"
        className={`${styles.step} readable-tooltip`}
        aria-label={decreaseLabel}
        data-tooltip={decreaseLabel}
        disabled={!numeric}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => step(-1)}
      >
        <RemixIcon name="subtract-line" size={13} />
      </button>
      <input
        className={styles.stepInput}
        aria-label={label}
        value={display}
        inputMode="decimal"
        onChange={(e) => onChange(emitStepperValue(e.currentTarget.value, unit))}
      />
      <button
        type="button"
        className={`${styles.step} readable-tooltip`}
        aria-label={increaseLabel}
        data-tooltip={increaseLabel}
        disabled={!numeric}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => step(1)}
      >
        <RemixIcon name="add-line" size={13} />
      </button>
    </span>
  );
}

function ColorControl({
  label, value, onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);
  return (
    <span className={styles.colorWrap} ref={ref}>
      <button
        type="button"
        className={`${styles.swatch} readable-tooltip`}
        style={{ '--swatch-color': value || 'transparent' } as CSSProperties}
        aria-label={label}
        data-tooltip={label}
        onClick={() => setOpen((v) => !v)}
      />
      {open ? (
        <div className={styles.colorPopover}>
          <div className={styles.colorGrid}>
            {EDITOR_SWATCH_COLORS.map((hex) => (
              <button
                key={hex}
                type="button"
                className={styles.colorTile}
                style={{ background: hex }}
                aria-label={hex}
                onClick={() => { onChange(hex); setOpen(false); }}
              />
            ))}
          </div>
          <input
            type="color"
            className={styles.colorNative}
            value={normalizeColorForPicker(value)}
            onChange={(e) => onChange(e.currentTarget.value)}
          />
        </div>
      ) : null}
    </span>
  );
}
