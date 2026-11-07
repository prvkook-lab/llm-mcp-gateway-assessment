# MCP and LLM Gateway Assessment

A TypeScript implementation of four backend engineering tasks: a custom Model Context Protocol (MCP) server, a role-based JSON-RPC security gateway, a streaming LLM gateway with incremental PII redaction, and a SQLite-backed token rate limiter with provider fallback.

The project emphasizes strict validation, explicit authorization, bounded streaming state, atomic quota admission, and deterministic failure handling.

## Architecture

| Module | Responsibility | Interface |
| --- | --- | --- |
| Task 1: MCP server | Tool discovery and execution with session lifecycle management | stdio or HTTP `/mcp` |
| Task 2: Security gateway | Authentication, role authorization, session ownership, and upstream validation | HTTP `/mcp` |
| Task 3: Streaming LLM gateway | Request validation, provider streaming, PII redaction, and client SSE delivery | HTTP `/v1/stream` |
| Task 4: Rate limiter and fallback | Persistent token reservations and provider selection after 429 or timeout | Integrated into Task 3 |

```text
MCP client ──> Security gateway ──> Custom MCP server
               authentication      lifecycle and tools
               role checks         strict arguments

LLM client ──> Streaming gateway ──> SQLite quota admission
                      │                     │
                      │              Primary provider
                      │                     │
                      │              Fallback provider
                      │              (429 or timeout)
                      │                     │
                      └── SSE response <── PII redaction
```

```text
src/
  shared/http.ts          Bounded JSON parsing and HTTP error handling
  task1/protocol.ts       JSON-RPC validation, MCP lifecycle, and tool handlers
  task1/transports.ts     stdio and stateful HTTP transports
  task1/main.ts           MCP server entry point
  task2/gateway.ts        Authentication, authorization, and MCP proxy
  task2/main.ts           Security gateway entry point
  task3/redaction.ts      Incremental, bounded PII redaction
  task3/gateway.ts        Streaming LLM endpoint
  task3/main.ts           LLM gateway entry point
  task4/limiter.ts        SQLite sliding-window token limiter
  task4/providers.ts      Provider SSE adapter, deadlines, and fallback
tests/                    Automated tests organized by task
README.md                 Setup, execution, architecture, and technical scope
REVIEW.md                 Review findings and regression coverage
```

## Prerequisites and setup

- Node.js **26.13.0 or newer**
- npm; verified with **11.20.0**

SQLite is provided by Node's built-in `node:sqlite` module and requires no separate database service or native npm dependency.

```sh
npm ci
npm run build
npm run typecheck
npm test
```

Use `npm install` when intentionally updating dependencies. The committed `package-lock.json` provides reproducible installations with `npm ci`.

For local execution, copy the configuration template and replace its placeholder endpoints and empty keys:

```sh
cp .env.example .env
```

`.env` is ignored by Git. The commands below use Node's `--env-file` option to load it; the npm start scripts do not load environment files automatically.

| Variable | Purpose |
| --- | --- |
| `HOST` | Bind address; defaults to `127.0.0.1` |
| `PORT` | Listener port; overridden per service in the examples below |
| `MCP_TRANSPORT` | `stdio` or `http` for Task 1 |
| `MCP_UPSTREAM` | MCP server URL, typically `http://127.0.0.1:3001/mcp` |
| `READER_API_KEY`, `ADMIN_API_KEY` | Distinct bearer keys mapped to server-configured roles |
| `PRIMARY_URL`, `FALLBACK_URL` | OpenAI-compatible streaming completion endpoints |
| `PRIMARY_API_KEY`, `FALLBACK_API_KEY` | Provider credentials |
| `MODEL` | Model identifier sent to both providers |
| `RATE_DB` | SQLite file path; defaults to `rate-limit.sqlite` |

## Task 1: Custom MCP server

The server implements the **2025-11-25** MCP lifecycle over JSON-RPC 2.0. Supported methods are `initialize`, `notifications/initialized`, `ping`, `tools/list`, and `tools/call`.

| Tool | Arguments | Behavior |
| --- | --- | --- |
| `add` | `{ "a": number, "b": number }` | Adds two finite numbers; overflow produces an MCP tool error |
| `echo` | `{ "text": string }` | Returns text, limited to 4096 characters |

Request envelopes, method parameters, and tool arguments are strictly validated. Standard `_meta` fields and supported client implementation information are accepted. Unknown parameters, nonfinite numbers, and JSON-RPC batches are rejected. Responses preserve string or safe-integer request IDs, including empty strings and zero. Duplicate IDs are rejected; tracking is bounded to 10,000 distinct IDs per session. Notifications receive no JSON-RPC response and do not execute tool calls.

### Execution

For stdio, run the compiled entry point directly:

```sh
node dist/task1/main.js
```

For HTTP:

```sh
MCP_TRANSPORT=http PORT=3001 node --env-file=.env dist/task1/main.js
```

With environment variables already exported, `npm run start:mcp` is also available. The checked-in `.npmrc` suppresses npm lifecycle banners to preserve protocol-only stdout. Avoid overriding its log level when using npm as an MCP launcher.

### Transport behavior

Stdio uses UTF-8, newline-delimited JSON. It handles fragmented and multiple frames, enforces a 64 KiB frame limit, reports malformed or unterminated frames, and resynchronizes after oversized input. Stdout contains only protocol messages.

HTTP uses `POST /mcp` for messages and `DELETE /mcp` to close a session. `GET /mcp` returns 405 because standalone SSE is not offered. POST requests require:

```text
Content-Type: application/json
Accept: application/json, text/event-stream
```

Initialize first, retain the returned `Mcp-Session-Id`, and send `notifications/initialized` before requesting tools. Subsequent POST and DELETE requests require the session ID and `MCP-Protocol-Version: 2025-11-25`. Initialization returns the supported protocol version for negotiation.

Sessions are isolated, expire after 30 idle minutes, and are capped at 1000. HTTP bodies are limited to 64 KiB. Malformed UTF-8, unsupported content encodings, invalid origins, and unacceptable media types are rejected. Browser origins are denied by default; the transport factory supports an explicit origin allowlist.

## Task 2: JSON-RPC security gateway

Start Task 1 in HTTP mode, then run the gateway in a separate terminal:

```sh
PORT=3002 node --env-file=.env dist/task2/main.js
```

The gateway exposes `/mcp` and requires `Authorization: Bearer <key>` on every request. It uses the same initialization, session, and protocol-header flow as Task 1.

| Role | Permitted tools | Shared operations |
| --- | --- | --- |
| Reader | `echo` | Initialize, acknowledge initialization, ping, list permitted tools, close owned sessions |
| Admin | `echo`, `add` | Same shared operations |

Roles are assigned by server configuration, never by client headers. Missing or invalid credentials return 401. Forbidden requests return HTTP 403 with JSON-RPC code `-32003`. Tool discovery is filtered, and invocation is independently authorized. Notification-shaped tool calls are not forwarded, even when the caller's role permits the named tool.

The gateway validates supported parameters before forwarding, binds sessions to authenticated identities, counts in-flight initialization toward capacity, and removes ownership on session deletion. Startup validation rejects duplicate identities, duplicate or empty keys, and unknown roles.

Upstream protection includes a fixed destination URL, blocked redirects, credential/header isolation, a 3000 ms deadline, and cancellation on client disconnect. Responses are bounded to 64 KiB and checked for matching IDs, mutually exclusive result/error fields, valid error types, and valid tool-list structures. Upstream failures produce sanitized, ID-correlated JSON-RPC errors.

## Task 3: Streaming LLM gateway with PII redaction

Configure provider endpoints, keys, model, and client bearer keys in `.env`, then start the gateway:

```sh
PORT=3003 node --env-file=.env dist/task3/main.js
```

Example request, using the reader key configured in `.env`:

```sh
curl -N http://127.0.0.1:3003/v1/stream \
  -H 'Authorization: Bearer YOUR_READER_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Say hello","maxOutputTokens":128}'
```

The request accepts only `prompt` and optional `maxOutputTokens`. Prompt length is 1–16384 UTF-16 code units. Output allowance defaults to 512 tokens and must be between 1 and 4096. Both configured roles may use this endpoint.

Successful responses use SSE with JSON payloads:

```text
event: delta
data: {"text":"Hello "}

event: done
data: {}
```

The provider adapter parses SSE independently of network chunk boundaries. It supports fragmented UTF-8, LF/CRLF/CR framing, comments, multiline data, multiple events, and `[DONE]`, with bounded frames/events and truncated-stream detection.

Redaction applies to decoded provider content. It buffers whitespace-delimited tokens across chunks and replaces tokens containing `@` or Unicode numbers with `[REDACTED]`. This suppresses email-like content, phone components, SSNs, card numbers, and numeric identifiers even when split across provider chunks. Tokens reaching 4096 code units are suppressed through their next boundary to bound memory. Whitespace is preserved; unfinished tokens are discarded on failure.

The response writer respects backpressure, and client disconnection aborts provider work. Errors before streaming produce sanitized HTTP responses. Errors after streaming begins emit `event: error` without a success event or partial pending token. A separate output safety bound limits provider text to `maxOutputTokens * 32` bytes.

## Task 4: SQLite token limiter and provider fallback

Task 4 is integrated into Task 3. It does not require a separate server process.

### Sliding-window admission

`TokenLimiter(path, capacity, windowMs)` stores token reservations in SQLite using WAL, prepared statements, and `BEGIN IMMEDIATE`. Pruning, quota checks, and reservation insertion occur atomically to prevent oversubscription across connections sharing the database.

The rolling window includes `(now - windowMs, now]`. Quotas are isolated by authenticated identity, reservations persist across restarts, and a persisted clock prevents backward wall-clock changes from reopening quota. Shared connections must use matching capacity/window settings. A 100 ms busy timeout bounds lock waits; contention fails closed with HTTP 503 before provider execution.

The executable gateway reserves **10,000 tokens per identity per 60 seconds**. Each attempt reserves UTF-8 input bytes plus requested maximum output tokens. Requests exceeding total capacity return 413. Exhausted windows return 429 with `Retry-After` calculated from sufficient expiring reservations.

Reservations are retained after failure or cancellation. Fallback attempts require separate admission because an aborted provider may still incur cost.

### Provider fallback

Providers are attempted in configured order. HTTP **429** or a **3000 ms** first-text timeout triggers fallback. The monotonic deadline includes synchronous provider initialization and rejects results arriving at or after the boundary. Empty chunks do not reset it, and changing wall-clock time does not extend it.

After text begins, the same timeout applies between nonempty chunks, excluding time spent waiting on the consumer. Once any provider text has been emitted, an error terminates the stream rather than mixing completions. Other failures, including HTTP 500, invalid SSE, and authentication errors, are not retried. Cancellation and provider exhaustion propagate. HTTP 429 switches immediately to the next provider without a retry delay.

## Testing and verification

```sh
npm run build
npm run typecheck
npm test
```

`npm test` builds the executable entry points before running Vitest. Automated tests use mocked external providers and require no live API credentials. Integration tests use temporary SQLite databases, fake clocks, worker threads, and ephemeral localhost HTTP servers; local socket access must be permitted.

The verified suite contains **45 passing tests**:

| Test file | Tests | Main coverage |
| --- | ---: | --- |
| `tests/task1.test.ts` | 8 | Strict validation, lifecycle, IDs, transport limits, UTF-8, and actual CLI stdout |
| `tests/task2.test.ts` | 6 | Authorization without forwarding, role spoofing, sessions, upstream validation, and initialization capacity |
| `tests/task3.test.ts` | 11 | Cross-chunk PII, Unicode boundaries, streaming errors, disconnects, quotas, and database contention |
| `tests/task4.test.ts` | 20 | Window boundaries, persistence, concurrent workers, SSE parsing, cancellation, and exact timeout behavior |

[REVIEW.md](REVIEW.md) records review findings, fixes, regression coverage, and implementation assumptions.

## Technical limitations

- **MCP scope:** The implementation targets the 2025-11-25 tool-serving profile. Resources, prompts, sampling, OAuth, server-initiated/resumable SSE, and newer protocol revisions are not implemented or advertised. Tool listing is unpaginated and rejects supplied cursors. The security proxy expects JSON-response MCP upstreams.
- **Redaction scope:** The conservative lexical policy also redacts harmless numbers and some non-email uses of `@`. It does not detect names, plain-word postal addresses, or obfuscated/spelled-out identifiers. Safe text is emitted at token boundaries rather than immediately on every provider chunk.
- **Token accounting:** UTF-8 input bytes provide a conservative estimate for byte-based tokenizers, not model-specific tokenization. Output reservations assume the provider honors `max_tokens`; actual-usage reconciliation and refunds are not implemented.
- **Timeout enforcement:** JavaScript cannot preempt synchronous event-loop blocking. Overdue results are rejected when execution resumes. Fallback is restricted to failures before provider text has been emitted.
- **Deployment scope:** SQLite coordinates processes sharing a local database file, not a distributed multi-host quota service. Servers bind to loopback by default. Deployments beyond localhost require TLS and appropriate secret management; Task 1's standalone HTTP server relies on Task 2 for authenticated access.
- **Verification scope:** Tests exercise local integration and simulated provider behavior; they do not verify live commercial provider compatibility or constitute a penetration test.

## References

- [MCP 2025-11-25 transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP 2025-11-25 tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [Node.js SQLite API](https://nodejs.org/api/sqlite.html)
