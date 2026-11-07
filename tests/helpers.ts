import type { Server } from 'node:http';
import { once } from 'node:events';
export async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  return `http://127.0.0.1:${address.port}`;
}
export async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
export const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' },
} };
export const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
export const rpcHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
