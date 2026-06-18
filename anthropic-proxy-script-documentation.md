# Anthropic Proxy Script Technical Documentation

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
- Automatic block lifecycle management (start / delta / stop)
- 30-second keepalive heartbeat to prevent client timeouts

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
      ├── Mode A: Anthropic Direct Pass-Through (when both APIs are anthropic format)
      │     └── Forward request/response as-is, 30s keepalive
      │
      └── Mode B: OpenAI Bidirectional Conversion
            ├── Routing system (4 slots × primary/backup API)
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
node anthropic-proxy.mjs
```

Default listener: `http://127.0.0.1:4000`. Override with the `PORT` environment variable.

---

## API Endpoints

### Health Check

```http
HEAD /
```
Returns 200.

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
- Anthropic Messages API request body format
- streaming / non-streaming
- tools / images / system / thinking

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
```

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

---

## Protocol Conversion Rules

### Anthropic → OpenAI (Request Direction)

#### Message Body

| Anthropic | OpenAI |
|-----------|--------|
| `system` (string or array) | `system` message |
| `text` | `content` |
| `image` + source | `image_url` content |
| `tool_use` | `tool_calls` (ID processed via denormalize) |
| `tool_result` | `tool` role message (ID processed via denormalize) |
| `metadata.user_id` | `user` |

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
3. **tool_use block** — Opens when `tool_calls` is detected (closes any open thinking block first), buffers `id` + `name` before formally sending `content_block_start`, parameter fragments are temporarily stored in the buffer

### Error Handling

- `closeAllBlocks()` called on stream interruption to close all open blocks
- Attempts to send `message_delta` + `message_stop` to ensure the client receives a complete event sequence
- Failed SSE chunks are logged but do not interrupt the stream

---

## Reasoning Degradation Mechanism

When the upstream API does not support the `reasoning_effort` parameter and returns a 4xx error:

```
max → high (retry once)
high → remove reasoning_effort parameter (retry once)
```

Trigger conditions (error message contains any of the following keywords):
- `reasoning_effort`
- `unsupported parameter`
- `unknown parameter`
- `invalid parameter`
- `unrecognized`

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

---

## Error Handling

HTTP status code to Anthropic standard error type mapping:

| Status Code | error.type |
|-------------|-----------|
| 400 | `invalid_request_error` |
| 401 | `authentication_error` |
| 403 | `authentication_error` |
| 404 | `not_found_error` |
| 429 | `rate_limit_error` |
| 529 | `overloaded_error` |
| Other | `api_error` |

---

## Timeout Control

- Per-request timeout: 300 seconds by default (configurable via `PROXY_TIMEOUT_MS` environment variable)
- Timeout triggers `AbortController.abort()` to terminate the request

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
| `ENABLE_SECONDARY_API` | `false` | Enable backup API |
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

### Others

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4000` | Listening port |
| `PROXY_TIMEOUT_MS` | `300000` | Request timeout (ms) |

---

## Known Limitations

- MCP `server_tool_use` not adapted
- `cache_creation_input_tokens` not implemented (always returns 0)
- OpenAI cache statistics only map `prompt_tokens_details.cached_tokens`
- No request body size limit
- `reasoning_effort` depends on upstream support (degradation retry provides fallback)
- Tool streaming depends on upstream chunk order stability
- Non-streaming `thinking` blocks do not include signature verification data

---

## Directory Structure

```
anthropic-proxy.mjs              # Core proxy service
zshrc                            # Zsh startup function
README.md                        # Deployment guide (Chinese)
README_EN.md                     # Deployment guide (English)
anthropic-proxy脚本说明.md        # This documentation (Chinese)
anthropic-proxy-script-documentation.md  # This documentation (English)
```

---

## License

For learning and research purposes only. Not recommended for production use (unless you harden timeouts, rate-limiting, and authentication yourself).
