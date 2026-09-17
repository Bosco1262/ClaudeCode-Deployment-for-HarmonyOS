// Regression tests for anthropic-proxy.mjs
// 运行: node --test tests/proxy.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROXY_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'anthropic-proxy.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ▸ Everything started by the helpers is tracked, so a failing test can never
// ▸ leave a listening server or a child process behind and hang the runner
// ▸ 助手启动的全部资源都会登记，确保失败的测试不会留下监听中的服务或子进程而挂住测试运行器
const started = { mocks: new Set(), proxies: new Set() };

after(async () => {
    for (const proxy of started.proxies) {
        try { await proxy.stop(); } catch (_) { /* already gone */ }
    }
    for (const mock of started.mocks) {
        try { mock.close(); } catch (_) { /* already closed */ }
    }
});

// ───────────────────────────── helpers ─────────────────────────────

async function waitFor(fn, timeoutMs, intervalMs = 50) {
    const started = Date.now();
    for (;;) {
        if (await fn()) return true;
        if (Date.now() - started > timeoutMs) return false;
        await sleep(intervalMs);
    }
}

function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

function httpRequest({ port, method = 'GET', path: pathname = '/', headers = {}, body = null, timeout = 15000 }) {
    return new Promise((resolve, reject) => {
        const finalHeaders = { ...headers };
        if (body != null) {
            finalHeaders['Content-Length'] = Buffer.byteLength(body);
        }
        const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: finalHeaders, agent: false }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                text: Buffer.concat(chunks).toString('utf8'),
                json: () => JSON.parse(Buffer.concat(chunks).toString('utf8'))
            }));
        });
        req.on('error', reject);
        req.setTimeout(timeout, () => req.destroy(new Error('client timeout')));
        if (body != null) req.write(body);
        req.end();
    });
}

async function startProxy(env) {
    const port = await getFreePort();
    const proc = spawn(process.execPath, [PROXY_PATH], {
        env: {
            ...process.env,
            PORT: String(port),
            PROXY_LANG: 'en',
            PROXY_TIMEOUT_MS: '5000',
            PROXY_IDLE_TIMEOUT_MS: '5000',
            PRIMARY_API_FORMAT: 'openai',
            PRIMARY_API_KEY: 'sk-test',
            ...env
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    proc.stdout.on('data', d => { output += d; });
    proc.stderr.on('data', d => { output += d; });
    let exit = null;
    proc.on('exit', (code, signal) => { exit = { code, signal }; });

    const handle = {
        port,
        proc,
        output: () => output,
        exitInfo: () => exit,
        expectExit: (timeoutMs) => new Promise((resolve, reject) => {
            const startedAt = Date.now();
            const timer = setInterval(() => {
                if (exit) { clearInterval(timer); resolve(exit); }
                else if (Date.now() - startedAt > timeoutMs) { clearInterval(timer); reject(new Error(`proxy did not exit:\n${output}`)); }
            }, 50);
        }),
        stop: async () => {
            if (exit) return;
            proc.kill('SIGTERM');
            const stopped = await waitFor(() => Promise.resolve(Boolean(exit)), 8000);
            if (!stopped) proc.kill('SIGKILL');
        }
    };
    started.proxies.add(handle);

    const ready = await waitFor(async () => {
        try {
            // HEAD / is exempt from the access policy, so it also works with a token configured
            // HEAD / 不受访问策略限制，配置令牌后依然可用于就绪探测
            const res = await httpRequest({ port, method: 'HEAD', path: '/', timeout: 1000 });
            return res.status === 200;
        } catch (_) {
            return false;
        }
    }, 8000);

    if (!ready) {
        proc.kill('SIGKILL');
        throw new Error(`proxy did not become ready:\n${output}`);
    }

    return handle;
}

async function startMockUpstream(handler) {
    const port = await getFreePort();
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const bodyBuf = Buffer.concat(chunks);
            let json = null;
            try { json = JSON.parse(bodyBuf.toString('utf8')); } catch (_) { /* not JSON */ }
            handler(req, res, { bodyBuf, json, text: bodyBuf.toString('utf8') });
        });
    });
    await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
    const handle = {
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => {
            server.closeAllConnections?.();
            server.close();
        }
    };
    started.mocks.add(handle);
    return handle;
}

// Byte-accurate de-chunking for raw socket responses
function dechunk(rawBuf) {
    const headerEnd = rawBuf.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd < 0) return Buffer.alloc(0);
    const header = rawBuf.subarray(0, headerEnd).toString('latin1');
    if (!/transfer-encoding:\s*chunked/i.test(header)) return rawBuf.subarray(headerEnd + 4);
    const parts = [];
    let i = headerEnd + 4;
    while (i < rawBuf.length) {
        const nl = rawBuf.indexOf(Buffer.from('\r\n'), i);
        if (nl < 0) break;
        const size = parseInt(rawBuf.subarray(i, nl).toString('latin1').trim(), 16);
        if (!Number.isFinite(size) || size === 0) break;
        parts.push(rawBuf.subarray(nl + 2, nl + 2 + size));
        i = nl + 2 + size + 2;
    }
    return Buffer.concat(parts);
}

// Minimal Anthropic-style JSON response for the OpenAI channel
function respondOpenAiChat(res, content = 'ok', usage = null) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        id: 'chatcmpl-1',
        choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: usage || { prompt_tokens: 1, completion_tokens: 1 }
    }));
}

function messageBody(overrides = {}) {
    return JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hello' }],
        ...overrides
    });
}

// Parse an Anthropic SSE payload into [{ event, data }]
function parseSse(text) {
    const events = [];
    for (const block of text.split('\n\n')) {
        const lines = block.split('\n').filter(line => line.length > 0);
        if (lines.length === 0) continue;
        const entry = { event: null, data: null };
        for (const line of lines) {
            if (line.startsWith('event: ')) entry.event = line.slice(7).trim();
            else if (line.startsWith('data: ')) entry.data = line.slice(6);
        }
        if (entry.event) events.push(entry);
    }
    return events;
}

function sse(res, payload) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// ───────────────────────────── tests ─────────────────────────────

test('request body keeps multi-byte characters intact across socket chunk boundaries', { timeout: 30000 }, async () => {
    const mock = await startMockUpstream((req, res, { text }) => {
        // Echo the received body back as the assistant content (byte-accurate)
        respondOpenAiChat(res, text);
    });
    const proxy = await startProxy({ PRIMARY_BASE_URL: mock.url });

    try {
        const prefix = '{"model":"claude-sonnet-4-6","max_tokens":64,"messages":[{"role":"user","content":"';
        const suffix = '"}]}';
        const body = Buffer.from(prefix + '中'.repeat(40000) + suffix, 'utf8');
        const head = Buffer.from(
            `POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1:${proxy.port}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
            'latin1'
        );

        // Force the first socket read to end in the middle of a 3-byte character
        const prefixBytes = Buffer.byteLength(prefix, 'utf8');
        const desired = 65536 - head.length;
        const remainder = (desired - prefixBytes) % 3;
        const split = remainder === 0 ? desired - 1 : desired;
        assert.notEqual((split - prefixBytes) % 3, 0, 'test setup must split a multi-byte character');

        const socket = net.connect(proxy.port, '127.0.0.1');
        const collected = new Promise(resolve => {
            const chunks = [];
            socket.on('data', chunk => chunks.push(chunk));
            socket.on('close', () => resolve(Buffer.concat(chunks)));
            socket.on('error', () => resolve(Buffer.concat(chunks)));
        });
        await new Promise(resolve => socket.on('connect', resolve));
        socket.write(Buffer.concat([head, body.subarray(0, split)]));
        await sleep(150);
        socket.write(body.subarray(split));

        const raw = await collected;
        const payload = JSON.parse(dechunk(raw).toString('utf8'));
        const text = payload.content?.[0]?.text || '';
        const replacementChars = [...text].filter(ch => ch === '\uFFFD').length;
        const intact = [...text].filter(ch => ch === '中').length;

        assert.equal(replacementChars, 0, `body must not be corrupted, got ${replacementChars} U+FFFD`);
        assert.equal(intact, 40000, 'all CJK characters must survive the round trip');
    } finally {
        await proxy.stop();
        mock.close();
    }
});

test('oversized request body is rejected with 413', { timeout: 20000 }, async () => {
    const mock = await startMockUpstream((req, res) => respondOpenAiChat(res));
    const proxy = await startProxy({ PRIMARY_BASE_URL: mock.url, MAX_BODY_BYTES: '1024' });

    try {
        const res = await httpRequest({
            port: proxy.port,
            method: 'POST',
            path: '/v1/messages',
            headers: { 'Content-Type': 'application/json' },
            body: messageBody({ messages: [{ role: 'user', content: 'x'.repeat(4096) }] })
        });
        assert.equal(res.status, 413);
        assert.equal(res.json().error.type, 'invalid_request_error');
    } finally {
        await proxy.stop();
        mock.close();
    }
});

test('access guard rejects foreign origins and hosts, allows CLI clients', { timeout: 20000 }, async () => {
    const mock = await startMockUpstream((req, res) => respondOpenAiChat(res));
    const proxy = await startProxy({ PRIMARY_BASE_URL: mock.url });
    const base = { port: proxy.port, method: 'POST', path: '/v1/messages', headers: { 'Content-Type': 'application/json' }, body: messageBody() };

    try {
        const evil = await httpRequest({ ...base, headers: { ...base.headers, Origin: 'https://evil.example' } });
        assert.equal(evil.status, 403);
        assert.equal(evil.json().error.type, 'authentication_error');

        const local = await httpRequest({ ...base, headers: { ...base.headers, Origin: 'http://localhost:5173' } });
        assert.equal(local.status, 200);

        const cli = await httpRequest(base);
        assert.equal(cli.status, 200);

        const badHost = await httpRequest({ ...base, headers: { ...base.headers, Host: 'evil.example' } });
        assert.equal(badHost.status, 403);
    } finally {
        await proxy.stop();
        mock.close();
    }
});

test('optional PROXY_AUTH_TOKEN is enforced when set', { timeout: 20000 }, async () => {
    const mock = await startMockUpstream((req, res) => respondOpenAiChat(res));
    const proxy = await startProxy({ PRIMARY_BASE_URL: mock.url, PROXY_AUTH_TOKEN: 'secret-token' });
    const base = { port: proxy.port, method: 'POST', path: '/v1/messages', headers: { 'Content-Type': 'application/json' }, body: messageBody() };

    try {
        const missing = await httpRequest(base);
        assert.equal(missing.status, 401);

        const wrong = await httpRequest({ ...base, headers: { ...base.headers, 'x-api-key': 'nope' } });
        assert.equal(wrong.status, 401);

        const viaApiKey = await httpRequest({ ...base, headers: { ...base.headers, 'x-api-key': 'secret-token' } });
        assert.equal(viaApiKey.status, 200);

        const viaBearer = await httpRequest({ ...base, headers: { ...base.headers, Authorization: 'Bearer secret-token' } });
        assert.equal(viaBearer.status, 200);
    } finally {
        await proxy.stop();
        mock.close();
    }
});

test('CORS preflight answers allowed origins only', { timeout: 20000 }, async () => {
    const mock = await startMockUpstream((req, res) => respondOpenAiChat(res));
    const proxy = await startProxy({ PRIMARY_BASE_URL: mock.url });

    try {
        const allowed = await httpRequest({
            port: proxy.port, method: 'OPTIONS', path: '/v1/messages',
            headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' }
        });
        assert.equal(allowed.status, 204);
        assert.equal(allowed.headers['access-control-allow-origin'], 'http://localhost:5173');
        assert.match(allowed.headers['vary'] || '', /Origin/);

        const denied = await httpRequest({
            port: proxy.port, method: 'OPTIONS', path: '/v1/messages',
            headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' }
        });
        assert.equal(denied.status, 403);
    } finally {
        await proxy.stop();
        mock.close();
    }
});

test('invalid model type is rejected with 400', { timeout: 20000 }, async () => {
    const mock = await startMockUpstream((req, res) => respondOpenAiChat(res));
    const proxy = await startProxy({ PRIMARY_BASE_URL: mock.url });

    try {
        const res = await httpRequest({
            port: proxy.port, method: 'POST', path: '/v1/messages',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 123, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })
        });
        assert.equal(res.status, 400);
        assert.equal(res.json().error.type, 'invalid_request_error');
    } finally {
        await proxy.stop();
        mock.close();
    }
});

test('count_tokens uses a local estimate on OpenAI channels', { timeout: 20000 }, async () => {
    const mock = await startMockUpstream((req, res) => respondOpenAiChat(res));
    const proxy = await startProxy({ PRIMARY_BASE_URL: mock.url });

    try {
        const res = await httpRequest({
            port: proxy.port, method: 'POST', path: '/v1/messages/count_tokens',
            headers: { 'Content-Type': 'application/json' },
            body: messageBody({ messages: [{ role: 'user', content: 'hello world, 你好世界' }] })
        });
        assert.equal(res.status, 200);
        const payload = res.json();
        assert.ok(Number.isInteger(payload.input_tokens) && payload.input_tokens > 0, `expected a positive integer, got ${payload.input_tokens}`);
    } finally {
        await proxy.stop();
        mock.close();
    }
});

test('count_tokens passes through on Anthropic channels and falls back on 404', { timeout: 20000 }, async () => {
    let countTokensStatus = 404;
    const mock = await startMockUpstream((req, res) => {
        if (req.url === '/v1/messages/count_tokens') {
            res.writeHead(countTokensStatus, { 'Content-Type': 'application/json' });
            res.end(countTokensStatus === 200 ? JSON.stringify({ input_tokens: 42 }) : JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'no such route' } }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
    const proxy = await startProxy({ PRIMARY_BASE_URL: mock.url, PRIMARY_API_FORMAT: 'anthropic' });

    try {
        const fallback = await httpRequest({
            port: proxy.port, method: 'POST', path: '/v1/messages/count_tokens',
            headers: { 'Content-Type': 'application/json' },
            body: messageBody()
        });
        assert.equal(fallback.status, 200);
        assert.ok(fallback.json().input_tokens > 0);

        countTokensStatus = 200;
        const passthrough = await httpRequest({
            port: proxy.port, method: 'POST', path: '/v1/messages/count_tokens',
            headers: { 'Content-Type': 'application/json' },
            body: messageBody()
        });
        assert.equal(passthrough.status, 200);
        assert.equal(passthrough.json().input_tokens, 42);
    } finally {
        await proxy.stop();
        mock.close();
    }
});

test('Anthropic pass-through forwards requests, errors and streams verbatim', { timeout: 30000 }, async () => {
    const seen = [];
    const mock = await startMockUpstream((req, res, { json }) => {
        seen.push({ url: req.url, json });
        if (json && json.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_up","type":"message","role":"assistant","content":[]}}\n\n');
            res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
            res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"passthrough"}}\n\n');
            res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
            res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
            res.end();
            return;
        }
        if (json && json.messages?.[0]?.content === 'fail-me') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'upstream says no' } }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            id: 'msg_up', type: 'message', role: 'assistant',
            content: [{ type: 'text', text: 'direct-ok' }],
            model: json.model, stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 3 }
        }));
    });
    const proxy = await startProxy({ PRIMARY_BASE_URL: mock.url, PRIMARY_API_FORMAT: 'anthropic' });
    const headers = { 'Content-Type': 'application/json' };

    try {
        // ▸ Non-streaming: body forwarded as-is, only the model is rewritten
        // ▸ 非流式：请求体原样转发，仅替换 model
        const direct = await httpRequest({ port: proxy.port, method: 'POST', path: '/v1/messages', headers, body: messageBody() });
        assert.equal(direct.status, 200);
        assert.equal(direct.json().content[0].text, 'direct-ok');
        assert.equal(seen.at(-1).json.model, 'gpt-4o', 'upstream model must come from the slot target');
        assert.equal(seen.at(-1).url, '/v1/messages');

        // ▸ Upstream error envelope forwarded verbatim (no nesting)
        // ▸ 上游错误信封原样转发（不二次嵌套）
        const failed = await httpRequest({
            port: proxy.port, method: 'POST', path: '/v1/messages', headers,
            body: messageBody({ messages: [{ role: 'user', content: 'fail-me' }] })
        });
        assert.equal(failed.status, 400);
        const failedBody = failed.json();
        assert.equal(failedBody.type, 'error');
        assert.equal(failedBody.error.message, 'upstream says no');

        // ▸ Streaming: SSE events pass through untouched
        // ▸ 流式：SSE 事件原样透传
        const streamed = await httpRequest({
            port: proxy.port, method: 'POST', path: '/v1/messages', headers,
            body: messageBody({ stream: true })
        });
        assert.equal(streamed.status, 200);
        assert.match(streamed.text, /event: message_start/);
        assert.match(streamed.text, /"text_delta","text":"passthrough"/);
        assert.match(streamed.text, /event: message_stop/);
    } finally {
        await proxy.stop();
        mock.close();
    }
});

test('conversion never injects the literal "undefined" into prompts', { timeout: 20000 }, async () => {
    const seen = [];
    const mock = await startMockUpstream((req, res, { json }) => {
        seen.push(json);
        respondOpenAiChat(res, 'ok');
    });
    const proxy = await startProxy({ PRIMARY_BASE_URL: mock.url });

    try {
        const res = await httpRequest({
            port: proxy.port, method: 'POST', path: '/v1/messages',
            headers: { 'Content-Type': 'application/json' },
            body: messageBody({
                messages: [
                    { role: 'user', content: [{ type: 'text' }, { type: 'text', text: 'hello' }] },
                    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text' }] }] }
                ]
            })
        });
        assert.equal(res.status, 200);

        const forwarded = JSON.stringify(seen.at(-1).messages);
        assert.ok(!forwarded.includes('undefined'), `prompt must not contain "undefined": ${forwarded}`);
        const userMessage = seen.at(-1).messages.find(m => m.role === 'user' && m.content === 'hello');
        assert.ok(userMessage, 'the real text must still be forwarded');
    } finally {
        await proxy.stop();
        mock.close();
    }
});

test('array-shaped content from third-party upstreams is accepted', { timeout: 30000 }, async () => {
    const mock = await startMockUpstream((req, res, { json }) => {
        if (json && json.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            res.write(`data: ${JSON.stringify({ id: 'c1', choices: [{ delta: { content: [{ type: 'text', text: 'hello ' }] }, finish_reason: null }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ id: 'c1', choices: [{ delta: { content: 'world' }, finish_reason: 'stop' }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            id: 'chatcmpl-x',
            choices: [{ message: { role: 'assistant', content: [{ type: 'text', text: 'hello ' }, 'world'] }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1 }
        }));
    });
    const proxy = await startProxy({ PRIMARY_BASE_URL: mock.url });

    try {
        const nonStream = await httpRequest({
            port: proxy.port, method: 'POST', path: '/v1/messages',
            headers: { 'Content-Type': 'application/json' },
            body: messageBody()
        });
        assert.equal(nonStream.status, 200);
        assert.equal(nonStream.json().content[0].text, 'hello world');

        const stream = await httpRequest({
            port: proxy.port, method: 'POST', path: '/v1/messages',
            headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
            body: messageBody({ stream: true })
        });
        const streamedText = parseSse(stream.text)
            .filter(e => e.event === 'content_block_delta')
            .map(e => JSON.parse(e.data))
            .filter(d => d.delta.type === 'text_delta')
            .map(d => d.delta.text)
            .join('');
        assert.equal(streamedText, 'hello world');
    } finally {
        await proxy.stop();
        mock.close();
    }
});

test('failover switches to the secondary channel when the primary is unreachable', { timeout: 20000 }, async () => {
    const deadPort = await getFreePort();
    const secondary = await startMockUpstream((req, res) => respondOpenAiChat(res, 'from-secondary'));
    const proxy = await startProxy({
        PRIMARY_BASE_URL: `http://127.0.0.1:${deadPort}`,
        ENABLE_SECONDARY_API: 'true',
        SECONDARY_API_KEY: 'sk-secondary',
        SECONDARY_BASE_URL: secondary.url
    });

    try {
        const res = await httpRequest({
            port: proxy.port, method: 'POST', path: '/v1/messages',
            headers: { 'Content-Type': 'application/json' },
            body: messageBody()
        });
        assert.equal(res.status, 200);
        assert.equal(res.json().content[0].text, 'from-secondary');
        assert.match(proxy.output(), /Failover: PRIMARY → SECONDARY/);
    } finally {
        await proxy.stop();
        secondary.close();
    }
});

test('failover reports the second failure when both channels are down', { timeout: 20000 }, async () => {
    const deadPrimary = await getFreePort();
    const deadSecondary = await getFreePort();
    const proxy = await startProxy({
        PRIMARY_BASE_URL: `http://127.0.0.1:${deadPrimary}`,
        ENABLE_SECONDARY_API: 'true',
        SECONDARY_API_KEY: 'sk-secondary',
        SECONDARY_BASE_URL: `http://127.0.0.1:${deadSecondary}`
    });

    try {
        const res = await httpRequest({
            port: proxy.port, method: 'POST', path: '/v1/messages',
            headers: { 'Content-Type': 'application/json' },
            body: messageBody()
        });
        assert.equal(res.status, 502);
        assert.match(proxy.output(), /Failover: PRIMARY → SECONDARY/);
    } finally {
        await proxy.stop();
    }
});

test('reasoning_effort is downgraded once when the upstream rejects it', { timeout: 20000 }, async () => {
    const seen = [];
    const mock = await startMockUpstream((req, res, { json }) => {
        seen.push(json);
        if (json && json.reasoning_effort !== undefined) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning_effort' is not supported with this model.", type: 'invalid_request_error' } }));
            return;
        }
        respondOpenAiChat(res, 'degraded-ok');
    });
    const proxy = await startProxy({ PRIMARY_BASE_URL: mock.url });

    try {
        const res = await httpRequest({
            port: proxy.port, method: 'POST', path: '/v1/messages',
            headers: { 'Content-Type': 'application/json' },
            body: messageBody()
        });
        assert.equal(res.status, 200);
        assert.equal(res.json().content[0].text, 'degraded-ok');
        assert.equal(seen.length, 2, 'exactly one retry is expected');
        assert.ok(seen[0].reasoning_effort !== undefined, 'first attempt carries reasoning_effort');
        assert.equal(seen[1].reasoning_effort, undefined, 'retry drops reasoning_effort');
    } finally {
        await proxy.stop();
        mock.close();
    }
});

test('streaming conversion emits sequential thinking/text/tool blocks', { timeout: 30000 }, async () => {
    const mock = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const steps = [
            { id: 'c1', choices: [{ delta: { reasoning_content: 'thinking hard' }, finish_reason: null }] },
            { id: 'c1', choices: [{ delta: { content: 'hello ' }, finish_reason: null }] },
            { id: 'c1', choices: [{ delta: { content: 'world' }, finish_reason: null }] },
            { id: 'c1', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_abc', function: { name: 'get_weather' } }] }, finish_reason: null }] },
            { id: 'c1', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }, finish_reason: null }] },
            {
                id: 'c1',
                choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }, finish_reason: 'tool_calls' }],
                usage: { prompt_tokens: 11, completion_tokens: 7 }
            }
        ];
        (async () => {
            for (const step of steps) {
                sse(res, step);
                await sleep(15);
            }
            res.write('data: [DONE]\n\n');
            res.end();
        })();
    });
    const proxy = await startProxy({ PRIMARY_BASE_URL: mock.url });

    try {
        const res = await httpRequest({
            port: proxy.port, method: 'POST', path: '/v1/messages',
            headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
            body: messageBody({ stream: true })
        });
        assert.equal(res.status, 200);
        const events = parseSse(res.text);

        assert.equal(events[0].event, 'message_start');
        assert.equal(events.at(-1).event, 'message_stop');
        assert.equal(events.at(-2).event, 'message_delta');

        const starts = events.filter(e => e.event === 'content_block_start').map(e => JSON.parse(e.data));
        assert.deepEqual(starts.map(b => b.content_block.type), ['thinking', 'text', 'tool_use']);
        assert.deepEqual(starts.map(b => b.index), [0, 1, 2]);
        assert.deepEqual(starts[2].content_block.input, {}, 'tool_use start must carry an empty input object');

        let open = 0;
        for (const event of events) {
            if (event.event === 'content_block_start') open++;
            if (event.event === 'content_block_stop') open--;
            assert.ok(open <= 1, `blocks must not interleave, saw ${open} open blocks`);
        }
        assert.equal(open, 0, 'every block must be closed');

        const toolJson = events
            .filter(e => e.event === 'content_block_delta')
            .map(e => JSON.parse(e.data))
            .filter(d => d.index === 2)
            .map(d => d.delta.partial_json)
            .join('');
        assert.deepEqual(JSON.parse(toolJson), { city: 'Paris' });

        const messageDelta = JSON.parse(events.findLast(e => e.event === 'message_delta').data);
        assert.equal(messageDelta.delta.stop_reason, 'tool_use');
        assert.equal(messageDelta.usage.output_tokens, 7);
        assert.equal(messageDelta.usage.input_tokens, 11);
    } finally {
        await proxy.stop();
        mock.close();
    }
});

test('usage-only trailing chunk without a newline is still accounted', { timeout: 30000 }, async () => {
    const mock = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        (async () => {
            sse(res, { id: 'c1', choices: [{ delta: { content: 'hi' }, finish_reason: null }] });
            await sleep(15);
            sse(res, { id: 'c1', choices: [{ delta: {}, finish_reason: 'stop' }] });
            await sleep(15);
            // Usage arrives on a chunk without choices and without a trailing blank line
            res.write(`data: ${JSON.stringify({ id: 'c1', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3 } } })}`);
            res.end();
        })();
    });
    const proxy = await startProxy({ PRIMARY_BASE_URL: mock.url });

    try {
        const res = await httpRequest({
            port: proxy.port, method: 'POST', path: '/v1/messages',
            headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
            body: messageBody({ stream: true })
        });
        const events = parseSse(res.text);
        const messageDelta = JSON.parse(events.findLast(e => e.event === 'message_delta').data);
        assert.equal(messageDelta.usage.output_tokens, 5);
        assert.equal(messageDelta.usage.input_tokens, 10);
        assert.equal(messageDelta.usage.cache_read_input_tokens, 3);
        assert.equal(messageDelta.delta.stop_reason, 'end_turn');
    } finally {
        await proxy.stop();
        mock.close();
    }
});

test('idle upstream is aborted by the idle watchdog', { timeout: 30000 }, async () => {
    const mock = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': req.url.includes('chat') ? 'application/json' : 'text/event-stream' });
        res.flushHeaders();
        // Never send a body → the proxy must abort on its own
    });
    const proxy = await startProxy({ PRIMARY_BASE_URL: mock.url, PROXY_IDLE_TIMEOUT_MS: '300' });

    try {
        const nonStream = await httpRequest({
            port: proxy.port, method: 'POST', path: '/v1/messages',
            headers: { 'Content-Type': 'application/json' },
            body: messageBody()
        });
        assert.equal(nonStream.status, 504);
        assert.match(nonStream.json().error.message, /timed out/i);

        const started = Date.now();
        const stream = await httpRequest({
            port: proxy.port, method: 'POST', path: '/v1/messages',
            headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
            body: messageBody({ stream: true })
        });
        assert.ok(Date.now() - started < 5000, 'stream must not hang forever');
        assert.match(stream.text, /message_stop/);
        assert.equal(proxy.exitInfo(), null, 'proxy must survive an idle upstream');
        assert.ok(!proxy.output().includes('Unhandled promise rejection'), 'the idle abort must not leak rejections');
    } finally {
        await proxy.stop();
        mock.close();
    }
});

test('client disconnect cancels the upstream stream', { timeout: 30000 }, async () => {
    let upstreamClosedAt = null;
    const mock = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.on('close', () => { upstreamClosedAt = Date.now(); });
        const timer = setInterval(() => {
            sse(res, { id: 'c1', choices: [{ delta: { content: 'x' }, finish_reason: null }] });
        }, 100);
        res.on('close', () => clearInterval(timer));
    });
    const proxy = await startProxy({ PRIMARY_BASE_URL: mock.url });

    try {
        const body = Buffer.from(messageBody({ stream: true }), 'utf8');
        const head = Buffer.from(
            `POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1:${proxy.port}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n`,
            'latin1'
        );
        const socket = net.connect(proxy.port, '127.0.0.1');
        await new Promise(resolve => socket.on('connect', resolve));
        socket.write(Buffer.concat([head, body]));
        await new Promise(resolve => socket.once('data', resolve));
        const abortedAt = Date.now();
        socket.destroy();

        const cancelled = await waitFor(() => Promise.resolve(upstreamClosedAt !== null), 3000);
        assert.ok(cancelled, 'upstream stream must be cancelled after the client goes away');
        assert.ok(upstreamClosedAt - abortedAt < 2000, 'cancellation must happen promptly');
        assert.equal(proxy.exitInfo(), null, 'proxy must survive a client abort');
        assert.match(proxy.output(), /Client disconnected/, 'the abort must be logged as a client disconnect');
        assert.ok(!proxy.output().includes('Upstream idle'), 'a client abort must not be reported as an upstream idle timeout');
        assert.ok(!proxy.output().includes('Unhandled promise rejection'), 'the abort path must not leak rejections');
    } finally {
        await proxy.stop();
        mock.close();
    }
});

test('handles concurrent streaming and non-streaming requests', { timeout: 30000 }, async () => {
    const mock = await startMockUpstream((req, res, { json }) => {
        const lastContent = json?.messages?.at(-1)?.content;
        if (json && json.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            for (const ch of String(lastContent)) {
                sse(res, { id: 'c1', choices: [{ delta: { content: ch }, finish_reason: null }] });
            }
            sse(res, { id: 'c1', choices: [{ delta: {}, finish_reason: 'stop' }] });
            res.write('data: [DONE]\n\n');
            res.end();
            return;
        }
        respondOpenAiChat(res, `echo:${lastContent}`);
    });
    const proxy = await startProxy({ PRIMARY_BASE_URL: mock.url });
    const headers = { 'Content-Type': 'application/json' };

    try {
        const nonStreamJobs = Array.from({ length: 6 }, (_, i) => httpRequest({
            port: proxy.port, method: 'POST', path: '/v1/messages', headers,
            body: messageBody({ messages: [{ role: 'user', content: `plain-${i}` }] })
        }));
        const streamJobs = Array.from({ length: 3 }, (_, i) => httpRequest({
            port: proxy.port, method: 'POST', path: '/v1/messages', headers: { ...headers, Accept: 'text/event-stream' },
            body: messageBody({ stream: true, messages: [{ role: 'user', content: `stream-${i}` }] })
        }));

        const nonStream = await Promise.all(nonStreamJobs);
        const streams = await Promise.all(streamJobs);

        nonStream.forEach((res, i) => {
            assert.equal(res.status, 200);
            assert.equal(res.json().content[0].text, `echo:plain-${i}`, 'responses must not be mixed up between requests');
        });
        streams.forEach((res, i) => {
            const text = parseSse(res.text)
                .filter(e => e.event === 'content_block_delta')
                .map(e => JSON.parse(e.data))
                .filter(d => d.delta.type === 'text_delta')
                .map(d => d.delta.text)
                .join('');
            assert.equal(text, `stream-${i}`, 'streams must not be mixed up between requests');
        });
        assert.equal(proxy.exitInfo(), null, 'proxy must survive concurrent traffic');
    } finally {
        await proxy.stop();
        mock.close();
    }
});

test('idle watchdog can be disabled with 0', { timeout: 30000 }, async () => {
    const mock = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        let i = 0;
        const timer = setInterval(() => {
            i++;
            if (i <= 4) {
                sse(res, { id: 'c1', choices: [{ delta: { content: 'x' }, finish_reason: null }] });
            } else {
                clearInterval(timer);
                sse(res, { id: 'c1', choices: [{ delta: {}, finish_reason: 'stop' }] });
                res.write('data: [DONE]\n\n');
                res.end();
            }
        }, 250);
        res.on('close', () => clearInterval(timer));
    });
    const proxy = await startProxy({ PRIMARY_BASE_URL: mock.url, PROXY_IDLE_TIMEOUT_MS: '0' });

    try {
        const res = await httpRequest({
            port: proxy.port, method: 'POST', path: '/v1/messages',
            headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
            body: messageBody({ stream: true })
        });
        assert.equal(res.status, 200);
        assert.match(res.text, /message_stop/, 'a slow but healthy stream must complete when the watchdog is off');
        assert.ok(!proxy.output().includes('Upstream idle'), 'the idle watchdog must stay disabled');
    } finally {
        await proxy.stop();
        mock.close();
    }
});

test('tolerates CRLF framing, data without a space and comment lines', { timeout: 30000 }, async () => {
    const mock = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(': keepalive\r\n');
        res.write('data:{"id":"c1","choices":[{"delta":{"content":"crlf "},"finish_reason":null}]}\r\n\r\n');
        res.write('data:{"id":"c1","choices":[{"delta":{"content":"works"},"finish_reason":"stop"}]}\r\n\r\n');
        res.write('data: [DONE]\r\n\r\n');
        res.end();
    });
    const proxy = await startProxy({ PRIMARY_BASE_URL: mock.url });

    try {
        const res = await httpRequest({
            port: proxy.port, method: 'POST', path: '/v1/messages',
            headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
            body: messageBody({ stream: true })
        });
        assert.equal(res.status, 200);
        const text = parseSse(res.text)
            .filter(e => e.event === 'content_block_delta')
            .map(e => JSON.parse(e.data))
            .filter(d => d.delta.type === 'text_delta')
            .map(d => d.delta.text)
            .join('');
        assert.equal(text, 'crlf works');
        assert.match(res.text, /message_stop/);
        assert.ok(!proxy.output().includes('SSE Parse failed'), 'no chunk may fail to parse');
    } finally {
        await proxy.stop();
        mock.close();
    }
});

test('startup fails fast on an invalid PORT and warns on an invalid timeout', { timeout: 30000 }, async () => {
    const invalid = spawn(process.execPath, [PROXY_PATH], {
        env: { ...process.env, PORT: 'not-a-port', PROXY_LANG: 'en' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    invalid.stdout.on('data', d => { output += d; });
    invalid.stderr.on('data', d => { output += d; });
    const exitCode = await new Promise(resolve => invalid.on('exit', code => resolve(code)));
    assert.equal(exitCode, 1);
    assert.match(output, /Invalid PORT/);

    const mock = await startMockUpstream((req, res) => respondOpenAiChat(res));
    const tolerant = await startProxy({ PRIMARY_BASE_URL: mock.url, PROXY_TIMEOUT_MS: 'not-a-number' });
    try {
        assert.match(tolerant.output(), /Invalid PROXY_TIMEOUT_MS/);
        const res = await httpRequest({
            port: tolerant.port, method: 'POST', path: '/v1/messages',
            headers: { 'Content-Type': 'application/json' },
            body: messageBody()
        });
        assert.equal(res.status, 200);
    } finally {
        await tolerant.stop();
        mock.close();
    }
});

test('graceful shutdown closes long-lived streams', {
    timeout: 30000,
    skip: process.platform === 'win32' ? 'Windows terminates on SIGTERM without running JS handlers' : false
}, async () => {
    const mock = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const timer = setInterval(() => {
            sse(res, { id: 'c1', choices: [{ delta: { content: 'x' }, finish_reason: null }] });
        }, 100);
        res.on('close', () => clearInterval(timer));
    });
    const proxy = await startProxy({ PRIMARY_BASE_URL: mock.url });

    try {
        const body = Buffer.from(messageBody({ stream: true }), 'utf8');
        const head = Buffer.from(
            `POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1:${proxy.port}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n`,
            'latin1'
        );
        const socket = net.connect(proxy.port, '127.0.0.1');
        await new Promise(resolve => socket.on('connect', resolve));
        socket.write(Buffer.concat([head, body]));
        await new Promise(resolve => socket.once('data', resolve));

        proxy.proc.kill('SIGTERM');
        const exit = await proxy.expectExit(9000);
        assert.equal(exit.code, 0, `expected a clean exit, got ${JSON.stringify(exit)}`);
        socket.destroy();
    } finally {
        await proxy.stop();
        mock.close();
    }
});
