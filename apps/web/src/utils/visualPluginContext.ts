import type {
  InstalledPluginRecord,
  ProjectVisualReference,
} from '@readable-studio/contracts';

/**
 * Crosses the additive `@`-plugin boundary without forwarding catalogue data.
 * A missing author-supplied contract intentionally contributes nothing: using
 * title, id, description, tags, or use-case text as a fallback is unsafe.
 */
export function visualReferenceForPlugin(
  record: InstalledPluginRecord,
): ProjectVisualReference | null {
  const characteristics = record.manifest?.readable?.visualReference?.characteristics
    .map((value) => value.trim())
    .filter(Boolean) ?? [];
  return characteristics.length > 0 ? { characteristics } : null;
}

/**
 * Limits additive visual-reference surfaces to plugins that survive the exact
 * same content-clean conversion used when Home submits the prompt.
 */
export function pluginsWithVisualReferences(
  records: InstalledPluginRecord[],
): InstalledPluginRecord[] {
  return records.filter((record) => visualReferenceForPlugin(record) !== null);
}
