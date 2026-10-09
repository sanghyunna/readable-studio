import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";

// Pipeline directory discovery and leaf copies rather than waiting for a full
// serial walk before copying. Keep cp's link/attribute policy; never hardlink
// a tree that callers rewrite. Dereferenced directory links join the same queue.
export async function copyTreeConcurrent(
  source: string,
  destination: string,
  options: { dereference?: boolean } = {},
): Promise<void> {
  type Entry = { from: string; to: string; directory: boolean; link?: boolean };
  const pending: Entry[] = [{ from: source, to: destination, directory: true }];
  const concurrency = Math.min(20, availableParallelism());
  let cursor = 0;
  let active = 0;
  let failed = false;
  let failure: unknown;
  await new Promise<void>((resolve, reject) => {
    const copy = async (entry: Entry): Promise<void> => {
      const directory = entry.link && options.dereference
        ? (await stat(entry.from)).isDirectory() : entry.directory;
      if (!directory) {
        await cp(entry.from, entry.to, { recursive: true, ...options });
        return;
      }
      await mkdir(entry.to, { recursive: true });
      for (const child of await readdir(entry.from, { withFileTypes: true })) {
        pending.push({
          from: join(entry.from, child.name), to: join(entry.to, child.name),
          directory: child.isDirectory(), link: child.isSymbolicLink(),
        });
      }
    };
    const pump = (): void => {
      while (!failed && active < concurrency && cursor < pending.length) {
        const entry = pending[cursor++]!;
        active += 1;
        void copy(entry).catch((error: unknown) => {
          if (!failed) { failed = true; failure = error; }
        }).finally(() => {
          active -= 1;
          pump();
        });
      }
      // Drain all in-flight operations before reporting failure so callers can
      // safely remove a partial snapshot without racing outstanding writes.
      if (active === 0) {
        if (failed) reject(failure);
        else resolve();
      }
    };
    pump();
  });
}
