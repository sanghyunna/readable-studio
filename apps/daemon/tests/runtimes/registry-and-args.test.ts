import { test } from 'vitest';
import {
  AGENT_DEFS, assert, chmodSync, codex, cursorAgent, detectAgents, grokBuild, join, mkdtempSync, rmSync, tmpdir, withEnvSnapshot, withPlatform, writeFileSync,
} from './helpers/test-helpers.js';
import {
  codexNeedsDangerFullAccessSandbox,
  parseCodexModelCatalog,
} from '../../src/runtimes/defs/codex.js';
import { readLocalAgentProfileDefs } from '../../src/runtimes/registry.js';

function writeFakeCodexBin(dir: string, script: string): string {
  const runner = join(dir, 'codex-runner.ts');
  writeFileSync(runner, script);
  const bin = join(dir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  if (process.platform === 'win32') {
    writeFileSync(bin, `@echo off\r\n"${process.execPath}" "%~dp0codex-runner.ts" %*\r\n`);
    return bin;
  }
  writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${runner}' "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

test('AGENT_DEFS ids are unique', () => {
  const ids = AGENT_DEFS.map((a) => a.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dupes, [], `duplicate agent ids: ${JSON.stringify(dupes)}`);
});

test('local agent profiles inherit a base adapter and can pin the default model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'readable-local-agent-profiles-'));
  try {
    await withEnvSnapshot(['READABLE_AGENT_PROFILES_CONFIG'], async () => {
      const config = join(dir, 'agents.local.json');
      writeFileSync(
        config,
        JSON.stringify({
          agents: [
            {
              id: 'zcode',
              name: 'ZCode',
              baseAgent: 'claude',
              bin: 'zcode',
              args: ['run'],
              defaultModel: 'zyb-claude',
              models: [
                { id: 'zyb-claude', label: 'zyb-claude' },
                { id: 'zyb-gpt', label: 'zyb-gpt' },
              ],
              env: {
                ZCODE_ROUTE: 'design',
                RETRIES: 2,
                'BAD-NAME': 'ignored',
              },
            },
          ],
        }),
      );
      process.env.READABLE_AGENT_PROFILES_CONFIG = config;

      const profiles = readLocalAgentProfileDefs();
      assert.equal(profiles.length, 1);
      const [profile] = profiles;
      assert.ok(profile);
      assert.equal(profile.id, 'zcode');
      assert.equal(profile.name, 'ZCode');
      assert.equal(profile.bin, 'zcode');
      assert.equal(profile.promptViaStdin, true);
      assert.equal(profile.streamFormat, 'claude-stream-json');
      assert.deepEqual(profile.fallbackModels.map((model) => model.id), [
        'default',
        'zyb-claude',
        'zyb-gpt',
      ]);
      assert.deepEqual(profile.env, {
        ZCODE_ROUTE: 'design',
        RETRIES: '2',
      });

      const defaultArgs = profile.buildArgs('', [], [], {});
      assert.deepEqual(defaultArgs.slice(0, 2), ['run', '-p']);
      assert.ok(defaultArgs.includes('--model'));
      assert.equal(defaultArgs[defaultArgs.indexOf('--model') + 1], 'zyb-claude');

      const explicitArgs = profile.buildArgs('', [], [], { model: 'zyb-gpt' });
      assert.equal(explicitArgs[explicitArgs.indexOf('--model') + 1], 'zyb-gpt');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('local agent profiles skip explicit unknown baseAgent without falling back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'readable-local-agent-profiles-invalid-'));
  try {
    await withEnvSnapshot(['READABLE_AGENT_PROFILES_CONFIG'], async () => {
      const config = join(dir, 'agents.local.json');
      writeFileSync(
        config,
        JSON.stringify({
          agents: [
            { id: 'claude', bin: 'duplicate' },
            { id: 'bad id with spaces', bin: 'bad' },
            { id: 'unknown-base', baseAgent: 'does-not-exist', bin: 'bad' },
            { id: 'ok-wrapper', bin: 'ok-wrapper' },
          ],
        }),
      );
      process.env.READABLE_AGENT_PROFILES_CONFIG = config;

      const profiles = readLocalAgentProfileDefs();

      assert.deepEqual(profiles.map((profile) => profile.id), ['ok-wrapper']);
      assert.equal(profiles[0]?.bin, 'ok-wrapper');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sandbox mode ignores implicit and host explicit local agent profiles', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'readable-local-agent-profiles-sandbox-'));
  try {
    await withEnvSnapshot(['READABLE_AGENT_PROFILES_CONFIG', 'READABLE_SANDBOX_MODE', 'READABLE_DATA_DIR'], async () => {
      const config = join(dir, 'agents.local.json');
      writeFileSync(
        config,
        JSON.stringify({
          agents: [{ id: 'explicit-wrapper', bin: 'explicit-wrapper' }],
        }),
      );

      process.env.READABLE_SANDBOX_MODE = '1';
      delete process.env.READABLE_DATA_DIR;
      delete process.env.READABLE_AGENT_PROFILES_CONFIG;
      assert.deepEqual(readLocalAgentProfileDefs(), []);

      process.env.READABLE_AGENT_PROFILES_CONFIG = config;
      assert.deepEqual(readLocalAgentProfileDefs(), []);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex argv keeps danger-full-access free of permissions overrides while workspace-write retains them', () => {
  withEnvSnapshot(['READABLE_CODEX_DISABLE_PLUGINS', 'READABLE_CODEX_SANDBOX', 'WSL_DISTRO_NAME'], () => {
    delete process.env.READABLE_CODEX_DISABLE_PLUGINS;
    delete process.env.READABLE_CODEX_SANDBOX;
    delete process.env.WSL_DISTRO_NAME;

    withPlatform('win32', () => {
      assert.deepEqual(codex.buildArgs('', [], [], {}, {}), [
        'app-server', '--listen', 'stdio://', '-c', 'sandbox_mode="danger-full-access"',
      ]);
    });
    withPlatform('darwin', () => {
      assert.deepEqual(codex.buildArgs('', [], [], {}, {}), [
        'app-server', '--listen', 'stdio://', '-c', 'sandbox_mode="workspace-write"',
        '-c', 'sandbox_workspace_write.network_access=true',
        '-c', 'default_permissions=":workspace"',
      ]);
    });
  });
});

test('codex args disable plugins when READABLE_CODEX_DISABLE_PLUGINS is 1', () => {
  withEnvSnapshot(['READABLE_CODEX_DISABLE_PLUGINS', 'READABLE_CODEX_SANDBOX'], () => {
    process.env.READABLE_CODEX_DISABLE_PLUGINS = '1';
    delete process.env.READABLE_CODEX_SANDBOX;

    withPlatform('darwin', () => {
      const args = codex.buildArgs('', [], [], {}, { cwd: '/tmp/readable-project' });

      assert.deepEqual(args.slice(0, 11), [
        'app-server',
        '--listen',
        'stdio://',
        '-c',
        'sandbox_mode="workspace-write"',
        '-c',
        'sandbox_workspace_write.network_access=true',
        '-c',
        'default_permissions=":workspace"',
        '--disable',
        'plugins',
      ]);
    });
  });
});

test('codex args use workspace-write sandbox on macOS and Linux', () => {
  withEnvSnapshot(['READABLE_CODEX_DISABLE_PLUGINS', 'READABLE_CODEX_SANDBOX', 'WSL_DISTRO_NAME'], () => {
    delete process.env.READABLE_CODEX_DISABLE_PLUGINS;
    delete process.env.READABLE_CODEX_SANDBOX;

    for (const platform of ['darwin', 'linux'] as const) {
      withPlatform(platform, () => {
        delete process.env.WSL_DISTRO_NAME;
        const args = codex.buildArgs('', [], [], {}, { cwd: '/tmp/readable-project' });
        assert.equal(args.includes('--full-auto'), false);
        assert.deepEqual(args.slice(0, 5), [
          'app-server',
          '--listen',
          'stdio://',
          '-c',
          'sandbox_mode="workspace-write"',
        ]);
        assert.equal(
          args.includes('-c'),
          true,
        );
        assert.equal(
          args.includes('default_permissions=":workspace"'),
          true,
        );
      });
    }
  });
});

test('codex args use danger-full-access sandbox on WSL because workspace-write stays read-only', () => {
  withPlatform('linux', () => {
    withEnvSnapshot(['READABLE_CODEX_DISABLE_PLUGINS', 'READABLE_CODEX_SANDBOX', 'WSL_DISTRO_NAME'], () => {
      delete process.env.READABLE_CODEX_DISABLE_PLUGINS;
      delete process.env.READABLE_CODEX_SANDBOX;
      process.env.WSL_DISTRO_NAME = 'Ubuntu';
      assert.equal(codexNeedsDangerFullAccessSandbox('linux', process.env), true);
      const args = codex.buildArgs('', [], [], {}, { cwd: '/tmp/readable-project' });
      assert.deepEqual(args.slice(0, 5), [
        'app-server', '--listen', 'stdio://', '-c', 'sandbox_mode="danger-full-access"',
      ]);
      assert.equal(args.some((arg) => arg.startsWith('default_permissions=')), false);
    });
  });
});

test('codex args allow READABLE_CODEX_SANDBOX danger-full-access override on Linux', () => {
  withPlatform('linux', () => {
    withEnvSnapshot(['READABLE_CODEX_DISABLE_PLUGINS', 'READABLE_CODEX_SANDBOX', 'WSL_DISTRO_NAME'], () => {
      delete process.env.READABLE_CODEX_DISABLE_PLUGINS;
      process.env.READABLE_CODEX_SANDBOX = 'danger-full-access';
      delete process.env.WSL_DISTRO_NAME;

      assert.equal(codexNeedsDangerFullAccessSandbox('linux', process.env), true);
      const args = codex.buildArgs('', [], [], {}, { cwd: '/tmp/readable-project' });
      assert.deepEqual(args.slice(0, 5), [
        'app-server', '--listen', 'stdio://', '-c', 'sandbox_mode="danger-full-access"',
      ]);
      assert.equal(
        args.includes('sandbox_workspace_write.network_access=true'),
        false,
      );
      assert.equal(args.some((arg) => arg.startsWith('default_permissions=')), false);
    });
  });
});

test('codex args ignore unknown READABLE_CODEX_SANDBOX values', () => {
  withPlatform('linux', () => {
    withEnvSnapshot(['READABLE_CODEX_DISABLE_PLUGINS', 'READABLE_CODEX_SANDBOX', 'WSL_DISTRO_NAME'], () => {
      delete process.env.READABLE_CODEX_DISABLE_PLUGINS;
      process.env.READABLE_CODEX_SANDBOX = 'workspace-write';
      delete process.env.WSL_DISTRO_NAME;

      assert.equal(codexNeedsDangerFullAccessSandbox('linux', process.env), false);
      const args = codex.buildArgs('', [], [], {}, { cwd: '/tmp/readable-project' });
      assert.deepEqual(args.slice(0, 5), [
        'app-server', '--listen', 'stdio://', '-c', 'sandbox_mode="workspace-write"',
      ]);
    });
  });
});

test('codex args use danger-full-access sandbox on Windows because workspace-write blocks PowerShell', () => {
  // Codex CLI's workspace-write sandbox mode on Windows lacks a working
  // OS-level sandbox and falls back to a policy that rejects shell
  // invocations such as powershell.exe with "blocked by policy".
  // The agent cannot list files or run any shell-backed tool under that
  // policy. danger-full-access is Codex CLI's documented Windows-compatible
  // mode (issue #1721).
  withEnvSnapshot(['READABLE_CODEX_DISABLE_PLUGINS', 'READABLE_CODEX_SANDBOX'], () => {
    delete process.env.READABLE_CODEX_DISABLE_PLUGINS;
    delete process.env.READABLE_CODEX_SANDBOX;

    withPlatform('win32', () => {
      const args = codex.buildArgs('', [], [], {}, { cwd: '/tmp/readable-project' });

      assert.deepEqual(args.slice(0, 5), [
        'app-server', '--listen', 'stdio://', '-c', 'sandbox_mode="danger-full-access"',
      ]);
      // The workspace-write-scoped network override is meaningless under
      // danger-full-access and must not appear on Windows.
      assert.equal(args.includes('workspace-write'), false);
      assert.equal(
        args.includes('sandbox_workspace_write.network_access=true'),
        false,
      );
      assert.equal(args.some((arg) => arg.startsWith('default_permissions=')), false);
    });
  });
});

test('codex args keep plugins enabled when READABLE_CODEX_DISABLE_PLUGINS is unset', () => {
  withEnvSnapshot(['READABLE_CODEX_DISABLE_PLUGINS', 'READABLE_CODEX_SANDBOX'], () => {
    delete process.env.READABLE_CODEX_DISABLE_PLUGINS;
    delete process.env.READABLE_CODEX_SANDBOX;

    withPlatform('darwin', () => {
      const args = codex.buildArgs('', [], [], {}, { cwd: '/tmp/readable-project' });

      assert.equal(args.includes('--disable'), false);
      assert.equal(args.includes('plugins'), false);
    });
  });
});

test('codex args keep plugins enabled when READABLE_CODEX_DISABLE_PLUGINS is not 1', () => {
  withEnvSnapshot(['READABLE_CODEX_DISABLE_PLUGINS', 'READABLE_CODEX_SANDBOX'], () => {
    process.env.READABLE_CODEX_DISABLE_PLUGINS = 'true';
    delete process.env.READABLE_CODEX_SANDBOX;

    withPlatform('darwin', () => {
      const args = codex.buildArgs('', [], [], {}, { cwd: '/tmp/readable-project' });

      assert.equal(args.includes('--disable'), false);
      assert.equal(args.includes('plugins'), false);
    });
  });
});

test('codex has no speculative picker catalogue when live discovery fails', async () => {
  const expectedModels: string[] = [];

  assert.deepEqual(codex.fallbackModels.map((m) => m.id), expectedModels);
  assert.ok(codex.reasoningOptions, 'codex must define reasoningOptions');
  assert.deepEqual(codex.reasoningOptions.map((o) => o.id), [
    'default',
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
  ]);

  const args = codex.buildArgs(
    '',
    [],
    [],
    { model: 'gpt-5.5', reasoning: 'xhigh' },
    { cwd: '/tmp/readable-project' },
  );
  assert.ok(args.includes('model="gpt-5.5"'));
  assert.ok(args.includes('model_reasoning_effort="xhigh"'));

  const dir = mkdtempSync(join(tmpdir(), 'readable-agents-codex-models-'));
  try {
    await withEnvSnapshot(['PATH', 'READABLE_AGENT_HOME', 'CODEX_BIN', 'CODEX_HOME'], async () => {
      writeFakeCodexBin(dir, `
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex 1.0.0');
  process.exit(0);
}
process.exit(0);
`);
      process.env.READABLE_AGENT_HOME = dir;
      process.env.PATH = dir;
      process.env.CODEX_HOME = dir;
      delete process.env.CODEX_BIN;

      const agents = await detectAgents({ codex: { CODEX_HOME: dir } }, { enabledAgentIds: ['codex'], refresh: true });
      const detected = agents.find((agent) => agent.id === 'codex');

      assert.ok(detected);
      assert.equal(detected.available, false);
      assert.equal(detected.version, 'codex 1.0.0');
      assert.equal(detected.modelsSource, 'fallback');
      assert.deepEqual(detected.models.map((m: { id: string }) => m.id), expectedModels);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex parses the CLI-owned cache and app-server model/list shapes', () => {
  const cacheParsed = parseCodexModelCatalog(JSON.stringify({
    models: [
      { slug: 'gpt-5.3-codex-spark', display_name: 'GPT-5.3-Codex-Spark', visibility: 'list' },
      { slug: 'gpt-hidden-internal', display_name: 'Hidden internal', visibility: 'hide' },
    ],
  }));
  const appServerParsed = parseCodexModelCatalog(JSON.stringify({
    data: [
      { id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', hidden: false },
      { id: 'gpt-hidden-internal', displayName: 'Hidden internal', hidden: true },
    ],
  }));

  assert.deepEqual(cacheParsed, [
    { id: 'default', label: 'Default (CLI config)' },
    { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3-Codex-Spark' },
  ]);
  assert.deepEqual(appServerParsed, [
    { id: 'default', label: 'Default (CLI config)' },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
  ]);
});

test('codex detection does not resurrect a disk cache after adapter failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'readable-agents-codex-live-models-'));
  try {
    await withEnvSnapshot(['PATH', 'READABLE_AGENT_HOME', 'CODEX_BIN', 'CODEX_HOME'], async () => {
      writeFakeCodexBin(dir, `
if (process.argv[2] === '--version') {
  console.log('codex-cli 9.9.9');
  process.exit(0);
}
process.exit(2);
`);
      writeFileSync(join(dir, 'models_cache.json'), JSON.stringify({
        models: [
          { slug: 'gpt-5.3-codex-spark', display_name: 'GPT-5.3-Codex-Spark', visibility: 'list' },
        ],
      }));
      process.env.READABLE_AGENT_HOME = dir;
      process.env.PATH = dir;
      process.env.CODEX_HOME = dir;
      delete process.env.CODEX_BIN;

      const agents = await detectAgents({ codex: { CODEX_HOME: dir } }, { enabledAgentIds: ['codex'], refresh: true });
      const detected = agents.find((agent) => agent.id === 'codex');

      assert.ok(detected);
      assert.equal(detected.available, false);
      assert.equal(detected.modelsSource, 'fallback');
      assert.deepEqual(detected.models, []);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex ships no account-independent fallback snapshot', () => {
  assert.deepEqual(codex.fallbackModels, []);
});

test('cursor-agent parses live model ids separately from display labels', () => {
  assert.ok(cursorAgent.listModels, 'cursor-agent must define live model discovery');
  const parsed = cursorAgent.listModels.parse([
    'Available models',
    'auto - Auto',
    'composer-2.5 - Composer 2.5 (current)',
    'grok-4.3 - Grok 4.3 1M',
  ].join('\n'));

  assert.deepEqual(parsed, [
    { id: 'default', label: 'Default (CLI config)' },
    { id: 'auto', label: 'Auto' },
    { id: 'composer-2.5', label: 'Composer 2.5 (current)' },
    { id: 'grok-4.3', label: 'Grok 4.3 1M' },
  ]);
});

test('cursor-agent probes allow slow Windows VDI startup', () => {
  assert.ok(cursorAgent.listModels, 'cursor-agent must define live model discovery');
  assert.ok((cursorAgent.listModels.timeoutMs ?? 0) >= 90_000);

  assert.ok(cursorAgent.authProbe, 'cursor-agent must define an auth probe');
  assert.deepEqual(cursorAgent.authProbe.args, ['status']);
  assert.ok((cursorAgent.authProbe.timeoutMs ?? 0) >= 90_000);
});

test('grok-build filters login headers from live model discovery output', () => {
  assert.ok(grokBuild.listModels, 'grok-build must define live model discovery');
  const parsed = grokBuild.listModels.parse([
    'You are logged in with grok.com.',
    '',
    'Default model: grok-build',
    '',
    'Available models:',
    '',
    '- grok-composer-2.5-fast',
    '* grok-build (default)',
  ].join('\n'));

  assert.deepEqual(parsed, [
    { id: 'default', label: 'Default (CLI config)' },
    { id: 'grok-composer-2.5-fast', label: 'grok-composer-2.5-fast' },
    { id: 'grok-build', label: 'grok-build' },
  ]);
});

// Recent Codex CLI versions reject a bare `-` argv sentinel; passing it
// alongside the stdin pipe causes `error: unexpected argument '-' found`
// and exit code 2 before any prompt is read. We deliver the prompt via
// stdin pipe alone (gated by `promptViaStdin: true`). Regression of #237.
test('codex args do not include the literal `-` stdin sentinel (regression of #237)', () => {
  delete process.env.READABLE_CODEX_DISABLE_PLUGINS;

  const baseArgs = codex.buildArgs('', [], [], {}, { cwd: '/tmp/readable-project' });
  assert.equal(baseArgs.includes('-'), false);

  const withModel = codex.buildArgs(
    '',
    [],
    [],
    { model: 'gpt-5-codex' },
    { cwd: '/tmp/readable-project' },
  );
  assert.equal(withModel.includes('-'), false);

  const withReasoning = codex.buildArgs(
    '',
    [],
    [],
    { reasoning: 'high' },
    { cwd: '/tmp/readable-project' },
  );
  assert.equal(withReasoning.includes('-'), false);

  process.env.READABLE_CODEX_DISABLE_PLUGINS = '1';
  const withDisablePlugins = codex.buildArgs(
    '',
    [],
    [],
    {},
    { cwd: '/tmp/readable-project' },
  );
  assert.equal(withDisablePlugins.includes('-'), false);
});

test('codex args pass valid extraAllowedDirs through app-server sandbox config', () => {
  delete process.env.READABLE_CODEX_DISABLE_PLUGINS;

  const args = codex.buildArgs(
    '',
    [],
    ['/repo/skills', '', null, '/tmp/codex/generated_images', undefined] as unknown as string[],
    {},
    { cwd: '/tmp/readable-project' },
  );

  assert.ok(args.includes('sandbox_workspace_write.writable_roots=["/repo/skills","/tmp/codex/generated_images"]'));
});
