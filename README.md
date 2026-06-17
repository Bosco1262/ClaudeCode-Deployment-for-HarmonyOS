# 从零开始部署 Claude Code 完整教程（多模型槽位 + 双通道 + Agent 工具调用版）

本教程仅依赖系统自带的 **Node.js** 和 **npm**。通过本地一个轻量级的纯 Node.js 脚本将 Claude Code 复杂的 **双向工具链请求、Thinking 推理和 SSE 流** 优雅地翻译给 OpenAI（或任何 OpenAI 兼容接口，如 DeepSeek），实现一键启动、退出自动清理。

> 代理脚本的详细技术说明（协议转换规则、SSE 流式状态机、Reasoning 降级机制等）请参阅 [anthropic-proxy脚本说明.md](anthropic-proxy脚本说明.md)。

---

## 一、前提检查
在华为应用市场搜索并安装`DevNode-OH`

在终端运行以下命令，确保环境满足最低要求：

```bash
node -v   # 需要 >= 18
npm -v    # 需要 >= 9
```

---

## 二、创建协议转换代理脚本

在用户目录下创建 `~/anthropic-proxy.mjs`。该脚本负责在本地 `127.0.0.1:4000` 监听，**双向无缝翻译文本对话、Thinking 推理与 Tool Use 工具调用结构**，并支持 **4 模型槽位动态路由**与 **主备双 API 通道**。

```bash
vim ~/anthropic-proxy.mjs
```

将项目中的 `anthropic-proxy.mjs` 文件内容完整复制进去（无第三方依赖，开箱即用）。核心能力包括：

- Anthropic Messages ↔ OpenAI Chat Completions 全类型双向翻译
- SSE 流式双向转换（含 thinking block、text block、tool_use block）
- 4 槽位模型路由：Default / Sonnet / Opus / Haiku，各槽位可独立配置上游模型与推理深度
- 主备双 API 通道（PRIMARY / SECONDARY），槽位级别分流
- Anthropic 协议直连透传模式（当所有 API 均为 Anthropic 格式时自动跳过协议转换）
- Tool ID 双向标准化（`toolu_oai_xxx` ↔ `call_xxx`）
- Reasoning 降级重试（`max → high → 移除参数`）
- 30 秒 SSE keepalive 心跳
- 请求级超时控制（默认 5 分钟）

给脚本赋予运行权限：

```bash
chmod +x ~/anthropic-proxy.mjs
```

---

## 三、配置 Zsh Shell 函数

编辑 `~/.zshrc`：

```bash
vim ~/.zshrc
```

在文件末尾追加以下代码。请按照实际情况修改 **API 核心配置** 和 **模型槽位配置** 区域：

```bash
# ╔══════════════════════════════════════════════════════════════╗
# ║               Claude Code 代理网关启动器                       ║
# ╚══════════════════════════════════════════════════════════════╝
claude() {

    # ┌─────────────────────────────────────────────────────────────┐
    # │ 1. API 核心配置                                              │
    # └─────────────────────────────────────────────────────────────┘

    # ▸ 主 API 配置
    local PRIMARY_API_FORMAT="openai"                        # 协议格式: "openai" 或 "anthropic"
    local PRIMARY_AUTH_TYPE="api-key"                         # 授权类型: "api-key" 或 "bearer"
    local PRIMARY_API_KEY="sk-your-primary-key"              # 授权密钥
    local PRIMARY_BASE_URL="https://api.openai.com"          # 接入端点

    # ▸ 备用 API 配置
    local ENABLE_SECONDARY_API="false"                       # 是否启用备 API 分流
    local SECONDARY_API_FORMAT="openai"                      # 协议格式: "openai" 或 "anthropic"
    local SECONDARY_AUTH_TYPE="api-key"                      # 授权类型: "api-key" 或 "bearer"
    local SECONDARY_API_KEY="sk-your-secondary-key"         # 备用授权密钥
    local SECONDARY_BASE_URL="https://api.openai.com"       # 备用接入端点

    # ┌─────────────────────────────────────────────────────────────┐
    # │ 2. 模型槽位配置 (4槽位 × 主备双通道)                            │
    # └─────────────────────────────────────────────────────────────┘

    # ▸ 槽位 1：默认模型
    local Client_Model_Default="claude-sonnet-4-6"           # 客户端请求的模型名
    local Upstream_Model_Default="deepseek-ai/DeepSeek-V4-Pro"  # 上游实际转发的模型名
    local API_for_Default="PRIMARY"                          # 指向的 API 通道 (PRIMARY / SECONDARY)
    local REASONING_for_Default="auto"                       # 推理深度 (auto/max/high/medium/low/none)
                                                             #   auto: 根据 budget_tokens 自动映射，无 budget 时默认 medium

    # ▸ 槽位 2：Sonnet 模型
    local Client_Model_Sonnet="claude-sonnet-4-6"
    local Upstream_Model_Sonnet="deepseek-ai/DeepSeek-V4-Pro"
    local API_for_Sonnet="PRIMARY"
    local REASONING_for_Sonnet="auto"

    # ▸ 槽位 3：Opus 模型
    local Client_Model_Opus="claude-opus-4-7"
    local Upstream_Model_Opus="deepseek-ai/DeepSeek-V4-Flash"
    local API_for_Opus="PRIMARY"
    local REASONING_for_Opus="auto"

    # ▸ 槽位 4：Haiku 模型 (子智能体运行槽位)
    local Client_Model_Haiku="claude-haiku-4-5"
    local Upstream_Model_Haiku="deepseek-ai/DeepSeek-V4-Flash"
    local API_for_Haiku="SECONDARY"
    local REASONING_for_Haiku="auto"

    # ┌─────────────────────────────────────────────────────────────┐
    # │ 3. 代理环境初始化                                             │
    # └─────────────────────────────────────────────────────────────┘
    local PROXY_PORT=4000
    local PROXY_SCRIPT="$HOME/anthropic-proxy.mjs"
    local PROXY_PID=""

    if [[ ! -f "$PROXY_SCRIPT" ]]; then
        echo "[Gateway] 代理脚本未找到: $PROXY_SCRIPT"
        return 1
    fi

    # ▸ 检测是否可跳过代理直连 (仅当主备皆为 Anthropic 原生协议且配置相同时)
    local CAN_BYPASS_PROXY="false"
    if [[ "$PRIMARY_API_FORMAT" == "anthropic" ]]; then
        if [[ "$ENABLE_SECONDARY_API" != "true" ]]; then
            CAN_BYPASS_PROXY="true"
        elif [[ "$SECONDARY_API_FORMAT" == "anthropic" && "$PRIMARY_BASE_URL" == "$SECONDARY_BASE_URL" && "$PRIMARY_API_KEY" == "$SECONDARY_API_KEY" ]]; then
            CAN_BYPASS_PROXY="true"
        fi
    fi

    # ╔══════════════════════════════════════════════════════════════╗
    # ║ 模式 A：Anthropic 直连模式 (跳过协议转换)                        ║
    # ╚══════════════════════════════════════════════════════════════╝
    if [[ "$CAN_BYPASS_PROXY" == "true" ]]; then
        echo "[Gateway] Anthropic 直连模式，跳过代理..."
        
        export ANTHROPIC_BASE_URL="$PRIMARY_BASE_URL"
        export ANTHROPIC_AUTH_TOKEN="$PRIMARY_API_KEY"
        export ANTHROPIC_SKIP_CONNECTIVITY_CHECK=1
        export CLAUDE_CODE_SKIP_CONNECTIVITY_CHECK=1
        
        # ── 设置上游真实模型名 ─
        export ANTHROPIC_MODEL="$Upstream_Model_Default"
        export ANTHROPIC_DEFAULT_SONNET_MODEL="$Upstream_Model_Sonnet"
        export ANTHROPIC_DEFAULT_OPUS_MODEL="$Upstream_Model_Opus"
        export ANTHROPIC_DEFAULT_HAIKU_MODEL="$Upstream_Model_Haiku"
        export CLAUDE_CODE_SUBAGENT_MODEL="$Upstream_Model_Haiku"

    # ╔══════════════════════════════════════════════════════════════╗
    # ║ 模式 B：代理网关模式 (启动 Node 进行协议转换)                      ║
    # ╚══════════════════════════════════════════════════════════════╝
    else
        echo "[Gateway] 启动协议转换代理..."
        
        # ── 将槽位与 API 配置通过环境变量传递给 Node 代理 ──
        CLIENT_MODEL_DEFAULT="$Client_Model_Default" \
        UPSTREAM_MODEL_DEFAULT="$Upstream_Model_Default" \
        MODEL_DEFAULT_API="$API_for_Default" \
        MODEL_DEFAULT_REASONING="$REASONING_for_Default" \
        \
        CLIENT_MODEL_SONNET="$Client_Model_Sonnet" \
        UPSTREAM_MODEL_SONNET="$Upstream_Model_Sonnet" \
        MODEL_SONNET_API="$API_for_Sonnet" \
        MODEL_SONNET_REASONING="$REASONING_for_Sonnet" \
        \
        CLIENT_MODEL_OPUS="$Client_Model_Opus" \
        UPSTREAM_MODEL_OPUS="$Upstream_Model_Opus" \
        MODEL_OPUS_API="$API_for_Opus" \
        MODEL_OPUS_REASONING="$REASONING_for_Opus" \
        \
        CLIENT_MODEL_HAIKU="$Client_Model_Haiku" \
        UPSTREAM_MODEL_HAIKU="$Upstream_Model_Haiku" \
        MODEL_HAIKU_API="$API_for_Haiku" \
        MODEL_HAIKU_REASONING="$REASONING_for_Haiku" \
        \
        PRIMARY_API_FORMAT="$PRIMARY_API_FORMAT" \
        PRIMARY_AUTH_TYPE="$PRIMARY_AUTH_TYPE" \
        PRIMARY_API_KEY="$PRIMARY_API_KEY" \
        PRIMARY_BASE_URL="$PRIMARY_BASE_URL" \
        \
        ENABLE_SECONDARY_API="$ENABLE_SECONDARY_API" \
        SECONDARY_API_FORMAT="$SECONDARY_API_FORMAT" \
        SECONDARY_AUTH_TYPE="$SECONDARY_AUTH_TYPE" \
        SECONDARY_API_KEY="$SECONDARY_API_KEY" \
        SECONDARY_BASE_URL="$SECONDARY_BASE_URL" \
        \
        PROXY_TIMEOUT_MS="${PROXY_TIMEOUT_MS:-300000}" \
        PORT="$PROXY_PORT" \
        nohup node "$PROXY_SCRIPT" > $HOME/.anthropic-proxy.log 2>&1 &
        
        PROXY_PID=$!
        sleep 2.5

        # ── 健康检查 ──
        if ! kill -0 "$PROXY_PID" 2>/dev/null; then
            echo "[Gateway] 启动失败，最近 12 行日志："
            tail -12 "$HOME/.anthropic-proxy.log"
            return 1
        fi

        echo "[Gateway] 已启动 (127.0.0.1:${PROXY_PORT})"
        echo ""
        
        export ANTHROPIC_BASE_URL="http://127.0.0.1:${PROXY_PORT}"
        export ANTHROPIC_API_KEY="sk-ant-mock-key-to-local-proxy"
        export ANTHROPIC_SKIP_CONNECTIVITY_CHECK=1
        export CLAUDE_CODE_SKIP_CONNECTIVITY_CHECK=1

        # ── 设置客户端声明的模型名 (代理会负责映射到上游真实模型) ──
        export ANTHROPIC_MODEL="$Client_Model_Default"
        export ANTHROPIC_DEFAULT_SONNET_MODEL="$Client_Model_Sonnet"
        export ANTHROPIC_DEFAULT_OPUS_MODEL="$Client_Model_Opus"
        export ANTHROPIC_DEFAULT_HAIKU_MODEL="$Client_Model_Haiku"
        export CLAUDE_CODE_SUBAGENT_MODEL="$Client_Model_Haiku"
    fi

    # ╔══════════════════════════════════════════════════════════════╗
    # ║ 启动 Claude Code CLI                                          ║
    # ╚══════════════════════════════════════════════════════════════╝
    echo "[Claude Code] 启动中..."
    echo ""
    npx @anthropic-ai/claude-code@2.1.112

    # ╔══════════════════════════════════════════════════════════════╗
    # ║ 退出清理：释放环境变量并停止代理进程                               ║
    # ╚══════════════════════════════════════════════════════════════╝
    unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_SKIP_CONNECTIVITY_CHECK CLAUDE_CODE_SKIP_CONNECTIVITY_CHECK
    unset ANTHROPIC_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_HAIKU_MODEL CLAUDE_CODE_SUBAGENT_MODEL CLAUDE_CODE_EFFORT_LEVEL
    unset ANTHROPIC_AUTH_TOKEN

    if [[ -n "$PROXY_PID" ]]; then
        echo "[Gateway] 停止代理进程 (PID: ${PROXY_PID})...."
        kill "${PROXY_PID}" 2>/dev/null
        wait "${PROXY_PID}" 2>/dev/null
    fi

    echo "[Gateway] 环境已清理！"
}
```

保存退出。

---

## 四、建立绕过验证伪配置文件

由于首次登入 Claude Code 会连接 Anthropic 并在物理链路层面强行进行国家及地区校验。只需本地伪造已校验状态，即可免受影响：

```bash
echo '{"hasCompletedOnboarding": true}' > ~/.claude.json
```

---

## 五、启动并测试运行

重新加载 zsh 配置让命令生效（可能需要手动关闭终端再打开）：

```bash
source ~/.zshrc
```

直接键入 `claude`：

```text
$ claude
[Gateway] 启动协议转换代理...
[Gateway] 已启动 (127.0.0.1:4000)

[Claude Code] 启动中...

(Claude Code 启动成功，准备就绪...)
```

### 功能验证（工具调用测试）：
进入 Claude Code 对话窗口后，随便问一个它需要读取环境的问题，比如：
> "请帮我查看一下我当前的工作盘里都有哪些文件？"

你会惊奇地发现，它会向终端**申请文件系统读取权限**。允许后，它能成功借助我们刚刚双向解析的 **Tool Use** 机制，调用操作系统的底层命令，像官方正版一样提供代码开发、文件编辑和命令行执行能力！

---

## 六、卸载
删除 `~/.zshrc` 中的 `claude` 函数定义，然后删掉代理脚本和 `Claude Code` 相关文件即可：

```bash
rm ~/anthropic-proxy.mjs    # 删掉代理脚本
rm ~/.anthropic-proxy.log   # 删掉代理脚本日志
rm ~/.claude.json           # 删除Claude Code配置文件
rm -rf ~/.claude            # 删除Claude Code本地文件
npx clear-npx-cache         # 回车后将清除所有npx缓存，包含拉取的@anthropic-ai/claude-code@2.1.112
```
