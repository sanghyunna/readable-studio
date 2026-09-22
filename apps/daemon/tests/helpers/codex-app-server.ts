/** A real stdio RPC peer. The turn body controls notifications and completion. */
export function codexAppServerFixture(turnBody: string): string {
  return `
const { createInterface } = require('node:readline');
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
const text = delta => send({ method: 'item/agentMessage/delta', params: { itemId: 'message', delta } });
const fail = message => send({ method: 'turn/completed', params: { turn: { status: 'failed', error: { message } } } });
const finish = () => send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread' } } });
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn' } } });
    ${turnBody}
  }
}).on('close', () => process.exit(0));
`;
}
