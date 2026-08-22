'use client';

import { Button, Input, Select } from '@readable-studio/components';
import type {
  HostedProviderId,
  HostedProviderStatusResponse,
  HostedSessionResponse,
} from '@readable-studio/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import { useHostedT } from '../i18n/hosted';
import { HostedProviderClient } from '../providers/hosted';
import styles from './HostedProviderPanel.module.css';

type ProviderApi = Pick<HostedProviderClient, 'getSession' | 'status' | 'set' | 'test' | 'clear'>;

const PROVIDER_LABEL: Record<HostedProviderId, string> = {
  'anthropic': 'Anthropic',
  'vercel-ai-gateway': 'Vercel AI Gateway',
};

export function HostedProviderPanel({ client }: { client: ProviderApi }) {
  const t = useHostedT();
  const [session, setSession] = useState<HostedSessionResponse | null>(null);
  const [status, setStatus] = useState<HostedProviderStatusResponse>({
    provider: null,
    configured: false,
  });
  const [provider, setProvider] = useState<HostedProviderId>('anthropic');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([client.getSession(), client.status()])
      .then(([nextSession, nextStatus]) => {
        if (!active) return;
        setSession(nextSession);
        setStatus(nextStatus);
        setProvider(nextStatus.provider ?? nextSession.providers[0]?.id ?? 'anthropic');
      })
      .catch(() => {
        if (!active) return;
        setFailed(true);
        setMessage(t('hosted.provider.error'));
      });
    return () => {
      active = false;
    };
  }, [client, t]);

  const act = async (operation: () => Promise<void>) => {
    setBusy(true);
    setFailed(false);
    setMessage('');
    try {
      await operation();
    } catch {
      setFailed(true);
      setMessage(t('hosted.provider.error'));
    } finally {
      setBusy(false);
    }
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!key) return;
    void act(async () => {
      await client.set({ provider, key });
      setKey('');
      setStatus({ provider, configured: true });
      setMessage(t('hosted.provider.setSuccess'));
    });
  };

  const test = () => void act(async () => {
    try {
      const result = await client.test({ provider });
      setMessage(t('hosted.provider.testSuccess', { model: result.model }));
    } catch {
      try {
        setStatus(await client.status());
      } catch {
        setStatus({ provider: null, configured: false });
      }
      throw new Error('hosted provider test failed');
    }
  });

  const clear = () => void act(async () => {
    await client.clear();
    setKey('');
    setStatus({ provider: null, configured: false });
    setMessage(t('hosted.provider.clearSuccess'));
  });

  return (
    <section className={styles.panel} aria-labelledby="hosted-provider-title">
      <p className={styles.eyebrow}>{t('hosted.provider.eyebrow')}</p>
      <h1 id="hosted-provider-title">{t('hosted.provider.title')}</h1>
      <p className={styles.description}>{t('hosted.provider.description')}</p>

      <dl className={styles.runtime}>
        <div>
          <dt>{t('hosted.provider.runtime')}</dt>
          <dd>Pi</dd>
        </div>
      </dl>

      {session ? (
        <form className={styles.form} onSubmit={save}>
          <label>
            <span>{t('hosted.provider.provider')}</span>
            <Select
              value={provider}
              onChange={(event) => setProvider(event.target.value as HostedProviderId)}
              disabled={busy}
            >
              {session.providers.map((item) => (
                <option key={item.id} value={item.id}>
                  {PROVIDER_LABEL[item.id]} · {item.model}
                </option>
              ))}
            </Select>
          </label>
          <label>
            <span>{t('hosted.provider.apiKey')}</span>
            <Input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder={t('hosted.provider.apiKeyPlaceholder')}
              disabled={busy}
              required
            />
          </label>
          <p className={styles.status}>
            {status.configured
              ? t('hosted.provider.configured')
              : t('hosted.provider.notConfigured')}
          </p>
          <div className={styles.actions}>
            <Button variant="primary" type="submit" disabled={busy || key.length === 0}>
              {t('hosted.provider.save')}
            </Button>
            <Button
              variant="ghost"
              type="button"
              onClick={test}
              disabled={busy || !status.configured || status.provider !== provider}
            >
              {t('hosted.provider.test')}
            </Button>
            <Button
              variant="subtle"
              type="button"
              onClick={clear}
              disabled={busy || !status.configured}
            >
              {t('hosted.provider.clear')}
            </Button>
          </div>
        </form>
      ) : (
        <p className={styles.status}>{t('hosted.provider.loading')}</p>
      )}

      {message ? (
        <p className={failed ? styles.error : styles.notice} role={failed ? 'alert' : 'status'}>
          {message}
        </p>
      ) : null}
    </section>
  );
}
