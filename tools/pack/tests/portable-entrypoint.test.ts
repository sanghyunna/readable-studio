import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe.skipIf(process.platform !== "win32")("release entrypoint parameters", () => {
  it("defaults FastBuild on and allows an explicit false for controlled comparisons", async () => {
    // Execute only the parsed parameter block, never the release build body.
    const path = resolve("../../build-portable.ps1").replaceAll("'", "''");
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", `
      $errors=$null; $tokens=$null
      $ast=[Management.Automation.Language.Parser]::ParseFile('${path}',[ref]$tokens,[ref]$errors)
      if($errors.Count) { throw $errors[0] }
      $probe=[scriptblock]::Create($ast.ParamBlock.Extent.Text + '; [bool]$FastBuild')
      @((& $probe), (& $probe -FastBuild:$false), (& $probe -FastBuild)) | ConvertTo-Json -Compress
    `], { windowsHide: true, timeout: 30_000 });
    expect(JSON.parse(stdout)).toEqual([true, false, true]);
  });
});
