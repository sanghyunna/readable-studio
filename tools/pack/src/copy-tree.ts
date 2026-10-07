import { cp, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

// Independent leaf copies avoid recursive cp's per-file await chain. Keep cp's
// default link/attribute policy; never hardlink a tree that callers rewrite.
export async function copyTreeConcurrent(source: string, destination: string): Promise<void> {
  const leaves: Array<{ from: string; to: string }> = [];
  const visit = async (from: string, to: string): Promise<void> => {
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const child = { from: join(from, entry.name), to: join(to, entry.name) };
      if (entry.isDirectory()) await visit(child.from, child.to);
      else leaves.push(child);
    }
  };
  await visit(source, destination);
  let cursor = 0;
  let failed = false;
  const workers = Array.from({ length: Math.min(16, leaves.length) }, async () => {
    while (!failed && cursor < leaves.length) {
      const leaf = leaves[cursor++]!;
      try { await cp(leaf.from, leaf.to, { recursive: true }); }
      catch (error) { failed = true; throw error; }
    }
  });
  // Drain in-flight copies before propagating failure or allowing cleanup.
  const results = await Promise.allSettled(workers);
  for (const result of results) if (result.status === "rejected") throw result.reason;
}
