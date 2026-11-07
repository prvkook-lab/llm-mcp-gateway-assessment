# LLM and MCP gateway assessment

Four independent TypeScript modules, with executable servers for Tasks 1–3 and Task 4 integrated into the LLM gateway. Requires Node.js **26.13.0 or newer**; tested with npm **11.20.0**. No GitHub publishing or external provider calls are performed by installation or tests.

## Setup and verification

```sh
npm install
npm run build
npm run typecheck
npm test
```

`npm test` builds the executable entry points first, then runs the full suite. The project `.npmrc` suppresses npm lifecycle banners so the MCP launcher's stdout remains protocol-only; compiler/test output is preserved.

`package-lock.json` locks dependencies; use `npm ci` for subsequent clean installations. Tests use Vitest, temporary SQLite databases, fake clocks/providers, and ephemeral localhost HTTP servers. Local sockets must be permitted. No live API credentials are needed. `node:sqlite` is built into Node, so there is no native npm database dependency.

```text
src/
  shared/http.ts          bounded JSON requests and sanitized HTTP errors
  task1/protocol.ts       strict JSON-RPC validation, tools and MCP lifecycle
  task1/transports.ts     stdio and stateful HTTP transports
  task1/main.ts           MCP entry point
  task2/gateway.ts        bearer authentication, role policy and upstream proxy
  task2/main.ts           security gateway entry point
  task3/redaction.ts      incremental bounded PII redaction
  task3/gateway.ts        authenticated streaming SSE endpoint
  task3/main.ts           LLM gateway entry point
  task4/limiter.ts        SQLite exact rolling token window
  task4/providers.ts      provider SSE adapter, deadlines and fallback
tests/                    tests grouped by task
```

The workspace was empty, with no prior structure or assessment handout available. Tool names, roles, endpoints and limits below are explicit implementation assumptions, so their behavior is reviewable.

## Task 1 — Custom MCP server

Targets the **2025-11-25** MCP lifecycle and JSON-RPC 2.0. Supports `initialize`, `notifications/initialized`, `ping`, `tools/list`, and `tools/call`. Tools are `add({a,b})` and `echo({text})`. Request envelopes, method parameters and tool arguments reject unknown properties outside supported MCP metadata and client-info fields; numbers must be finite and echo text is limited to 4096 characters. Requests retain string/safe-integer IDs, including zero and empty strings; duplicate IDs are rejected within a session. Sessions accept at most 10,000 distinct request IDs to bound replay-tracking memory; valid notifications receive no JSON-RPC response and never execute tool calls. JSON-RPC batches are rejected. Tool discovery has JSON Schemas; arithmetic overflow is an MCP tool error.

```sh
# Default transport: newline-delimited JSON on stdin/stdout; no logs on stdout
npm run start:mcp

# Or stateful Streamable HTTP, JSON responses (no standalone SSE stream)
MCP_TRANSPORT=http PORT=3001 npm run start:mcp
```

For direct use in an MCP client, launch `node /absolute/project/path/dist/task1/main.js`. `npm run start:mcp` also keeps stdout protocol-only with the checked-in `.npmrc`; do not override npm's log level when using that launcher.

HTTP endpoint: `POST /mcp`; `DELETE /mcp` closes a session; `GET` returns 405. POST requires `Content-Type: application/json` and `Accept: application/json, text/event-stream`. Initialize returns `Mcp-Session-Id`; subsequent POSTs require that ID and `MCP-Protocol-Version: 2025-11-25`. Send `notifications/initialized` before tool requests. Initialization negotiates this supported version, even when the requested version differs. Sessions expire after 30 idle minutes, with a cap of 1000. Transport factory options allow explicit browser origins and different session limits. Browser origins are denied by default. Bind address defaults to loopback.

Stdio accepts UTF-8 NDJSON frames, handles fragmented/multiple frames, enforces 64 KiB per frame, reports malformed/unterminated frames, and discards oversized frames through the next newline before resuming. HTTP requests also have a 64 KiB limit, return 413 without destroying the response socket, reject unsupported content encodings, and reject malformed UTF-8. Accept-header parsing rejects disabled (`q=0`) and lookalike media types. Independent session objects prevent cross-client lifecycle contamination.

This is an intentionally small MCP implementation: no resources, prompts, sampling, server-initiated notifications, resumable SSE, OAuth, or 2026 protocol support. Standard `_meta` fields and optional client implementation information are accepted. Unknown method parameters remain rejected. Tool listing is unpaginated; supplied cursors are rejected. Unsupported capabilities are never advertised.

## Task 2 — JSON-RPC security gateway

```sh
MCP_UPSTREAM=http://127.0.0.1:3001/mcp \
READER_API_KEY=replace-with-random-reader-key \
ADMIN_API_KEY=replace-with-different-random-admin-key \
PORT=3002 npm run start:security
```

Uses the same `/mcp` protocol flow, with `Authorization: Bearer <key>` on **every** request. Configure secrets through the environment; `.env.example` is a reference, not automatically loaded. Invalid/missing keys return 401. Nonempty identities, distinct keys/IDs, and recognized roles are validated at startup. Roles come from server configuration; request headers cannot assign roles. Reader keys may discover and invoke `echo`; admins may also use `add`. Both may initialize and ping. Everything else is denied by default. Tool discovery is filtered, invocation is independently checked, and all supported method/tool parameters are validated locally before forwarding. Tool calls without IDs are never forwarded, even if the caller's role permits that tool. Denied requests return HTTP 403 / JSON-RPC `-32003`; denied notifications receive 202 without being forwarded.

Session ownership binds each upstream session to the authenticated identity, including DELETE requests. Session metadata has bounded capacity and idle expiration; in-flight initialization also counts toward capacity. DELETE removes ownership, and collisions in upstream session IDs are rejected. Keys use constant-time comparison for equal-length candidates. User credentials and arbitrary headers never reach the upstream. The upstream URL is fixed configuration, redirects are rejected, calls have a 3000 ms deadline, and upstream failures are sanitized. Upstream JSON bodies are limited to 64 KiB; response IDs, mutually exclusive result/error fields, error types, and tool-list structures are validated. Client disconnects abort upstream requests. This proxy targets Task 1's JSON-response transport, not arbitrary SSE-only MCP servers.

## Task 3 — Streaming LLM gateway

Start the gateway with the variables shown in `.env.example` (use actual OpenAI-compatible provider endpoints and keys):

```sh
# Export PRIMARY_URL, PRIMARY_API_KEY, FALLBACK_URL, FALLBACK_API_KEY, MODEL,
# READER_API_KEY and ADMIN_API_KEY first.
PORT=3003 npm run start:llm

curl -N http://127.0.0.1:3003/v1/stream \
  -H 'Authorization: Bearer replace-with-random-reader-key' \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Say hello","maxOutputTokens":128}'
```

`POST /v1/stream` accepts only `prompt` and optional `maxOutputTokens` (default 512, range 1–4096). Prompt length is 1–16384 UTF-16 code units, subject also to the HTTP body limit. Both configured roles may use this endpoint. The response is SSE with JSON payloads:

```text
event: delta
data: {"text":"Hello "}

event: done
data: {}
```

Redaction operates on decoded **content**, after parsing upstream SSE. The SSE parser supports fragmented UTF-8, LF/CRLF/CR framing, comments, multiple events, multiline data, `[DONE]`, bounded events and truncated-stream detection. It does not assume one network chunk equals one event.

The redactor holds each whitespace-delimited token across all provider chunks. Tokens containing `@` or Unicode numbers are replaced with `[REDACTED]`. This conservatively suppresses email addresses, phone components, SSNs, credit card numbers, and numeric identifiers, including PII split at any chunk boundary. It also redacts harmless numbers and some non-email uses of `@`. This is a deliberate privacy-over-fidelity policy, not a full named-entity detector: names, plain-word addresses and obfuscated/spelled-out identifiers are outside scope. Whitespace is preserved, so formatted phone numbers become multiple redaction markers. Tokens reaching 4096 code units are suppressed through the next whitespace boundary to bound memory. Safe text streams at token boundaries; a token is held until whitespace or successful end of stream. On failure, unfinished tokens are discarded.

The HTTP writer respects backpressure; client disconnection aborts the active provider. Errors before response headers use sanitized HTTP errors; errors after streaming starts emit `event: error` and terminate without a success event or raw provider details. Provider output has an additional byte safety limit of `maxOutputTokens * 32`.

## Task 4 — SQLite token window and fallback

`TokenLimiter(path, capacity, windowMs)` uses `node:sqlite`, WAL, prepared statements, a 100 ms busy timeout configured before enabling WAL, and `BEGIN IMMEDIATE` to atomically prune, check and reserve tokens. This prevents oversubscription across connections/processes using the same database file. Each successful reservation is recorded at admission; the exact rolling window includes `(now - windowMs, now]`, with expiration at the boundary. User identities have independent quotas. A persisted clock prevents backward wall-clock changes from reopening quota. Shared connections must use matching capacity/window configuration. Initialization failures close the connection. Lock contention fails closed (HTTP 503 in the LLM gateway), with a short busy timeout so a database lock cannot impose the former five-second wait on the provider's three-second deadline.

The executable LLM gateway allows **10,000 reserved tokens per identity per 60 seconds**, stored in `RATE_DB` (default `rate-limit.sqlite`). Reservation cost is UTF-8 input bytes plus requested maximum output tokens. Byte count conservatively estimates input tokens for byte-based tokenizers; replace it with the selected model's tokenizer for tighter accounting. Output accounting assumes the provider honors `max_tokens`. Reservations are never refunded, including 429s, timeouts or client cancellation. Each fallback attempt reserves again because an aborted provider may still have incurred cost. A request larger than capacity returns 413; exhausted windows return 429 with `Retry-After` calculated from sufficient expiring reservations. Admission failures stop processing before a provider call.

`streamWithFallback` tries providers in configured order. A provider returning HTTP **429** or taking **3000 ms** to produce the first text triggers fallback. The deadline uses a monotonic clock, includes synchronous provider initialization, and rejects results arriving at or after the boundary. Changing wall-clock time does not extend it. JavaScript timers cannot preempt a blocked event loop; any overdue result is rejected when execution resumes. After text begins, the same timeout applies between nonempty chunks. Empty chunks do not reset the deadline. Provider calls are aborted at deadline; even providers ignoring cancellation cannot prevent fallback. Backpressure time spent with the consumer is excluded from the next-chunk deadline. Once any provider text has been emitted, failures terminate the stream, avoiding duplicate or inconsistent completions. Other errors (including HTTP 500, malformed SSE, and authentication errors) are not retried; exhaustion and caller cancellation propagate. No deliberate retry sleep or HTTP `Retry-After` delay is applied: 429 switches immediately to the next provider.

SQLite is appropriate for processes sharing a local filesystem; distributed hosts need a shared transactional quota backend. Servers bind to loopback by default. Use a TLS reverse proxy and appropriate operational secret management when deploying beyond localhost. No prompt, provider content or secrets are logged.

## Reference specifications

- [MCP 2025-11-25 transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP 2025-11-25 tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [Node.js SQLite API](https://nodejs.org/api/sqlite.html)

## Review and regression coverage

See [REVIEW.md](REVIEW.md) for the requirements matrix, corrected findings, coverage details, and remaining scope assumptions. Tests include the actual npm stdio launcher, UTF-8/body-limit rejection, upstream-response validation, authorization without forwarding, cross-chunk PII (including surrogate pairs), stream failure/cancellation, SQLite persistence and worker concurrency, and provider deadline/fallback boundaries.
