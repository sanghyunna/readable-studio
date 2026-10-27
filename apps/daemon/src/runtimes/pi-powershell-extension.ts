import { createBashToolDefinition, createLocalBashOperations, createReadToolDefinition, DEFAULT_MAX_BYTES, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { resolvePiPowerShell } from './pi-powershell.js';

const UTF8_PREAMBLE = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$PSDefaultParameterValues['Get-Content:Encoding'] = 'UTF8'`;

/** Explicitly loaded only by the managed Windows invocation; never by other adapters. */
export default function registerPowerShell(pi: ExtensionAPI): void {
  const cwd = process.cwd();
  const tool = createBashToolDefinition(cwd, {
    // Retain Pi's output cap, timeout, abort, hidden spawn and process-tree cleanup.
    // Resolve on execution so an unavailable interpreter is a visible tool error,
    // not an extension-load failure that silently removes the shell capability.
    // The resolver shares an asynchronous probe and caches only successful results.
    operations: {
      exec: async (command, cwd, options) => createLocalBashOperations({ shellPath: await resolvePiPowerShell() })
        .exec(`${UTF8_PREAMBLE}\n${command}`, cwd, options),
    },
  });
  pi.registerTool({
    ...tool,
    name: 'powershell',
    label: 'PowerShell',
    description: tool.description.replace('a bash command', 'a Windows PowerShell 5.1 command'),
    promptSnippet: 'Execute Windows PowerShell commands. Use PowerShell syntax, not Bash syntax.',
    promptGuidelines: [
      'Use read to examine text files instead of Get-Content. Use PowerShell for shell operations or the bounded long-line command returned by read.',
      'Use PowerShell syntax: $env:NAME for environment variables and semicolons rather than &&. Git Bash is optional and may be invoked explicitly if installed.',
    ],
    parameters: {
      ...tool.parameters,
      properties: {
        ...tool.parameters.properties,
        command: { ...tool.parameters.properties.command, description: 'Windows PowerShell command to execute' },
      },
    },
  });

  const read = createReadToolDefinition(cwd);
  pi.registerTool({
    ...read,
    promptGuidelines: ['Use read to examine text files instead of Get-Content, cat or sed. Continue large files with offset/limit.'],
    async execute(id, args, signal, onUpdate, ctx) {
      const result = await read.execute(id, args, signal, onUpdate, ctx);
      if (!result.details?.truncation?.firstLineExceedsLimit) return result;
      // Pi's pinned private helper keeps the fallback identical to read's path normalization.
      const { resolveReadPathAsync }: { resolveReadPathAsync: (file: string, cwd: string) => Promise<string> } =
        await import(new URL('./core/tools/path-utils.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href);
      const resolvedPath = await resolveReadPathAsync(args.path, cwd);
      const file = `'${resolvedPath.replaceAll("'", "''")}'`;
      const lineIndex = Math.max(0, (args.offset ?? 1) - 1);
      // Leave room under Pi's byte cap and never split a UTF-16 surrogate pair.
      const command = `$start = 0
$line = Get-Content -LiteralPath ${file} -Encoding UTF8 | Select-Object -Skip ${lineIndex} -First 1
$count = [Math]::Min(${Math.floor(DEFAULT_MAX_BYTES / 4)}, $line.Length - $start)
if ($count -gt 0 -and [char]::IsHighSurrogate($line[$start + $count - 1])) { $count-- }
[Console]::WriteLine($line.Substring($start, $count))
if ($start + $count -lt $line.Length) { [Console]::WriteLine('[Next character offset: ' + ($start + $count) + ']') } else { [Console]::WriteLine('[End of line]') }`;
      return { ...result, content: [{ type: 'text', text:
        `This line exceeds read's output limit. Use powershell to read a bounded UTF-8 range:\n\n\`\`\`powershell\n${command}\n\`\`\`\n\nContinue the same line by setting $start to the reported next character offset until [End of line].` }] };
    },
  });
}
