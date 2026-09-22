import { forwardRef, useLayoutEffect, useState, type ComponentProps } from 'react';
import { HomeHero, type HomeHeroHandle } from '../HomeHero';

/** Synchronous draft ownership; only the composer subscribes to text changes. */
export function createHomeDraft() {
  let text = '';
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => text,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set(next: string | ((current: string) => string)) {
      const value = typeof next === 'function' ? next(text) : next;
      if (value === text) return;
      text = value;
      for (const listener of listeners) listener();
    },
  };
}

type Props = Omit<ComponentProps<typeof HomeHero>, 'prompt' | 'submitReady'> & {
  readonly draft: ReturnType<typeof createHomeDraft>;
};

export const HomeDraft = forwardRef<HomeHeroHandle, Props>(function HomeDraft(
  { draft, ...props }, ref,
) {
  const [prompt, setPrompt] = useState(draft.getSnapshot);
  useLayoutEffect(() => draft.subscribe(() => setPrompt(draft.getSnapshot())), [draft]);
  return <HomeHero {...props} ref={ref} prompt={prompt}
    submitReady={!props.submitDisabled && (prompt.trim().length > 0 || (props.stagedFiles?.length ?? 0) > 0)} />;
});
