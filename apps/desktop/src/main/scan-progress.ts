import { request, type RequestOptions } from 'node:http';
import type { ScanProgress } from './startup-splash.js';

export class ScanProgressUnavailable extends Error {
  constructor(readonly detail: string) {
    super(`Agent scan status unavailable: ${detail}`);
  }
}

/** Parse the daemon response once, before it enters the reveal state machine. */
function parseScanProgress(payload: unknown): ScanProgress | null {
  if (typeof payload !== 'object' || payload === null || !('scan' in payload)) {
    throw new ScanProgressUnavailable('invalid response');
  }
  const scan = payload.scan;
  if (scan === null) return null;
  if (typeof scan !== 'object' ||
      !('phase' in scan) || !(scan.phase === 'running' || scan.phase === 'done' || scan.phase === 'cancelled' || scan.phase === 'failed') ||
      !('currentAgentName' in scan) || !(scan.currentAgentName === null || typeof scan.currentAgentName === 'string') ||
      !('completed' in scan) || typeof scan.completed !== 'number' || !Number.isInteger(scan.completed) || scan.completed < 0 ||
      !('total' in scan) || typeof scan.total !== 'number' || !Number.isInteger(scan.total) || scan.total < scan.completed) {
    throw new ScanProgressUnavailable('invalid progress');
  }
  return { phase: scan.phase, currentAgentName: scan.currentAgentName, completed: scan.completed, total: scan.total };
}

export async function readDaemonScan(discoverDaemonUrl: () => Promise<string | null>): Promise<ScanProgress | null> {
  const base = await discoverDaemonUrl();
  if (base === null) throw new ScanProgressUnavailable('daemon is not reachable');
  return requestScan(base, { signal: AbortSignal.timeout(1000) });
}

/** Acknowledges shared scan ownership, not completion; progress remains a GET. */
export function startDaemonScan(base: string, signal: AbortSignal): Promise<ScanProgress | null> {
  return requestScan(base, { method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) });
}

function requestScan(base: string, options: RequestOptions): Promise<ScanProgress | null> {
  return new Promise((resolve, reject) => {
    const req = request(new URL('/api/agents/scan', base), options, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new ScanProgressUnavailable(`HTTP ${response.statusCode}`));
        return;
      }
      response.setEncoding('utf8');
      let body = '';
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve(parseScanProgress(JSON.parse(body))); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}
