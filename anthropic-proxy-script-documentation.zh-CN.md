# Anthropic Proxy 脚本技术说明

[English](anthropic-proxy-script-documentation.md) | [简体中文](anthropic-proxy-script-documentation.zh-CN.md)

本项目 (`anthropic-proxy.mjs`) 是一个本地 **Anthropic Messages API ↔ OpenAI Chat Completions API 双向代理网关**，用于让 Claude Code 兼容第三方模型 API，并支持动态路由、多模型槽位、流式协议转换与 Reasoning 适配。

---

## 核心能力

### 协议转换

* Anthropic Messages API → OpenAI Chat Completions
* OpenAI Chat Completions → Anthropic SSE Events
* System / Tool / Image / Thinking 全类型支持

### 流式 SSE 双向翻译

* OpenAI SSE → Anthropic `content_block_*` 事件
* 支持：
  * thinking block（`reasoning_content`，如 DeepSeek R1）
  * text block
  * tool_use block
* 自动 block 生命周期管理（start / delta / stop）
* 30 秒 keepalive 心跳防止客户端超时

### Thinking / Reasoning 支持

* Anthropic `thinking.budget_tokens` → OpenAI `reasoning_effort`
* 自动映射等级：
  * >= 4096 → max
  * >= 2048 → high
  * >= 1024 → medium
  * else → low
* `adaptive` 模式 → 映射为 high
* 无 thinking 配置时 → 默认 medium
* 上游不支持时自动降级重试：max → high → 移除参数

### 工具调用转换

* Anthropic `tool_use` ↔ OpenAI `function_call`
* ID 双向标准化：
  * `toolu_oai_xxx` → `call_xxx`（Anthropic → OpenAI 方向，denormalize）
  * `call_xxx` → `toolu_oai_xxx`（OpenAI → Anthropic 方向，normalize）

### 四槽位模型路由系统

支持 4 个模型槽位：

| 槽位 | 默认 Client Model | 用途 |
|------|-------------------|------|
| Default | `claude-sonnet-4-6` | 默认模型 |
| Sonnet | `claude-3-5-sonnet-20241022` | Sonnet 模型 |
| Opus | `claude-3-opus-20240229` | Opus 模型 |
| Haiku | `claude-3-5-haiku-20241022` | 子智能体运行槽位 |

每个槽位可独立配置：
* `client` — Claude 侧模型名
* `target` — 实际上游模型
* `api` — API 通道（`PRIMARY` / `SECONDARY`）
* `reasoning` — 推理深度策略

---

## 架构

```
Claude Code CLI
      │
      ▼
anthropic-proxy.mjs (本地 Node HTTP 服务 :4000)
      │
      ├── 模式 A：Anthropic 直连透传（主备皆为 anthropic 格式时）
      │     └── 原样转发请求/响应，30s keepalive
      │
      └── 模式 B：OpenAI 协议双向转换
            ├── 路由系统（4槽位 × 主/备API）
            ├── 协议转换引擎（anthropicToOpenAI）
            ├── SSE 流式状态机（thinking/text/tool block 管理）
            └── Reasoning 降级重试系统
      │
      ▼
上游 API（OpenAI / Anthropic / 第三方兼容 API）
```

---

## 启动方式

```bash
node anthropic-proxy.mjs
```

默认监听 `http://127.0.0.1:4000`，可通过 `PORT` 环境变量修改。

---

## API 端点

### 健康检查

```http
HEAD /
```
返回 200。

### 模型列表

```http
GET /v1/models
```

动态返回所有槽位配置的模型名：

```json
{
  "data": [
    { "type": "model", "id": "claude-sonnet-4-6", "display_name": "CLAUDE-SONNET-4-6" }
  ]
}
```

### 核心对话接口

```http
POST /v1/messages
```

支持：
* Anthropic Messages API 请求体
* streaming / non-streaming
* tools / images / system / thinking

---

## 模型路由机制

### 路由优先级

1. **精确匹配** — 请求模型名与槽位的 `client` 字段完全一致（不区分大小写）
2. **子串模糊匹配** — 请求模型名包含槽位的 `client` 字段（或反向包含），取最长匹配
3. **兜底** — fallback 到 Default 槽位（`slots[0]`）

### 路由结果结构

```js
{
  format:      "openai" | "anthropic",  // 根据槽位指向的 API 通道决定
  key:         "...",                    // API 密钥
  base:        "...",                    // 上游 base URL
  authType:    "api-key" | "bearer",    // 认证方式
  targetModel: "...",                    // 实际上游模型名
  reasoning:   "auto"|"max"|"high"|"medium"|"low"|"none",
  name:        "PRIMARY" | "SECONDARY"  // 使用哪个 API 通道
}
```

---

## 两种运行模式

### 模式 A：Anthropic 直连透传

当路由结果的 `format === "anthropic"` 时启用。

* 请求原样转发到上游 Anthropic 端点（仅替换 `model` 字段）
* 支持流式/非流式响应原样透传
* 流式模式下每 30 秒发送 SSE 心跳（`:keepalive`）
* 错误时尝试解析上游标准错误格式并原样转发，避免嵌套

### 模式 B：OpenAI 协议双向转换

当路由结果的 `format === "openai"` 时启用。

* 请求经 `anthropicToOpenAI()` 转换后发送到上游 OpenAI 兼容端点
* 响应经 SSE 状态机转换为 Anthropic 格式事件

---

## 协议转换规则

### Anthropic → OpenAI（请求方向）

#### 消息体

| Anthropic | OpenAI |
|-----------|--------|
| `system`（string 或 array） | `system` message |
| `text` | `content` |
| `image` + source | `image_url` content |
| `tool_use` | `tool_calls`（ID 经 denormalize 处理） |
| `tool_result` | `tool` role message（ID 经 denormalize 处理） |
| `metadata.user_id` | `user` |

#### 工具定义

```json
// Anthropic
{ "name": "...", "description": "...", "input_schema": {...} }

// OpenAI
{ "type": "function", "function": { "name": "...", "description": "...", "parameters": {...} } }
```

#### 工具选择策略

| Anthropic `tool_choice` | OpenAI `tool_choice` |
|------------------------|---------------------|
| `{ type: "auto" }` | `"auto"` |
| `{ type: "any" }` | `"required"` |
| `{ type: "tool", name: "xxx" }` | `{ type: "function", function: { name: "xxx" } }` |

#### Thinking 映射

| Anthropic `thinking` | OpenAI |
|---------------------|--------|
| `budget_tokens >= 4096` | `reasoning_effort: "max"` |
| `budget_tokens >= 2048` | `reasoning_effort: "high"` |
| `budget_tokens >= 1024` | `reasoning_effort: "medium"` |
| `budget_tokens < 1024` | `reasoning_effort: "low"` |
| `type: "adaptive"` | `reasoning_effort: "high"` |
| 无 thinking 配置 | `reasoning_effort: "medium"` |
| 槽位 reasoning = "none" | 不发送 `reasoning_effort` |

### OpenAI → Anthropic（响应方向）

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

## SSE 流式转换机制

OpenAI 流 → Anthropic 事件序列：

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

### Block 生命周期管理

流式转换采用动态索引 (`nextBlockIdx`) 递增分配 block index：

1. **thinking block** — 检测到 `reasoning_content` 时自动开启，文本内容出现时自动关闭（发送 `signature_delta` + `content_block_stop`）
2. **text block** — 检测到 `content` 时开启（会先关闭 thinking block）
3. **tool_use block** — 检测到 `tool_calls` 时开启（会先关闭 thinking block），缓冲 `id` + `name` 就绪后才正式发送 `content_block_start`，期间参数片段在 buffer 中暂存

### 异常处理

* 流中断时调用 `closeAllBlocks()` 关闭所有打开的块
* 尝试发送 `message_delta` + `message_stop` 保证客户端收到完整事件序列
* 解析失败的 SSE chunk 记录日志但不中断流

---

## Reasoning 降级机制

当上游 API 不支持 `reasoning_effort` 参数导致 4xx 错误时：

```
max → high（重试一次）
high → 移除 reasoning_effort 参数（重试一次）
```

触发条件（错误信息必须提到该参数本身）：
* `reasoning_effort`
* `reasoning effort`

---

## 认证方式

### OpenAI 模式

固定使用 `Authorization: Bearer <key>` 头。

### Anthropic 直连模式

支持两种认证类型（通过 `PRIMARY_AUTH_TYPE` / `SECONDARY_AUTH_TYPE` 配置）：

| 类型 | 请求头 |
|------|--------|
| `api-key`（默认） | `x-api-key: <key>` |
| `bearer` | `Authorization: Bearer <key>` + `anthropic-beta: oauth-2025-04-20` |

同时透传客户端的 `anthropic-beta` 和 `x-client-request-id` 头。

---

## 错误处理

HTTP 状态码到 Anthropic 标准 error type 的映射：

| 状态码 | error.type |
|--------|-----------|
| 400 | `invalid_request_error` |
| 401 | `authentication_error` |
| 403 | `authentication_error` |
| 404 | `not_found_error` |
| 429 | `rate_limit_error` |
| 529 | `overloaded_error` |
| 其他 | `api_error` |

---

## 超时控制

* 请求级超时：默认 300 秒（`PROXY_TIMEOUT_MS` 环境变量可配）
* 超时触发 `AbortController.abort()` 终止请求

---

## 环境变量一览

### 主 API 通道

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PRIMARY_API_FORMAT` | `openai` | 协议格式（openai / anthropic） |
| `PRIMARY_API_KEY` | — | API 密钥 |
| `PRIMARY_BASE_URL` | `https://api.openai.com` | API 基础路径 |
| `PRIMARY_AUTH_TYPE` | `api-key` | 授权类型（api-key / bearer） |

### 备用 API 通道

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ENABLE_SECONDARY_API` | `false` | 是否启用备 API |
| `SECONDARY_API_FORMAT` | `openai` | 协议格式 |
| `SECONDARY_API_KEY` | — | 备用密钥 |
| `SECONDARY_BASE_URL` | `https://api.openai.com` | 备用端点 |
| `SECONDARY_AUTH_TYPE` | `api-key` | 备用授权类型 |

### 模型槽位

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CLIENT_MODEL_DEFAULT` | `claude-sonnet-4-6` | 槽位1 客户端模型名 |
| `UPSTREAM_MODEL_DEFAULT` | `gpt-4o` | 槽位1 上游模型名 |
| `MODEL_DEFAULT_API` | `PRIMARY` | 槽位1 API 通道 |
| `MODEL_DEFAULT_REASONING` | `auto` | 槽位1 推理策略 |
| `CLIENT_MODEL_SONNET` | `claude-3-5-sonnet-20241022` | 槽位2 客户端模型名 |
| `UPSTREAM_MODEL_SONNET` | `gpt-4o` | 槽位2 上游模型名 |
| `MODEL_SONNET_API` | `PRIMARY` | 槽位2 API 通道 |
| `MODEL_SONNET_REASONING` | `auto` | 槽位2 推理策略 |
| `CLIENT_MODEL_OPUS` | `claude-3-opus-20240229` | 槽位3 客户端模型名 |
| `UPSTREAM_MODEL_OPUS` | `gpt-4o` | 槽位3 上游模型名 |
| `MODEL_OPUS_API` | `PRIMARY` | 槽位3 API 通道 |
| `MODEL_OPUS_REASONING` | `auto` | 槽位3 推理策略 |
| `CLIENT_MODEL_HAIKU` | `claude-3-5-haiku-20241022` | 槽位4 客户端模型名 |
| `UPSTREAM_MODEL_HAIKU` | `gpt-4o-mini` | 槽位4 上游模型名 |
| `MODEL_HAIKU_API` | `PRIMARY` | 槽位4 API 通道 |
| `MODEL_HAIKU_REASONING` | `auto` | 槽位4 推理策略 |

### 其他

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `4000` | 监听端口 |
| `PROXY_TIMEOUT_MS` | `300000` | 请求超时（毫秒） |

---

## 已知限制

* MCP `server_tool_use` 未适配
* `cache_creation_input_tokens` 未实现（固定返回 0）
* OpenAI cache 统计仅映射了 `prompt_tokens_details.cached_tokens`
* 无请求体大小限制
* `reasoning_effort` 依赖上游支持（有降级重试兜底）
* Tool streaming 依赖上游 chunk 顺序稳定性
* 非流式响应的 `thinking` 块不含 signature 验证数据

---

## License

仅供学习与研究用途，不建议用于生产环境（除非自行加固超时/限流/鉴权）。
