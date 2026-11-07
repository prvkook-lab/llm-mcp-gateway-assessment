import { describe, it, expect } from 'vitest';
import { PiiRedactor, redactStream } from '../src/task3/redaction.js';
import { createLlmGateway } from '../src/task3/gateway.js';
import { TokenLimiter } from '../src/task4/limiter.js';
import { ProviderError, type Provider } from '../src/task4/providers.js';
import { close, listen } from './helpers.js';
async function collect(source: AsyncIterable<string>) { let text = ''; for await (const chunk of source) text += chunk; return text; }
describe('Task 3: cross-chunk PII redaction and streaming gateway', () => {
  it('redacts emails, phone numbers, SSNs and Unicode digits at every split point', () => {
    const text = 'Contact alice@example.com or +1 (212) 555-1234; SSN 123-45-6789 and １２３. End';
    for (let split = 0; split <= text.length; split++) {
      const redactor = new PiiRedactor();
      const result = redactor.push(text.slice(0, split)) + redactor.push(text.slice(split)) + redactor.finish();
      expect(result).not.toMatch(/alice|example|212|555|123|１２３/);
      expect(result).toContain('Contact'); expect(result).toContain('End');
    }
  });
  it('handles single-character chunks and flushes only complete safe tokens', async () => {
    async function* input() { yield* 'hello alice@example.com world'; }
    expect(await collect(redactStream(input()))).toBe('hello [REDACTED] world');
    const redactor = new PiiRedactor();
    expect(redactor.push('secret@')).toBe('');
    expect(redactor.push('host.test ')).toBe('[REDACTED] ');
  });
  it('bounds memory and suppresses the entire oversized token', () => {
    const redactor = new PiiRedactor(8);
    expect(redactor.push('abcdefgh')).toBe('[REDACTED]');
    expect(redactor.push('more@example.com')).toBe('');
    expect(redactor.push(' safe ')).toBe(' safe ');
    expect(redactor.finish()).toBe('');
  });
  it('does not flush partially received PII on upstream failure', async () => {
    async function* input() { yield 'hello alice@'; throw new Error('failed'); }
    let emitted = '';
    await expect((async () => { for await (const chunk of redactStream(input())) emitted += chunk; })()).rejects.toThrow('failed');
    expect(emitted).toBe('hello ');
  });
  it('streams redacted SSE, authenticates and enforces request validation and token quotas', async () => {
    const limiter = new TokenLimiter(':memory:', 100);
    const provider: Provider = { name: 'test', async *stream() { yield 'Hello al'; yield 'ice@example.com '; yield 'world'; } };
    const gateway = createLlmGateway({ providers: [provider], principals: [{ id: 'u', role: 'reader', key: 'secret' }], limiter });
    const url = await listen(gateway) + '/v1/stream';
    const post = (body: unknown, key = 'secret') => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
    try {
      expect((await post({ prompt: 'hi' }, 'bad')).status).toBe(401);
      expect((await post({ prompt: 'hi', maxOutputTokens: -1 })).status).toBe(400);
      expect((await post({ prompt: 'hi', extra: true })).status).toBe(400);
      const response = await post({ prompt: 'hi', maxOutputTokens: 60 });
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      const output = await response.text();
      expect(output).toContain('[REDACTED]'); expect(output).toContain('event: done');
      expect(output).not.toContain('alice');
      const denied = await post({ prompt: 'hi', maxOutputTokens: 60 });
      expect(denied.status).toBe(429); expect(Number(denied.headers.get('retry-after'))).toBeGreaterThan(0);
      expect((await post({ prompt: 'x'.repeat(100), maxOutputTokens: 1 })).status).toBe(413);
    } finally { await close(gateway); limiter.close(); }
  });
  it('charges each provider attempt and redacts fallback output', async () => {
    const limiter = new TokenLimiter(':memory:', 100);
    const gateway = createLlmGateway({ limiter, principals: [{ id: 'u', role: 'reader', key: 'secret' }], providers: [
      { name: 'primary', async *stream() { throw new ProviderError(429); } },
      { name: 'fallback', async *stream() { yield 'a@b.com'; } },
    ] });
    const url = await listen(gateway) + '/v1/stream';
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: JSON.stringify({ prompt: 'hi', maxOutputTokens: 10 }) });
      expect(await response.text()).toContain('[REDACTED]');
      expect(limiter.consume('u', 76)).toEqual({ allowed: true, remaining: 0 });
    } finally { await close(gateway); limiter.close(); }
  });
});

describe('Task 3 review regressions', () => {
  it('redacts non-BMP numeric characters even when UTF-16 surrogate pairs span chunks', () => {
    const text = 'safe 𝟙𝟚𝟛 user@example.com done';
    const redactor = new PiiRedactor(); let result = '';
    for (let i = 0; i < text.length; i++) result += redactor.push(text[i]!);
    result += redactor.finish();
    expect(result).toBe('safe [REDACTED] [REDACTED] done');
  });
  it('terminates a partial response with sanitized SSE error and no unfinished token or done event', async () => {
    const limiter = new TokenLimiter(':memory:', 100);
    const gateway = createLlmGateway({ limiter, principals: [{ id: 'u', role: 'reader', key: 'secret' }], providers: [
      { name: 'failing', async *stream() { yield 'Hello alice@'; throw new Error('provider-secret'); } },
    ] });
    const url = await listen(gateway) + '/v1/stream';
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: JSON.stringify({ prompt: 'hi', maxOutputTokens: 20 }) });
      const output = await response.text();
      expect(output).toContain('Hello '); expect(output).toContain('event: error');
      expect(output).not.toMatch(/alice|provider-secret|event: done/);
    } finally { await close(gateway); limiter.close(); }
  });
  it('aborts the provider promptly when the HTTP client disconnects', async () => {
    const limiter = new TokenLimiter(':memory:', 100);
    let aborted!: () => void;
    const noticed = new Promise<void>(resolve => { aborted = resolve; });
    const gateway = createLlmGateway({ limiter, principals: [{ id: 'u', role: 'reader', key: 'secret' }], providers: [{
      name: 'waiting', async *stream(_request, signal) {
        signal.addEventListener('abort', aborted, { once: true });
        yield 'safe ';
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
        signal.throwIfAborted();
      },
    }] });
    const url = await listen(gateway) + '/v1/stream';
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: JSON.stringify({ prompt: 'hi', maxOutputTokens: 20 }) });
      const reader = response.body!.getReader(); await reader.read(); await reader.cancel();
      await noticed;
    } finally { await close(gateway); limiter.close(); }
  });
  it('validates identities at startup instead of silently sharing quotas for duplicate IDs', () => {
    const limiter = new TokenLimiter(':memory:', 100);
    try {
      expect(() => createLlmGateway({ limiter, providers: [{ name: 'test', async *stream() { yield 'safe'; } }], principals: [
        { id: 'same', role: 'reader', key: 'one' }, { id: 'same', role: 'admin', key: 'two' },
      ] })).toThrow('Invalid principals');
    } finally { limiter.close(); }
  });
});

describe('SQLite contention integration', () => {
  it('fails closed with 503 and never calls a provider while another connection holds the write lock', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { vi } = await import('vitest');
    const directory = mkdtempSync(join(tmpdir(), 'gateway-lock-'));
    const path = join(directory, 'rate.sqlite');
    const limiter = new TokenLimiter(path, 100);
    const blocker = new DatabaseSync(path); blocker.exec('BEGIN IMMEDIATE');
    const provider = { name: 'test', stream: vi.fn(async function* () { yield 'safe'; }) };
    const gateway = createLlmGateway({ limiter, providers: [provider], principals: [{ id: 'u', role: 'reader', key: 'secret' }] });
    const url = await listen(gateway) + '/v1/stream';
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: JSON.stringify({ prompt: 'hi', maxOutputTokens: 10 }) });
      expect(response.status).toBe(503); expect(provider.stream).not.toHaveBeenCalled();
      blocker.exec('ROLLBACK');
      expect(limiter.consume('u', 100)).toEqual({ allowed: true, remaining: 0 });
    } finally { await close(gateway); blocker.close(); limiter.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
