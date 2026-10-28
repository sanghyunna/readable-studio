import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DesignTemplateUploadAnalyseResponse, DesignTemplateUploadAnalysisResponse,
  UploadableDesignTemplateType, UserDesignTemplateSummary,
} from '@readable-studio/contracts';

const ROOT = '/api/design-template-uploads';
export type UploadError = 'invalidFile' | 'analyseError' | 'expired' | 'networkError' | 'saveError';

// One template being reviewed: the uploaded ZIP itself, or one inner ZIP of a
// bundle. Name, cover and type choices live per template.
export interface UploadItem {
  entryName: string;
  analysis: DesignTemplateUploadAnalysisResponse;
  name: string;
  coverPageId: string;
  /** User override of the detected type; finalize sends `type` only when set. */
  type?: UploadableDesignTemplateType;
  status: 'pending' | 'saved' | 'skipped' | 'failed';
  error?: UploadError;
}

type Live = { bundle: boolean; id: string };

function toItem(entryName: string, analysis: DesignTemplateUploadAnalysisResponse): UploadItem {
  return {
    entryName, analysis, name: analysis.suggestedName,
    coverPageId: analysis.suggestedCoverPageId, status: 'pending',
  };
}

export function useTemplateUpload(onComplete: (templates: UserDesignTemplateSummary[]) => void) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [file, setFile] = useState<File | null>(null);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [index, setIndex] = useState(0);
  // null for a single-template ZIP; otherwise the bundle and its unreadable inner ZIPs.
  const [bundle, setBundle] = useState<{ id: string; invalid: Array<{ entryName: string; reason: string }> } | null>(null);
  const [summary, setSummary] = useState(false);
  // Templates already saved from a bundle, in save order. They survive an
  // expired bundle and are reported when the wizard closes.
  const [saved, setSaved] = useState<UserDesignTemplateSummary[]>([]);
  const [busy, setBusy] = useState<'uploading' | 'analysing' | 'finalizing' | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<UploadError | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const live = useRef<Live | null>(null);
  const request = useRef<XMLHttpRequest | null>(null);
  const generation = useRef(0);
  const finalizing = useRef(false);
  // Once finalize is attempted the server may have committed and closed the session,
  // so a 404 from preview polling no longer means expiry.
  const attempted = useRef(new Set<string>());
  const discard = useCallback(async ({ bundle: isBundle, id }: Live) => {
    const path = isBundle ? `bundles/${encodeURIComponent(id)}` : encodeURIComponent(id);
    const response = await fetch(`${ROOT}/${path}`, { method: 'DELETE', keepalive: true });
    if (!response.ok) throw new Error('Upload session cleanup failed');
  }, []);
  const cancel = useCallback(async () => {
    generation.current += 1;
    request.current?.abort();
    request.current = null;
    setBusy(null);
    const target = live.current;
    if (target) {
      await discard(target);
      if (live.current === target) live.current = null;
    }
  }, [discard]);
  useEffect(() => () => {
    if (!finalizing.current) void cancel().catch(() => {});
  }, [cancel]);
  function resetAnalysis() {
    live.current = null;
    setItems([]);
    setBundle(null);
    setIndex(0);
    setSummary(false);
  }
  // Only the template on screen is polled; other bundle children render
  // their thumbnails once the user reaches them.
  const current = summary ? undefined : items[index];
  const polled = current?.analysis;
  useEffect(() => {
    if (!polled?.pages.some((page) => page.thumbnail.status === 'pending')) return;
    const controller = new AbortController();
    const version = generation.current;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`${ROOT}/${encodeURIComponent(polled.sessionId)}`, { signal: controller.signal });
        if (controller.signal.aborted || generation.current !== version || attempted.current.has(polled.sessionId)) return;
        if (response.status === 404) {
          // A bundle child 404s once the whole bundle expired.
          setError('expired');
          resetAnalysis();
          setStep(1);
        } else if (response.ok) {
          const next: DesignTemplateUploadAnalysisResponse = await response.json();
          if (controller.signal.aborted || generation.current !== version) return;
          setItems((list) => list.map((item) => item.analysis.sessionId === next.sessionId ? { ...item, analysis: next } : item));
        }
      } catch {
        // A transient preview refresh must not discard the user's choices.
      }
    }, 2000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [polled]);

  async function selectFiles(files: File[]) {
    setError(null);
    setErrorDetail(null);
    const selected = files[0];
    if (files.length !== 1 || !selected || !/\.zip$/i.test(selected.name) || selected.size === 0) {
      setError('invalidFile');
      return;
    }
    try {
      await cancel();
      setFile(selected);
      resetAnalysis();
      setBusy(null);
    } catch {
      setError('networkError');
    }
  }
  function analyse() {
    if (!file || request.current) return;
    setError(null);
    setErrorDetail(null);
    setStep(2);
    if (items.length) return;
    setBusy('uploading');
    setProgress(0);
    const version = ++generation.current;
    const xhr = new XMLHttpRequest();
    request.current = xhr;
    xhr.open('POST', `${ROOT}/analyse`);
    xhr.upload.onprogress = (event) => {
      if (generation.current !== version || !event.lengthComputable) return;
      const percent = Math.round(event.loaded / event.total * 100);
      setProgress(percent);
      if (percent === 100) setBusy('analysing');
    };
    xhr.onload = () => {
      let data: DesignTemplateUploadAnalyseResponse;
      try { data = JSON.parse(xhr.responseText); } catch {
        if (generation.current === version) {
          request.current = null;
          setBusy(null);
          setError('analyseError');
        }
        return;
      }
      const target: Live = data.kind === 'bundle'
        ? { bundle: true, id: data.bundleId } : { bundle: false, id: data.sessionId };
      if (generation.current !== version) {
        if (target.id) void discard(target).catch(() => {});
        return;
      }
      request.current = null;
      setBusy(null);
      if (xhr.status < 200 || xhr.status >= 300) {
        const message = (data as { error?: { message?: unknown } }).error?.message;
        setError('analyseError');
        setErrorDetail(typeof message === 'string' && message ? message : null);
        return;
      }
      live.current = target;
      setIndex(0);
      if (data.kind === 'bundle') {
        const templates = [...data.templates].sort((a, b) => a.index - b.index);
        setBundle({
          id: data.bundleId,
          invalid: templates.flatMap((entry) => entry.ok ? [] : [{ entryName: entry.entryName, reason: entry.reason }]),
        });
        setItems(templates.flatMap((entry) => entry.ok ? [toItem(entry.entryName, entry.analysis)] : []));
      } else {
        setItems([toItem(data.originalFileName, data)]);
      }
    };
    xhr.onerror = () => {
      if (generation.current !== version) return;
      request.current = null;
      setBusy(null);
      setError('networkError');
    };
    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  }
  function update(patch: Partial<Pick<UploadItem, 'name' | 'coverPageId' | 'type'>>) {
    setItems((list) => list.map((item, position) => position === index ? { ...item, ...patch } : item));
  }
  async function finalize(position: number): Promise<UserDesignTemplateSummary | UploadError | null> {
    const item = items[position];
    if (!item || finalizing.current) return null;
    finalizing.current = true;
    attempted.current.add(item.analysis.sessionId);
    setBusy('finalizing');
    setError(null);
    try {
      const response = await fetch(`${ROOT}/${encodeURIComponent(item.analysis.sessionId)}/finalize`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...(item.type ? { type: item.type } : {}), name: item.name.trim(), coverPageId: item.coverPageId }),
      });
      if (!response.ok) return response.status === 404 ? 'expired' : 'saveError';
      return (await response.json()).template;
    } catch {
      return 'networkError';
    } finally {
      finalizing.current = false;
      setBusy(null);
    }
  }
  function record(position: number, result: UserDesignTemplateSummary | UploadError) {
    const failed = typeof result === 'string';
    setItems((list) => list.map((item, at) => at !== position ? item
      : failed ? { ...item, status: 'failed', error: result } : { ...item, status: 'saved', error: undefined }));
    if (!failed) setSaved((list) => [...list, result]);
  }
  function advance() {
    if (index + 1 < items.length) {
      setIndex(index + 1);
      setStep(2);
    } else setSummary(true);
  }
  async function finish() {
    const result = await finalize(index);
    if (!result) return;
    if (bundle) {
      // Each bundle template is saved on confirmation; failures are retried from the summary.
      record(index, result);
      advance();
    } else if (typeof result !== 'string') {
      live.current = null;
      // Earlier saves (from a bundle that expired) follow: the caller selects the first.
      onComplete([result, ...saved]);
    } else if (result === 'expired') {
      resetAnalysis();
      setStep(1);
      setError('expired');
    } else setError(result);
  }
  function skip() {
    const item = items[index];
    if (!item) return;
    // Best effort: closing the wizard cancels the whole bundle anyway.
    void discard({ bundle: false, id: item.analysis.sessionId }).catch(() => {});
    setItems((list) => list.map((entry, at) => at === index ? { ...entry, status: 'skipped' } : entry));
    advance();
  }
  async function retry(position: number) {
    const result = await finalize(position);
    if (result) record(position, result);
    return result;
  }
  return {
    step, setStep, file, selectFiles, items, index, current, bundle, summary, saved,
    busy, progress, error, errorDetail, setError, cancel, analyse, update, finish, skip, retry,
  };
}
