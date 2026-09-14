// Presentation-layer de-duplication for agent model lists.
//
// The daemon catalogue is honest but redundant: Claude Code documents both a
// short alias and the full model id for the same underlying model, so the raw
// list renders as `Fable (alias)` + `claude-fable-5`, `Sonnet (alias)` +
// `claude-sonnet-4-5` — two rows that run the same model. Users read that as a
// broken picker ("the model names are wrong/inconsistent").
//
// Nothing is invented or dropped here. Each alias/id pair collapses into ONE
// entry that keeps the canonical (full) id as its value — the id the CLI
// resolves the alias to anyway — and shows a clean human label. Models with no
// counterpart pass through untouched.
//
// Registered Databricks endpoints are exempt from all of this: their ids are
// opaque app aliases and their labels are already sanitized display names, so
// two distinct endpoints (`sonnet`, `c-sonnet-model-service`) must never be
// read as an alias pair and collapsed into one.

import type { AgentModelOption } from '@readable-studio/contracts';

function isManagedOption(option: AgentModelOption): boolean {
  return option.source === 'databricks';
}

/** Strips the parenthetical noise the daemon appends to alias rows. */
function bareLabel(label: string): string {
  return label.replace(/\s*\((alias|CLI config)\)\s*$/i, '').trim();
}

/**
 * Family key for an option, or null when it participates in no alias pair.
 *
 * Alias rows are bare words (`sonnet`, `opus`, `fable`); the canonical rows
 * embed that same word inside a vendor-prefixed, version-suffixed id
 * (`claude-sonnet-4-5`). Matching on the alias token is what pairs them.
 */
function aliasToken(id: string): string {
  return id.toLowerCase();
}

function canonicalMatchesAlias(canonicalId: string, alias: string): boolean {
  // `claude-sonnet-4-5` contains `sonnet` as a hyphen-delimited segment.
  return canonicalId.toLowerCase().split(/[-_/]/).includes(alias);
}

/**
 * Collapses alias/id duplicates into a single coherent entry per model.
 *
 * Order is preserved from the source list (the daemon already orders it
 * meaningfully, with `default` first). For a collapsed pair the entry takes the
 * canonical id as its value and the alias's clean display name as its label,
 * so the list reads `Default · Fable · Sonnet · Opus · Haiku` while still
 * executing against `claude-fable-5`, `claude-sonnet-4-5`, ...
 */
export function dedupeAgentModels(
  models: AgentModelOption[],
): AgentModelOption[] {
  if (models.length === 0) return models;

  // Alias rows are the ones whose id is a single bare token that also appears
  // inside some other option's id.
  const aliasIds = new Set<string>();
  const canonicalForAlias = new Map<string, AgentModelOption>();

  for (const option of models) {
    if (option.id === 'default' || isManagedOption(option)) continue;
    const alias = aliasToken(option.id);
    if (/[-_/]/.test(alias)) continue; // not a bare alias token
    const canonical = models.find(
      (other) =>
        other.id !== option.id &&
        !isManagedOption(other) &&
        canonicalMatchesAlias(other.id, alias),
    );
    if (!canonical) continue;
    aliasIds.add(option.id);
    canonicalForAlias.set(option.id, canonical);
  }

  const consumedCanonicalIds = new Set(
    Array.from(canonicalForAlias.values(), (option) => option.id),
  );

  const out: AgentModelOption[] = [];
  const emitted = new Set<string>();

  for (const option of models) {
    if (isManagedOption(option)) {
      if (emitted.has(option.id)) continue;
      emitted.add(option.id);
      out.push(option);
      continue;
    }

    // The alias row is where the merged entry is emitted (aliases sort earlier
    // and carry the friendlier name), so the canonical row is skipped once its
    // alias has already produced the entry.
    if (consumedCanonicalIds.has(option.id) && !aliasIds.has(option.id)) {
      const aliasOwner = Array.from(canonicalForAlias.entries()).find(
        ([, canonical]) => canonical.id === option.id,
      );
      if (aliasOwner && emitted.has(aliasOwner[1].id)) continue;
    }

    if (aliasIds.has(option.id)) {
      const canonical = canonicalForAlias.get(option.id);
      if (!canonical || emitted.has(canonical.id)) continue;
      emitted.add(canonical.id);
      out.push({ ...canonical, id: canonical.id, label: bareLabel(option.label) });
      continue;
    }

    if (emitted.has(option.id)) continue;
    emitted.add(option.id);
    out.push({ ...option, label: bareLabel(option.label) });
  }

  return out;
}
