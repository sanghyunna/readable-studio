import type { DatabricksConnectionMode } from '@readable-studio/contracts';
import { DatabricksClient, DatabricksServiceError } from './client.js';
import type { ConnectionSecretStorage } from './secret-storage.js';

/** Private connection identity; never an API DTO. */
export interface DatabricksConnectionBinding {
  id: string;
  /** Absent on existing generations means cli-profile. */
  mode?: DatabricksConnectionMode;
  profileName: string;
  host: string;
  isDefault: boolean;
}

interface Bearer { value: string; expiresAt: number; }

export class DatabricksCredentials {
  private readonly cached = new Map<string, Bearer>();
  private readonly pending = new Map<string, Promise<Bearer>>();
  private readonly unavailable = new Set<string>();
  constructor(private readonly client: DatabricksClient, private readonly now: () => number = Date.now,
    private readonly safetyMarginMs = 120_000, private readonly storage?: ConnectionSecretStorage) {}

  persistenceUnavailable(binding: DatabricksConnectionBinding): boolean { return this.unavailable.has(this.key(binding)); }

  matches(binding: DatabricksConnectionBinding, token: string): boolean { return this.cached.get(this.key(binding))?.value === token; }

  private key(binding: DatabricksConnectionBinding): string {
    return JSON.stringify([binding.id, binding.profileName, binding.host]);
  }

  /** Daemon-only bearer acquisition. Never serialize or log this return value. */
  async acquire(binding: DatabricksConnectionBinding): Promise<string> {
    const key = this.key(binding);
    const cached = this.cached.get(key);
    if (cached && cached.expiresAt > this.now() + this.safetyMarginMs) return cached.value;
    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.refresh(binding).then((bearer) => {
        if (this.pending.get(key) === pending) this.cached.set(key, bearer);
        return bearer;
      }).finally(() => {
        if (this.pending.get(key) === pending) this.pending.delete(key);
      });
      this.pending.set(key, pending);
    }
    const bearer = await pending;
    if (bearer.expiresAt <= this.now() + this.safetyMarginMs) throw new DatabricksServiceError('DATABRICKS_AUTH_REQUIRED');
    return bearer.value;
  }

  /** Persist only after workspace validation. The binding is the non-secret reference. */
  async setWorkspaceToken(binding: DatabricksConnectionBinding, token: string): Promise<void> {
    const key = this.key(binding);
    const result = await this.storage?.store(key, token) ?? 'unavailable';
    this.cached.set(key, { value: token, expiresAt: Infinity });
    if (result === 'stored') this.unavailable.delete(key);
    else {
      this.unavailable.add(key);
      console.warn('Databricks credential encryption unavailable: token is memory-only; re-enter it after restarting the app.');
    }
  }

  async forget(binding: DatabricksConnectionBinding): Promise<void> {
    const key = this.key(binding);
    this.cached.delete(key);
    this.pending.delete(key);
    this.unavailable.delete(key);
    if (binding.mode === 'workspace-token') await this.storage?.clear(key);
  }

  private async refresh(binding: DatabricksConnectionBinding): Promise<Bearer> {
    if (binding.mode === 'workspace-token') {
      const result = await this.storage?.load(this.key(binding)) ?? { state: 'missing' };
      if (result.state === 'loaded') {
        this.unavailable.delete(this.key(binding));
        return { value: result.secret, expiresAt: Infinity };
      }
      if (result.state === 'unavailable') {
        this.unavailable.add(this.key(binding));
        throw new DatabricksServiceError('DATABRICKS_KEYRING_UNAVAILABLE', true);
      }
      throw new DatabricksServiceError('DATABRICKS_AUTH_REQUIRED');
    }
    const raw = await this.client.json(['auth', 'token', '--profile', binding.profileName]);
    if (!raw || typeof raw !== 'object') throw new DatabricksServiceError('DATABRICKS_AUTH_REQUIRED');
    const payload = raw as Record<string, unknown>;
    const expiry = payload.expiry ?? payload.expires_at ?? payload.expires_on;
    // CLI expiry is absolute. expires_in is intentionally never read.
    const expiresAt = typeof expiry === 'number' ? (expiry < 1e12 ? expiry * 1000 : expiry)
      : typeof expiry === 'string' ? Date.parse(expiry) : NaN;
    if (typeof payload.access_token !== 'string' || !payload.access_token || !Number.isFinite(expiresAt) || expiresAt <= this.now() + this.safetyMarginMs) {
      throw new DatabricksServiceError('DATABRICKS_AUTH_REQUIRED');
    }
    return { value: payload.access_token, expiresAt };
  }
}
