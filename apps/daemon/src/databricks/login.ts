import { randomUUID } from 'node:crypto';
import type { DatabricksLoginRequest, DatabricksLoginResponse, DatabricksLoginState } from '@readable-studio/contracts';
import { DatabricksClient, DatabricksServiceError, databricksWorkspaceOrigin, issueFor } from './client.js';

export interface DatabricksLoginClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
export interface DatabricksLoginOptions {
  clock?: DatabricksLoginClock;
  deadlineMs?: number;
  pollMs?: number;
}
interface LoginJob {
  snapshot: DatabricksLoginResponse;
  controller: AbortController;
  deadline?: ReturnType<typeof setTimeout>;
  poll?: ReturnType<typeof setTimeout>;
}
const active = (job: LoginJob) => ['starting', 'waiting-for-browser'].includes(job.snapshot.state);

/** In-memory jobs expose only opaque handles. CLI stdout/stderr and tokens never leave this module. */
export class DatabricksLogins {
  private readonly jobs = new Map<string, LoginJob>();
  private readonly clock: DatabricksLoginClock;
  constructor(private readonly client: DatabricksClient,
    private readonly connected: (host: string, profileName: string, signal: AbortSignal) => Promise<string>,
    private readonly options: DatabricksLoginOptions = {}) {
    this.clock = options.clock ?? { now: Date.now, setTimeout, clearTimeout };
  }

  start(request: DatabricksLoginRequest): DatabricksLoginResponse {
    const host = databricksWorkspaceOrigin(request.host);
    // One browser authorization at a time prevents competing CLI config writes.
    if ([...this.jobs.values()].some(active)) throw new DatabricksServiceError('DATABRICKS_STALE_REVISION', true);
    const loginId = randomUUID();
    const deadlineMs = this.options.deadlineMs ?? 600_000;
    const job: LoginJob = { controller: new AbortController(), snapshot: {
      loginId, state: 'starting', createdAt: new Date(this.clock.now()).toISOString(),
      deadlineAt: new Date(this.clock.now() + deadlineMs).toISOString(), completedAt: null, profileId: null, issues: [],
    } };
    this.jobs.set(loginId, job);
    job.deadline = this.clock.setTimeout(() => this.finish(job, 'timed-out'), deadlineMs);
    void this.run(job, host, `readable-${loginId}`, deadlineMs);
    return structuredClone(job.snapshot);
  }

  get(loginId: string): DatabricksLoginResponse {
    const job = this.jobs.get(loginId);
    if (!job) throw new DatabricksServiceError('DATABRICKS_SCAN_EXPIRED');
    return structuredClone(job.snapshot);
  }

  cancel(loginId: string): DatabricksLoginResponse {
    const job = this.jobs.get(loginId);
    if (!job) throw new DatabricksServiceError('DATABRICKS_SCAN_EXPIRED');
    this.finish(job, 'cancelled');
    return this.get(loginId);
  }

  private finish(job: LoginJob, state: DatabricksLoginState, error?: unknown): void {
    if (!active(job)) return;
    job.snapshot.state = state;
    job.snapshot.completedAt = new Date(this.clock.now()).toISOString();
    job.snapshot.issues = error === undefined ? [] : [issueFor(error)];
    if (job.deadline !== undefined) this.clock.clearTimeout(job.deadline);
    if (job.poll !== undefined) this.clock.clearTimeout(job.poll);
    // AbortSignal is passed into native spawn, so cancellation kills the CLI, not just polling.
    job.controller.abort();
  }

  private async run(job: LoginJob, host: string, profileName: string, deadlineMs: number): Promise<void> {
    try {
      const status = await this.client.probe();
      if (!active(job)) return;
      if (status.cli !== 'ready') throw new DatabricksServiceError(status.cli === 'missing' ? 'DATABRICKS_CLI_MISSING' : 'DATABRICKS_CLI_UNSUPPORTED');
      const login = this.client.login(host, profileName, job.controller.signal, deadlineMs);
      job.snapshot.state = 'waiting-for-browser';
      void login.catch((error: unknown) => this.finish(job, 'failed', error));
      await this.poll(job, host, profileName);
    } catch (error) { this.finish(job, 'failed', error); }
  }

  private async poll(job: LoginJob, host: string, profileName: string): Promise<void> {
    if (!active(job)) return;
    try {
      const raw = await this.client.json(['auth', 'token', '--profile', profileName], job.controller.signal);
      if (!active(job)) return;
      const token = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      const expiry = token.expiry ?? token.expires_at ?? token.expires_on;
      const expiresAt = typeof expiry === 'number' ? (expiry < 1e12 ? expiry * 1000 : expiry)
        : typeof expiry === 'string' ? Date.parse(expiry) : NaN;
      if (typeof token.access_token === 'string' && token.access_token && expiresAt > this.clock.now()) {
        const profileId = await this.connected(host, profileName, job.controller.signal);
        if (!active(job)) return;
        job.snapshot.profileId = profileId;
        this.finish(job, 'authenticated');
        return;
      }
    } catch (error) {
      if (!active(job)) return;
      const issue = issueFor(error);
      if (issue.code !== 'DATABRICKS_AUTH_REQUIRED' && issue.code !== 'DATABRICKS_UPSTREAM_UNAVAILABLE') {
        this.finish(job, 'failed', error); return;
      }
    }
    if (active(job)) job.poll = this.clock.setTimeout(() => { void this.poll(job, host, profileName); }, this.options.pollMs ?? 1000);
  }
}
