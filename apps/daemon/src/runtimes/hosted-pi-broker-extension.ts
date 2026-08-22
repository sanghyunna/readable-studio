import { createConnection } from 'node:net';

// Keep this above the broker's worst-case JSON expansion of a 4 MiB file.
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_DESIGN_SYSTEM_CONTENT_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

type BrokerParams = {
  operation: 'project:file:list' | 'project:file:read' | 'project:file:write' | 'design-system:read';
  path?: string;
  content?: string;
  designSystemId?: string;
};

type BrokerResponse = {
  ok: boolean;
  operation?: string;
  content?: string;
  entries?: string[];
  code?: string;
  message?: string;
};

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

type ExtensionApi = {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    promptSnippet: string;
    parameters: Record<string, unknown>;
    execute(
      toolCallId: string,
      params: BrokerParams,
      signal: AbortSignal | undefined,
    ): Promise<ToolResult>;
  }): void;
};

const parameters: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    operation: {
      type: 'string',
      enum: ['project:file:list', 'project:file:read', 'project:file:write', 'design-system:read'],
    },
    path: { type: 'string' },
    content: { type: 'string' },
    designSystemId: { type: 'string' },
  },
  required: ['operation'],
};

function responseText(response: BrokerResponse): string {
  if (!response.ok) return response.message || 'hosted Pi broker rejected the request';
  if (typeof response.content === 'string') return response.content;
  if (Array.isArray(response.entries)) return response.entries.join('\n');
  return 'ok';
}

function callBroker(params: BrokerParams, signal: AbortSignal | undefined): Promise<BrokerResponse> {
  const socketPath = process.env.READABLE_HOSTED_PI_BROKER_SOCKET;
  const token = process.env.READABLE_HOSTED_PI_BROKER_TOKEN;
  if (!socketPath || !token) return Promise.reject(new Error('hosted Pi broker is unavailable'));

  return new Promise<BrokerResponse>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    let settled = false;
    let timeout: NodeJS.Timeout;
    const finish = (error: Error | null, response?: BrokerResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      if (error) reject(error);
      else if (response) resolve(response);
      else reject(new Error('hosted Pi broker returned no response'));
    };
    const abort = () => finish(new Error('hosted Pi broker request cancelled'));
    timeout = setTimeout(() => finish(new Error('hosted Pi broker timed out')), REQUEST_TIMEOUT_MS);
    timeout.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ ...params, token })}\n`);
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_RESPONSE_BYTES) {
        finish(new Error('hosted Pi broker response is too large'));
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as BrokerResponse;
        finish(null, response);
      } catch {
        finish(new Error('hosted Pi broker response is invalid'));
      }
    });
    socket.once('error', (error) => finish(error));
  });
}

function designSystemRequest(params: BrokerParams): { path: string; designSystemId?: string } {
  const keys = Object.keys(params);
  if (
    params.operation !== 'design-system:read'
    || keys.some((key) => !['operation', 'path', 'designSystemId'].includes(key))
    || typeof params.path !== 'string'
    || Buffer.byteLength(params.path, 'utf8') < 1
    || Buffer.byteLength(params.path, 'utf8') > 1_024
    || /[\u0000-\u001f\u007f]/u.test(params.path)
    || params.path.startsWith('/')
    || params.path.includes('\\')
    || /^[A-Za-z]:/u.test(params.path)
    || params.path.split('/').some((part) => part === '' || part === '.' || part === '..')
    || (
      params.designSystemId !== undefined
      && !/^(?!\.+$)[A-Za-z0-9._-]{1,128}$/u.test(params.designSystemId)
    )
  ) throw new Error('hosted design-system read request is invalid');
  return {
    path: params.path,
    ...(params.designSystemId === undefined ? {} : { designSystemId: params.designSystemId }),
  };
}

function designSystemEnvironment(): { readUrl: string; toolToken: string; carrierToken: string } {
  const readUrl = process.env.READABLE_HOSTED_DESIGN_SYSTEM_READ_URL;
  const toolToken = process.env.READABLE_TOOL_TOKEN;
  const carrierToken = process.env.READABLE_HOSTED_PI_BROKER_TOKEN;
  if (
    !readUrl
    || !toolToken
    || !/^odds_[A-Za-z0-9_-]{43}$/u.test(toolToken)
    || !carrierToken
    || !/^odpi_[A-Za-z0-9_-]{43}$/u.test(carrierToken)
  ) {
    throw new Error('hosted design-system read is unavailable');
  }
  let url: URL;
  try { url = new URL(readUrl); } catch { throw new Error('hosted design-system read is unavailable'); }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username !== ''
    || url.password !== ''
    || url.search !== ''
    || url.hash !== ''
    || url.pathname !== '/api/tools/design-systems/read'
    || url.toString() !== readUrl
  ) throw new Error('hosted design-system read is unavailable');
  return { readUrl, toolToken, carrierToken };
}

async function callDesignSystem(
  params: BrokerParams,
  signal: AbortSignal | undefined,
): Promise<BrokerResponse> {
  const request = designSystemRequest(params);
  const { readUrl, toolToken, carrierToken } = designSystemEnvironment();
  let response: Response;
  try {
    response = await fetch(readUrl, {
      method: 'POST',
      redirect: 'error',
      ...(signal ? { signal } : {}),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${toolToken}`,
        'Content-Type': 'application/json',
        'X-Readable-Studio-Tool-Token': carrierToken,
      },
      body: JSON.stringify(request),
    });
  } catch {
    throw new Error('hosted design-system read failed');
  }
  let body: string;
  try { body = await response.text(); } catch { throw new Error('hosted design-system read failed'); }
  if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error('hosted design-system read failed');
  }
  if (!response.ok) return { ok: false, message: 'hosted design-system read was denied' };
  try {
    const parsed = JSON.parse(body) as { content?: unknown };
    if (
      typeof parsed.content !== 'string'
      || Buffer.byteLength(parsed.content, 'utf8') > MAX_DESIGN_SYSTEM_CONTENT_BYTES
    ) throw new Error('invalid content');
    return { ok: true, operation: params.operation, content: parsed.content };
  } catch {
    throw new Error('hosted design-system read failed');
  }
}

export default function hostedPiBrokerExtension(pi: ExtensionApi): void {
  pi.registerTool({
    name: 'readable_hosted_broker',
    label: 'Hosted files',
    description: 'Use the daemon-owned project and design-system file capabilities for the current run.',
    promptSnippet: 'daemon-owned hosted file capabilities',
    parameters,
    async execute(_toolCallId, params, signal) {
      try {
        const response = params.operation === 'design-system:read'
          ? await callDesignSystem(params, signal)
          : await callBroker(params, signal);
        return {
          content: [{ type: 'text', text: responseText(response) }],
          ...(response.ok ? {} : { isError: true }),
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        };
      }
    },
  });
}
