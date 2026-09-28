/** Closed vocabulary: never forward raw upstream exception text, URLs or credentials. */
export function formatStreamFailure(error: unknown, phase: 'connecting' | 'reading', host: string): string | undefined {
  const parts: string[] = error === 'terminated' ? ['terminated (Pi did not provide a socket cause)'] : [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && typeof current === 'object' && !seen.has(current) && parts.length < 5) {
    seen.add(current);
    if (!(current instanceof Error)) break;
    const code = 'code' in current && typeof current.code === 'string' && /^(?:UND_ERR_[A-Z_]+|E(?:CONNRESET|PIPE|TIMEDOUT|HOSTUNREACH|NETUNREACH))$/.test(current.code)
      ? current.code : undefined;
    const message = /^(?:terminated|other side closed|fetch failed|body timeout|socket hang up)$/i.test(current.message)
      ? current.message : undefined;
    if (message || code) parts.push(`${current.name === 'SocketError' ? 'SocketError' : current.name === 'TypeError' ? 'TypeError' : 'Error'}: ${message ?? 'connection failed'}${code ? ` (${code})` : ''}`);
    current = current.cause;
  }
  if (!parts.length || parts.every(part => part === 'TypeError: fetch failed')) return undefined;
  return `Connection closed while ${phase === 'reading' ? 'reading the streaming response' : 'connecting'} from ${host} (${parts.join('; ')}). Retryable: yes; check the proxy or gateway connection and retry.`;
}
