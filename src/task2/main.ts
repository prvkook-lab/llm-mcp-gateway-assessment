import { createSecurityGateway } from './gateway.js';
import { requiredEnv } from '../shared/http.js';
const server = createSecurityGateway({ upstream: requiredEnv('MCP_UPSTREAM'), principals: [
  { id: 'reader', role: 'reader', key: requiredEnv('READER_API_KEY') },
  { id: 'admin', role: 'admin', key: requiredEnv('ADMIN_API_KEY') },
] });
server.listen(Number(process.env.PORT ?? 3002), process.env.HOST ?? '127.0.0.1');
process.once('SIGTERM', () => server.close());
