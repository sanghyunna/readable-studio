import type { DatabricksEndpoint } from '@readable-studio/contracts';
import { useT } from '../../i18n';

export function DatabricksModelDetails({ endpoint, className }: { endpoint: DatabricksEndpoint; className?: string }) {
  const t = useT();
  const api = endpoint.api === 'anthropic-messages' ? t('databricks.api.anthropic')
    : endpoint.api === 'openai-completions' ? t('databricks.api.openai') : t('databricks.api.unknown');
  const evidence = endpoint.protocolEvidence;
  const protocol = !evidence ? t('databricks.details.protocolMissing')
    : evidence.reason === 'runtime-accepted' ? t('databricks.details.protocolNegotiated')
    : evidence.reason === 'chat-task' ? t('databricks.details.protocolChatTask')
    : t('databricks.details.protocolMetadata', {
      advertised: evidence.advertised.join(', ') || t('databricks.details.notReported'),
      native: evidence.native.join(', ') || t('databricks.details.notReported'),
    });
  const context = endpoint.capabilities.contextWindow === null ? t('databricks.details.contextUnknown')
    : t(`databricks.details.source.${endpoint.capabilities.limitSources?.contextWindow ?? 'unknown'}`);
  const output = endpoint.capabilities.maxTokens === null ? t('databricks.details.outputUnknown')
    : t(`databricks.details.source.${endpoint.capabilities.limitSources?.maxTokens ?? 'unknown'}`);
  return <>
    <small className={className}>{api}. {protocol} {evidence?.reason === 'prefer-messages' ? t('databricks.details.preferMessages') : ''}</small>
    <small className={className}>{t('databricks.details.limits', { context, output })}</small>
  </>;
}
