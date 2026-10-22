import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { compareSealedPortableContent, type SealedPortableManifest } from "../src/content-equivalence.js";

const args = process.argv.slice(2);
const values = new Map<string, string>();
for (let index = 0; index < args.length; index += 2) {
  const name = args[index]!;
  const value = args[index + 1];
  if (!["--expected-json", "--actual-root", "--out-json"].includes(name) || value == null || value.startsWith("--")) {
    throw new Error(`invalid content-manifest argument: ${name}`);
  }
  values.set(name, value);
}
for (const name of ["--expected-json", "--actual-root", "--out-json"]) {
  if (!values.has(name)) throw new Error(`missing ${name}`);
}
const expected = JSON.parse(await readFile(resolve(values.get("--expected-json")!), "utf8")) as SealedPortableManifest;
if (expected.v !== 1 || !Array.isArray(expected.files)) throw new Error("invalid sealed portable manifest");
const result = await compareSealedPortableContent(expected, resolve(values.get("--actual-root")!));
await writeFile(resolve(values.get("--out-json")!), `${JSON.stringify(result, null, 2)}\n`, "utf8");
if (!result.equal) {
  process.stderr.write(`${result.error}\n`);
  process.exitCode = 1;
}
