import type { DatabricksIssue } from './databricks.js';
/** App-managed browser SSO, also used for update-server authentication. */
export interface DatabricksManagedLoginRequest { host?: string; profile?: string; }
export interface DatabricksManagedLoginStart {
  state: 'started' | 'needs-input';
  loginId?: string;
  host?: string;
  profile?: string;
}
export interface DatabricksManagedLoginStatus {
  state: 'waiting-browser' | 'succeeded' | 'failed' | 'cancelled' | 'timeout';
  authUrl?: string;
  profileId?: string;
  issues?: DatabricksIssue[];
}
