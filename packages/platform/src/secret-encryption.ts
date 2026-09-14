import { createHash } from 'node:crypto';
import { createConnection, createServer, type Socket } from 'node:net';
import { resolve } from 'node:path';

/** Main-process OS encryption adapter. No Electron dependency or renderer API. */
export interface SecretEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export class SecretEncryptionUnavailable extends Error {
  constructor() { super('OS secret encryption unavailable'); }
}

/** A private local Windows pipe, scoped by the daemon's persistent data root, not its port. */
export function secretEncryptionPipe(dataRoot: string): string {
  const identity = resolve(dataRoot).toLowerCase();
  return `\\\\.\\pipe\\secret-encryption-${createHash('sha256').update(identity).digest('hex')}`;
}

const MAX_FRAME = 128 * 1024;
const TIMEOUT_MS = 5000;
type EncryptionRequest = { operation: 'encrypt' | 'decrypt'; value: string };
type EncryptionResponse = { ok: true; value: string } | { ok: false };

/** One bounded JSON frame per connection. Payloads and underlying errors are never logged. */
function readFrame(socket: Socket, receive: (value: unknown) => void): void {
  let bytes = 0;
  let text = '';
  socket.setEncoding('utf8');
  socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new SecretEncryptionUnavailable()));
  const onData = (chunk: string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_FRAME) { socket.destroy(new SecretEncryptionUnavailable()); return; }
    text += chunk;
    const end = text.indexOf('\n');
    if (end < 0) return;
    socket.off('data', onData);
    try { receive(JSON.parse(text.slice(0, end))); }
    catch { socket.destroy(new SecretEncryptionUnavailable()); }
  };
  socket.on('data', onData);
}

/** Start only after Electron app.whenReady(). Windows pipe ACLs are the local OS-user boundary. */
export async function serveSecretEncryption(dataRoot: string, encryption: SecretEncryption): Promise<{ close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // Transport failures are returned to the client as unavailable, never with secret-bearing causes.
    socket.on('error', () => socket.destroy());
    readFrame(socket, (raw) => {
      let response: EncryptionResponse = { ok: false };
      try {
        const request = raw as Partial<EncryptionRequest> | null;
        if (request && typeof request.value === 'string' && encryption.isEncryptionAvailable()) {
          if (request.operation === 'encrypt') response = { ok: true, value: encryption.encryptString(request.value).toString('base64') };
          else if (request.operation === 'decrypt') response = { ok: true, value: encryption.decryptString(Buffer.from(request.value, 'base64')) };
        }
      } catch { response = { ok: false }; }
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  await new Promise<void>((yes, no) => {
    server.once('error', no);
    server.listen(secretEncryptionPipe(dataRoot), () => { server.off('error', no); yes(); });
  });
  return { close: () => new Promise<void>((yes, no) => {
    for (const socket of sockets) socket.destroy();
    server.close((error) => error ? no(new SecretEncryptionUnavailable()) : yes());
  }) };
}

/** Real cross-process transport; plaintext exists only in process/kernel memory, never a file. */
export async function requestSecretEncryption(dataRoot: string, operation: EncryptionRequest['operation'], value: string): Promise<string> {
  if (process.platform !== 'win32') throw new SecretEncryptionUnavailable();
  return new Promise<string>((yes, no) => {
    const socket = createConnection(secretEncryptionPipe(dataRoot));
    const fail = () => { socket.destroy(); no(new SecretEncryptionUnavailable()); };
    socket.once('error', fail);
    socket.once('close', fail);
    readFrame(socket, (raw) => {
      const response = raw as Partial<EncryptionResponse> | null;
      if (!response || response.ok !== true || typeof response.value !== 'string') { fail(); return; }
      yes(response.value);
      socket.destroy();
    });
    socket.once('connect', () => socket.write(`${JSON.stringify({ operation, value })}\n`));
  });
}
