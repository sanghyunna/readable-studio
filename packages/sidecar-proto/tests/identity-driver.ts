import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  SIDECAR_CONTRACT,
  SIDECAR_ENV,
  SIDECAR_STAMP_FIELDS,
  SIDECAR_STAMP_FLAGS,
} from "../src/index.js";

const { values } = parseArgs({
  allowPositionals: false,
  options: {
    output: { type: "string" },
  },
  strict: true,
});

if (values.output == null || values.output.length === 0) {
  throw new TypeError("--output is required");
}

const artifact = {
  defaults: SIDECAR_CONTRACT.defaults,
  env: SIDECAR_ENV,
  stampFields: SIDECAR_STAMP_FIELDS,
  stampFlags: SIDECAR_STAMP_FLAGS,
} as const;
const outputPath = resolve(import.meta.dirname, "../../..", values.output);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
