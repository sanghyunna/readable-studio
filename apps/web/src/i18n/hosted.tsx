'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { ar } from './hosted-locales/ar';
import { de } from './hosted-locales/de';
import { esES } from './hosted-locales/es-ES';
import { fa } from './hosted-locales/fa';
import { fr } from './hosted-locales/fr';
import { hu } from './hosted-locales/hu';
import { id } from './hosted-locales/id';
import { ja } from './hosted-locales/ja';
import { pl } from './hosted-locales/pl';
import { ptBR } from './hosted-locales/pt-BR';
import { ru } from './hosted-locales/ru';
import { th } from './hosted-locales/th';
import { tr } from './hosted-locales/tr';
import { uk } from './hosted-locales/uk';
import { zhCN } from './hosted-locales/zh-CN';
import { zhTW } from './hosted-locales/zh-TW';
import { en } from './locales/en';
import { ko } from './locales/ko';
import type { Dict } from './types';

export const HOSTED_LOCALES = [
  'ar', 'de', 'en', 'es-ES', 'fa', 'fr', 'hu', 'id', 'ja', 'ko', 'pl',
  'pt-BR', 'ru', 'th', 'tr', 'uk', 'zh-CN', 'zh-TW',
] as const;

export type HostedLocale = (typeof HOSTED_LOCALES)[number];

export const HOSTED_PROVIDER_KEYS = [
  'hosted.provider.eyebrow',
  'hosted.provider.title',
  'hosted.provider.description',
  'hosted.provider.runtime',
  'hosted.provider.provider',
  'hosted.provider.apiKey',
  'hosted.provider.apiKeyPlaceholder',
  'hosted.provider.save',
  'hosted.provider.test',
  'hosted.provider.clear',
  'hosted.provider.loading',
  'hosted.provider.configured',
  'hosted.provider.notConfigured',
  'hosted.provider.setSuccess',
  'hosted.provider.testSuccess',
  'hosted.provider.clearSuccess',
  'hosted.provider.error',
] as const satisfies readonly (keyof Dict)[];

export const HOSTED_CONTENT_KEYS = [
  'hosted.content.eyebrow',
  'hosted.content.title',
  'hosted.content.description',
  'hosted.content.error',
  'hosted.content.downloadArchive',
  'hosted.content.projectId',
  'hosted.content.projectIdPlaceholder',
  'hosted.content.openProject',
  'hosted.content.browserLabel',
  'hosted.content.files',
  'hosted.content.newFile',
  'hosted.content.noFiles',
  'hosted.content.fileSize',
  'hosted.content.folders',
  'hosted.content.noFolders',
  'hosted.content.deleteNamed',
  'hosted.content.delete',
  'hosted.content.newFolderPath',
  'hosted.content.createFolder',
  'hosted.content.uploadFiles',
  'hosted.content.uploadDirectory',
  'hosted.content.upload',
  'hosted.content.filePath',
  'hosted.content.filePathPlaceholder',
  'hosted.content.content',
  'hosted.content.saveFile',
  'hosted.content.preview',
  'hosted.content.deleteFile',
  'hosted.content.renameFile',
  'hosted.content.rename',
  'hosted.content.confirmDelete',
  'hosted.content.previewTitle',
] as const satisfies readonly (keyof Dict)[];

export const HOSTED_RUN_KEYS = [
  'hosted.run.eyebrow',
  'hosted.run.title',
  'hosted.run.description',
  'hosted.run.projectName',
  'hosted.run.createProject',
  'hosted.run.project',
  'hosted.run.selectProject',
  'hosted.run.conversationTitle',
  'hosted.run.createConversation',
  'hosted.run.conversation',
  'hosted.run.selectConversation',
  'hosted.run.prompt',
  'hosted.run.start',
  'hosted.run.retry',
  'hosted.run.cancel',
  'hosted.run.status.idle',
  'hosted.run.status.starting',
  'hosted.run.status.running',
  'hosted.run.status.reconnecting',
  'hosted.run.status.canceling',
  'hosted.run.status.complete',
  'hosted.run.status.canceled',
  'hosted.run.status.error',
  'hosted.run.output',
] as const satisfies readonly (keyof Dict)[];

export const HOSTED_MESSAGE_KEYS = [
  ...HOSTED_PROVIDER_KEYS,
  ...HOSTED_CONTENT_KEYS,
  ...HOSTED_RUN_KEYS,
] as const;

export type HostedMessageKey = (typeof HOSTED_MESSAGE_KEYS)[number];

export type HostedMessages = {
  [Key in HostedMessageKey]: string;
};

function hostedMessagesFromGlobal(dict: Dict): HostedMessages {
  return Object.fromEntries(
    HOSTED_MESSAGE_KEYS.map((key) => [key, dict[key]]),
  ) as HostedMessages;
}

export const HOSTED_MESSAGES: Record<HostedLocale, HostedMessages> = {
  'ar': ar,
  'de': de,
  'en': hostedMessagesFromGlobal(en),
  'es-ES': esES,
  'fa': fa,
  'fr': fr,
  'hu': hu,
  'id': id,
  'ja': ja,
  'ko': hostedMessagesFromGlobal(ko),
  'pl': pl,
  'pt-BR': ptBR,
  'ru': ru,
  'th': th,
  'tr': tr,
  'uk': uk,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
};

export function resolveHostedLocale(languages: readonly string[]): HostedLocale {
  for (const raw of languages) {
    const normalized = raw.trim().toLowerCase();
    if (!normalized) continue;
    const exact = HOSTED_LOCALES.find((locale) => locale.toLowerCase() === normalized);
    if (exact) return exact;
    const language = normalized.split('-')[0];
    const base = HOSTED_LOCALES.find((locale) => locale.toLowerCase().split('-')[0] === language);
    if (base) return base;
  }
  return 'en';
}

export function hostedDirection(locale: HostedLocale): 'ltr' | 'rtl' {
  return locale === 'ar' || locale === 'fa' ? 'rtl' : 'ltr';
}

export function translateHosted(
  locale: HostedLocale,
  key: HostedMessageKey,
  vars?: Record<string, string | number>,
): string {
  const raw = HOSTED_MESSAGES[locale][key];
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = vars[name];
    return value == null ? `{${name}}` : String(value);
  });
}

type HostedTranslator = (
  key: HostedMessageKey,
  vars?: Record<string, string | number>,
) => string;

const HostedI18nContext = createContext<HostedTranslator>((key, vars) => translateHosted('en', key, vars));

export function HostedI18nProvider({
  children,
  initial,
}: {
  children: ReactNode;
  initial?: HostedLocale;
}) {
  const [locale] = useState<HostedLocale>(() => initial ?? resolveHostedLocale(
    typeof navigator === 'undefined'
      ? []
      : navigator.languages?.length
        ? navigator.languages
        : [navigator.language],
  ));

  useEffect(() => {
    document.documentElement.setAttribute('lang', locale);
    document.documentElement.setAttribute('dir', hostedDirection(locale));
  }, [locale]);

  const t = useCallback<HostedTranslator>(
    (key, vars) => translateHosted(locale, key, vars),
    [locale],
  );
  return <HostedI18nContext.Provider value={t}>{children}</HostedI18nContext.Provider>;
}

export function useHostedT(): HostedTranslator {
  return useContext(HostedI18nContext);
}
