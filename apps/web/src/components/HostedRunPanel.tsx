'use client';

import { Button, Input, Select, Textarea } from '@readable-studio/components';
import type {
  HostedConversation,
  HostedProject,
  HostedRunCreateV1,
  HostedRunStatus,
} from '@readable-studio/contracts';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useHostedT } from '../i18n/hosted';
import type { HostedProviderClient } from '../providers/hosted';
import { randomUUID } from '../utils/uuid';
import styles from './HostedRunPanel.module.css';

type RunApi = Pick<
  HostedProviderClient,
  | 'listProjects'
  | 'createProject'
  | 'listConversations'
  | 'createConversation'
  | 'upsertMessage'
  | 'createRun'
  | 'cancelRun'
  | 'runEventsUrl'
>;

interface PendingRun {
  readonly userMessageId: string;
  readonly intent: HostedRunCreateV1;
  messagesPrepared: boolean;
}

export function HostedRunPanel({ client }: { client: RunApi }) {
  const t = useHostedT();
  const [projects, setProjects] = useState<readonly HostedProject[]>([]);
  const [conversations, setConversations] = useState<readonly HostedConversation[]>([]);
  const [projectId, setProjectId] = useState('');
  const [conversationId, setConversationId] = useState('');
  const [projectName, setProjectName] = useState('');
  const [conversationTitle, setConversationTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [output, setOutput] = useState('');
  const [runId, setRunId] = useState('');
  const [status, setStatus] = useState<'idle' | 'starting' | 'running' | 'reconnecting' | 'canceling' | 'complete' | 'canceled' | 'error'>('idle');
  const pending = useRef<PendingRun | null>(null);
  const outputRef = useRef('');
  const eventsRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let active = true;
    client.listProjects().then(({ projects: next }) => {
      if (!active) return;
      setProjects(next);
      setProjectId((current) => current || next[0]?.id || '');
    }).catch(() => active && setStatus('error'));
    return () => {
      active = false;
      eventsRef.current?.close();
    };
  }, [client]);

  useEffect(() => {
    if (!projectId) {
      setConversations([]);
      setConversationId('');
      return;
    }
    let active = true;
    client.listConversations(projectId).then(({ conversations: next }) => {
      if (!active) return;
      setConversations(next);
      setConversationId((current) => next.some(({ id }) => id === current) ? current : next[0]?.id || '');
    }).catch(() => active && setStatus('error'));
    return () => {
      active = false;
    };
  }, [client, projectId]);

  const resetPending = () => {
    pending.current = null;
    if (status === 'error') setStatus('idle');
  };

  const createProject = async (event: FormEvent) => {
    event.preventDefault();
    if (!projectName.trim()) return;
    setStatus('starting');
    try {
      const { project } = await client.createProject({ title: projectName.trim() });
      resetPending();
      setProjects((current) => [...current, project]);
      setProjectId(project.id);
      setProjectName('');
      setStatus('idle');
    } catch {
      setStatus('error');
    }
  };

  const createConversation = async (event: FormEvent) => {
    event.preventDefault();
    if (!projectId) return;
    setStatus('starting');
    try {
      const { conversation } = await client.createConversation(projectId, {
        ...(conversationTitle.trim() ? { title: conversationTitle.trim() } : {}),
      });
      resetPending();
      setConversations((current) => [...current, conversation]);
      setConversationId(conversation.id);
      setConversationTitle('');
      setStatus('idle');
    } catch {
      setStatus('error');
    }
  };

  const finishRun = (
    runStatus: Extract<HostedRunStatus, 'succeeded' | 'failed' | 'canceled'>,
  ) => {
    eventsRef.current?.close();
    eventsRef.current = null;
    setStatus(runStatus === 'succeeded' ? 'complete' : runStatus === 'canceled' ? 'canceled' : 'error');
  };

  const connect = (activeRunId: string) => {
    const events = new EventSource(client.runEventsUrl(activeRunId), { withCredentials: true });
    eventsRef.current = events;
    events.addEventListener('start', () => setStatus('running'));
    events.addEventListener('agent', (event) => {
      const message = event as MessageEvent<string>;
      try {
        const payload = JSON.parse(message.data) as { type?: unknown; delta?: unknown };
        if (payload.type !== 'text_delta' || typeof payload.delta !== 'string') return;
        outputRef.current += payload.delta;
        setOutput(outputRef.current);
      } catch {
        // Invalid public events are ignored; the terminal event remains authoritative.
      }
    });
    events.addEventListener('end', (event) => {
      const message = event as MessageEvent<string>;
      let runStatus: Extract<HostedRunStatus, 'succeeded' | 'failed' | 'canceled'> = 'failed';
      try {
        const payload = JSON.parse(message.data) as { status?: unknown };
        if (payload.status === 'succeeded' || payload.status === 'canceled' || payload.status === 'failed') {
          runStatus = payload.status;
        }
      } catch {
        // Persist a failed terminal state when the server payload is malformed.
      }
      finishRun(runStatus);
    });
    events.onerror = () => setStatus((current) => (
      current === 'running' ? 'reconnecting' : current
    ));
  };

  const startRun = async (event: FormEvent) => {
    event.preventDefault();
    if (!projectId || !conversationId || !prompt.trim()) return;
    const current = pending.current ?? {
      userMessageId: randomUUID(),
      messagesPrepared: false,
      intent: {
        projectId,
        conversationId,
        assistantMessageId: randomUUID(),
        agentId: 'pi',
        message: prompt.trim(),
        clientRequestId: randomUUID(),
      },
    };
    pending.current = current;
    setStatus('starting');
    setRunId('');
    outputRef.current = '';
    setOutput('');
    try {
      if (!current.messagesPrepared) {
        await client.upsertMessage(projectId, conversationId, current.userMessageId, {
          role: 'user',
          content: current.intent.message,
        });
        await client.upsertMessage(projectId, conversationId, current.intent.assistantMessageId, {
          role: 'assistant',
          content: '',
        });
        current.messagesPrepared = true;
      }
      const result = await client.createRun(current.intent);
      pending.current = null;
      setRunId(result.runId);
      setStatus('running');
      connect(result.runId);
    } catch {
      setStatus('error');
    }
  };

  const cancel = async () => {
    if (!runId) return;
    setStatus('canceling');
    try {
      await client.cancelRun(runId);
    } catch {
      setStatus('error');
    }
  };

  const active = ['starting', 'running', 'reconnecting', 'canceling'].includes(status);
  return (
    <section className={styles.panel} aria-labelledby="hosted-run-title">
      <p className={styles.eyebrow}>{t('hosted.run.eyebrow')}</p>
      <h2 id="hosted-run-title">{t('hosted.run.title')}</h2>
      <p className={styles.description}>{t('hosted.run.description')}</p>

      <div className={styles.pickers}>
        <form onSubmit={createProject}>
          <label>
            <span>{t('hosted.run.projectName')}</span>
            <Input value={projectName} onChange={(event) => {
              setProjectName(event.target.value);
            }} disabled={active} />
          </label>
          <Button type="submit" variant="ghost" disabled={active || !projectName.trim()}>{t('hosted.run.createProject')}</Button>
        </form>
        <label>
          <span>{t('hosted.run.project')}</span>
          <Select value={projectId} onChange={(event) => {
            resetPending();
            setProjectId(event.target.value);
          }} disabled={active}>
            <option value="">{t('hosted.run.selectProject')}</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </Select>
        </label>
        <form onSubmit={createConversation}>
          <label>
            <span>{t('hosted.run.conversationTitle')}</span>
            <Input value={conversationTitle} onChange={(event) => {
              setConversationTitle(event.target.value);
            }} disabled={active || !projectId} />
          </label>
          <Button type="submit" variant="ghost" disabled={active || !projectId}>{t('hosted.run.createConversation')}</Button>
        </form>
        <label>
          <span>{t('hosted.run.conversation')}</span>
          <Select value={conversationId} onChange={(event) => {
            resetPending();
            setConversationId(event.target.value);
          }} disabled={active || !projectId}>
            <option value="">{t('hosted.run.selectConversation')}</option>
            {conversations.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.title}</option>)}
          </Select>
        </label>
      </div>

      <form className={styles.runForm} onSubmit={startRun}>
        <label>
          <span>{t('hosted.run.prompt')}</span>
          <Textarea value={prompt} onChange={(event) => {
            resetPending();
            setPrompt(event.target.value);
          }} disabled={active} rows={4} />
        </label>
        <div className={styles.actions}>
          <Button type="submit" variant="primary" disabled={active || !projectId || !conversationId || !prompt.trim()}>
            {pending.current ? t('hosted.run.retry') : t('hosted.run.start')}
          </Button>
          {runId && active ? <Button type="button" variant="subtle" onClick={cancel} disabled={status === 'canceling'}>{t('hosted.run.cancel')}</Button> : null}
        </div>
      </form>

      <p className={status === 'error' ? styles.error : styles.status} role={status === 'error' ? 'alert' : 'status'}>
        {t(`hosted.run.status.${status}`)}
      </p>
      <div className={styles.output} aria-live="polite">
        <h3>{t('hosted.run.output')}</h3>
        <pre>{output}</pre>
      </div>
    </section>
  );
}
