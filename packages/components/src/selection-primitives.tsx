import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react';

import { joinClassNames } from './class-names';
import styles from './selection-primitives.module.css';

type ControlledSelectionButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-pressed' | 'disabled' | 'onClick' | 'type'
> & {
  readonly disabled?: boolean;
  readonly pending?: boolean;
  readonly pressed: boolean;
  readonly onPressedChange: (pressed: boolean) => void;
};

export type SwitchProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-checked' | 'disabled' | 'onClick' | 'role' | 'type'
> & {
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly pending?: boolean;
  readonly stateText?: ReactNode;
  readonly onCheckedChange: (checked: boolean) => void;
};

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  {
    checked,
    children,
    className,
    disabled = false,
    pending = false,
    stateText,
    onCheckedChange,
    ...props
  },
  ref,
) {
  function handleClick(_event: MouseEvent<HTMLButtonElement>): void {
    if (disabled || pending) return;
    onCheckedChange(!checked);
  }

  return (
    <button
      {...props}
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-busy={pending || undefined}
      aria-disabled={pending || undefined}
      data-state={checked ? 'on' : 'off'}
      disabled={disabled}
      className={joinClassNames(styles.selectionControl, styles.switch, className)}
      onClick={handleClick}
    >
      {children === undefined ? null : <span className={styles.label}>{children}</span>}
      <span className={styles.track} aria-hidden="true">
        <span className={styles.thumb} />
      </span>
      {stateText === undefined ? null : <span className={styles.stateText}>{stateText}</span>}
    </button>
  );
});

export type ToggleButtonProps = ControlledSelectionButtonProps;

export const ToggleButton = forwardRef<HTMLButtonElement, ToggleButtonProps>(
  function ToggleButton(
    {
      children,
      className,
      disabled = false,
      pending = false,
      pressed,
      onPressedChange,
      ...props
    },
    ref,
  ) {
    function handleClick(_event: MouseEvent<HTMLButtonElement>): void {
      if (disabled || pending) return;
      onPressedChange(!pressed);
    }

    return (
      <button
        {...props}
        ref={ref}
        type="button"
        aria-pressed={pressed}
        aria-busy={pending || undefined}
        aria-disabled={pending || undefined}
        data-state={pressed ? 'on' : 'off'}
        disabled={disabled}
        className={joinClassNames(styles.selectionControl, styles.toggleButton, className)}
        onClick={handleClick}
      >
        {children}
      </button>
    );
  },
);

export type ToggleCardProps = ControlledSelectionButtonProps;

export const ToggleCard = forwardRef<HTMLButtonElement, ToggleCardProps>(function ToggleCard(
  {
    children,
    className,
    disabled = false,
    pending = false,
    pressed,
    onPressedChange,
    ...props
  },
  ref,
) {
  function handleClick(_event: MouseEvent<HTMLButtonElement>): void {
    if (disabled || pending) return;
    onPressedChange(!pressed);
  }

  return (
    <button
      {...props}
      ref={ref}
      type="button"
      aria-pressed={pressed}
      aria-busy={pending || undefined}
      aria-disabled={pending || undefined}
      data-state={pressed ? 'on' : 'off'}
      disabled={disabled}
      className={joinClassNames(styles.selectionControl, styles.toggleCard, className)}
      onClick={handleClick}
    >
      {children}
    </button>
  );
});
