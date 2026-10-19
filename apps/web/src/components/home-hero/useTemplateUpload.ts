import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DesignTemplateType, DesignTemplateUploadAnalysisResponse,
  UserDesignTemplateSummary,
} from '@readable-studio/contracts';

const ROOT = '/api/design-template-uploads';
export type UploadError = 'invalidFile' | 'analyseError' | 'expired' | 'networkError' | 'saveError';

export function useTemplateUpload(onComplete: (template: UserDesignTemplateSummary) => void) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [type, setType] = useState<DesignTemplateType | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [analysis, setAnalysis] = useState<DesignTemplateUploadAnalysisResponse | null>(null);
  const [name, setName] = useState('');
  const [coverPageId, setCoverPageId] = useState('');
  const [busy, setBusy] = useState<'uploading' | 'analysing' | 'finalizing' | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<UploadError | null>(null);
  const session = useRef<string | null>(null);
  const request = useRef<XMLHttpRequest | null>(null);
  const generation = useRef(0);
  const finalizing = useRef(false);
  // Once finalize is attempted the server may have committed and closed the session,
  // so a 404 from preview polling no longer means expiry.
  const finalizeAttempted = useRef(false);
  const discard = useCallback(async (id: string) => {
    const response = await fetch(`${ROOT}/${encodeURIComponent(id)}`, { method: 'DELETE', keepalive: true });
    if (!response.ok) throw new Error('Upload session cleanup failed');
  }, []);
  const cancel = useCallback(async () => {
    generation.current += 1;
    request.current?.abort();
    request.current = null;
    setBusy(null);
    const id = session.current;
    if (id) {
      await discard(id);
      if (session.current === id) session.current = null;
    }
  }, [discard]);
  useEffect(() => () => {
    if (!finalizing.current) void cancel().catch(() => {});
  }, [cancel]);
  useEffect(() => {
    if (!analysis?.pages.some((page) => page.thumbnail.status === 'pending')) return;
    const controller = new AbortController();
    const version = generation.current;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`${ROOT}/${encodeURIComponent(analysis.sessionId)}`, { signal: controller.signal });
        if (controller.signal.aborted || generation.current !== version || finalizeAttempted.current) return;
        if (response.status === 404) {
          setError('expired');
          setAnalysis(null);
          session.current = null;
          setStep(2);
        } else if (response.ok) {
          const next: DesignTemplateUploadAnalysisResponse = await response.json();
          if (!controller.signal.aborted && generation.current === version) setAnalysis(next);
        }
      } catch {
        // A transient preview refresh must not discard the user's choices.
      }
    }, 2000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [analysis]);

  async function selectFiles(files: File[]) {
    setError(null);
    const selected = files[0];
    if (files.length !== 1 || !selected || !/\.zip$/i.test(selected.name) || selected.size === 0) {
      setError('invalidFile');
      return;
    }
    try {
      await cancel();
      setFile(selected);
      setAnalysis(null);
      setBusy(null);
    } catch {
      setError('networkError');
    }
  }
  function analyse() {
    if (!file || request.current) return;
    setError(null);
    setStep(3);
    if (analysis) return;
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
      let data: DesignTemplateUploadAnalysisResponse;
      try { data = JSON.parse(xhr.responseText); } catch {
        if (generation.current === version) {
          request.current = null;
          setBusy(null);
          setError('analyseError');
        }
        return;
      }
      if (generation.current !== version) {
        if (data.sessionId) void discard(data.sessionId).catch(() => {});
        return;
      }
      request.current = null;
      setBusy(null);
      if (xhr.status < 200 || xhr.status >= 300) {
        setError('analyseError');
        return;
      }
      session.current = data.sessionId;
      finalizeAttempted.current = false;
      setAnalysis(data);
      setName(data.suggestedName);
      setCoverPageId(data.suggestedCoverPageId);
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
  async function finish() {
    if (!analysis || !type || finalizing.current) return;
    finalizing.current = true;
    finalizeAttempted.current = true;
    setBusy('finalizing');
    setError(null);
    try {
      const response = await fetch(`${ROOT}/${encodeURIComponent(analysis.sessionId)}/finalize`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type, name: name.trim(), coverPageId }),
      });
      if (!response.ok) {
        if (response.status === 404) {
          setAnalysis(null);
          session.current = null;
          setStep(2);
          setError('expired');
        } else setError('saveError');
        return;
      }
      const data = await response.json();
      session.current = null;
      onComplete(data.template);
    } catch {
      setError('networkError');
    } finally {
      finalizing.current = false;
      setBusy(null);
    }
  }
  return {
    step, setStep, type, setType, file, selectFiles, analysis, name, setName,
    coverPageId, setCoverPageId, busy, progress, error, setError, cancel, analyse, finish,
  };
}
