import http from 'node:http';

// ╔══════════════════════════════════════════════════════════════╗
// ║ 1. 核心配置读取 (主、备 API 密钥与端点)                           ║
// ╚══════════════════════════════════════════════════════════════╝
const PRIMARY_FORMAT    = process.env.PRIMARY_API_FORMAT || 'openai';
const PRIMARY_KEY       = process.env.PRIMARY_API_KEY;
const PRIMARY_BASE      = process.env.PRIMARY_BASE_URL || 'https://api.openai.com';
const PRIMARY_AUTH_TYPE = process.env.PRIMARY_AUTH_TYPE || 'api-key';

const ENABLE_SECONDARY  = process.env.ENABLE_SECONDARY_API === 'true';
const SECONDARY_FORMAT  = process.env.SECONDARY_API_FORMAT || 'openai';
const SECONDARY_KEY     = process.env.SECONDARY_API_KEY;
const SECONDARY_BASE    = process.env.SECONDARY_BASE_URL || 'https://api.openai.com';
const SECONDARY_AUTH_TYPE = process.env.SECONDARY_AUTH_TYPE || 'api-key';

const PROXY_TIMEOUT_MS  = parseInt(process.env.PROXY_TIMEOUT_MS || '300000', 10);

// ╔══════════════════════════════════════════════════════════════╗
// ║ 2. 模型槽位矩阵 (4槽位 × 主备双 API)                             ║
// ╚══════════════════════════════════════════════════════════════╝
const slots = [
    { 
        client:   (process.env.CLIENT_MODEL_DEFAULT || 'claude-sonnet-4-6').toLowerCase().trim(), 
        target:   process.env.UPSTREAM_MODEL_DEFAULT || 'gpt-4o', 
        api:      process.env.MODEL_DEFAULT_API || 'PRIMARY', 
        reasoning: process.env.MODEL_DEFAULT_REASONING || 'auto' 
    },
    { 
        client:   (process.env.CLIENT_MODEL_SONNET || 'claude-3-5-sonnet-20241022').toLowerCase().trim(), 
        target:   process.env.UPSTREAM_MODEL_SONNET || 'gpt-4o', 
        api:      process.env.MODEL_SONNET_API || 'PRIMARY', 
        reasoning: process.env.MODEL_SONNET_REASONING || 'auto' 
    },
    { 
        client:   (process.env.CLIENT_MODEL_OPUS || 'claude-3-opus-20240229').toLowerCase().trim(), 
        target:   process.env.UPSTREAM_MODEL_OPUS || 'gpt-4o', 
        api:      process.env.MODEL_OPUS_API || 'PRIMARY', 
        reasoning: process.env.MODEL_OPUS_REASONING || 'auto' 
    },
    { 
        client:   (process.env.CLIENT_MODEL_HAIKU || 'claude-3-5-haiku-20241022').toLowerCase().trim(), 
        target:   process.env.UPSTREAM_MODEL_HAIKU || 'gpt-4o-mini', 
        api:      process.env.MODEL_HAIKU_API || 'PRIMARY', 
        reasoning: process.env.MODEL_HAIKU_REASONING || 'auto' 
    }
];

const PORT = process.env.PORT || 4000;

// ╔══════════════════════════════════════════════════════════════╗
// ║ 3. 工具函数                                                   ║
// ╚══════════════════════════════════════════════════════════════╝

function log(msg) {
    console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

let _requestCounter = 0;
function nextRequestId() {
    return `req_${++_requestCounter}_${Date.now()}`;
}

function sendAnthropicError(res, status, message) {
    // 根据状态码映射 Anthropic 标准 error.type
    let errorType = 'api_error';
    if (status === 400) errorType = 'invalid_request_error';
    else if (status === 401) errorType = 'authentication_error';
    else if (status === 403) errorType = 'authentication_error';
    else if (status === 404) errorType = 'not_found_error';
    else if (status === 429) errorType = 'rate_limit_error';
    else if (status === 529) errorType = 'overloaded_error';

    log(`[Error] HTTP ${status} (${errorType}): ${message}`);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
        type: "error", 
        error: { type: errorType, message: message } 
    }));
}

// ▸ 检测上游是否因不支持 reasoning_effort 参数而报错
function isReasoningEffortError(errorText) {
    const lower = errorText.toLowerCase();
    return lower.includes('reasoning_effort') || 
           lower.includes('unsupported parameter') || 
           lower.includes('unknown parameter') || 
           lower.includes('invalid parameter') || 
           lower.includes('unrecognized');
}

// ▸ 模型路由策略：精确匹配 → 最长模糊匹配 → 兜底默认槽位
function selectRoute(requestedModel) {
    const modelName = requestedModel.toLowerCase().trim();

    // 1. 精确匹配 Zsh 声明出来的映射名
    let conf = slots.find(s => s.client === modelName);

    // 2. 模糊自适应识别，优先最长 (最精确) 匹配
    if (!conf) {
        const candidates = slots.filter(s => modelName.includes(s.client) || s.client.includes(modelName));
        if (candidates.length > 0) {
            candidates.sort((a, b) => b.client.length - a.client.length);
            conf = candidates[0];
        }
    }

    // 3. 兜底匹配槽位 1
    if (!conf) {
        conf = slots[0];
    }

    const useSecondary = ENABLE_SECONDARY && conf.api === 'SECONDARY';
    return {
        format:     useSecondary ? SECONDARY_FORMAT : PRIMARY_FORMAT,
        key:        useSecondary ? SECONDARY_KEY : PRIMARY_KEY,
        base:       useSecondary ? SECONDARY_BASE : PRIMARY_BASE,
        authType:   useSecondary ? SECONDARY_AUTH_TYPE : PRIMARY_AUTH_TYPE,
        targetModel: conf.target,
        reasoning:  conf.reasoning,
        name:       useSecondary ? 'SECONDARY' : 'PRIMARY'
    };
}

// ▸ Tool ID 标准化转换 (Anthropic 与 OpenAI 格式互转)
function normalizeToolId(id) {
    if (!id) return id;
    if (id.startsWith('call_')) return 'toolu_oai_' + id.slice(5);
    return id;
}

function denormalizeToolId(id) {
    if (!id) return id;
    if (id.startsWith('toolu_oai_')) return 'call_' + id.slice(10);
    return id;
}

// ╔══════════════════════════════════════════════════════════════╗
// ║ 4. 请求协议转换：Anthropic Messages → OpenAI Chat Completions  ║
// ╚══════════════════════════════════════════════════════════════╝

function anthropicToOpenAI(anthBody, route) {
    const messages = [];

    // ▸ 处理 System Prompt
    if (anthBody.system) {
        let systemText;
        if (typeof anthBody.system === 'string') {
            systemText = anthBody.system;
        } else if (Array.isArray(anthBody.system)) {
            systemText = anthBody.system
                .filter(block => block.type === 'text' && block.text)
                .map(block => block.text)
                .join('\n\n');
        }
        if (systemText) {
            messages.push({ role: 'system', content: systemText });
        }
    }

    // ▸ 遍历处理消息体
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
                } 
                else if (part.type === 'image') {
                    const imageUrl = part.source?.url ? part.source.url : `data:${part.source?.media_type || 'image/jpeg'};base64,${part.source?.data || ''}`;
                    images.push({ type: 'image_url', image_url: { url: imageUrl } });
                } 
                else if (part.type === 'tool_use') {
                    toolCalls.push({
                        id: denormalizeToolId(part.id),
                        type: 'function',
                        function: { name: part.name, arguments: JSON.stringify(part.input || {}) }
                    });
                } 
                else if (part.type === 'tool_result') {
                    let resContent = '';
                    if (typeof part.content === 'string') {
                        resContent = part.content;
                    } else if (Array.isArray(part.content)) {
                        resContent = part.content.map(c => c.text || '').join('\n');
                    }
                    toolResults.push({
                        role: 'tool',
                        tool_call_id: denormalizeToolId(part.tool_use_id),
                        content: resContent
                    });
                }
            }

            // ▸ 根据 Role 组装 OpenAI 消息结构
            if (role === 'user') {
                if (toolResults.length > 0) {
                    messages.push(...toolResults);
                } else if (images.length > 0) {
                    messages.push({ role: 'user', content: [{ type: 'text', text: textContent || ' ' }, ...images] });
                } else {
                    messages.push({ role: 'user', content: textContent || ' ' });
                }
            } 
            else if (role === 'assistant') {
                const oaiMsg = { role: 'assistant' };
                if (textContent) oaiMsg.content = textContent;
                if (toolCalls.length > 0) oaiMsg.tool_calls = toolCalls;
                messages.push(oaiMsg);
            }
        }
    }

    // ▸ 构建基础请求体
    const oaiBody = {
        model: route.targetModel,
        messages,
        max_tokens: anthBody.max_tokens ?? 4096,
        temperature: anthBody.temperature ?? 1.0,
        stream: !!anthBody.stream,
    };

    // ▸ 翻译工具定义：Anthropic tools → OpenAI functions
    if (anthBody.tools && anthBody.tools.length > 0) {
        oaiBody.tools = anthBody.tools.map(tool => ({
            type: 'function',
            function: { name: tool.name, description: tool.description, parameters: tool.input_schema }
        }));
        
        if (anthBody.tool_choice) {
            const tc = anthBody.tool_choice;
            if (tc.type === 'auto') oaiBody.tool_choice = 'auto';
            else if (tc.type === 'any') oaiBody.tool_choice = 'required';
            else if (tc.type === 'tool') oaiBody.tool_choice = { type: 'function', function: { name: tc.name } };
        }
    }

    // ▸ 推理深度映射：budget_tokens → reasoning_effort
    if (route.reasoning !== 'none') {
        let targetEffort = route.reasoning;
        
        if (targetEffort === 'auto') {
            if (anthBody.thinking && anthBody.thinking.type === 'enabled') {
                const budget = anthBody.thinking.budget_tokens || 1024;
                if (budget >= 4096) targetEffort = 'max';
                else if (budget >= 2048) targetEffort = 'high';
                else if (budget >= 1024) targetEffort = 'medium';
                else targetEffort = 'low';
            } else if (anthBody.thinking && anthBody.thinking.type === 'adaptive') {
                // adaptive 模式：由模型自动决定推理深度，映射为 OpenAI 的中等偏高水平
                targetEffort = 'high';
            } else {
                targetEffort = 'medium';
            }
        }
        
        // 始终发送 reasoning_effort，若上游不支持则由错误处理模块自动降级重试
        oaiBody.reasoning_effort = targetEffort;
    }

    // ▸ 映射 Anthropic metadata.user_id → OpenAI user (用于追踪)
    if (anthBody.metadata?.user_id) {
        oaiBody.user = anthBody.metadata.user_id;
    }

    return oaiBody;
}


// ╔══════════════════════════════════════════════════════════════╗
// ║ 5. HTTP 服务核心逻辑                                           ║
// ╚══════════════════════════════════════════════════════════════╝
const server = http.createServer(async (req, res) => {
    const pathname = req.url.split('?')[0];
    const requestId = nextRequestId();
    const requestStart = Date.now();
    log(`[${requestId}] --> ${req.method} ${pathname}`);

    // ▸ 心跳检测端点
    if (req.method === 'HEAD' && pathname === '/') {
        res.writeHead(200);
        res.end();
        return;
    }

    // ▸ 模型列表端点：动态返回槽位支持的模型
    if (req.method === 'GET' && pathname === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            data: slots.map(s => ({ type: "model", id: s.client, display_name: s.client.toUpperCase() })) 
        }));
        return;
    }

    // ▸ 核心对话端点
    if (req.method === 'POST' && pathname === '/v1/messages') {
        try {
            // ── 读取并解析请求体 ──
            let body = '';
            req.on('data', chunk => { body += chunk; });
            await new Promise((resolve, reject) => {
                req.on('end', resolve);
                req.on('error', reject);
            });

            let anthBody;
            try {
                anthBody = JSON.parse(body);
            } catch (err) {
                sendAnthropicError(res, 400, 'Invalid JSON body');
                return;
            }

            // ── 路由决策 ──
            const clientRequestedModel = anthBody.model || slots[0].client;
            const route = selectRoute(clientRequestedModel);
            
            log(`[${requestId}] Route: ${route.name} API (${route.format}) | client=${clientRequestedModel} → upstream=${route.targetModel} | stream=${!!anthBody.stream} | thinking=${anthBody.thinking ? anthBody.thinking.type : 'disabled'}`);

            // ══════════════════════════════════════════════════════════════
            // 模式 A：Anthropic 协议直连透传
            // ══════════════════════════════════════════════════════════════
            if (route.format === 'anthropic') {
                const headers = {
                    'Content-Type': 'application/json',
                    'anthropic-version': req.headers['anthropic-version'] || '2023-06-01'
                };

                // 根据认证类型选择 Bearer 或 x-api-key
                if (route.key) {
                    if (route.authType === 'bearer') {
                        headers['Authorization'] = `Bearer ${route.key}`;
                        // OAuth Bearer 认证需附带配套 beta 标志
                        if (!headers['anthropic-beta']) {
                            headers['anthropic-beta'] = 'oauth-2025-04-20';
                        } else {
                            headers['anthropic-beta'] += ',oauth-2025-04-20';
                        }
                    } else {
                        headers['x-api-key'] = route.key;
                    }
                }

                if (req.headers['anthropic-beta']) {
                    headers['anthropic-beta'] = req.headers['anthropic-beta'];
                }

                if (req.headers['x-client-request-id']) {
                    headers['x-client-request-id'] = req.headers['x-client-request-id'];
                }

                anthBody.model = route.targetModel;
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

                try {
                    const response = await fetch(`${route.base}/v1/messages`, {
                        method: 'POST', headers, body: JSON.stringify(anthBody), signal: controller.signal
                    });
                    clearTimeout(timeoutId);
                    const elapsed = Date.now() - requestStart;
                    log(`[${requestId}] <-- Anthropic ${response.status} | ${elapsed}ms`);

                    if (!response.ok) {
                        const errText = await response.text();
                        // 尝试解析上游标准错误格式并原样转发，避免二次嵌套
                        try {
                            const errJson = JSON.parse(errText);
                            if (errJson.type === 'error' && errJson.error) {
                                res.writeHead(response.status, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify(errJson));
                                return;
                            }
                        } catch (_) { /* 非JSON，走通用错误处理 */ }
                        sendAnthropicError(res, response.status, `直连平台处理错: ${errText}`);
                        return;
                    }

                    // 流式响应透传
                    if (anthBody.stream) {
                        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
                        if (response.body) {
                            const reader = response.body.getReader();
                            // 按 30 秒间隔发送 SSE 心跳，防止客户端 45 秒活性超时
                            let keepaliveTimer = setInterval(() => {
                                try { res.write(':keepalive\n\n'); } catch (_) { /* 连接已断 */ }
                            }, 30000);
                            try {
                                while (true) {
                                    const { done, value } = await reader.read();
                                    if (done) break;
                                    res.write(value);
                                }
                            } finally {
                                clearInterval(keepaliveTimer);
                            }
                        }
                        res.end();
                    } 
                    // 非流式响应透传
                    else {
                        const data = await response.json();
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(data));
                    }
                    return;
                } catch (fetchErr) {
                    log(`[${requestId}] Anthropic Upstream Failed: ${fetchErr.message}`);
                    sendAnthropicError(res, 502, `无法连接上游直连节点: ${fetchErr.message}`);
                    return;
                }
            }

            // ══════════════════════════════════════════════════════════════
            // 模式 B：OpenAI 协议双向转换
            // ══════════════════════════════════════════════════════════════
            const oaiBody = anthropicToOpenAI(anthBody, route);
            log(`[${requestId}] OpenAI Upstream model=${oaiBody.model}`);

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
            let response;

            try {
                response = await fetch(`${route.base}/v1/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${route.key}` },
                    body: JSON.stringify(oaiBody),
                    signal: controller.signal
                });
            } catch (fetchErr) {
                log(`[${requestId}] OpenAI Connection failed: ${fetchErr.message}`);
                sendAnthropicError(res, 502, `中转网络失联: ${route.base}`);
                return;
            } finally {
                clearTimeout(timeoutId);
            }

            log(`[${requestId}] <-- OpenAI HTTP ${response.status} | ${Date.now() - requestStart}ms`);

            // ── 错误处理与自动降级重试 ──
            if (!response.ok) {
                const errorText = await response.text();

                if (oaiBody.reasoning_effort && isReasoningEffortError(errorText)) {
                    const prev = oaiBody.reasoning_effort;
                    if (prev === 'max') {
                        log(`[${requestId}] Retry reasoning_effort: max → high`);
                        oaiBody.reasoning_effort = 'high';
                    } else {
                        log(`[${requestId}] Retry reasoning_effort rejected, removing`);
                        delete oaiBody.reasoning_effort;
                    }

                    const retryRes = await fetch(`${route.base}/v1/chat/completions`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${route.key}` },
                        body: JSON.stringify(oaiBody),
                        signal: controller.signal
                    });

                    if (!retryRes.ok) {
                        const err2 = await retryRes.text();
                        sendAnthropicError(res, retryRes.status, `上游服务器拒绝处理: ${err2}`);
                        return;
                    }
                    response = retryRes;
                    log(`[${requestId}] OpenAI Retry OK HTTP ${response.status}`);
                } else {
                    sendAnthropicError(res, response.status, `上游服务器拒绝处理: ${errorText}`);
                    return;
                }
            }

            // ── 流式响应转换 (OpenAI SSE → Anthropic SSE) ──
            if (anthBody.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'Access-Control-Allow-Origin': '*',
                });

                const messageId = `msg_proxy_${Date.now()}`;
                let inputTokens = 0;
                let outputTokens = 0;
                let cacheCreationTokens = 0;
                let cacheReadTokens = 0;
                let finalFinishReason = 'end_turn';
                
                // 块状态管理
                let thinkingBlockOpened = false;
                let textBlockOpened = false;
                const toolBlockStates = {};
                let nextBlockIdx = 0;
                let thinkingBlockIdx = -1;
                let textBlockIdx = -1;

                const ensureTextBlockStart = () => {
                    if (!textBlockOpened) {
                        textBlockOpened = true;
                        textBlockIdx = nextBlockIdx++;
                        res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: textBlockIdx, content_block: { type: "text", text: "" } })}\n\n`);
                    }
                };

                const ensureThinkingBlockStart = () => {
                    if (!thinkingBlockOpened) {
                        thinkingBlockOpened = true;
                        thinkingBlockIdx = nextBlockIdx++;
                        res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: thinkingBlockIdx, content_block: { type: "thinking", thinking: "" } })}\n\n`);
                    }
                };

                const closeAllBlocks = () => {
                    if (thinkingBlockOpened) {
                        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: thinkingBlockIdx, delta: { type: "signature_delta", signature: "" } })}\n\n`);
                        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: thinkingBlockIdx })}\n\n`);
                        thinkingBlockOpened = false;
                    }
                    if (textBlockOpened) {
                        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: textBlockIdx })}\n\n`);
                        textBlockOpened = false;
                    }
                    for (const key of Object.keys(toolBlockStates)) {
                        const state = toolBlockStates[key];
                        if (state && state.opened) {
                            res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: state.index })}\n\n`);
                            state.opened = false;
                        }
                    }
                };

                // 发送起始信号
                res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: messageId, type: "message", role: "assistant", content: [], model: clientRequestedModel, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })}\n\n`);

                const reader = response.body?.getReader();
                if (!reader) {
                    sendAnthropicError(res, 500, "Response stream was broken");
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

                                if (chunk.usage) {
                                    outputTokens = chunk.usage.completion_tokens || 0;
                                    inputTokens = chunk.usage.prompt_tokens || inputTokens;
                                    if (chunk.usage.prompt_tokens_details?.cached_tokens) {
                                        cacheReadTokens = chunk.usage.prompt_tokens_details.cached_tokens;
                                    }
                                }
                                if (finishReason) finalFinishReason = finishReason;

                                // ▸ reasoning_content → thinking 块 (如 DeepSeek R1)
                                if (delta?.reasoning_content) {
                                    ensureThinkingBlockStart();
                                    res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: thinkingBlockIdx, delta: { type: "thinking_delta", thinking: delta.reasoning_content } })}\n\n`);
                                }

                                // ▸ text content → text 块
                                if (delta?.content) {
                                    if (thinkingBlockOpened) {
                                        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: thinkingBlockIdx, delta: { type: "signature_delta", signature: "" } })}\n\n`);
                                        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: thinkingBlockIdx })}\n\n`);
                                        thinkingBlockOpened = false;
                                    }
                                    ensureTextBlockStart();
                                    res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: textBlockIdx, delta: { type: "text_delta", text: delta.content } })}\n\n`);
                                }

                                // ▸ tool_calls 处理 (需前先关闭 thinking 块防止交叉)
                                if (delta?.tool_calls) {
                                    if (thinkingBlockOpened) {
                                        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: thinkingBlockIdx, delta: { type: "signature_delta", signature: "" } })}\n\n`);
                                        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: thinkingBlockIdx })}\n\n`);
                                        thinkingBlockOpened = false;
                                    }

                                    for (const t of delta.tool_calls) {
                                        const oaiIdx = t.index;
                                        if (oaiIdx === undefined) continue;
                                        
                                        let state = toolBlockStates[oaiIdx];
                                        if (!state) {
                                            state = { id: t.id ? normalizeToolId(t.id) : null, name: t.function?.name || null, opened: false, buffer: '' };
                                            toolBlockStates[oaiIdx] = state;
                                        }

                                        if (t.id) state.id = normalizeToolId(t.id);
                                        if (t.function?.name) state.name = t.function.name;
                                        if (t.function?.arguments) state.buffer += t.function.arguments;

                                        // 当 id + name 就绪时，打开 content_block_start 并回放缓冲区
                                        if (!state.opened && state.id && state.name) {
                                            state.opened = true;
                                            state.index = nextBlockIdx++;
                                            res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: state.index, content_block: { type: "tool_use", id: state.id, name: state.name } })}\n\n`);
                                            
                                            if (state.buffer) {
                                                res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: state.index, delta: { type: "input_json_delta", partial_json: state.buffer } })}\n\n`);
                                                state.buffer = '';
                                            }
                                        }

                                        // 持续发送参数片段
                                        if (state.opened && t.function?.arguments) {
                                            res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: state.index, delta: { type: "input_json_delta", partial_json: t.function.arguments } })}\n\n`);
                                        }
                                    }
                                }
                            } catch (parseErr) {
                                log(`[${requestId}] SSE Parse failed: ${(parseErr.message || '').slice(0, 80)}`);
                            }
                        }
                    }

                    // ── 流结束，关闭所有打开的块 ──
                    closeAllBlocks();
                    const stopReasonMap = { 'stop': 'end_turn', 'length': 'max_tokens', 'tool_calls': 'tool_use', 'content_filter': 'end_turn', 'function_call': 'tool_use' };
                    
                    res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: stopReasonMap[finalFinishReason] || 'end_turn', stop_sequence: null }, usage: { output_tokens: outputTokens, input_tokens: inputTokens, cache_creation_input_tokens: cacheCreationTokens, cache_read_input_tokens: cacheReadTokens } })}\n\n`);
                    res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
                    res.end();
                    log(`[${requestId}] Stream done | in=${inputTokens} out=${outputTokens} cache_read=${cacheReadTokens} | ${Date.now() - requestStart}ms`);

                } catch (streamErr) {
                    log(`[${requestId}] Stream Aborted: ${(streamErr.message || '').slice(0, 80)}`);
                    closeAllBlocks();
                    try {
                        res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: outputTokens || 0, input_tokens: inputTokens || 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } })}\n\n`);
                        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
                    } catch (_) { /* 连接可能已断开 */ }
                    res.end();
                }
            } 
            
            // ── 非流式响应转换 ──
            else {
                const oaiData = await response.json();
                const choice = oaiData.choices?.[0];

                if (!choice) {
                    sendAnthropicError(res, 502, "Empty upstream response choice");
                    return;
                }

                const resContent = [];

                // ▸ 提取推理/思考内容
                if (choice.message?.reasoning_content) {
                    resContent.push({ type: 'thinking', thinking: choice.message.reasoning_content, signature: '' });
                }
                // ▸ 提取正常文本
                if (choice.message?.content) {
                    const text = choice.message.content.trim();
                    if (text) resContent.push({ type: 'text', text });
                }
                // ▸ 提取工具调用
                if (choice.message?.tool_calls) {
                    for (const t of choice.message.tool_calls) {
                        let parsedInput = {};
                        try { parsedInput = JSON.parse(t.function.arguments); } catch { parsedInput = {}; }
                        resContent.push({ type: 'tool_use', id: normalizeToolId(t.id), name: t.function.name, input: parsedInput });
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
                    usage: {
                        input_tokens: oaiData.usage?.prompt_tokens || 0,
                        output_tokens: oaiData.usage?.completion_tokens || 0,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: oaiData.usage?.prompt_tokens_details?.cached_tokens || 0
                    }
                }));
                log(`[${requestId}] Non-stream done | in=${oaiData.usage?.prompt_tokens || 0} out=${oaiData.usage?.completion_tokens || 0} | ${Date.now() - requestStart}ms`);
            }
        } catch (err) {
            log(`[${requestId}] Fatal: ${err.message}`);
            sendAnthropicError(res, 500, `网关系统发生核心崩溃: ${err.message}`);
        }
    } 
    
    // ▸ 404 兜底路由
    else {
        log(`[${requestId}] 404 ${req.method} ${req.url}`);
        sendAnthropicError(res, 404, 'Route not supported');
    }
});

// ╔══════════════════════════════════════════════════════════════╗
// ║ 6. 进程管理与启动                                              ║
// ╚══════════════════════════════════════════════════════════════╝
const gracefulShutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

server.listen(PORT, '127.0.0.1', () => {
    log(`[Startup] Listening on http://127.0.0.1:${PORT}`);
});
