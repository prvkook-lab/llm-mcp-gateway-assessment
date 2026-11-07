# Assessment review

Reviewed against the four requirements supplied in the conversation and the MCP 2025-11-25 specification. There is no separate original assessment handout or prior project proposal in this workspace; tool choices, roles, endpoints, conservative redaction and token estimation remain the explicit assumptions described in README.md. This review does not claim compliance with unseen requirements.

## Requirements and verification

| Task | Implemented behavior | Automated evidence |
| --- | --- | --- |
| 1: Custom MCP server | Strict request/tool schemas; MCP initialize/ready lifecycle; stdio and session-based HTTP; bounded frames and bodies; JSON-RPC errors and IDs; stdout isolation | Invalid/unknown arguments, lifecycle checks, unknown methods, batch rejection, fragmented and malformed UTF-8, frame recovery, media types, origin/session checks, body limits, standard metadata, ID replay protection, real npm subprocess stdout |
| 2: Security gateway | Server-assigned roles; bearer authentication; deny by default; filtered discovery; local method/argument validation; no unauthorized upstream calls; per-principal session ownership | Reader/admin integration, forbidden methods/tools, role-header spoofing, forbidden and permitted notification-shaped tool calls never forwarded, invalid arguments, credential/header isolation, malformed/oversized upstream responses, mismatched IDs, ID-correlated upstream errors, in-flight session capacity, session deletion/theft |
| 3: Streaming LLM gateway | Parsed provider SSE to redacted client SSE; bounded state across chunk boundaries; backpressure; cancellation; sanitized errors | Every two-part split of sample email/phone/SSN text, single-character chunks, split Unicode surrogate pairs, oversized tokens, incomplete PII on failure, authentication/validation/quota integration, fallback redaction, client disconnection, partial-stream errors |
| 4: Rate limiter and fallback | Exact SQLite token-reservation sliding window; WAL and atomic write transactions; persisted state/clock; retry timing; 429/3000 ms fallback before first emitted text | Exact window boundaries, per-user isolation, reopen/shared-connection persistence, four concurrent workers competing for the same quota, HTTP lock-contention failure without provider execution, fallback/exhaustion/cancellation, exact 3000 ms boundary, empty chunks, synchronous initialization, clock rollback, partial-output timeout |

## Findings corrected

1. **MCP interoperability:** empty-string request IDs and standard metadata were rejected. They are now accepted, with method/tool fields still strict. Optional client implementation information is supported. Request ID reuse is rejected, with bounded per-session ID tracking. Unpaginated tool listing explicitly rejects cursors.
2. **Stdout isolation:** `npm run start:mcp` could emit npm lifecycle banners. The repository now sets npm's log level to silent, while preserving child-process output. A test launches the actual npm entry point and parses every stdout line as JSON-RPC. Direct `node dist/task1/main.js` remains the recommended MCP client command.
3. **Proxy boundary validation:** upstream responses could contain both `result` and `error`, invalid error fields, oversized bodies, or malformed tool descriptors. The proxy now bounds and validates responses and their matching IDs, and returns ID-correlated JSON-RPC errors on upstream failures. It validates supported method/tool parameters locally and never forwards tool-call notifications, even to an upstream that might execute them.
4. **Session security:** DELETE acknowledgements previously left local ownership behind, and initialization capacity was checked after the upstream call. Ownership now clears correctly; pending initializations count toward capacity; invalid/colliding upstream session IDs are rejected; disconnects cancel upstream work.
5. **HTTP validation:** substring Accept checks accepted lookalike/disabled content types, malformed UTF-8 could be replaced silently, and iterator exit on an oversized body could destroy the response socket. Media types are parsed, UTF-8 is decoded strictly, and bounded request consumption reliably returns 413.
6. **Provider deadline:** wall-clock time could distort the first-content deadline, synchronous setup was excluded, and a boundary result could win a timer race. A monotonic deadline now covers setup and checks results at the boundary; empty chunks do not reset it. Cleanup cannot delay fallback, including a hung response-body cancellation. Abort and partial-output cases are tested separately.
7. **SSE limits/framing:** repeated empty data fields escaped the prior aggregate limit and caused quadratic summation. Event size is tracked incrementally, including field overhead, and CR-only framing is supported through EOF. Response bodies are cancelled on rejection or completion without waiting indefinitely.
8. **SQLite lock handling:** the five-second SQLite busy timeout could exceed the provider deadline, and was installed after WAL initialization. It is now 100 ms and installed first. Initialization errors close the database; runtime contention returns HTTP 503 without calling a provider or granting quota.
9. **Identity configuration:** both gateways now reject missing/duplicate identities, duplicate/empty keys, and unknown roles at startup, preventing unintended quota sharing.

## Explicit limits

- MCP targets the pinned 2025-11-25 tool-serving profile, with JSON responses over HTTP. OAuth, resumable/server-initiated SSE and newer MCP revisions are not implemented or advertised. The standalone Task 1 HTTP server is intended for loopback; Task 2 adds authentication.
- PII redaction is deliberately conservative lexical output redaction. It suppresses email-like and numeric tokens; it does not detect names, plain-word postal addresses, or obfuscated identifiers. Harmless numbers are also redacted.
- Input tokens use a UTF-8-byte upper estimate for byte-based tokenizers; output quota reserves requested `max_tokens` and assumes the provider honors that bound. Failed provider attempts retain reservations. There is no model-specific tokenizer or actual-usage reconciliation.
- Fallback is before any provider text is emitted. A timeout/error after text begins terminates the stream to avoid mixed completions. Each fallback attempt must independently pass quota admission.
- JavaScript cannot preempt synchronous event-loop blocking. Overdue provider results are rejected when execution resumes. Short database lock waits avoid imposing a five-second blocking wait in normal quota admission.
- SQLite transactions coordinate processes sharing a local database file, not a distributed multi-host deployment. Busy contention fails closed.
- Tests use local servers, SQLite and fake providers/clocks. They do not call live commercial providers or constitute a penetration test or a formal compliance certification.

## Running verification

```sh
npm install
npm run build
npm run typecheck
npm test
```

`npm test` builds entry points before testing stdout through the actual CLI. All integration tests require permission to bind localhost sockets. See README.md for environment variables, per-task commands, MCP handshake/header requirements and the LLM curl example.

## Final verification results

- `npm run build`: passed.
- `npm run typecheck`: passed.
- `npm test`: **45 passed**, across all four test files; no failures or skipped tests.

| Test file | Passing tests |
| --- | ---: |
| `tests/task1.test.ts` | 8 |
| `tests/task2.test.ts` | 6 |
| `tests/task3.test.ts` | 11 |
| `tests/task4.test.ts` | 20 |

The suite ran with localhost socket access enabled because the filesystem/network sandbox prohibits binding test servers. No live provider calls or GitHub publication occurred.

## Sources

- [MCP base protocol and metadata](https://modelcontextprotocol.io/specification/2025-11-25/basic)
- [MCP transport requirements](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [JSON-RPC 2.0](https://www.jsonrpc.org/specification)
- [Node.js SQLite API](https://nodejs.org/api/sqlite.html)
