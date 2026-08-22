import {
  PluginManifestSchema,
  UNSUPPORTED_LEGACY_PRODUCT_V1,
  type PluginManifest,
} from '@readable-studio/contracts';
import { isUnsupportedLegacyProductV1 } from './parsers/manifest.js';

export interface ValidateResult {
  ok: boolean;
  warnings: string[];
  errors: string[];
}

// Doctor-level validation. Combines schema parse + cross-field rules that
// the JSON Schema cannot easily express:
//
//   - Pipeline stages with `repeat: true` must declare an `until`
//     expression (spec §10.2 hard constraint).
//   - Capability list must be an array of canonical capability strings;
//     unknown ids land in `warnings[]` instead of `errors[]` so a forward
//     spec patch can introduce new caps without breaking installs.
//   - GenUI surface oauth.route='mcp' references an MCP server declared in
//     readable.context.mcp.

const KNOWN_CAPABILITIES = new Set([
  'prompt:inject',
  'fs:read',
  'fs:write',
  'mcp',
  'subprocess',
  'bash',
  'network',
  'connector',
]);

// @dsp func-30ea3892
export function validateManifest(value: unknown): ValidateResult {
  if (isUnsupportedLegacyProductV1(value)) {
    return { ok: false, warnings: [], errors: [UNSUPPORTED_LEGACY_PRODUCT_V1] };
  }

  const parsed = PluginManifestSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      warnings: [],
      errors: parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`),
    };
  }
  return validateSafe(parsed.data);
}

// @dsp func-73c29b1c
export function validateSafe(manifest: PluginManifest): ValidateResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  const readable = manifest.readable;
  if (readable) {
    const stages = readable.pipeline?.stages ?? [];
    for (const stage of stages) {
      if (stage.repeat && !stage.until) {
        errors.push(`pipeline.stages[${stage.id}]: repeat=true requires an 'until' expression`);
      }
    }

    const caps = readable.capabilities ?? [];
    for (const cap of caps) {
      // Keep the parser generic: connector sources were removed, but the
      // capability namespace is still recognised for forward compatibility.
      if (cap.startsWith('connector:')) continue;
      if (!KNOWN_CAPABILITIES.has(cap)) {
        warnings.push(`capability '${cap}' is not in the v1 vocabulary; doctor will surface this to the operator`);
      }
    }

    const declaredMcpNames = new Set<string>();
    for (const mcp of readable.context?.mcp ?? []) {
      if (typeof mcp.name === 'string') declaredMcpNames.add(mcp.name);
    }

    for (const surface of readable.genui?.surfaces ?? []) {
      const oauth = surface.oauth;
      if (!oauth) continue;
      if (oauth.route === 'mcp') {
        if (!oauth.mcpServerId) {
          errors.push(`genui.surfaces[${surface.id}]: oauth.route='mcp' requires mcpServerId`);
        } else if (declaredMcpNames.size > 0 && !declaredMcpNames.has(oauth.mcpServerId)) {
          errors.push(`genui.surfaces[${surface.id}]: oauth.mcpServerId='${oauth.mcpServerId}' is not declared in readable.context.mcp`);
        }
      }
    }
  }

  return { ok: errors.length === 0, warnings, errors };
}
