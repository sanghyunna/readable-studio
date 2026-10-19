import { useCallback, useEffect, useState } from 'react';
import type { DesignTemplatesResponse, UserDesignTemplateSummary } from '@readable-studio/contracts';

const ROOT = '/api/design-templates';

export function useUserDeckTemplates(enabled: boolean) {
  const [{ templates, error }, setState] = useState<{
    templates: UserDesignTemplateSummary[];
    error: string | null;
  }>({ templates: [], error: null });
  const upsert = useCallback((template: UserDesignTemplateSummary) => {
    setState((current) => {
      const next = [template, ...current.templates.filter((item) => item.id !== template.id)];
      return JSON.stringify(current.templates) === JSON.stringify(next)
        ? current : { ...current, templates: next };
    });
  }, []);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(ROOT, { signal });
      if (!response.ok) return;
      const data: DesignTemplatesResponse = await response.json();
      if (!signal?.aborted) {
        const next = (data.designTemplates ?? []).filter(
          (item): item is UserDesignTemplateSummary => item.userImported === true,
        );
        setState((current) => JSON.stringify(current.templates) === JSON.stringify(next)
          ? current : { ...current, templates: next });
      }
    } catch {
      // Listing is retried when pending covers are refreshed or the Hub mounts.
    }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => { controller.abort(); };
  }, [enabled, refresh]);
  const pending = templates.some((template) => template.thumbnail.status === 'pending');
  useEffect(() => {
    if (!enabled || !pending) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => void refresh(controller.signal), 5000);
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [enabled, pending, refresh]);

  async function manage(id: string, name?: string) {
    setState((current) => current.error === null ? current : { ...current, error: null });
    try {
      const response = await fetch(`${ROOT}/${encodeURIComponent(id)}`, {
        method: name === undefined ? 'DELETE' : 'PATCH',
        ...(name === undefined ? {} : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name }),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setState((current) => ({ ...current, error: data.message ?? data.error }));
        return false;
      }
      if (name === undefined) setState((current) => ({
        ...current, templates: current.templates.filter((item) => item.id !== id),
      }));
      else upsert(data.template);
      return true;
    } catch (err) {
      setState((current) => ({ ...current, error: err instanceof Error ? err.message : String(err) }));
      return false;
    }
  }
  return { templates, error, upsert, manage };
}
