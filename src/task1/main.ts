import { createMcpHttpServer, serveStdio } from './transports.js';
const transport = process.env.MCP_TRANSPORT ?? 'stdio';
if (transport === 'stdio') await serveStdio(process.stdin, process.stdout);
else if (transport === 'http') {
  const server = createMcpHttpServer();
  server.listen(Number(process.env.PORT ?? 3001), process.env.HOST ?? '127.0.0.1');
  process.once('SIGTERM', () => server.close());
} else throw new Error('MCP_TRANSPORT must be stdio or http');
