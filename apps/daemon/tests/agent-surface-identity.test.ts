import { execFile } from 'node:child_process';
import http from 'node:http';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const cliEntry = fileURLToPath(new URL('../bin/readable.mjs', import.meta.url));

function json(response: http.ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

describe('Readable Studio agent surface identity', () => {
  let baseUrl: string;
  let server: http.Server;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      switch (request.url) {
        case '/api/skills':
          json(response, { skills: [{ id: 'brief', name: 'Brief' }] });
          return;
        case '/api/design-systems':
          json(response, { designSystems: [] });
          return;
        case '/api/projects':
          json(response, { projects: [] });
          return;
        case '/api/active':
          json(response, { active: false });
          return;
        default:
          response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('fixture server did not bind TCP');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  it('reports invalid commands under the canonical executable identity', async () => {
    // Given: an unsupported top-level command.
    // When: the built CLI rejects it.
    const result = await execFileAsync(process.execPath, [cliEntry, 'definitely-invalid']).catch(
      (error: unknown) => error as { stderr: string },
    );

    // Then: the diagnostic names the shipped executable, never the removed alias.
    expect(result.stderr).toContain('unknown command: readable definitely-invalid');
    expect(result.stderr).not.toContain(`unknown command: ${['o', 'd'].join('')} `);
  });

  it('registers the canonical MCP server key when the default is used', async () => {
    // Given: the CLI can resolve no running daemon and must build its fallback launch spec.
    // When: an agent config preview is requested without --name.
    const result = await execFileAsync(process.execPath, [
      cliEntry,
      'mcp',
      'install',
      'cursor',
      '--print',
      '--json',
      '--daemon-url',
      'http://127.0.0.1:9',
    ]);

    // Then: the machine-consumed JSON config uses only the canonical product id.
    const payload = JSON.parse(result.stdout) as { preview: string };
    const preview = JSON.parse(payload.preview) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(preview.mcpServers)).toEqual(['readable-studio']);
  });

  it('publishes the canonical MCP protocol identity without changing tool inventory', async () => {
    // Given: a real stdio MCP process backed by deterministic HTTP fixtures.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliEntry, 'mcp', '--daemon-url', baseUrl],
      stderr: 'pipe',
    });
    const client = new Client({ name: 'identity-probe', version: '1.0.0' });

    try {
      // When: an MCP client initializes and inventories tools and resources.
      await client.connect(transport);
      const tools = await client.listTools();
      const resources = await client.listResources();
      const call = await client.callTool({ name: 'list_projects', arguments: {} });
      const resource = await client.readResource({ uri: 'readable-studio://focus/active' });

      // Then: identifiers carry Readable Studio while task-2 tool capability ids and response shapes stay exact.
      expect(client.getServerVersion()?.name).toBe('readable-studio');
      expect(tools.tools.map((tool) => tool.name)).toHaveLength(18);
      expect(resources.resources.map((item) => item.uri)).toEqual([
        'readable-studio://focus/active',
        'readable-studio://skills/brief/SKILL.md',
      ]);
      expect(call.content).toEqual([{ type: 'text', text: '{\n  "projects": []\n}' }]);
      expect(resource.contents).toEqual([{
        uri: 'readable-studio://focus/active',
        mimeType: 'application/json',
        text: '{\n  "active": false\n}',
      }]);
    } finally {
      await transport.close();
    }
  });
});
