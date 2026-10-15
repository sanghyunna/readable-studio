import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesignTemplatesResponse, UserDesignTemplateSummary } from '@readable-studio/contracts';

const ROOT = '/api/design-templates';

export function useUserDeckTemplates(enabled: boolean) {
  const [{ templates, progress, error }, setState] = useState<{
    templates: UserDesignTemplateSummary[];
    progress: number | null;
    error: string | null;
  }>({ templates: [], progress: null, error: null });
  const uploadRef = useRef<XMLHttpRequest | null>(null);
  const upsert = useCallback((template: UserDesignTemplateSummary) => {
    setState((current) => {
      const next = [...current.templates.filter((item) => item.id !== template.id), template];
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
          (item): item is UserDesignTemplateSummary => item.userImported === true && item.mode === 'deck',
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
    return () => { controller.abort(); uploadRef.current?.abort(); };
  }, [enabled, refresh]);
  const pending = templates.some((template) => template.thumbnail.status === 'pending');
  useEffect(() => {
    if (!enabled || !pending) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => void refresh(controller.signal), 5000);
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [enabled, pending, refresh]);

  function importZip(file: File) {
    if (uploadRef.current) return;
    setState((current) => ({ ...current, error: null, progress: 0 }));
    const xhr = new XMLHttpRequest();
    uploadRef.current = xhr;
    xhr.open('POST', `${ROOT}/import`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        const next = Math.round(event.loaded / event.total * 100);
        setState((current) => current.progress === next ? current : { ...current, progress: next });
      }
    };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        setState((current) => ({
          ...current,
          progress: null,
          ...(xhr.status >= 200 && xhr.status < 300
            ? { templates: [...current.templates.filter((item) => item.id !== data.template.id), data.template] }
            : { error: data.message ?? data.error ?? `HTTP ${xhr.status}` }),
        }));
      } catch {
        setState((current) => ({ ...current, error: `HTTP ${xhr.status}`, progress: null }));
      }
      uploadRef.current = null;
    };
    xhr.onerror = () => {
      setState((current) => ({ ...current, error: 'Network error', progress: null }));
      uploadRef.current = null;
    };
    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  }
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
  return { templates, progress, error, importZip, manage };
}
