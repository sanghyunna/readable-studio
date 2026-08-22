'use client';

import { useState } from 'react';
import { HostedContentPanel } from './components/HostedContentPanel';
import { HostedProviderPanel } from './components/HostedProviderPanel';
import { HostedRunPanel } from './components/HostedRunPanel';
import { HostedI18nProvider } from './i18n/hosted';
import { HostedProviderClient } from './providers/hosted';
import styles from './HostedApp.module.css';

export function HostedApp() {
  const [client] = useState(() => new HostedProviderClient());
  return (
    <main className={styles.main}>
      <HostedI18nProvider>
        <div className={styles.layout}>
          <HostedProviderPanel client={client} />
          <HostedContentPanel client={client} />
          <HostedRunPanel client={client} />
        </div>
      </HostedI18nProvider>
    </main>
  );
}
