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
  if (anthBody.tools && anthBody.tools.length > 0) {
    oaiBody.tools = anthBody.tools.map(tool => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.input_schema }
    }));
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
      const timeoutId = setTimeout(() => controller.abort(), 15000);

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
        
        res.write(`event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            id: messageId, type: "message", role: "assistant", content: [],
            model: clientRequestedModel, stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 } 
          }
        })}\n\n`);
        
        res.write(`event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start", index: 0, content_block: { type: "text", text: "" }
        })}\n\n`);

        const reader = response.body?.getReader();
        if (!reader) {
          sendAnthropicError(res, 500, "Response body stream non-readable");
          return;
        }

        const decoder = new TextDecoder();
        let buffer = '';
        let textBlockClosed = false;
        const openedToolBlocks = {};

        const closeAllBlocks = () => {
          if (!textBlockClosed) {
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
            textBlockClosed = true;
          }
          for (const idxStr of Object.keys(openedToolBlocks)) {
            const idx = parseInt(idxStr, 10);
            if (openedToolBlocks[idx]) {
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: idx })}\n\n`);
              delete openedToolBlocks[idx];
            }
          }
        };

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
                
                if (delta?.content) {
                  res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: delta.content }
                  })}\n\n`);
                }
                
                if (delta?.tool_calls) {
                  for (const t of delta.tool_calls) {
                    const idx = t.index + 1;
                    if (!openedToolBlocks[idx]) {
                      openedToolBlocks[idx] = true;
                      res.write(`event: content_block_start\ndata: ${JSON.stringify({
                        type: "content_block_start",
                        index: idx,
                        content_block: { type: "tool_use", id: t.id || `call_${Date.now()}`, name: t.function?.name || "" }
                      })}\n\n`);
                    }
                    if (t.function?.arguments) {
                      res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                        type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: t.function.arguments }
                      })}\n\n`);
                    }
                  }
                }
              } catch (parseErr) {}
            }
          }
          
          closeAllBlocks();
          const stopReasonMap = { 'stop': 'end_turn', 'length': 'max_tokens', 'tool_calls': 'tool_use' };
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
          resContent.push({ type: 'text', text: choice.message.content });
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
