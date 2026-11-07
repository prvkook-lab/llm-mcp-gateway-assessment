import { createLlmGateway } from './gateway.js';
import { SseProvider } from '../task4/providers.js';
import { TokenLimiter } from '../task4/limiter.js';
import { requiredEnv } from '../shared/http.js';
const limiter = new TokenLimiter(process.env.RATE_DB ?? 'rate-limit.sqlite', 10_000);
const server = createLlmGateway({
  limiter,
  principals: [{ id: 'reader', role: 'reader', key: requiredEnv('READER_API_KEY') }, { id: 'admin', role: 'admin', key: requiredEnv('ADMIN_API_KEY') }],
  providers: [
    new SseProvider('primary', requiredEnv('PRIMARY_URL'), requiredEnv('PRIMARY_API_KEY'), requiredEnv('MODEL')),
    new SseProvider('fallback', requiredEnv('FALLBACK_URL'), requiredEnv('FALLBACK_API_KEY'), requiredEnv('MODEL')),
  ],
});
server.listen(Number(process.env.PORT ?? 3003), process.env.HOST ?? '127.0.0.1');
process.once('SIGTERM', () => { server.close(() => limiter.close()); });
