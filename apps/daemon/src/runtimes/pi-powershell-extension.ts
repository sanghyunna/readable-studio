import { createBashToolDefinition, createLocalBashOperations, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { resolvePiPowerShell } from './pi-powershell.js';

/** Explicitly loaded only by the managed Windows invocation; never by other adapters. */
export default function registerPowerShell(pi: ExtensionAPI): void {
  const tool = createBashToolDefinition(process.cwd(), {
    // Retain Pi's output cap, timeout, abort, hidden spawn and process-tree cleanup.
    // Resolve on execution so an unavailable interpreter is a visible tool error,
    // not an extension-load failure that silently removes the shell capability.
    operations: {
      exec: (command, cwd, options) => createLocalBashOperations({ shellPath: resolvePiPowerShell() })
        .exec(command, cwd, options),
    },
  });
  pi.registerTool({
    ...tool,
    name: 'powershell',
    label: 'PowerShell',
    description: tool.description.replace('a bash command', 'a Windows PowerShell 5.1 command'),
    promptSnippet: 'Execute Windows PowerShell commands. Use PowerShell syntax, not Bash syntax.',
    promptGuidelines: ['Use PowerShell syntax: $env:NAME for environment variables and semicolons rather than &&. Git Bash is optional and may be invoked explicitly if installed.'],
    parameters: {
      ...tool.parameters,
      properties: {
        ...tool.parameters.properties,
        command: { ...tool.parameters.properties.command, description: 'Windows PowerShell command to execute' },
      },
    },
  });
}
