# 从零开始部署 Claude Code 完整教程（带单 OpenAI 格式API路由并支持 Agent 工具调用版）

本教程仅依赖系统自带的 **Node.js** 和 **npm**。通过本地一个轻量级的纯 Node.js 脚本将 Claude Code 复杂的 **双向工具链请求和 SSE 流** 优雅地翻译给 OpenAI（或任何 OpenAI 兼容接口，如 DeepSeek），实现一键启动、退出自动清理。

---

## 一、前提检查
在华为应用市场搜索并安装`DevNode-OH`

在终端运行以下命令，确保环境满足最低要求：

```bash
node -v   # 需要 >= 18
npm -v    # 需要 >= 9
```

---

## 二、创建协议转换代理脚本（支持 Tool Use 工具链）

在用户目录下创建 `~/anthropic-proxy.mjs`。该脚本负责在本地 `127.0.0.1:4000` 监听，**双向无缝翻译文本对话与 Tool Use 工具调用结构**。

```bash
vim ~/anthropic-proxy.mjs
```

复制并粘贴以下完整代码（无第三方依赖，开箱即用）：

```javascript
import http from 'node:http';

const OPENAI_BASE = process.env.OPENAI_BASE || 'https://api.openai.com';
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const TARGET_MODEL = process.env.TARGET_MODEL || 'gpt-4o';
const PORT = process.env.PORT || 4000;

if (!OPENAI_KEY) {
  console.error('FATAL: OPENAI_API_KEY environment variable is required');
  process.exit(1);
}

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function sendAnthropicError(res, status, message) {
  log(`❌ Sending Error ${status}: ${message}`);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    type: "error",
    error: {
      type: "api_error",
      message: message
    }
  }));
}

function anthropicToOpenAI(anthBody) {
  const messages = [];
  if (anthBody.system) {
    messages.push({ role: 'system', content: anthBody.system });
  }
  for (const msg of anthBody.messages || []) {
    const { role, content } = msg;
    if (typeof content === 'string') {
      messages.push({ role, content });
      continue;
    }
    if (Array.isArray(content)) {
      let textContent = '';
      const toolCalls = [];
      const toolResults = [];
      const images = [];
      for (const part of content) {
        if (part.type === 'text') {
          textContent += part.text;
        } else if (part.type === 'image') {
          const imageUrl = part.source?.url 
            ? part.source.url
            : `data:${part.source?.media_type || 'image/jpeg'};base64,${part.source?.data || ''}`;
          images.push({ type: 'image_url', image_url: { url: imageUrl } });
        } else if (part.type === 'tool_use') {
          toolCalls.push({
            id: part.id,
            type: 'function',
            function: { name: part.name, arguments: JSON.stringify(part.input || {}) }
          });
        } else if (part.type === 'tool_result') {
          let resContent = '';
          if (typeof part.content === 'string') {
            resContent = part.content;
          } else if (Array.isArray(part.content)) {
            resContent = part.content.map(c => c.text || '').join('\n');
          }
          toolResults.push({ role: 'tool', tool_call_id: part.tool_use_id, content: resContent });
        }
      }
      if (role === 'user') {
        if (toolResults.length > 0) {
          messages.push(...toolResults);
        } else if (images.length > 0) {
          messages.push({ role: 'user', content: [{ type: 'text', text: textContent || ' ' }, ...images] });
        } else {
          messages.push({ role: 'user', content: textContent || ' ' });
        }
      } else if (role === 'assistant') {
        const oaiMsg = { role: 'assistant' };
        if (textContent) oaiMsg.content = textContent;
        if (toolCalls.length > 0) oaiMsg.tool_calls = toolCalls;
        messages.push(oaiMsg);
      }
    }
  }
  const oaiBody = {
    model: TARGET_MODEL,
    messages,
    max_tokens: anthBody.max_tokens || 4096,
    temperature: anthBody.temperature ?? 1.0,
    stream: !!anthBody.stream,
  };
  
  // 翻译工具定义与策略控制
  if (anthBody.tools && anthBody.tools.length > 0) {
    oaiBody.tools = anthBody.tools.map(tool => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.input_schema }
    }));
    
    // 完美的工具选择策略翻译
    if (anthBody.tool_choice) {
      const tc = anthBody.tool_choice;
      if (tc.type === 'auto') {
        oaiBody.tool_choice = 'auto';
      } else if (tc.type === 'any') {
        oaiBody.tool_choice = 'required';
      } else if (tc.type === 'tool') {
        oaiBody.tool_choice = { type: 'function', function: { name: tc.name } };
      }
    }
  }
  return oaiBody;
}

const server = http.createServer(async (req, res) => {
  const pathname = req.url.split('?')[0];
  log(`--> ${req.method} ${req.url} (Mapped to: ${pathname})`);

  if (req.method === 'HEAD' && pathname === '/') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/models') {
    log(`[Models] Mocking models list...`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: [
        { type: "model", id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4-6" },
        { type: "model", id: "claude-3-7-sonnet-20250219", display_name: "Claude 3.7 Sonnet" },
        { type: "model", id: "claude-3-5-sonnet-20241022", display_name: "Claude 3.5 Sonnet" }
      ]
    }));
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/messages') {
    try {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      await new Promise((resolve, reject) => {
        req.on('end', resolve);
        req.on('error', reject);
      });
      
      let anthBody;
      try { anthBody = JSON.parse(body); } catch (err) {
        sendAnthropicError(res, 400, 'Invalid JSON body');
        return;
      }

      const clientRequestedModel = anthBody.model || "claude-sonnet-4-6";
      log(`[Messages] Client requested model: ${clientRequestedModel}`);
      
      const oaiBody = anthropicToOpenAI(anthBody);
      log(`[Messages] Forwarding to OpenAI: model=${oaiBody.model}, stream=${oaiBody.stream}`);
      
      const controller = new AbortController();
      // 长任务超宽裕容错机制 (120 秒)
      const timeoutId = setTimeout(() => controller.abort(), 120000);

      let response;
      try {
        response = await fetch(`${OPENAI_BASE}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENAI_KEY}`,
          },
          body: JSON.stringify(oaiBody),
          signal: controller.signal
        });
      } catch (fetchErr) {
        log(`❌ Upstream connection failed: ${fetchErr.message}`);
        sendAnthropicError(res, 502, `无法连接到 ${OPENAI_BASE}。确认网络或代理。`);
        return;
      } finally {
        clearTimeout(timeoutId);
      }
      
      log(`[Upstream Response] HTTP ${response.status}`);
      if (!response.ok) {
        const errorText = await response.text();
        log(`❌ Upstream error details: ${errorText}`);
        sendAnthropicError(res, response.status, `接口商错误: ${errorText}`);
        return;
      }
      
      if (anthBody.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        
        const messageId = `msg_proxy_${Date.now()}`;
        let outputTokens = 0;
        let finalFinishReason = 'end_turn';
        
        let textBlockOpened = false;
        const toolBlockStates = {}; // 用原始的 OpenAI index 稳定作键追踪状态
        let nextToolIdx = 1;        // 映射索引，文本块由于权重固定为 0，工具块必从 1 开始

        const ensureTextBlockStart = () => {
          if (!textBlockOpened) {
            textBlockOpened = true;
            res.write(`event: content_block_start\ndata: ${JSON.stringify({
              type: "content_block_start", index: 0, content_block: { type: "text", text: "" }
            })}\n\n`);
          }
        };

        const closeAllBlocks = () => {
          if (textBlockOpened) {
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
            textBlockOpened = false;
          }
          // 正确提取真正转换过后的 mapped index 关闭客户端对应的块
          for (const key of Object.keys(toolBlockStates)) {
            const state = toolBlockStates[key];
            if (state && state.opened) {
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: state.index })}\n\n`);
              state.opened = false;
            }
          }
        };

        res.write(`event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            id: messageId, type: "message", role: "assistant", content: [],
            model: clientRequestedModel, stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 } 
          }
        })}\n\n`);

        const reader = response.body?.getReader();
        if (!reader) {
          sendAnthropicError(res, 500, "Response body stream non-readable");
          return;
        }

        const decoder = new TextDecoder();
        let buffer = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            
            for (const line of lines) {
              if (!line.trim() || !line.startsWith('data: ')) continue;
              const data = line.slice(6).trim();
              if (data === '[DONE]') continue;
              
              try {
                const chunk = JSON.parse(data);
                if (!chunk.choices?.length) continue;
                const delta = chunk.choices[0].delta;
                const finishReason = chunk.choices[0].finish_reason;
                if (chunk.usage) outputTokens = chunk.usage.completion_tokens || 0;
                if (finishReason) finalFinishReason = finishReason;
                
                // 处理文本流延迟启动文本块
                if (delta?.content) {
                  ensureTextBlockStart();
                  res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: delta.content }
                  })}\n\n`);
                }
                
                // 完美的流式工具调用定位映射逻辑
                if (delta?.tool_calls) {
                  for (const t of delta.tool_calls) {
                    const oaiIdx = t.index;
                    if (oaiIdx === undefined) continue;

                    let state = toolBlockStates[oaiIdx];
                    if (!state) {
                      const blockIdx = nextToolIdx++;
                      state = {
                        index: blockIdx,
                        opened: false,
                        id: t.id || `call_${Date.now()}_${blockIdx}`,
                        name: t.function?.name || ''
                      };
                      toolBlockStates[oaiIdx] = state;
                    }

                    // 补全由于多流块拼装可能导致缺失的前序属性
                    if (t.id) state.id = t.id;
                    if (t.function?.name) state.name = t.function.name;

                    if (!state.opened) {
                      state.opened = true;
                      res.write(`event: content_block_start\ndata: ${JSON.stringify({
                        type: "content_block_start",
                        index: state.index,
                        content_block: { type: "tool_use", id: state.id, name: state.name }
                      })}\n\n`);
                    }
                    if (t.function?.arguments) {
                      res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                        type: "content_block_delta", index: state.index, delta: { type: "input_json_delta", partial_json: t.function.arguments }
                      })}\n\n`);
                    }
                  }
                }
              } catch (parseErr) {}
            }
          }
          
          closeAllBlocks();
          const stopReasonMap = {
            'stop': 'end_turn',
            'length': 'max_tokens',
            'tool_calls': 'tool_use',
            'content_filter': 'end_turn',
            'function_call': 'tool_use'
          };
          res.write(`event: message_delta\ndata: ${JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: stopReasonMap[finalFinishReason] || 'end_turn', stop_sequence: null },
            usage: { output_tokens: outputTokens }
          })}\n\n`);
          res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
          res.end();
        } catch (streamErr) {
          closeAllBlocks();
          res.end();
        }
      } else {
        const oaiData = await response.json();
        const choice = oaiData.choices?.[0];
        if (!choice) {
          sendAnthropicError(res, 502, "OpenAI returns empty choice");
          return;
        }
        const resContent = [];
        if (choice.message?.content) {
          const text = choice.message.content.trim();
          if (text) resContent.push({ type: 'text', text });
        }
        if (choice.message?.tool_calls) {
          for (const t of choice.message.tool_calls) {
            let parsedInput = {};
            try { parsedInput = JSON.parse(t.function.arguments); } catch { parsedInput = {}; }
            resContent.push({ type: 'tool_use', id: t.id, name: t.function.name, input: parsedInput });
          }
        }
        const stopReasonMap = { 'stop': 'end_turn', 'tool_calls': 'tool_use', 'length': 'max_tokens' };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: oaiData.id || `msg_${Date.now()}`,
          type: 'message',
          role: 'assistant',
          content: resContent,
          model: clientRequestedModel,
          stop_reason: stopReasonMap[choice.finish_reason] || 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: oaiData.usage?.prompt_tokens || 0, output_tokens: oaiData.usage?.completion_tokens || 0 }
        }));
      }
    } catch (err) {
      console.error('Core routing error:', err);
      sendAnthropicError(res, 500, `代理服务器内部发生异常: ${err.message}`);
    }
  } else {
    log(`❌ Unhandled Route: ${req.method} ${req.url}`);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Route not supported' }));
  }
});

const gracefulShutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
server.listen(PORT, '127.0.0.1', () => {
  log(`✅ Proxy running on http://127.0.0.1:${PORT}`);
});

```

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

在文件末尾追加以下代码。请按照实际情况修改`用户参数配置区`：

```bash
# ===== Claude Code 智能双模中转启动器 =====
claude() {
  # ========== 用户参数配置区 ==========
  local API_FORMAT="openai"                   # 选项: "openai" 或 "anthropic"
  local API_KEY="sk-your-api-key"             # 对应的 API 密钥 (OpenAI 的 sk-... 或 Anthropic 的 sk-ant-...)
  local TARGET_MODEL="gpt-4o"                 # [仅用于 OpenAI] 目标翻译模型 (如 gpt-4o, deepseek-chat 等)
  local BASE_URL="https://api.openai.com"     # API 基础路径 (如 https://api.openai.com 或 https://api.anthropic.com)
  # ====================================

  local PROXY_PORT=4000
  local PROXY_SCRIPT="$HOME/anthropic-proxy.mjs"
  local PROXY_PID=""

  # -------------- 模式一：Anthropic 原生直连 / 第三方代理直连 --------------
  if [[ "$API_FORMAT" == "anthropic" ]]; then
    echo "✨ 检测到 Anthropic 原生格式，跳过本地网关，实施高速直连..."
    
    # 注入原生环境变量（跳过本地翻译，直连目标端点）
    export ANTHROPIC_BASE_URL="$BASE_URL"
    export ANTHROPIC_API_KEY="$API_KEY"
    export ANTHROPIC_MODEL="$TARGET_MODEL"
    export ANTHROPIC_DEFAULT_OPUS_MODEL="$TARGET_MODEL"
    export ANTHROPIC_DEFAULT_SONNET_MODEL="$TARGET_MODEL"
    export ANTHROPIC_DEFAULT_HAIKU_MODEL="$TARGET_MODEL"
    export CLAUDE_CODE_SUBAGENT_MODEL="$TARGET_MODEL"
    export CLAUDE_CODE_EFFORT_LEVEL=max
    export ANTHROPIC_SKIP_CONNECTIVITY_CHECK=1
    export CLAUDE_CODE_SKIP_CONNECTIVITY_CHECK=1

  # -------------- 模式二：OpenAI 协议双向本地翻译模式 --------------
  elif [[ "$API_FORMAT" == "openai" ]]; then
    echo "🚀 检测到 OpenAI 格式，正在启动本地后台协议适配器..."
    
    if [[ ! -f "$PROXY_SCRIPT" ]]; then
      echo "❌ 代理脚本未找到，请先创建它: $PROXY_SCRIPT"
      return 1
    fi

    local NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [[ $NODE_VERSION -lt 18 ]]; then
      echo "❌ OpenAI 翻译层需要 Node.js >= v18。"
      return 1
    fi

    # 启动后台中转
    OPENAI_API_KEY="$API_KEY" \
    OPENAI_BASE="$BASE_URL" \
    TARGET_MODEL="$TARGET_MODEL" \
    nohup node "$PROXY_SCRIPT" > $HOME/.anthropic-proxy.log 2>&1 &
    PROXY_PID=$!

    # 稍微等待，保障初始化完成
    sleep 3

    # 探活检测
    if ! kill -0 "$PROXY_PID" 2>/dev/null; then
      echo "❌ 代理网关启动失败。尾部日志:"
      tail -20 "$HOME/.anthropic-proxy.log"
      return 1
    fi
    echo "✅ 本地代理网关启动成功 (工作进程 PID: ${PROXY_PID})"
    echo ""

    # 将 Claude Code 指向本地回环代理端口
    export ANTHROPIC_BASE_URL="http://127.0.0.1:${PROXY_PORT}"
    export ANTHROPIC_API_KEY="sk-ant-dummy-placeholder-key-for-local-proxy"
    export ANTHROPIC_SKIP_CONNECTIVITY_CHECK=1
    export CLAUDE_CODE_SKIP_CONNECTIVITY_CHECK=1
    
  else
    echo "❌ 错误：未知的 API_FORMAT: '$API_FORMAT'。请在 ~/.zshrc 中修改为 'openai' 或 'anthropic'."
    return 1
  fi

  # -------------- 调起主程序 --------------
  echo "🎯 正在加载 Claude Code..."
  echo "📝 退出请输入「/exit」或在终端按下「Ctrl+C」"
  echo ""

  npx --yes @anthropic-ai/claude-code@2.1.112

  # -------------- 安全环境清理 --------------
  unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_SKIP_CONNECTIVITY_CHECK CLAUDE_CODE_SKIP_CONNECTIVITY_CHECK
  
  if [[ -n "$PROXY_PID" ]]; then
    echo ""
    echo "🛑 正在关闭本地中转服务 (PID: ${PROXY_PID})..."
    kill "${PROXY_PID}" 2>/dev/null
    wait "${PROXY_PID}" 2>/dev/null
    pkill -f "anthropic-proxy.mjs" 2>/dev/null
  fi
  echo "✅ 退出完毕，终端运行环境已复原！"
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
🚀 检测到 OpenAI 格式，正在启动本地后台协议适配器...
✅ 本地代理网关启动成功 (工作进程 PID: ${PROXY_PID})

🎯 正在加载 Claude Code...
📝 退出请输入「/exit」或在终端按下「Ctrl+C」

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
