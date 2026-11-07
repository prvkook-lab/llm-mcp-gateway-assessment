export class ProviderError extends Error {
  constructor(public readonly status: number, message = 'Provider failed') { super(message); }
}
export class ProviderTimeout extends Error {}
export interface CompletionRequest { prompt: string; maxOutputTokens: number }
export interface Provider {
  name: string;
  stream(request: CompletionRequest, signal: AbortSignal): AsyncIterable<string>;
}
async function timed<T>(operation: () => Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        abort = () => reject(controller.signal.reason ?? new Error('Aborted'));
        controller.signal.addEventListener('abort', abort, { once: true });
        if (controller.signal.aborted) { abort(); return; }
        timer = setTimeout(() => {
          const error = new ProviderTimeout('Provider timed out');
          reject(error); controller.abort(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) controller.signal.removeEventListener('abort', abort);
  }
}
/** Fallback only before any provider text has been committed. Each next() has a deadline. */
export async function* streamWithFallback(providers: readonly Provider[], request: CompletionRequest,
  signal: AbortSignal, timeoutMs = 3000): AsyncGenerator<string> {
  if (!providers.length) throw new Error('No providers configured');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid provider timeout');
  for (let index = 0; index < providers.length; index++) {
    signal.throwIfAborted();
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    let iterator: AsyncIterator<string> | undefined;
    let committed = false;
    let deadline = performance.now() + timeoutMs;
    try {
      iterator = providers[index]!.stream(request, controller.signal)[Symbol.asyncIterator]();
      while (true) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new ProviderTimeout('Provider timed out');
        const active = iterator;
        const next = await timed(() => active.next(), remaining, controller);
        signal.throwIfAborted();
        if (performance.now() >= deadline) throw new ProviderTimeout('Provider timed out');
        if (next.done) return;
        if (next.value) { committed = true; yield next.value; deadline = performance.now() + timeoutMs; }
      }
    } catch (error) {
      const retryable = error instanceof ProviderTimeout || error instanceof ProviderError && error.status === 429;
      if (signal.aborted || committed || !retryable || index === providers.length - 1) throw error;
    } finally {
      controller.abort();
      signal.removeEventListener('abort', cancel);
      // A non-cooperative provider must not block fallback indefinitely.
      const finished = iterator;
      if (finished?.return) void Promise.resolve().then(() => finished.return!()).catch(() => undefined);
    }
  }
}

/** OpenAI-compatible SSE adapter; does not depend on network chunk boundaries. */
export class SseProvider implements Provider {
  constructor(public readonly name: string, private readonly url: string, private readonly apiKey: string,
    private readonly model: string, private readonly fetcher: typeof fetch = fetch) {}
  async *stream(request: CompletionRequest, signal: AbortSignal): AsyncGenerator<string> {
    const response = await this.fetcher(this.url, {
      method: 'POST', signal, redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, stream: true, messages: [{ role: 'user', content: request.prompt }], max_tokens: request.maxOutputTokens }),
    });
    if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new ProviderError(response.status); }
    if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/event-stream' || !response.body) {
      void response.body?.cancel().catch(() => undefined); throw new ProviderError(502, 'Expected SSE');
    }
    let buffer = '';
    let data: string[] = [];
    let eventBytes = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.search(/[\r\n]/)) >= 0) {
          if (buffer[newline] === '\r' && newline === buffer.length - 1 && !done) break;
          const width = buffer[newline] === '\r' && buffer[newline + 1] === '\n' ? 2 : 1;
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + width);
          if (line.length > 65_536) throw new ProviderError(502, 'SSE frame too large');
          if (line.startsWith('data:')) {
            eventBytes += line.length + 1;
            if (eventBytes > 65_536) throw new ProviderError(502, 'SSE event too large');
            data.push(line.slice(5).replace(/^ /, ''));
          }
          if (line === '' && data.length) {
            const payload = data.join('\n'); data = []; eventBytes = 0;
            if (payload === '[DONE]') return;
            const event = JSON.parse(payload) as { error?: unknown; choices?: { delta?: { content?: unknown } }[] };
            if (event.error) throw new ProviderError(502);
            const text = event.choices?.[0]?.delta?.content;
            if (text !== undefined && text !== null && typeof text !== 'string') throw new ProviderError(502, 'Invalid content');
            if (typeof text === 'string') yield text;
          }
        }
        if (buffer.length > 65_536) throw new ProviderError(502, 'SSE line too large');
        if (done) throw new ProviderError(502, 'Truncated provider stream');
      }
    } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
}
