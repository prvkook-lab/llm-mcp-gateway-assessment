import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { z } from 'zod';
import { authenticate, validatePrincipals, type Principal } from '../task2/gateway.js';
import { HttpError, httpFailure, readJson } from '../shared/http.js';
import { redactStream } from './redaction.js';
import { streamWithFallback, type Provider } from '../task4/providers.js';
import { TokenLimiter } from '../task4/limiter.js';
const schema = z.strictObject({ prompt: z.string().min(1).max(16_384), maxOutputTokens: z.number().int().min(1).max(4096).default(512) });
export function createLlmGateway(options: {
  providers: readonly Provider[]; principals: readonly Principal[]; limiter: TokenLimiter; timeoutMs?: number;
}): Server {
  validatePrincipals(options.principals);
  if (!options.providers.length) throw new Error('Invalid gateway configuration');
  return createServer(async (req, res) => {
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableFinished) controller.abort(new Error('Client disconnected')); };
    res.on('close', disconnect);
    try {
      if (req.url !== '/v1/stream') throw new HttpError(404, 'Not found');
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
      if (req.headers.origin) throw new HttpError(403, 'Browser origins are disabled');
      const principal = authenticate(req.headers.authorization, options.principals);
      if (!principal) { res.setHeader('www-authenticate', 'Bearer'); throw new HttpError(401, 'Unauthorized'); }
      const parsed = schema.safeParse(await readJson(req));
      if (!parsed.success) throw new HttpError(400, 'Invalid completion request');
      const request = parsed.data;
      // UTF-8 byte count is a conservative input-token estimate for byte-based tokenizers.
      const reservation = Buffer.byteLength(request.prompt, 'utf8') + request.maxOutputTokens;
      if (reservation > options.limiter.capacity) throw new HttpError(413, 'Request exceeds token capacity');
      const providers = options.providers.map(provider => ({
        name: provider.name,
        async *stream(input: typeof request, signal: AbortSignal) {
          signal.throwIfAborted();
          let admission: ReturnType<TokenLimiter['consume']>;
          try { admission = options.limiter.consume(principal.id, reservation); }
          catch (error) {
            if (typeof error === 'object' && error !== null && 'errcode' in error && [5, 6].includes(Number(error.errcode))) throw new HttpError(503, 'Token quota store busy');
            throw error;
          }
          if (!admission.allowed) {
            if (!res.headersSent) res.setHeader('retry-after', Math.ceil(admission.retryAfterMs / 1000));
            throw new HttpError(429, 'Token rate limit exceeded');
          }
          yield* provider.stream(input, signal);
        },
      }));
      const send = async (event: string, payload: unknown) => {
        controller.signal.throwIfAborted();
        if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
        if (!res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)) {
          await once(res, 'drain', { signal: controller.signal });
        }
      };
      const source = streamWithFallback(providers, request, controller.signal, options.timeoutMs ?? 3000);
      let outputBytes = 0;
      async function* boundedSource() {
        for await (const chunk of source) {
          outputBytes += Buffer.byteLength(chunk);
          if (outputBytes > request.maxOutputTokens * 32) throw new Error('Provider output exceeds safety bound');
          yield chunk;
        }
      }
      for await (const text of redactStream(boundedSource())) await send('delta', { text });
      await send('done', {});
      res.end();
    } catch (error) {
      if (controller.signal.aborted) return;
      if (res.headersSent) {
        // Never flush a partial redactor token or expose provider error bodies.
        res.end('event: error\ndata: {"error":"Stream failed"}\n\n');
      } else httpFailure(res, error instanceof HttpError ? error : new HttpError(502, 'Provider unavailable'));
    } finally { res.off('close', disconnect); }
  });
}
