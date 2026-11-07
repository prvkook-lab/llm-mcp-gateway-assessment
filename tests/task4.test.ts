import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import ts from 'typescript';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenLimiter } from '../src/task4/limiter.js';
import { ProviderError, ProviderTimeout, SseProvider, streamWithFallback, type Provider } from '../src/task4/providers.js';
async function collect(source: AsyncIterable<string>) { let output = ''; for await (const chunk of source) output += chunk; return output; }
const request = { prompt: 'hello', maxOutputTokens: 10 };
const good: Provider = { name: 'good', async *stream() { yield 'safe '; yield 'text'; } };
describe('Task 4: SQLite sliding-window limiter', () => {
  it('enforces exact rolling boundaries, token cost, per-subject isolation and correct retry time', () => {
    const limiter = new TokenLimiter(':memory:', 10, 1000);
    try {
      expect(limiter.consume('a', 4, 1000)).toEqual({ allowed: true, remaining: 6 });
      expect(limiter.consume('a', 6, 1500)).toEqual({ allowed: true, remaining: 0 });
      expect(limiter.consume('a', 7, 1600)).toEqual({ allowed: false, retryAfterMs: 900 });
      expect(limiter.consume('a', 4, 1999)).toEqual({ allowed: false, retryAfterMs: 1 });
      expect(limiter.consume('a', 4, 2000)).toEqual({ allowed: true, remaining: 0 });
      expect(limiter.consume('b', 10, 2000).allowed).toBe(true);
      expect(limiter.consume('a', 11, 2000).allowed).toBe(false);
      expect(() => limiter.consume('a', -1)).toThrow();
    } finally { limiter.close(); }
  });
  it('persists reservations, shares atomic state across connections, and rejects config mismatch', () => {
    const directory = mkdtempSync(join(tmpdir(), 'limiter-')); const path = join(directory, 'test.sqlite');
    const a = new TokenLimiter(path, 10); const b = new TokenLimiter(path, 10);
    try {
      expect(a.consume('user', 7, 1000).allowed).toBe(true);
      expect(b.consume('user', 4, 1000).allowed).toBe(false);
      expect(() => new TokenLimiter(path, 20)).toThrow('mismatch');
      a.close();
      const reopened = new TokenLimiter(path, 10);
      try { expect(reopened.consume('user', 4, 1000).allowed).toBe(false); } finally { reopened.close(); }
    } finally { b.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('prevents oversubscription during concurrent reservations from separate workers', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'limiter-concurrent-'));
    const path = join(directory, 'shared.sqlite');
    const setup = new TokenLimiter(path, 10); setup.close();
    const source = readFileSync(new URL('../src/task4/limiter.ts', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext } }).outputText;
    const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(compiled).toString('base64');
    const script = `import { parentPort, workerData } from 'node:worker_threads';
      import { TokenLimiter } from '${moduleUrl}';
      const limiter = new TokenLimiter(workerData, 10);
      parentPort.postMessage('ready');
      parentPort.once('message', () => {
        let allowed = 0;
        for (let i = 0; i < 20; i++) if (limiter.consume('same-user', 1, 1000).allowed) allowed++;
        limiter.close(); parentPort.postMessage(allowed);
      });`;
    const workers = Array.from({ length: 4 }, () => new Worker(new URL('data:text/javascript;base64,' + Buffer.from(script).toString('base64')), { workerData: path }));
    try {
      await Promise.all(workers.map(worker => new Promise<void>((resolve, reject) => { worker.once('message', () => resolve()); worker.once('error', reject); })));
      const results = workers.map(worker => new Promise<number>((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }));
      workers.forEach(worker => worker.postMessage('start'));
      expect((await Promise.all(results)).reduce((a, b) => a + b, 0)).toBe(10);
    } finally { await Promise.all(workers.map(worker => worker.terminate())); rmSync(directory, { recursive: true, force: true }); }
  });
  it('does not release quota on clock rollback', () => {
    const limiter = new TokenLimiter(':memory:', 10, 1000);
    try {
      limiter.consume('u', 10, 5000);
      expect(limiter.consume('u', 1, 1000)).toEqual({ allowed: false, retryAfterMs: 1000 });
      expect(limiter.consume('u', 10, 6000).allowed).toBe(true);
    } finally { limiter.close(); }
  });
});
describe('Task 4: provider fallback', () => {
  it('falls back on HTTP 429', async () => {
    const primary: Provider = { name: 'primary', async *stream() { throw new ProviderError(429); } };
    expect(await collect(streamWithFallback([primary, good], request, new AbortController().signal))).toBe('safe text');
  });
  it('aborts and falls back at the default 3000ms deadline even for an uncooperative provider', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const stuck: Provider = { name: 'stuck', async *stream(_request, value) { signal = value; await new Promise(() => {}); yield ''; } };
    try {
      const result = collect(streamWithFallback([stuck, good], request, new AbortController().signal));
      await vi.advanceTimersByTimeAsync(2999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toBe('safe text'); expect(signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('does not let empty chunks extend the first-text deadline', async () => {
    vi.useFakeTimers();
    const empty: Provider = { name: 'empty', async *stream() {
      while (true) { await new Promise(resolve => setTimeout(resolve, 1000)); yield ''; }
    } };
    try {
      const result = collect(streamWithFallback([empty, good], request, new AbortController().signal));
      await vi.advanceTimersByTimeAsync(3000);
      expect(await result).toBe('safe text');
    } finally { vi.useRealTimers(); }
  });
  it('does not replay after partial output or retry non-429 errors', async () => {
    const fallback = { name: 'fallback', stream: vi.fn(good.stream) };
    const partial: Provider = { name: 'partial', async *stream() { yield 'partial'; throw new ProviderError(429); } };
    await expect(collect(streamWithFallback([partial, fallback], request, new AbortController().signal))).rejects.toThrow(ProviderError);
    const bad: Provider = { name: 'bad', async *stream() { throw new ProviderError(500); } };
    await expect(collect(streamWithFallback([bad, fallback], request, new AbortController().signal))).rejects.toThrow(ProviderError);
    expect(fallback.stream).not.toHaveBeenCalled();
  });
  it('propagates exhaustion and caller cancellation', async () => {
    const bad: Provider = { name: 'bad', async *stream() { throw new ProviderError(429); } };
    await expect(collect(streamWithFallback([bad, bad], request, new AbortController().signal))).rejects.toThrow(ProviderError);
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    await expect(collect(streamWithFallback([good], request, controller.signal))).rejects.toThrow('cancelled');
  });
  it('times out an exhausted provider', async () => {
    const stuck: Provider = { name: 'stuck', async *stream() { await new Promise(() => {}); yield ''; } };
    await expect(collect(streamWithFallback([stuck], request, new AbortController().signal, 10))).rejects.toThrow(ProviderTimeout);
  });
});
describe('provider SSE adapter', () => {
  it('decodes byte-split UTF-8, CRLF, comments, and multiple SSE events', async () => {
    const wire = ': keepalive\r\n\r\ndata: {"choices":[{"delta":{"content":"héllo "}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"world"}}]}\n\ndata: [DONE]\n\n';
    const bytes = new TextEncoder().encode(wire);
    const response = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
    const fetcher = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;
    const provider = new SseProvider('test', 'https://example.test', 'key', 'model', fetcher);
    expect(await collect(provider.stream(request, new AbortController().signal))).toBe('héllo world');
  });
  it('recognizes HTTP 429 and fails on truncated or oversized SSE', async () => {
    for (const response of [new Response('', { status: 429 }), new Response('data: {}\n\n', { headers: { 'content-type': 'text/event-stream' } }), new Response('x'.repeat(65_537), { headers: { 'content-type': 'text/event-stream' } })]) {
      const provider = new SseProvider('test', 'https://example.test', 'key', 'model', vi.fn().mockResolvedValue(response) as unknown as typeof fetch);
      await expect(collect(provider.stream(request, new AbortController().signal))).rejects.toThrow(ProviderError);
    }
  });
});

describe('Task 4 review regressions', () => {
  it('does not retry caller cancellation while waiting for the first chunk', async () => {
    const controller = new AbortController();
    const fallback = { name: 'fallback', stream: vi.fn(good.stream) };
    const stuck: Provider = { name: 'stuck', async *stream() { await new Promise(() => {}); yield ''; } };
    const result = collect(streamWithFallback([stuck, fallback], request, controller.signal));
    const rejected = expect(result).rejects.toThrow('stop');
    controller.abort(new Error('stop')); await rejected;
    expect(fallback.stream).not.toHaveBeenCalled();
  });
  it('includes synchronous provider initialization in its deadline', async () => {
    vi.useFakeTimers();
    const slow: Provider = { name: 'sync', stream() {
      vi.advanceTimersByTime(3001);
      return { async *[Symbol.asyncIterator]() { yield 'late'; } };
    } };
    try { expect(await collect(streamWithFallback([slow, good], request, new AbortController().signal))).toBe('safe text'); }
    finally { vi.useRealTimers(); }
  });
  it('treats text arriving exactly at 3000ms as a timeout and never mixes provider output', async () => {
    vi.useFakeTimers();
    const late: Provider = { name: 'late', async *stream() { await new Promise(resolve => setTimeout(resolve, 3000)); yield 'late'; } };
    try {
      const result = collect(streamWithFallback([late, good], request, new AbortController().signal));
      await vi.advanceTimersByTimeAsync(3000);
      expect(await result).toBe('safe text');
    } finally { vi.useRealTimers(); }
  });
  it('does not fallback after a timeout following partial output', async () => {
    vi.useFakeTimers();
    const fallback = { name: 'fallback', stream: vi.fn(good.stream) };
    const partial: Provider = { name: 'partial', async *stream() { yield 'partial '; await new Promise(() => {}); } };
    try {
      const result = collect(streamWithFallback([partial, fallback], request, new AbortController().signal));
      const rejected = expect(result).rejects.toThrow(ProviderTimeout);
      await vi.advanceTimersByTimeAsync(3000); await rejected;
      expect(fallback.stream).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('uses a monotonic deadline when wall-clock time changes', async () => {
    vi.useFakeTimers();
    const stuck: Provider = { name: 'stuck', async *stream() { await new Promise(() => {}); yield ''; } };
    try {
      const result = collect(streamWithFallback([stuck, good], request, new AbortController().signal));
      vi.setSystemTime(Date.now() - 60_000);
      await vi.advanceTimersByTimeAsync(3000);
      expect(await result).toBe('safe text');
    } finally { vi.useRealTimers(); }
  });
  it('bounds empty SSE data lines as well as nonempty data', async () => {
    const response = new Response('data:\n'.repeat(12_000), { headers: { 'content-type': 'text/event-stream' } });
    const provider = new SseProvider('test', 'https://example.test', 'key', 'model', vi.fn().mockResolvedValue(response) as unknown as typeof fetch);
    await expect(collect(provider.stream(request, new AbortController().signal))).rejects.toThrow('SSE event too large');
  });
  it('falls back on a 429 even when cancelling its response body hangs', async () => {
    const body = new ReadableStream({ cancel: () => new Promise(() => {}) });
    const provider = new SseProvider('test', 'https://example.test', 'key', 'model', vi.fn().mockResolvedValue(new Response(body, { status: 429 })) as unknown as typeof fetch);
    expect(await collect(streamWithFallback([provider, good], request, new AbortController().signal))).toBe('safe text');
  });
  it('supports CR-only SSE framing', async () => {
    const response = new Response('data: {"choices":[{"delta":{"content":"hello"}}]}\r\rdata: [DONE]\r\r', { headers: { 'content-type': 'text/event-stream' } });
    const provider = new SseProvider('test', 'https://example.test', 'key', 'model', vi.fn().mockResolvedValue(response) as unknown as typeof fetch);
    expect(await collect(provider.stream(request, new AbortController().signal))).toBe('hello');
  });
});
