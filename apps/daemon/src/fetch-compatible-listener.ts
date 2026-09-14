import { once } from 'node:events';
import type { Server } from 'node:http';

// Fetch's bad-port table: https://fetch.spec.whatwg.org/#port-blocking
// Windows dynamic TCP ranges can include these even when requesting port 0.
const FORBIDDEN_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69,
  77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123,
  135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530,
  531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719,
  1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666,
  6667, 6668, 6669, 6679, 6697, 10080,
]);
const MAX_ATTEMPTS = 10;

export class FetchCompatiblePortError extends Error {
  constructor() {
    super(`Unable to bind a Fetch-compatible loopback port after ${MAX_ATTEMPTS} attempts`);
    this.name = 'FetchCompatiblePortError';
  }
}

/** Start an unbound HTTP server; never publish a Fetch-forbidden ephemeral port. */
export async function listenOnFetchCompatiblePort(server: Server): Promise<{ server: Server; port: number }> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const address = server.address();
    // A TCP listener's address is an AddressInfo after its listening event.
    if (address && typeof address !== 'string' && !FORBIDDEN_PORTS.has(address.port)) {
      return { server, port: address.port };
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
  throw new FetchCompatiblePortError();
}
