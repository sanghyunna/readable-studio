import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import { PRODUCT_IDENTITY, serializeProductIdentity } from "../src/index.js";

const { values } = parseArgs({
  allowPositionals: false,
  options: {
    output: { type: "string" },
  },
  strict: true,
});

if (values.output == null || values.output.length === 0) {
  throw new Error("--output is required");
}

const outputPath = resolve(import.meta.dirname, "../../..", values.output);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, serializeProductIdentity(PRODUCT_IDENTITY), "utf8");
