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
* 自动 block 生命周期管理（start / delta / stop），且严格串行：thinking → text → tool_use
* 直连透传与协议转换两种模式下均提供 30 秒 keepalive 心跳
* 用量统计兼容“没有 choices 但带 usage”的尾块
* 宽容的 SSE 解析：`data:` 允许有无空格、兼容 `\r\n`、忽略注释行，并补处理没有换行结尾的最后一块

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

### 内容映射覆盖范围

* 文本、图片与工具结果均完整保留 —— 包括嵌套在 `tool_result` 中的图片
* `document` 块：纯文本源直接内联；base64 载荷默认降级为占位文本，设 `CONVERT_PDF_TO_FILE=true` 后映射为 `file` 块
* 采样参数：`top_p` 与 `stop_sequences` 原样透传（`top_k` 无 OpenAI 等价参数，丢弃）
* 不受支持的内容块会记录日志，不再静默丢弃

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
      ├── 访问守卫：Host / Origin / 可选令牌 + 请求体大小上限
      │
      ├── 模式 A：Anthropic 直连透传（主备皆为 anthropic 格式时）
      │     └── 原样转发请求/响应，30s keepalive
      │
      └── 模式 B：OpenAI 协议双向转换
            ├── 路由系统（4槽位 × 主/备API，单次故障转移）
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
node anthropic-proxy.mjs [选项]
```

| 选项 | 说明 |
|------|------|
| `-l`、`--lang`、`--language <语言>` | 输出语言（`en` / `zh-CN`） |
| `-h`、`--help` | 显示用法并退出 |

默认监听 `http://127.0.0.1:4000`，可通过 `PORT` 环境变量修改。`PORT` 非法会以退出码 1 快速失败；超时/大小类变量非法会输出警告并回退默认值。

---

## 语言解析

所有控制台日志与返回给客户端的错误信息均按固定优先级解析输出语言：

1. **显式手动参数** — `-l` / `--lang` / `--language`，或 `PROXY_LANG` 环境变量（便于容器场景）
2. **自动检测** — 系统语言（`LC_ALL` → `LC_MESSAGES` → `LANG`），其次为 Node.js 运行时区域设置
3. **英语兜底** — 当以上均不适用时保证回退

区域标签会归一化：`en`、`en-US`、`en_US.UTF-8` → `en`；`zh`、`zh-CN`、`zh_CN.UTF-8` → `zh-CN`。显式指定不支持的语言会输出警告并回退到英语，自动检测中不支持的候选会被跳过；缺失的文案条目同样回退为英语。

---

## API 端点

### 健康检查

```http
HEAD /
```
返回 200。不受访问策略限制，可直接用于就绪探测。

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
* 内容块：text / image / document / tool_use / tool_result（工具结果中的图片会被保留）

### Token 计数接口

```http
POST /v1/messages/count_tokens
```

路由方式与 `/v1/messages` 完全一致：

* Anthropic 通道 —— 转发到上游 `count_tokens` 端点；上游返回 `404` / `405` / `501` 时回退本地估算
* OpenAI 通道 —— 直接本地估算，因为 OpenAI 兼容接口没有对应端点

```json
{ "input_tokens": 1234 }
```

本地估算为启发式算法（约 4 个 ASCII 字符或 1 个全角字符 ≈ 1 Token，另加图片/文档固定开销），足够用于上下文统计，不可用于计费。

### CORS 预检

```http
OPTIONS /v1/messages
```

来源在白名单内返回 `204`，否则返回 `403`。预检在令牌校验之前应答（浏览器不会在预检中携带凭据）。

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

// selectRoute() 同时返回：
{
  slot:            { ... },              // 命中的槽位
  route:           { ... },              // 主路由（上表）
  alternateRoute:  { ... } | null        // 可直接使用的备用路由
}
```

### 通道故障转移

当 `ENABLE_SECONDARY_API=true` 且另一通道配置了密钥时，**在任何响应字节发给客户端之前**失败的请求会在另一通道上重试一次：

* 触发条件：连接错误、连接/响应头超时、`429` 与 `5xx`
* 不会触发：其他 `4xx`（客户端错误），以及流式响应已开始之后
* 重试会按目标通道的协议重新组装上游请求，因此 OpenAI 主通道可转移到 Anthropic 备用通道，反之亦然
* 每次转移都会记录日志：`通道故障转移: PRIMARY → SECONDARY（HTTP 502）`
* 每个客户端请求最多转移一次

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
* 流式过程中同样每 30 秒发送 SSE 心跳

---

## 协议转换规则

### Anthropic → OpenAI（请求方向）

#### 消息体

| Anthropic | OpenAI |
|-----------|--------|
| `system`（string 或 array） | `system` message |
| `text` | `content` |
| `image` + source | `image_url` content |
| `document`（文本源） | 内联为 `content` 文本 |
| `document`（base64 源） | 占位文本；设 `CONVERT_PDF_TO_FILE=true` 时转为 `file` 块 |
| `tool_use` | `tool_calls`（ID 经 denormalize 处理） |
| `tool_result` | `tool` role message（ID 经 denormalize 处理） |
| 含图片的 `tool_result` | `tool` 消息，`content` 为 `text` + `image_url` 数组 |
| `top_p` | `top_p` |
| `stop_sequences` | `stop` |
| `metadata.user_id` | `user` |

空的 assistant 消息会被跳过；不受支持的内容块会记录日志（`已丢弃不受支持的内容块: ...`），不再静默丢弃。

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

#### 流式用量（可选开启）

设 `STREAM_INCLUDE_USAGE=true` 会在流式请求中加入 `stream_options: { include_usage: true }`。默认关闭，因为部分 OpenAI 兼容第三方会拒绝该参数；自身就会回传用量的服务商（DeepSeek 及多数中转）无需开启。

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
| `usage.prompt_tokens_details.cache_creation_tokens` | `cache_creation_input_tokens` |

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
3. **tool_use block** — 检测到 `tool_calls` 时开启（会先关闭 thinking **与 text** 块，保证块之间不交叉），缓冲 `id` + `name` 就绪后才正式发送 `content_block_start`（携带 `input: {}`），期间参数片段在 buffer 中暂存

### 异常处理

* 流中断时调用 `closeAllBlocks()` 关闭所有打开的块
* 尝试发送 `message_delta` + `message_stop` 保证客户端收到完整事件序列
* 解析失败的 SSE chunk 记录日志但不中断流
* 上游长时间空闲时由 `PROXY_IDLE_TIMEOUT_MS` 中止，并优雅结束流

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

### 客户端 → 代理 认证（可选）

设置 `PROXY_AUTH_TOKEN` 后要求客户端携带共享令牌，详见下方安全章节。

---

## 安全与访问控制

服务仅监听 `127.0.0.1`，且每个请求都要通过访问守卫：

1. **Host 校验** —— `Host` 必须是 `localhost`、`127.0.0.1` 或 `::1`（可带端口），除非用 `ALLOWED_HOSTS`另行配置；可阻断 DNS Rebinding 类攻击。
2. **Origin 校验** —— 浏览器请求（携带 `Origin` 头）默认只接受 localhost / 回环来源；CLI 客户端不带 `Origin`，不受影响。可用 `ALLOWED_ORIGINS` 追加来源（支持精确值与 `*` 通配，例如 `http://192.168.1.10:5173`），或用 `ALLOWED_ORIGINS=*` 关闭校验（不推荐）。
3. **令牌校验** —— 设置 `PROXY_AUTH_TOKEN` 后，客户端必须发送 `Authorization: Bearer <token>` 或 `x-api-key: <token>`，比较使用常量时间算法。Claude Code 侧用 `ANTHROPIC_API_KEY=<同一令牌>`（或 `ANTHROPIC_AUTH_TOKEN`）即可。

其他加固：

* CORS 仅在来源被允许时回显该 `Origin`（绝不使用 `*`），并附带 `Vary: Origin`
* 请求体受 `MAX_BODY_BYTES` 限制（默认 64 MiB），超限直接返回 `413 invalid_request_error`，且不会缓冲整个请求体
* 令牌不写入日志；上游错误体原样透传，本地崩溃统一返回 `500 gatewayCrash`

---

## 错误处理

HTTP 状态码到 Anthropic 标准 error type 的映射：

| 状态码 | error.type |
|--------|-----------|
| 400 | `invalid_request_error` |
| 401 | `authentication_error` |
| 403 | `authentication_error` |
| 404 | `not_found_error` |
| 413 | `invalid_request_error` |
| 429 | `rate_limit_error` |
| 503 | `overloaded_error` |
| 529 | `overloaded_error` |
| 其他 | `api_error` |

未捕获的 Promise 异常会以日志记录（`未捕获的 Promise 异常（该请求继续执行）: ...`），而不会终止进程，避免单条异常流拖垮整个网关（以及其他并行会话）；同步的 `uncaughtException` 故意不拦截。

---

## 超时控制

每个请求受两级看门狗保护：

| 阶段 | 变量 | 默认值 | 行为 |
|------|------|--------|------|
| 连接 / 响应头 | `PROXY_TIMEOUT_MS` | 300 秒 | 等待上游响应头阶段中止请求 |
| 响应体 / 流 | `PROXY_IDLE_TIMEOUT_MS` | 120 秒 | 每收到一块数据即重置；上游长时间静默则中止 |

* 响应尚未开始时中止返回 `504 api_error`；流已开始则优雅结束（补发 `message_delta` + `message_stop`）
* 客户端断开时，代理会主动取消上游请求，而不是继续把流读完
* `PROXY_IDLE_TIMEOUT_MS=0` 可关闭空闲看门狗

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
| `ENABLE_SECONDARY_API` | `false` | 是否启用备 API（槽位分流 + 自动故障转移） |
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

### 安全

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PROXY_AUTH_TOKEN` | — | 可选的客户端共享访问令牌 |
| `ALLOWED_ORIGINS` | localhost / 回环 | 来源白名单，逗号分隔，支持 `*` 通配；单独一个 `*` 表示关闭校验 |
| `ALLOWED_HOSTS` | localhost / 回环 | 主机白名单，逗号分隔；单独一个 `*` 表示关闭校验 |

### 其他

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PROXY_LANG` | — | 显式指定输出语言（en / zh-CN），优先级同 `--lang` |
| `PORT` | `4000` | 监听端口（非法值直接终止启动） |
| `PROXY_TIMEOUT_MS` | `300000` | 连接 / 响应头超时（毫秒） |
| `PROXY_IDLE_TIMEOUT_MS` | `120000` | 上游空闲超时（毫秒），每收一块重置，`0` 表示关闭 |
| `MAX_BODY_BYTES` | `67108864` | 请求体大小上限（字节） |
| `STREAM_INCLUDE_USAGE` | `false` | 在 OpenAI 流式请求中索取用量 |
| `CONVERT_PDF_TO_FILE` | `false` | 将 base64 文档映射为 OpenAI `file` 内容块 |

---

## 回归测试

```bash
node --test tests/proxy.test.mjs
```

测试套件会启动本地 mock 上游，覆盖：请求体完整性（含跨 socket 读边界拆分的多字节字符）、大小上限、访问守卫、令牌鉴权、count_tokens、故障转移、Reasoning 降级、SSE 状态机、用量统计、空闲超时与客户端中断。

---

## 已知限制

* MCP `server_tool_use` 未适配（记录日志后丢弃）
* `tool_result.is_error` 在 OpenAI 侧无对应字段，仅保留错误文本本身
* `cache_creation_input_tokens` 仅在上游回传时才填充
* OpenAI cache 统计仅映射了 `prompt_tokens_details.cached_tokens`
* 官方 OpenAI 接口的流式用量需要设 `STREAM_INCLUDE_USAGE=true`
* `top_k` 无 OpenAI 等价参数，会被丢弃
* 并行 `tool_calls` 按 index 交错下发（每个 index 内部仍严格保持 start → deltas → stop）
* base64 文档需设 `CONVERT_PDF_TO_FILE=true`，否则降级为占位文本
* `reasoning_effort` 依赖上游支持（有降级重试兜底）
* Tool streaming 依赖上游 chunk 顺序稳定性
* 非流式响应的 `thinking` 块不含 signature 验证数据

---

## License

仅供学习与研究用途，不建议用于生产环境（除非自行加固超时/限流/鉴权）。
