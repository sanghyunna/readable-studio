import type { Transition, Variants } from 'motion/react';

import { useExitPhaseInert } from './hooks/useExitPhaseInert';

const spring: Transition = {
  type: 'spring',
  stiffness: 500,
  damping: 30,
  mass: 0.8,
};

export const modalOverlay: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.2 } },
  exit: { opacity: 0, pointerEvents: 'none', transition: { duration: 0.15 } },
};

export const modalContent: Variants = {
  hidden: { opacity: 0, scale: 0.96, y: 10 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: {
      ...spring,
      stiffness: 400,
      damping: 28,
    },
  },
  exit: {
    opacity: 0,
    scale: 0.97,
    y: 5,
    transition: { duration: 0.15 },
  },
};

export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.95 },
  visible: { opacity: 1, scale: 1, transition: spring },
  exit: { opacity: 0, scale: 0.97, transition: { duration: 0.15 } },
};

export const toastSlideUp: Variants = {
  hidden: { opacity: 0, y: 20, scale: 0.95 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: spring,
  },
  exit: {
    opacity: 0,
    y: -10,
    scale: 0.95,
    transition: { duration: 0.2 },
  },
};

export const listItem: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4, transition: { duration: 0.1 } },
};

export const staggerContainer: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.04,
      delayChildren: 0.02,
    },
  },
};

export const popoverIn: Variants = {
  hidden: { opacity: 0, scale: 0.92, y: -4 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: {
      type: 'spring',
      stiffness: 500,
      damping: 25,
      mass: 0.6,
    },
  },
  exit: {
    opacity: 0,
    scale: 0.95,
    transition: { duration: 0.12 },
  },
};

/**
 * Every variant above fades `opacity` to 0 on exit, and an exit is a
 * transition: no `@keyframes` step exists in which `pointer-events` could ride
 * along with `opacity`, and an ancestor's `pointer-events: none` is overridden
 * by any descendant declaring `auto` (verified in-browser). A dismissing
 * surface is therefore invisible AND both clickable and tab-reachable for the
 * length of its fade unless the subtree is gated.
 *
 * `useFadingSurface` is the one place that gate is expressed. It returns the
 * complete prop bundle for an animated root — presence variants plus the exit
 * gate — so a surface opts into the motion and the safety together and cannot
 * ship one without the other.
 */
export function useFadingSurface(variants: Variants, enabled = true) {
  const gate = useExitPhaseInert(enabled);
  return {
    variants,
    initial: 'hidden',
    animate: 'visible',
    exit: 'exit',
    ref: gate.ref,
    onAnimationStart: gate.onExitStart,
  } as const;
}
