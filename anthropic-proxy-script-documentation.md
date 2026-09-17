# Anthropic Proxy Script Technical Documentation

[English](anthropic-proxy-script-documentation.md) | [简体中文](anthropic-proxy-script-documentation.zh-CN.md)

This project (`anthropic-proxy.mjs`) is a local **Anthropic Messages API ↔ OpenAI Chat Completions API bidirectional proxy gateway**, designed to make Claude Code compatible with third-party model APIs, supporting dynamic routing, multi-model slots, streaming protocol conversion, and Reasoning adaptation.

---

## Core Capabilities

### Protocol Conversion

- Anthropic Messages API → OpenAI Chat Completions
- OpenAI Chat Completions → Anthropic SSE Events
- Full type support: System / Tool / Image / Thinking

### Streaming SSE Bidirectional Translation

- OpenAI SSE → Anthropic `content_block_*` events
- Supports:
  - thinking block (`reasoning_content`, e.g. DeepSeek R1)
  - text block
  - tool_use block
- Automatic block lifecycle management (start / delta / stop), strictly sequential: thinking → text → tool_use
- 30-second keepalive heartbeat in both pass-through and conversion modes
- Usage accounting also picks up chunks that carry usage but no choices
- Tolerant SSE parsing: `data:` with or without a space, `\r\n` endings, comment lines and a final chunk without a trailing newline

### Thinking / Reasoning Support

- Anthropic `thinking.budget_tokens` → OpenAI `reasoning_effort`
- Automatic level mapping:
  - >= 4096 → max
  - >= 2048 → high
  - >= 1024 → medium
  - else → low
- `adaptive` mode → maps to high
- No thinking config → defaults to medium
- Automatic degradation retry when unsupported by upstream: max → high → remove parameter

### Tool Call Conversion

- Anthropic `tool_use` ↔ OpenAI `function_call`
- ID bidirectional normalization:
  - `toolu_oai_xxx` → `call_xxx` (Anthropic → OpenAI direction, denormalize)
  - `call_xxx` → `toolu_oai_xxx` (OpenAI → Anthropic direction, normalize)

### Content Mapping Coverage

- Text, images and tool results are preserved — including images nested inside `tool_result` blocks
- `document` blocks: plain-text sources are inlined; base64 payloads degrade to a placeholder unless `CONVERT_PDF_TO_FILE=true`
- Sampling parameters: `top_p` and `stop_sequences` are forwarded (`top_k` has no OpenAI equivalent and is dropped)
- Unsupported content blocks are logged instead of being dropped silently

### Four-Slot Model Routing System

Supports 4 model slots:

| Slot | Default Client Model | Purpose |
|------|---------------------|---------|
| Default | `claude-sonnet-4-6` | Default model |
| Sonnet | `claude-3-5-sonnet-20241022` | Sonnet model |
| Opus | `claude-3-opus-20240229` | Opus model |
| Haiku | `claude-3-5-haiku-20241022` | Sub-agent slot |

Each slot is independently configurable:
- `client` — Claude-side model name
- `target` — Actual upstream model
- `api` — API channel (`PRIMARY` / `SECONDARY`)
- `reasoning` — Reasoning depth strategy

---

## Architecture

```
Claude Code CLI
      │
      ▼
anthropic-proxy.mjs (Local Node HTTP Service :4000)
      │
      ├── Access guard: Host / Origin / optional token, body size cap
      │
      ├── Mode A: Anthropic Direct Pass-Through (when both APIs are anthropic format)
      │     └── Forward request/response as-is, 30s keepalive
      │
      └── Mode B: OpenAI Bidirectional Conversion
            ├── Routing system (4 slots × primary/backup API, one-shot failover)
            ├── Protocol conversion engine (anthropicToOpenAI)
            ├── SSE streaming state machine (thinking/text/tool block management)
            └── Reasoning degradation retry system
      │
      ▼
Upstream API (OpenAI / Anthropic / Third-party Compatible API)
```

---

## Startup

```bash
node anthropic-proxy.mjs [options]
```

| Option | Description |
|--------|-------------|
| `-l`, `--lang`, `--language <lang>` | Output language (`en` / `zh-CN`) |
| `-h`, `--help` | Show usage and exit |

Default listener: `http://127.0.0.1:4000`. Override with the `PORT` environment variable. An invalid `PORT` aborts startup with exit code 1; invalid timeout/size values log a warning and fall back to their defaults.

---

## Language Resolution

All console logs and client-facing error messages follow a fixed language resolution priority:

1. **Explicit manual parameter** — `-l` / `--lang` / `--language`, or the `PROXY_LANG` environment variable (convenient for containers)
2. **Auto-detection** — the system locale (`LC_ALL` → `LC_MESSAGES` → `LANG`), then the Node.js runtime locale
3. **English fallback** — guaranteed when no candidate applies

Locale tags are normalized: `en`, `en-US`, `en_US.UTF-8` → `en`; `zh`, `zh-CN`, `zh_CN.UTF-8` → `zh-CN`. An unsupported explicit value logs a warning and falls back to English, while unsupported auto-detected candidates are skipped. Any missing catalog entry also falls back to English text.

---

## API Endpoints

### Health Check

```http
HEAD /
```
Returns 200. Exempt from the access policy, so it doubles as a readiness probe.

### Model List

```http
GET /v1/models
```

Dynamically returns all configured slot model names:

```json
{
  "data": [
    { "type": "model", "id": "claude-sonnet-4-6", "display_name": "CLAUDE-SONNET-4-6" }
  ]
}
```

### Core Chat Interface

```http
POST /v1/messages
```

Supports:
- Anthropic Messages API request body
- streaming / non-streaming
- tools / images / system / thinking
- content blocks: text / image / document / tool_use / tool_result (images inside tool results are preserved)

### Token Counting

```http
POST /v1/messages/count_tokens
```

Routes exactly like `/v1/messages`:

- Anthropic channels — forwarded to the upstream `count_tokens` endpoint; `404` / `405` / `501` fall back to a local estimate
- OpenAI channels — answered locally, since OpenAI-compatible APIs have no equivalent endpoint

```json
{ "input_tokens": 1234 }
```

The local estimate is a heuristic (≈4 ASCII characters or 1 wide character per token, plus fixed costs for images and documents). It is good enough for context accounting, not for billing.

### CORS Preflight

```http
OPTIONS /v1/messages
```

Answered with `204` when the request `Origin` is allowed, otherwise `403`. The preflight is answered before the token check, because browsers never attach credentials to it.

---

## Model Routing Mechanism

### Routing Priority

1. **Exact match** — Request model name exactly matches a slot's `client` field (case-insensitive)
2. **Substring fuzzy match** — Request model name contains a slot's `client` field (or vice versa), longest match wins
3. **Fallback** — Falls back to the Default slot (`slots[0]`)

### Route Result Structure

```js
{
  format:      "openai" | "anthropic",  // Determined by the slot's API channel
  key:         "...",                    // API key
  base:        "...",                    // Upstream base URL
  authType:    "api-key" | "bearer",    // Authentication method
  targetModel: "...",                    // Actual upstream model name
  reasoning:   "auto"|"max"|"high"|"medium"|"low"|"none",
  name:        "PRIMARY" | "SECONDARY"  // Which API channel to use
}

// selectRoute() also returns:
{
  slot:            { ... },              // The matched slot
  route:           { ... },              // Primary route (above)
  alternateRoute:  { ... } | null        // Ready-to-use backup route
}
```

### Channel Failover

When `ENABLE_SECONDARY_API=true` and the other channel has a key, a request that fails **before any response bytes reach the client** is retried once on the other channel:

- Triggers: connection errors, connect/header timeouts, `429` and `5xx`
- Never triggers on other `4xx` (client errors) or after streaming has started
- The retry rebuilds the upstream request for the target channel's protocol, so an OpenAI primary can fail over to an Anthropic backup and vice versa
- Every hop is logged: `Failover: PRIMARY → SECONDARY (HTTP 502)`
- At most one failover attempt per client request

---

## Two Operating Modes

### Mode A: Anthropic Direct Pass-Through

Enabled when the route result's `format === "anthropic"`.

- Request forwarded as-is to the upstream Anthropic endpoint (only the `model` field is replaced)
- Supports streaming/non-streaming pass-through
- Sends SSE heartbeat (`:keepalive`) every 30 seconds in streaming mode
- Attempts to parse upstream standard error format on failure and forwards as-is to avoid nesting

### Mode B: OpenAI Bidirectional Conversion

Enabled when the route result's `format === "openai"`.

- Request converted via `anthropicToOpenAI()` before being sent to the upstream OpenAI-compatible endpoint
- Response converted to Anthropic format events via the SSE state machine
- Sends the same 30-second SSE heartbeat while streaming

---

## Protocol Conversion Rules

### Anthropic → OpenAI (Request Direction)

#### Message Body

| Anthropic | OpenAI |
|-----------|--------|
| `system` (string or array) | `system` message |
| `text` | `content` |
| `image` + source | `image_url` content |
| `document` (text source) | inlined `content` text |
| `document` (base64 source) | placeholder text, or a `file` part with `CONVERT_PDF_TO_FILE=true` |
| `tool_use` | `tool_calls` (ID processed via denormalize) |
| `tool_result` | `tool` role message (ID processed via denormalize) |
| `tool_result` with images | `tool` message whose `content` is a `text` + `image_url` array |
| `top_p` | `top_p` |
| `stop_sequences` | `stop` |
| `metadata.user_id` | `user` |

Empty assistant messages are skipped, and unsupported content blocks are logged (`Dropped unsupported content part: ...`) instead of being dropped silently.

#### Tool Definitions

```json
// Anthropic
{ "name": "...", "description": "...", "input_schema": {...} }

// OpenAI
{ "type": "function", "function": { "name": "...", "description": "...", "parameters": {...} } }
```

#### Tool Choice Strategy

| Anthropic `tool_choice` | OpenAI `tool_choice` |
|------------------------|---------------------|
| `{ type: "auto" }` | `"auto"` |
| `{ type: "any" }` | `"required"` |
| `{ type: "tool", name: "xxx" }` | `{ type: "function", function: { name: "xxx" } }` |

#### Thinking Mapping

| Anthropic `thinking` | OpenAI |
|---------------------|--------|
| `budget_tokens >= 4096` | `reasoning_effort: "max"` |
| `budget_tokens >= 2048` | `reasoning_effort: "high"` |
| `budget_tokens >= 1024` | `reasoning_effort: "medium"` |
| `budget_tokens < 1024` | `reasoning_effort: "low"` |
| `type: "adaptive"` | `reasoning_effort: "high"` |
| No thinking config | `reasoning_effort: "medium"` |
| Slot reasoning = "none" | Do not send `reasoning_effort` |

#### Optional Streaming Usage

Set `STREAM_INCLUDE_USAGE=true` to add `stream_options: { include_usage: true }` to streamed OpenAI requests. It is off by default because some OpenAI-compatible third parties reject the parameter; providers that report usage on their own (DeepSeek, most relays) need no flag.

### OpenAI → Anthropic (Response Direction)

| OpenAI | Anthropic |
|--------|-----------|
| `choices[0].delta.content` | `text_delta` → text block |
| `choices[0].delta.reasoning_content` | `thinking_delta` → thinking block |
| `choices[0].delta.tool_calls` | `input_json_delta` → tool_use block |
| `finish_reason: "stop"` | `stop_reason: "end_turn"` |
| `finish_reason: "tool_calls"` | `stop_reason: "tool_use"` |
| `finish_reason: "length"` | `stop_reason: "max_tokens"` |
| `finish_reason: "content_filter"` | `stop_reason: "end_turn"` |
| `usage.prompt_tokens` | `input_tokens` |
| `usage.completion_tokens` | `output_tokens` |
| `usage.prompt_tokens_details.cached_tokens` | `cache_read_input_tokens` |
| `usage.prompt_tokens_details.cache_creation_tokens` | `cache_creation_input_tokens` |

---

## SSE Streaming Conversion Mechanism

OpenAI stream → Anthropic event sequence:

```
message_start
  ↓
content_block_start (thinking / text / tool)
  ↓
content_block_delta  ×N
  ↓
content_block_stop
  ↓
message_delta (stop_reason + usage)
  ↓
message_stop
```

### Block Lifecycle Management

Streaming conversion uses a dynamic index (`nextBlockIdx`) to allocate block indices incrementally:

1. **thinking block** — Automatically opens when `reasoning_content` is detected, automatically closes when text content appears (sends `signature_delta` + `content_block_stop`)
2. **text block** — Opens when `content` is detected (closes any open thinking block first)
3. **tool_use block** — Opens when `tool_calls` is detected (closes any open thinking **and text** block first, so blocks never interleave), buffers `id` + `name` before formally sending `content_block_start` (which carries `input: {}`), parameter fragments are temporarily stored in the buffer

### Error Handling

- `closeAllBlocks()` called on stream interruption to close all open blocks
- Attempts to send `message_delta` + `message_stop` to ensure the client receives a complete event sequence
- Failed SSE chunks are logged but do not interrupt the stream
- An idle upstream is aborted by `PROXY_IDLE_TIMEOUT_MS` and the stream is closed cleanly

---

## Reasoning Degradation Mechanism

When the upstream API does not support the `reasoning_effort` parameter and returns a 4xx error:

```
max → high (retry once)
high → remove reasoning_effort parameter (retry once)
```

Trigger conditions (error message must mention the parameter itself):
- `reasoning_effort`
- `reasoning effort`

---

## Authentication

### OpenAI Mode

Uses `Authorization: Bearer <key>` header by default.

### Anthropic Direct Mode

Supports two authentication types (configured via `PRIMARY_AUTH_TYPE` / `SECONDARY_AUTH_TYPE`):

| Type | Request Header |
|------|---------------|
| `api-key` (default) | `x-api-key: <key>` |
| `bearer` | `Authorization: Bearer <key>` + `anthropic-beta: oauth-2025-04-20` |

Also passes through the client's `anthropic-beta` and `x-client-request-id` headers.

### Client → Proxy Authentication (optional)

Set `PROXY_AUTH_TOKEN` to require a shared token from clients; see the security section below.

---

## Security & Access Control

The listener only binds `127.0.0.1`, and every request passes an access guard:

1. **Host check** — `Host` must be `localhost`, `127.0.0.1` or `::1` (with optional port) unless `ALLOWED_HOSTS` says otherwise; this blocks DNS-rebinding style attacks.
2. **Origin check** — browser requests (those carrying an `Origin` header) are only accepted from localhost/loopback origins by default. CLI clients send no `Origin` and are unaffected. Add extra origins with `ALLOWED_ORIGINS` (exact values or `*` wildcards, e.g. `http://192.168.1.10:5173`), or disable the check with `ALLOWED_ORIGINS=*` (not recommended).
3. **Token check** — when `PROXY_AUTH_TOKEN` is set, clients must send `Authorization: Bearer <token>` or `x-api-key: <token>`; the comparison is constant-time. Point Claude Code at the proxy with `ANTHROPIC_API_KEY=<the same token>` (or `ANTHROPIC_AUTH_TOKEN`).

Additional hardening:

- CORS responses echo the request `Origin` only when it is allowed (never `*`), and `Vary: Origin` is set
- Request bodies are capped by `MAX_BODY_BYTES` (default 64 MiB) and oversized uploads get `413 invalid_request_error` without buffering the whole body
- Tokens are never written to the log, and upstream error bodies are passed through while local crashes are reported as `500 gatewayCrash`

---

## Error Handling

HTTP status code to Anthropic standard error type mapping:

| Status Code | error.type |
|-------------|-----------|
| 400 | `invalid_request_error` |
| 401 | `authentication_error` |
| 403 | `authentication_error` |
| 404 | `not_found_error` |
| 413 | `invalid_request_error` |
| 429 | `rate_limit_error` |
| 503 | `overloaded_error` |
| 529 | `overloaded_error` |
| Other | `api_error` |

Unhandled promise rejections are logged (`Unhandled promise rejection (the request keeps running): ...`) instead of terminating the process, so a single misbehaving stream cannot take the gateway — or parallel sessions — down. Synchronous `uncaughtException` is deliberately not intercepted.

---

## Timeout Control

Two watchdogs protect every request:

| Phase | Variable | Default | Behavior |
|-------|----------|---------|----------|
| Connect / response headers | `PROXY_TIMEOUT_MS` | 300 s | Aborts the fetch while waiting for upstream headers |
| Body / stream | `PROXY_IDLE_TIMEOUT_MS` | 120 s | Re-armed on every received chunk; a silent upstream is aborted |

- Aborts surface as `504 api_error` when the response has not started yet, and as a terminated stream (`message_delta` + `message_stop`) when streaming already began
- If the client disconnects, the proxy cancels the upstream request instead of draining it
- `PROXY_IDLE_TIMEOUT_MS=0` disables the idle watchdog

---

## Environment Variables Reference

### Primary API Channel

| Variable | Default | Description |
|----------|---------|-------------|
| `PRIMARY_API_FORMAT` | `openai` | Protocol format (openai / anthropic) |
| `PRIMARY_API_KEY` | — | API key |
| `PRIMARY_BASE_URL` | `https://api.openai.com` | API base URL |
| `PRIMARY_AUTH_TYPE` | `api-key` | Auth type (api-key / bearer) |

### Backup API Channel

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_SECONDARY_API` | `false` | Enable the backup channel (slot routing + automatic failover) |
| `SECONDARY_API_FORMAT` | `openai` | Protocol format |
| `SECONDARY_API_KEY` | — | Backup key |
| `SECONDARY_BASE_URL` | `https://api.openai.com` | Backup endpoint |
| `SECONDARY_AUTH_TYPE` | `api-key` | Backup auth type |

### Model Slots

| Variable | Default | Description |
|----------|---------|-------------|
| `CLIENT_MODEL_DEFAULT` | `claude-sonnet-4-6` | Slot 1 client model name |
| `UPSTREAM_MODEL_DEFAULT` | `gpt-4o` | Slot 1 upstream model name |
| `MODEL_DEFAULT_API` | `PRIMARY` | Slot 1 API channel |
| `MODEL_DEFAULT_REASONING` | `auto` | Slot 1 reasoning strategy |
| `CLIENT_MODEL_SONNET` | `claude-3-5-sonnet-20241022` | Slot 2 client model name |
| `UPSTREAM_MODEL_SONNET` | `gpt-4o` | Slot 2 upstream model name |
| `MODEL_SONNET_API` | `PRIMARY` | Slot 2 API channel |
| `MODEL_SONNET_REASONING` | `auto` | Slot 2 reasoning strategy |
| `CLIENT_MODEL_OPUS` | `claude-3-opus-20240229` | Slot 3 client model name |
| `UPSTREAM_MODEL_OPUS` | `gpt-4o` | Slot 3 upstream model name |
| `MODEL_OPUS_API` | `PRIMARY` | Slot 3 API channel |
| `MODEL_OPUS_REASONING` | `auto` | Slot 3 reasoning strategy |
| `CLIENT_MODEL_HAIKU` | `claude-3-5-haiku-20241022` | Slot 4 client model name |
| `UPSTREAM_MODEL_HAIKU` | `gpt-4o-mini` | Slot 4 upstream model name |
| `MODEL_HAIKU_API` | `PRIMARY` | Slot 4 API channel |
| `MODEL_HAIKU_REASONING` | `auto` | Slot 4 reasoning strategy |

### Security

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_AUTH_TOKEN` | — | Optional shared token required from clients |
| `ALLOWED_ORIGINS` | localhost / loopback | Comma-separated Origin allowlist with `*` wildcards; `*` alone disables the check |
| `ALLOWED_HOSTS` | localhost / loopback | Comma-separated Host allowlist; `*` alone disables the check |

### Others

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_LANG` | — | Explicit output language (en / zh-CN), same priority as `--lang` |
| `PORT` | `4000` | Listening port (invalid values abort startup) |
| `PROXY_TIMEOUT_MS` | `300000` | Connect / response-header timeout (ms) |
| `PROXY_IDLE_TIMEOUT_MS` | `120000` | Upstream idle timeout (ms), re-armed per chunk, `0` disables |
| `MAX_BODY_BYTES` | `67108864` | Request body size limit in bytes |
| `STREAM_INCLUDE_USAGE` | `false` | Request token usage in OpenAI streams |
| `CONVERT_PDF_TO_FILE` | `false` | Map base64 documents to OpenAI `file` content parts |

---

## Regression Tests

```bash
node --test tests/proxy.test.mjs
```

The suite spins up local mock upstreams and covers the request-body integrity (including multi-byte characters split across socket reads), size limits, access guard, token auth, count_tokens, failover, reasoning degradation, the SSE state machine, usage accounting, idle timeouts and client aborts.

---

## Known Limitations

- MCP `server_tool_use` is not adapted (logged and dropped)
- `tool_result.is_error` has no OpenAI equivalent; the error text itself is preserved
- `cache_creation_input_tokens` is only populated when the upstream reports it
- OpenAI cache statistics only map `prompt_tokens_details.cached_tokens`
- Streaming usage on the official OpenAI API requires `STREAM_INCLUDE_USAGE=true`
- `top_k` has no OpenAI equivalent and is dropped
- Parallel `tool_calls` are emitted interleaved by index (each index keeps a strict start → deltas → stop order)
- Base64 documents need `CONVERT_PDF_TO_FILE=true`, otherwise they degrade to a placeholder
- `reasoning_effort` depends on upstream support (degradation retry provides fallback)
- Tool streaming depends on upstream chunk order stability
- Non-streaming `thinking` blocks do not include signature verification data

---

## License

For learning and research purposes only. Not recommended for production use (unless you harden timeouts, rate-limiting, and authentication yourself).
