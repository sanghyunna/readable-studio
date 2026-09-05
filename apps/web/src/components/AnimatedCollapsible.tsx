import { useCallback, type ComponentPropsWithoutRef } from 'react';

type Props = Omit<ComponentPropsWithoutRef<'div'>, 'aria-hidden'> & {
  open: boolean;
  openClassName?: string;
};

/**
 * Keeps animated, mounted collapse content aligned with its interaction state.
 * The closed boundary leaves descendants mounted for CSS motion while removing
 * them from pointer, keyboard, and accessibility-tree interaction immediately.
 */
export function AnimatedCollapsible({
  open,
  openClassName = 'open',
  className,
  children,
  ...props
}: Props) {
  const stateClassName = open ? ` ${openClassName}` : '';
  const setBoundaryRef = useCallback(
    (element: HTMLDivElement | null) => {
      element?.toggleAttribute('inert', !open);
    },
    [open],
  );

  return (
    <div
      {...props}
      ref={setBoundaryRef}
      className={`${className ?? ''}${stateClassName}`}
      aria-hidden={!open}
    >
      {children}
    </div>
  );
}
