import type { ChildProcess } from 'node:child_process';
import { watch, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Process creation is not updater readiness: keep the desktop until the helper owns its journal. */
export function waitForUpdateHelper(root: string, id: string, broker: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    const path = join(root, 'update-helper-ready.json');
    const watcher = watch(root, (_event, filename) => { if (String(filename).startsWith('update-helper-ready.json')) check(); });
    const timer = setTimeout(() => finish(new Error('업데이트 준비를 확인하지 못했습니다. 앱을 종료하지 않고 다시 시도해 주세요.')), 30_000);
    const exited = (code: number | null) => { if (code !== 0) finish(new Error(`업데이트 준비 프로세스가 종료되었습니다 (${code}).`)); };
    broker.once('exit', exited);
    function finish(error?: Error, pid?: number) {
      clearTimeout(timer); watcher.close(); broker.removeListener('exit', exited);
      if (error) reject(error); else resolve(pid!);
    }
    function check() {
      let ready: { id?: string; pid?: number };
      try { ready = JSON.parse(readFileSync(path, 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return; finish(error as Error); return; }
      if (ready.id === id && Number.isSafeInteger(ready.pid) && ready.pid! > 0) finish(undefined, ready.pid);
    }
    check();
  });
}
