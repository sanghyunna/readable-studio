import type { ReactNode } from 'react';
import { Icon } from './Icon';

type Props = {
  surface: 'hub' | 'workspace';
  expanded: boolean;
  ariaLabel: string;
  className: string;
  headClassName: string;
  toggleClassName: string;
  toggleLabel: string;
  toggleTestId: string;
  testId: string;
  onToggle: () => void;
  header: ReactNode;
  children: ReactNode;
  toggleDisabled?: boolean;
  toggleAriaPressed?: boolean;
  toggleIconSize?: number;
  toggleStrokeWidth?: number;
  tooltipPlacement?: 'right' | 'bottom';
};

/**
 * Shared frame for every project rail.
 *
 * Surfaces configure their content and skin, but cannot fork the structural
 * rules: the rail is always present, has exactly two states, and carries its
 * one toggle inside its own brand row - to the right of the brand while the
 * rail is expanded, and in the brand's place once it is collapsed. The
 * control never leaves the rail (it used to be portalled into the window
 * chrome strip), so it survives the Hub <-> workspace swap on the same node
 * the rail does.
 */
export function ProjectRail({
  surface,
  expanded,
  ariaLabel,
  className,
  headClassName,
  toggleClassName,
  toggleLabel,
  toggleTestId,
  testId,
  onToggle,
  header,
  children,
  toggleDisabled = false,
  toggleAriaPressed,
  toggleIconSize = 20,
  toggleStrokeWidth,
  tooltipPlacement = 'right',
}: Props) {
  const state = expanded ? 'expanded' : 'collapsed';

  return (
    <nav
      className={className}
      aria-label={ariaLabel}
      data-project-rail={surface}
      data-project-rail-state={state}
      data-rail-state={state}
      data-testid={testId}
    >
      <div className={headClassName} data-project-rail-head="">
        {header}
        <button
          type="button"
          className={`${toggleClassName} readable-tooltip`}
          data-project-rail-toggle=""
          data-project-rail-surface={surface}
          data-testid={toggleTestId}
          aria-label={toggleLabel}
          aria-expanded={expanded}
          {...(toggleAriaPressed === undefined ? {} : { 'aria-pressed': toggleAriaPressed })}
          title={toggleLabel}
          data-tooltip={toggleLabel}
          data-tooltip-placement={tooltipPlacement}
          data-tooltip-allow-expanded=""
          disabled={toggleDisabled}
          onClick={onToggle}
        >
          <Icon name="panel-left" size={toggleIconSize} {...(toggleStrokeWidth === undefined ? {} : { strokeWidth: toggleStrokeWidth })} />
        </button>
      </div>
      {children}
    </nav>
  );
}
