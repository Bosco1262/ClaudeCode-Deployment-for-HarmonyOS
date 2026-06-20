# Deploy Claude Code from Scratch — Full Guide (with Multi-Model Slots + Dual-Channel + Agent Tool Calls)

[English](README.md) | [简体中文](README.zh-CN.md)

This guide relies only on the system's built-in **Node.js** and **npm**. A lightweight pure Node.js script running locally elegantly translates Claude Code's complex **bidirectional tool-call requests, Thinking inference, and SSE streams** to OpenAI (or any OpenAI-compatible endpoint such as DeepSeek), enabling one-click startup with automatic cleanup on exit.

> For detailed technical documentation on the proxy script (protocol conversion rules, SSE streaming state machine, Reasoning degradation mechanism, etc.), see [anthropic-proxy-script-documentation.md](anthropic-proxy-script-documentation.md).

---

## 1. Prerequisites

Install `DevNode-OH` from the Huawei AppGallery.

Run the following commands in the terminal to verify the minimum environment requirements:

```bash
node -v   # requires >= 18
npm -v    # requires >= 9
```

---

## 2. Create the Protocol Conversion Proxy Script

Create `~/anthropic-proxy.mjs` in your home directory. This script listens on `127.0.0.1:4000` and performs **seamless bidirectional translation of text conversations, Thinking inference, and Tool Use calls**, with **4 model slot dynamic routing** and **primary/backup dual API channels**.

```bash
vim ~/anthropic-proxy.mjs
```

Copy the entire content of `anthropic-proxy.mjs` from this project into the file (zero third-party dependencies, ready to run). Core capabilities include:

- Full bidirectional translation between Anthropic Messages and OpenAI Chat Completions
- Bidirectional SSE streaming conversion (thinking block, text block, tool_use block)
- 4-slot model routing: Default / Sonnet / Opus / Haiku, each independently configurable with upstream model and reasoning depth
- Primary/backup dual API channels (PRIMARY / SECONDARY), slot-level traffic distribution
- Anthropic direct pass-through mode (automatically skips protocol conversion when all APIs use Anthropic format)
- Tool ID bidirectional normalization (`toolu_oai_xxx` ↔ `call_xxx`)
- Reasoning degradation retry (`max → high → remove parameter`)
- 30-second SSE keepalive heartbeat
- Per-request timeout control (default 5 minutes)

Make the script executable:

```bash
chmod +x ~/anthropic-proxy.mjs
```

---

## 3. Configure Zsh Shell Function

Edit `~/.zshrc`:

```bash
vim ~/.zshrc
```

Append the following code at the end of the file. Be sure to modify the **API Core Configuration** and **Model Slot Configuration** sections according to your actual setup:

```bash
# ╔══════════════════════════════════════════════════════════════╗
# ║           Claude Code Proxy Gateway Launcher                 ║
# ╚══════════════════════════════════════════════════════════════╝
claude() {

    # ┌─────────────────────────────────────────────────────────────┐
    # │ 1. API Core Configuration                                   │
    # └─────────────────────────────────────────────────────────────┘

    # ▸ Primary API Configuration
    local PRIMARY_API_FORMAT="openai"                        # Protocol format: "openai" or "anthropic"
    local PRIMARY_AUTH_TYPE="api-key"                        # Auth type: "api-key" or "bearer"
    local PRIMARY_API_KEY="sk-your-primary-key"              # Auth key
    local PRIMARY_BASE_URL="https://api.openai.com"          # API endpoint

    # ▸ Backup API Configuration
    local ENABLE_SECONDARY_API="false"                       # Enable backup API traffic distribution
    local SECONDARY_API_FORMAT="openai"                      # Protocol format: "openai" or "anthropic"
    local SECONDARY_AUTH_TYPE="api-key"                      # Auth type: "api-key" or "bearer"
    local SECONDARY_API_KEY="sk-your-secondary-key"          # Backup auth key
    local SECONDARY_BASE_URL="https://api.openai.com"        # Backup API endpoint

    # ┌─────────────────────────────────────────────────────────────┐
    # │ 2. Model Slot Configuration (4 slots × dual channel)        │
    # └─────────────────────────────────────────────────────────────┘

    # ▸ Slot 1: Default Model
    local Client_Model_Default="claude-sonnet-4-6"           # Client-requested model name
    local Upstream_Model_Default="deepseek-ai/DeepSeek-V4-Flash"  # Actual upstream model name for forwarding
    local API_for_Default="PRIMARY"                          # API channel (PRIMARY/SECONDARY)
    local REASONING_for_Default="auto"                       # Reasoning depth (auto/max/high/medium/low/none)
                                                             #           └ auto: maps based on budget_tokens, defaults to medium when no budget set

    # ▸ Slot 2: Sonnet Model
    local Client_Model_Sonnet="claude-sonnet-4-6"
    local Upstream_Model_Sonnet="deepseek-ai/DeepSeek-V4-Flash"
    local API_for_Sonnet="PRIMARY"
    local REASONING_for_Sonnet="auto"

    # ▸ Slot 3: Opus Model
    local Client_Model_Opus="claude-opus-4-7"
    local Upstream_Model_Opus="deepseek-ai/DeepSeek-V4-Pro"
    local API_for_Opus="PRIMARY"
    local REASONING_for_Opus="auto"

    # ▸ Slot 4: Haiku Model (sub-agent slot)
    local Client_Model_Haiku="claude-haiku-4-5"
    local Upstream_Model_Haiku="deepseek-ai/DeepSeek-V4-Flash"
    local API_for_Haiku="PRIMARY"
    local REASONING_for_Haiku="medium"  # Haiku doesn't support reasoning depth setting in Claude Code, so manual configuration is recommended

    # ┌─────────────────────────────────────────────────────────────┐
    # │ 3. Pre-Start Initialization                                 │
    # └─────────────────────────────────────────────────────────────┘

    # ── Clean up residual environment variables from the previous run ──
    unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
    unset ANTHROPIC_SKIP_CONNECTIVITY_CHECK CLAUDE_CODE_SKIP_CONNECTIVITY_CHECK
    unset ANTHROPIC_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_HAIKU_MODEL
    unset CLAUDE_CODE_SUBAGENT_MODEL CLAUDE_CODE_EFFORT_LEVEL

    # ── Kill residual proxy via PID file (verify port 4000 is occupied first to avoid false kills after reboot) ──
    local PID_FILE="$HOME/.anthropic-proxy.pid"
    if [[ -f "$PID_FILE" ]]; then
        if node -e "
        require('net').connect(4000,'127.0.0.1',()=>process.exit(0))
        .on('error',()=>process.exit(1))
        .setTimeout(1000,()=>process.exit(1));
        " 2>/dev/null; then
            kill "$(cat "$PID_FILE")" 2>/dev/null
        fi
        rm -f "$PID_FILE"
    fi
    sleep 0.3

    # ┌─────────────────────────────────────────────────────────────┐
    # │ 4. Proxy Environment Initialization                         │
    # └─────────────────────────────────────────────────────────────┘
    local PROXY_PORT=4000
    local PROXY_SCRIPT="$HOME/anthropic-proxy.mjs"
    local PROXY_PID=""

    # ── Null-value checks for required configuration ──
    if [[ -z "$PRIMARY_API_KEY" || "$PRIMARY_API_KEY" == "sk-your-primary-key" ]]; then
        echo "[Gateway] Error: PRIMARY_API_KEY is not configured. Please set it in ~/.zshrc"
        return 1
    fi
    if [[ -z "$PRIMARY_BASE_URL" ]]; then
        echo "[Gateway] Error: PRIMARY_BASE_URL is not configured"
        return 1
    fi
    if [[ -z "$Upstream_Model_Default" ]]; then
        echo "[Gateway] Error: Upstream default model is not configured"
        return 1
    fi

    if [[ ! -f "$PROXY_SCRIPT" ]]; then
        echo "[Gateway] Proxy script not found: $PROXY_SCRIPT"
        return 1
    fi

    # ▸ Detect pass-through mode (skip proxy when both APIs use native Anthropic protocol with matching configs)
    local CAN_BYPASS_PROXY="false"
    if [[ "$PRIMARY_API_FORMAT" == "anthropic" ]]; then
        if [[ "$ENABLE_SECONDARY_API" != "true" ]]; then
            CAN_BYPASS_PROXY="true"
        elif [[ "$SECONDARY_API_FORMAT" == "anthropic" && "$PRIMARY_BASE_URL" == "$SECONDARY_BASE_URL" && "$PRIMARY_API_KEY" == "$SECONDARY_API_KEY" ]]; then
            CAN_BYPASS_PROXY="true"
        fi
    fi

    # ╔══════════════════════════════════════════════════════════════╗
    # ║ Mode A: Anthropic Direct Pass-Through (skip proxy)           ║
    # ╚══════════════════════════════════════════════════════════════╝
    if [[ "$CAN_BYPASS_PROXY" == "true" ]]; then
        echo "[Gateway] Anthropic direct mode, skipping proxy..."
        
        export ANTHROPIC_BASE_URL="$PRIMARY_BASE_URL"
        export ANTHROPIC_AUTH_TOKEN="$PRIMARY_API_KEY"
        export ANTHROPIC_SKIP_CONNECTIVITY_CHECK=1
        export CLAUDE_CODE_SKIP_CONNECTIVITY_CHECK=1
        
        # ── Set upstream real model names ─
        export ANTHROPIC_MODEL="$Upstream_Model_Default"
        export ANTHROPIC_DEFAULT_SONNET_MODEL="$Upstream_Model_Sonnet"
        export ANTHROPIC_DEFAULT_OPUS_MODEL="$Upstream_Model_Opus"
        export ANTHROPIC_DEFAULT_HAIKU_MODEL="$Upstream_Model_Haiku"
        export CLAUDE_CODE_SUBAGENT_MODEL="$Upstream_Model_Haiku"

    # ╔══════════════════════════════════════════════════════════════╗
    # ║ Mode B: Proxy Gateway Mode (start Node for protocol conv.)   ║
    # ╚══════════════════════════════════════════════════════════════╝
    else
        echo "[Gateway] Starting protocol conversion proxy..."
        
        # ── Pass slot and API configurations to the Node proxy via env vars ──
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
        echo "$PROXY_PID" > "$HOME/.anthropic-proxy.pid"
        sleep 2.5

        # ── Health check ──
        if ! kill -0 "$PROXY_PID" 2>/dev/null; then
            echo "[Gateway] Failed to start. Last 12 lines of log:"
            tail -12 "$HOME/.anthropic-proxy.log"
            return 1
        fi

        echo "[Gateway] Started (127.0.0.1:${PROXY_PORT})"
        echo ""
        
        export ANTHROPIC_BASE_URL="http://127.0.0.1:${PROXY_PORT}"
        export ANTHROPIC_API_KEY="sk-ant-mock-key-to-local-proxy"
        export ANTHROPIC_SKIP_CONNECTIVITY_CHECK=1
        export CLAUDE_CODE_SKIP_CONNECTIVITY_CHECK=1

        # ── Set client-declared model names (the proxy maps them to upstream) ──
        export ANTHROPIC_MODEL="$Client_Model_Default"
        export ANTHROPIC_DEFAULT_SONNET_MODEL="$Client_Model_Sonnet"
        export ANTHROPIC_DEFAULT_OPUS_MODEL="$Client_Model_Opus"
        export ANTHROPIC_DEFAULT_HAIKU_MODEL="$Client_Model_Haiku"
        export CLAUDE_CODE_SUBAGENT_MODEL="$Client_Model_Haiku"
    fi

    # ╔══════════════════════════════════════════════════════════════╗
    # ║ Launch Claude Code CLI                                       ║
    # ╚══════════════════════════════════════════════════════════════╝
    echo "[Claude Code] Launching..."
    echo ""
    npx @anthropic-ai/claude-code@2.1.112

    # ╔══════════════════════════════════════════════════════════════╗
    # ║ Cleanup: unset env vars and stop proxy process               ║
    # ╚══════════════════════════════════════════════════════════════╝
    unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_SKIP_CONNECTIVITY_CHECK CLAUDE_CODE_SKIP_CONNECTIVITY_CHECK
    unset ANTHROPIC_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_HAIKU_MODEL CLAUDE_CODE_SUBAGENT_MODEL CLAUDE_CODE_EFFORT_LEVEL
    unset ANTHROPIC_AUTH_TOKEN

    if [[ -n "$PROXY_PID" ]]; then
        echo "[Gateway] Stopping proxy process (PID: ${PROXY_PID})..."
        kill "${PROXY_PID}" 2>/dev/null
        wait "${PROXY_PID}" 2>/dev/null
    fi
    rm -f "$HOME/.anthropic-proxy.pid"

    echo "[Gateway] Environment cleaned up!"
}
```

Save and exit.

---

## 4. Create the Onboarding Bypass Config File

On first login, Claude Code connects to Anthropic and performs a hard country/region check at the physical network layer. You can bypass this by creating a local fake verified-state file:

```bash
echo '{"hasCompletedOnboarding": true}' > ~/.claude.json
```

---

## 5. Launch and Test

Reload your zsh configuration (you may need to close and reopen the terminal):

```bash
source ~/.zshrc
```

Type `claude` directly:

```text
$ claude
[Gateway] Starting protocol conversion proxy...
[Gateway] Started (127.0.0.1:4000)

[Claude Code] Launching...

(Claude Code started successfully, ready...)
```

### Tool Call Verification:
Once inside the Claude Code chat window, ask something that requires reading the environment, for example:
> "Please check what files are in my current working directory?"

You'll be surprised to see that it requests **file system read permission**. After allowing it, Claude Code successfully leverages the **Tool Use** mechanism we just bidirectionally parsed to invoke underlying OS commands, providing code development, file editing, and command-line execution capabilities just like the official version!

---

## 6. Uninstalling

Remove the `claude` function from `~/.zshrc`, then delete the proxy script and Claude Code-related files:

```bash
rm ~/anthropic-proxy.mjs    # Remove proxy script
rm ~/.anthropic-proxy.log   # Remove proxy log
rm ~/.anthropic-proxy.pid   # Remove proxy PID file
rm ~/.claude.json           # Remove Claude Code config
rm -rf ~/.claude            # Remove Claude Code local files
npx clear-npx-cache         # Clear all npx cache including @anthropic-ai/claude-code@2.1.112
```

## 7. License
This project is licensed under the [MIT License](LICENSE).
