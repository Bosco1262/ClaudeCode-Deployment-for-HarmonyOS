import http from 'node:http';
import crypto from 'node:crypto';

// ╔══════════════════════════════════════════════════════════════╗
// ║ 1. Core Config Loading (Primary/Backup API Keys & Endpoints) ║
// ║ 1. 核心配置读取 (主、备 API 密钥与端点)                         ║
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

// ▸ Optional shared token, Origin/Host allowlists and feature flags
// ▸ 可选的共享访问令牌、来源/主机白名单与特性开关
const PROXY_AUTH_TOKEN_RAW = process.env.PROXY_AUTH_TOKEN;
const ALLOWED_ORIGINS_RAW  = process.env.ALLOWED_ORIGINS;
const ALLOWED_HOSTS_RAW    = process.env.ALLOWED_HOSTS;
const STREAM_INCLUDE_USAGE = process.env.STREAM_INCLUDE_USAGE === 'true';
const CONVERT_PDF_TO_FILE  = process.env.CONVERT_PDF_TO_FILE === 'true';

// ╔══════════════════════════════════════════════════════════════╗
// ║ 2. Language Resolution & Message Catalog                     ║
// ║ 2. 语言解析与消息文案                                        ║
// ╚══════════════════════════════════════════════════════════════╝

// ▸ Language priority: explicit CLI/env option → system locale → English fallback
// ▸ 语言优先级：显式 CLI/环境变量参数 → 系统语言 → 英语兜底

const LANGUAGE_ALIASES = { en: 'en', zh: 'zh-CN' };

// ▸ Normalize a locale tag (e.g. zh_CN.UTF-8 → zh-CN) to a supported language
// ▸ 将区域标签 (如 zh_CN.UTF-8 → zh-CN) 归一化为受支持的语言
function normalizeLanguage(tag) {
    if (!tag || typeof tag !== 'string') return null;
    const primary = tag.toLowerCase().trim().split('.')[0].split('@')[0].split(/[-_]/)[0];
    return LANGUAGE_ALIASES[primary] || null;
}

// ▸ Parse CLI options: -l / --lang / --language (space or = form)
// ▸ 解析 CLI 选项：-l / --lang / --language（空格或 = 形式）
function parseCliArgs(argv) {
    const options = { langValue: null, help: false, error: null };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];

        if (arg === '-h' || arg === '--help') {
            options.help = true;
            continue;
        }

        const longMatch = arg.match(/^--(?:lang|language)(?:=(.*))?$/);
        if (arg === '-l' || (longMatch && longMatch[1] === undefined)) {
            const value = argv[i + 1];
            if (!value || value.startsWith('-')) {
                options.error = { key: 'cli.missingValue', vars: { flag: arg } };
                return options;
            }
            options.langValue = value;
            i++;
            continue;
        }

        if (longMatch) {
            if (!longMatch[1]) {
                options.error = { key: 'cli.missingValue', vars: { flag: arg.split('=')[0] } };
                return options;
            }
            options.langValue = longMatch[1];
            continue;
        }

        options.error = { key: 'cli.unknownOption', vars: { arg } };
        return options;
    }

    return options;
}

// ▸ Resolve the output language with the fixed priority chain
// ▸ 按固定优先级链解析输出语言
function resolveLanguage(cliValue) {
    // 1. Explicit manual parameter: CLI option (--lang / --language / -l)
    // 1. 显式手动参数：CLI 选项 (--lang / --language / -l)
    if (cliValue) {
        const lang = normalizeLanguage(cliValue);
        if (lang) return { lang, source: 'cli' };
        return { lang: 'en', source: 'fallback', rejected: { value: cliValue, source: 'cli' } };
    }

    // 2. Explicit manual parameter: environment variable (e.g. container runtime)
    // 2. 显式手动参数：环境变量 (如容器运行时)
    const envValue = process.env.PROXY_LANG;
    if (envValue) {
        const lang = normalizeLanguage(envValue);
        if (lang) return { lang, source: 'env' };
        return { lang: 'en', source: 'fallback', rejected: { value: envValue, source: 'env' } };
    }

    // 3. Auto-detection: system locale variables, then the runtime locale
    // 3. 自动检测：系统语言变量，其次为运行时区域设置
    for (const candidate of [process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG]) {
        const lang = normalizeLanguage(candidate);
        if (lang) return { lang, source: 'system' };
    }
    try {
        const lang = normalizeLanguage(Intl.DateTimeFormat().resolvedOptions().locale);
        if (lang) return { lang, source: 'system' };
    } catch (_) { /* Intl unavailable, continue to the fallback */
                   /* Intl 不可用，继续走英语兜底 */ }

    // 4. English is the guaranteed fallback
    // 4. 英语为最终兜底
    return { lang: 'en', source: 'fallback' };
}

const cliOptions = parseCliArgs(process.argv.slice(2));
const languageSelection = resolveLanguage(cliOptions.langValue);
const LANG = languageSelection.lang;

const MESSAGES = {
    en: {
        'source.cli': '--lang option',
        'source.env': 'PROXY_LANG env var',
        'source.system': 'system locale',
        'source.fallback': 'English fallback',
        'startup.language': '[Startup] Output language: {lang} (source: {source})',
        'startup.listening': '[Startup] Listening on http://127.0.0.1:{port}',
        'startup.invalidEnv': '[Warning] Invalid {name} value ("{value}"), using {fallback}',
        'startup.invalidPort': '[Error] Invalid PORT "{value}": expected an integer between 1 and 65535',
        'startup.noKey': '[Warning] No API key configured for the {channel} channel; requests routed there will fail',
        'startup.accessPolicy': '[Startup] Access policy: origins={origins} | token={token}',
        'startup.shuttingDown': '[Shutdown] Stopping server...',
        'startup.listenFailed': '[Error] Failed to listen on 127.0.0.1:{port}: {detail}',
        'lang.unsupported': '[Warning] Unsupported language "{value}" ({source}), using English instead',
        'cli.unknownOption': 'Unknown option: {arg}',
        'cli.missingValue': 'Missing value for {flag}',
        'help.text': [
            'Usage: node anthropic-proxy.mjs [options]',
            '',
            'Options:',
            '  -l, --lang, --language <lang>  Output language: en | zh-CN',
            '                                 (default: system locale, English fallback)',
            '  -h, --help                     Show this help',
            '',
            'Environment variables:',
            '  PROXY_LANG                     Explicit output language (same as --lang)',
            '  PORT                           Listening port (default: 4000)',
            '  PROXY_TIMEOUT_MS               Connect/response-header timeout in ms (default: 300000)',
            '  PROXY_IDLE_TIMEOUT_MS          Upstream idle timeout in ms, 0 disables it (default: 120000)',
            '  MAX_BODY_BYTES                 Maximum request body size in bytes (default: 67108864)',
            '  PROXY_AUTH_TOKEN               Optional shared token required from clients',
            '  ALLOWED_ORIGINS                Comma-separated Origin allowlist, * disables the check',
            '  ALLOWED_HOSTS                  Comma-separated Host allowlist, * disables the check',
            '  STREAM_INCLUDE_USAGE           true: request token usage in OpenAI streams (default: false)',
            '  CONVERT_PDF_TO_FILE            true: map base64 documents to file parts (default: false)',
        ].join('\n'),
        'log.error': '[Error] HTTP {status} ({type}): {message}',
        'log.route': 'Route: {channel} API ({format}) | client={client} → upstream={upstream} | stream={stream} | thinking={thinking}',
        'log.anthropicUpstreamFailed': 'Anthropic Upstream Failed: {detail}',
        'log.upstreamModel': 'OpenAI Upstream model={model}',
        'log.openaiConnFailed': 'OpenAI Connection failed: {detail}',
        'log.retryRemove': 'Retry reasoning_effort rejected, removing',
        'log.retryDowngrade': 'Retry reasoning_effort: max → high',
        'log.retryConnFailed': 'OpenAI Retry Connection failed: {detail}',
        'log.retryOk': 'OpenAI Retry OK HTTP {status}',
        'log.failover': 'Failover: {from} → {to} (HTTP {reason})',
        'log.sseParseFailed': 'SSE Parse failed: {detail}',
        'log.streamDone': 'Stream done | in={in} out={out} cache_read={cache} | {ms}ms',
        'log.streamAborted': 'Stream Aborted: {detail}',
        'log.idleAbort': 'Upstream idle for {ms}ms, aborting',
        'log.clientAbort': 'Client disconnected, cancelling the upstream request',
        'log.nonStreamDone': 'Non-stream done | in={in} out={out} | {ms}ms',
        'log.countTokensEstimate': 'Token count estimated locally: {tokens}',
        'log.countTokensFallback': 'Upstream count_tokens unsupported (HTTP {status}), using the local estimate',
        'log.droppedPart': 'Dropped unsupported content part: {type} ({where})',
        'log.documentOmitted': 'Base64 document omitted (set CONVERT_PDF_TO_FILE=true to forward it): {title}',
        'log.fatal': 'Fatal: {detail}',
        'log.unhandledRejection': 'Unhandled promise rejection (the request keeps running): {detail}',
        'error.invalidJson': 'Invalid JSON body',
        'error.routeNotFound': 'Route not supported',
        'error.brokenStream': 'Response stream was broken',
        'error.emptyChoice': 'Upstream returned an empty response choice',
        'error.invalidModel': 'model must be a string',
        'error.bodyTooLarge': 'Request body exceeds the {limit}-byte limit',
        'error.originRejected': 'Cross-origin request rejected by the access policy',
        'error.hostRejected': 'Request host "{host}" is not allowed by the access policy',
        'error.unauthorized': 'Missing or invalid proxy access token',
        'error.keyMissing': 'No API key configured for the {channel} channel',
        'error.upstreamTimeout': 'Upstream timed out: {detail}',
        'error.directUpstream': 'Direct upstream error: {detail}',
        'error.directUnreachable': 'Failed to reach the direct upstream node: {detail}',
        'error.relayUnreachable': 'Relay network unreachable: {detail}',
        'error.upstreamRejected': 'Upstream server rejected the request: {detail}',
        'error.gatewayCrash': 'Gateway core crash: {detail}',
    },
    'zh-CN': {
        'source.cli': '--lang 参数',
        'source.env': 'PROXY_LANG 环境变量',
        'source.system': '系统语言',
        'source.fallback': '英语兜底',
        'startup.language': '[启动] 输出语言: {lang}（来源: {source}）',
        'startup.listening': '[启动] 正在监听 http://127.0.0.1:{port}',
        'startup.invalidEnv': '[警告] {name} 的值非法（"{value}"），已改用 {fallback}',
        'startup.invalidPort': '[错误] PORT 非法（"{value}"）：应为 1-65535 之间的整数',
        'startup.noKey': '[警告] {channel} 通道未配置 API 密钥，路由到该通道的请求将失败',
        'startup.accessPolicy': '[启动] 访问策略: 来源={origins} | 令牌={token}',
        'startup.shuttingDown': '[关闭] 正在停止服务...',
        'startup.listenFailed': '[错误] 无法监听 127.0.0.1:{port}：{detail}',
        'lang.unsupported': '[警告] 不支持的语言 "{value}"（{source}），已改用英语',
        'cli.unknownOption': '未知选项: {arg}',
        'cli.missingValue': '{flag} 缺少参数值',
        'help.text': [
            '用法: node anthropic-proxy.mjs [选项]',
            '',
            '选项:',
            '  -l, --lang, --language <语言>  输出语言: en | zh-CN',
            '                                 （默认：系统语言，英语兜底）',
            '  -h, --help                     显示此帮助',
            '',
            '环境变量:',
            '  PROXY_LANG                     显式指定输出语言（等同于 --lang）',
            '  PORT                           监听端口（默认 4000）',
            '  PROXY_TIMEOUT_MS               连接/响应头超时毫秒数（默认 300000）',
            '  PROXY_IDLE_TIMEOUT_MS          上游空闲超时毫秒数，0 表示关闭（默认 120000）',
            '  MAX_BODY_BYTES                 请求体大小上限（字节，默认 67108864）',
            '  PROXY_AUTH_TOKEN               可选的客户端共享访问令牌',
            '  ALLOWED_ORIGINS                来源白名单，逗号分隔，* 表示关闭校验',
            '  ALLOWED_HOSTS                  主机白名单，逗号分隔，* 表示关闭校验',
            '  STREAM_INCLUDE_USAGE           true: 在 OpenAI 流式请求中索取用量（默认 false）',
            '  CONVERT_PDF_TO_FILE            true: 将 base64 文档映射为 file 块（默认 false）',
        ].join('\n'),
        'log.error': '[错误] HTTP {status} ({type}): {message}',
        'log.route': '路由: {channel} API ({format}) | 客户端={client} → 上游={upstream} | 流式={stream} | 思考={thinking}',
        'log.anthropicUpstreamFailed': 'Anthropic 上游请求失败: {detail}',
        'log.upstreamModel': 'OpenAI 上游模型={model}',
        'log.openaiConnFailed': 'OpenAI 连接失败: {detail}',
        'log.retryRemove': 'reasoning_effort 被拒绝，移除该参数后重试',
        'log.retryDowngrade': '重试 reasoning_effort: max → high',
        'log.retryConnFailed': 'OpenAI 重试连接失败: {detail}',
        'log.retryOk': 'OpenAI 重试成功 HTTP {status}',
        'log.failover': '通道故障转移: {from} → {to}（HTTP {reason}）',
        'log.sseParseFailed': 'SSE 解析失败: {detail}',
        'log.streamDone': '流式完成 | in={in} out={out} cache_read={cache} | {ms}ms',
        'log.streamAborted': '流式响应中断: {detail}',
        'log.idleAbort': '上游空闲超过 {ms}ms，已中止',
        'log.clientAbort': '客户端已断开，正在取消上游请求',
        'log.nonStreamDone': '非流式完成 | in={in} out={out} | {ms}ms',
        'log.countTokensEstimate': '本地估算 Token 数: {tokens}',
        'log.countTokensFallback': '上游不支持 count_tokens（HTTP {status}），改用本地估算',
        'log.droppedPart': '已丢弃不受支持的内容块: {type}（{where}）',
        'log.documentOmitted': '已忽略 base64 文档（设 CONVERT_PDF_TO_FILE=true 可转发）: {title}',
        'log.fatal': '致命错误: {detail}',
        'log.unhandledRejection': '未捕获的 Promise 异常（该请求继续执行）: {detail}',
        'error.invalidJson': '请求体不是合法的 JSON',
        'error.routeNotFound': '不支持的路由',
        'error.brokenStream': '上游响应流已中断',
        'error.emptyChoice': '上游返回了空的响应选择',
        'error.invalidModel': 'model 必须是字符串',
        'error.bodyTooLarge': '请求体超过 {limit} 字节上限',
        'error.originRejected': '跨来源请求被访问策略拒绝',
        'error.hostRejected': '请求 Host "{host}" 不被访问策略允许',
        'error.unauthorized': '缺少或无效的代理访问令牌',
        'error.keyMissing': '{channel} 通道未配置 API 密钥',
        'error.upstreamTimeout': '上游超时: {detail}',
        'error.directUpstream': '直连平台处理错: {detail}',
        'error.directUnreachable': '无法连接上游直连节点: {detail}',
        'error.relayUnreachable': '中转网络失联: {detail}',
        'error.upstreamRejected': '上游服务器拒绝处理: {detail}',
        'error.gatewayCrash': '网关系统发生核心崩溃: {detail}',
    }
};

// ▸ Translate a message key, falling back to English when a key is missing
// ▸ 翻译消息 key，缺失条目回退为英语
function t(key, vars) {
    const template = (MESSAGES[LANG] && MESSAGES[LANG][key]) || MESSAGES.en[key] || key;
    if (!vars) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match);
}

if (cliOptions.error) {
    console.error(t(cliOptions.error.key, cliOptions.error.vars));
    console.error('');
    console.error(t('help.text'));
    process.exit(1);
}

if (cliOptions.help) {
    console.log(t('help.text'));
    process.exit(0);
}

if (languageSelection.rejected) {
    log(t('lang.unsupported', { value: languageSelection.rejected.value, source: t('source.' + languageSelection.rejected.source) }));
}

log(t('startup.language', { lang: LANG, source: t('source.' + languageSelection.source) }));

// ╔══════════════════════════════════════════════════════════════╗
// ║ 3. Environment Validation & Access Policy                    ║
// ║ 3. 环境校验与访问策略                                         ║
// ╚══════════════════════════════════════════════════════════════╝

const PROXY_TIMEOUT_MS      = readIntEnv('PROXY_TIMEOUT_MS', 300000);
const PROXY_IDLE_TIMEOUT_MS = readIntEnv('PROXY_IDLE_TIMEOUT_MS', 120000, { allowZero: true });
const MAX_BODY_BYTES        = readIntEnv('MAX_BODY_BYTES', 64 * 1024 * 1024);
const PORT                  = resolvePort(process.env.PORT);

const accessPolicy = buildAccessPolicy(PROXY_AUTH_TOKEN_RAW, ALLOWED_ORIGINS_RAW, ALLOWED_HOSTS_RAW);

log(t('startup.accessPolicy', {
    origins: accessPolicy.allowAnyOrigin ? '*' : (accessPolicy.origins.length > 0 ? accessPolicy.origins.join(', ') : 'localhost/loopback only'),
    token: accessPolicy.token ? 'required' : 'disabled'
}));

if (!PRIMARY_KEY) {
    log(t('startup.noKey', { channel: 'PRIMARY' }));
}
if (ENABLE_SECONDARY && !SECONDARY_KEY) {
    log(t('startup.noKey', { channel: 'SECONDARY' }));
}

// ╔══════════════════════════════════════════════════════════════╗
// ║ 4. Model Slot Matrix (4 Slots × Dual API Channels)          ║
// ║ 4. 模型槽位矩阵 (4槽位 × 主备双 API)                           ║
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

// ╔══════════════════════════════════════════════════════════════╗
// ║ 5. Utility Functions                                         ║
// ║ 5. 工具函数                                                   ║
// ╚══════════════════════════════════════════════════════════════╝

function log(msg) {
    console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

let _requestCounter = 0;
function nextRequestId() {
    return `req_${++_requestCounter}_${Date.now()}`;
}

// ▸ Parse a positive integer env var, warning and falling back when invalid
// ▸ 解析正整数环境变量，非法时警告并回退默认值
function readIntEnv(name, fallback, options = {}) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number.parseInt(raw, 10);
    const valid = Number.isInteger(value) && (options.allowZero ? value >= 0 : value > 0);
    if (!valid) {
        log(t('startup.invalidEnv', { name, value: raw, fallback }));
        return fallback;
    }
    return value;
}

// ▸ Resolve the listening port, failing fast on an invalid value
// ▸ 解析监听端口，非法值直接快速失败
function resolvePort(raw) {
    if (raw === undefined || raw === '') return 4000;
    const value = Number.parseInt(raw, 10);
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
        console.error(t('startup.invalidPort', { value: raw }));
        process.exit(1);
    }
    return value;
}

// ▸ Build the Origin/Host/token access policy (empty lists = localhost only)
// ▸ 构建来源/主机/令牌访问策略（空列表 = 仅本机）
const LOCAL_ORIGIN_PATTERNS = [
    'http://localhost', 'https://localhost', 'http://localhost:*', 'https://localhost:*',
    'http://127.0.0.1', 'https://127.0.0.1', 'http://127.0.0.1:*', 'https://127.0.0.1:*',
    'http://[::1]', 'https://[::1]', 'http://[::1]:*', 'https://[::1]:*'
];

function buildAccessPolicy(tokenRaw, originsRaw, hostsRaw) {
    const token = (tokenRaw || '').trim();
    const origins = (originsRaw || '').trim();
    const hosts = (hostsRaw || '').trim();
    const split = value => value.split(',').map(entry => entry.trim()).filter(Boolean);
    return {
        token,
        allowAnyOrigin: origins === '*',
        allowAnyHost: hosts === '*',
        customOrigins: Boolean(origins) && origins !== '*',
        customHosts: Boolean(hosts) && hosts !== '*',
        origins: origins && origins !== '*' ? split(origins) : [],
        hosts: hosts && hosts !== '*' ? split(hosts) : []
    };
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ▸ Exact (case-insensitive) or '*' wildcard matching for a single entry
// ▸ 单条目的精确匹配（忽略大小写）或 '*' 通配匹配
function wildcardMatch(pattern, value) {
    if (!pattern.includes('*')) return pattern.toLowerCase() === value.toLowerCase();
    const re = new RegExp('^' + pattern.split('*').map(escapeRegExp).join('.*') + '$', 'i');
    return re.test(value);
}

function originAllowed(origin) {
    if (accessPolicy.allowAnyOrigin) return true;
    const list = accessPolicy.customOrigins ? accessPolicy.origins : LOCAL_ORIGIN_PATTERNS;
    return list.some(pattern => wildcardMatch(pattern, origin));
}

function hostAllowed(hostHeader) {
    if (accessPolicy.allowAnyHost) return true;
    const host = (hostHeader || '').toLowerCase();
    if (!host) return false;
    if (accessPolicy.customHosts) return accessPolicy.hosts.some(pattern => wildcardMatch(pattern, host));
    let name;
    if (host.startsWith('[')) {
        const end = host.indexOf(']');
        name = end >= 0 ? host.slice(1, end) : host;
    } else {
        name = host.split(':')[0];
    }
    return name === 'localhost' || name === '127.0.0.1' || name === '::1';
}

// ▸ Constant-time comparison to avoid leaking the token byte by byte
// ▸ 常量时间比较，避免逐字节泄露令牌
function safeEqual(a, b) {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
}

function extractToken(req) {
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
    const key = req.headers['x-api-key'];
    if (typeof key === 'string' && key) return key.trim();
    return '';
}

// ▸ Access guard: Host always, Origin for browser clients, token when configured
// ▸ 访问守卫：始终校验 Host，浏览器请求校验 Origin，配置令牌时校验令牌
function checkAccess(req) {
    if (!hostAllowed(req.headers.host)) {
        return { status: 403, key: 'error.hostRejected', vars: { host: req.headers.host || '' } };
    }
    const origin = req.headers.origin;
    if (origin && !originAllowed(origin)) {
        return { status: 403, key: 'error.originRejected' };
    }
    if (accessPolicy.token) {
        const provided = extractToken(req);
        if (!provided || !safeEqual(provided, accessPolicy.token)) {
            return { status: 401, key: 'error.unauthorized' };
        }
    }
    return null;
}

// ▸ CORS headers echoed back only for allowed Origins (never a wildcard)
// ▸ 仅对白名单来源回显 CORS 头（绝不使用通配符）
function corsHeaders(req) {
    const origin = req.headers.origin;
    if (!origin) return {};
    return { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' };
}

// ▸ Watchdog: a single AbortController whose timer can be re-armed per phase
// ▸ 看门狗：单个 AbortController，计时器可按阶段重新布防
function createDeadline(ms) {
    const controller = new AbortController();
    let timer = null;
    const arm = (duration) => {
        if (timer) clearTimeout(timer);
        timer = duration > 0 ? setTimeout(() => controller.abort(), duration) : null;
    };
    const clear = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    };
    arm(ms);
    return { controller, arm, clear };
}

function sendAnthropicError(res, status, message, extraHeaders) {
    // Guard against double writeHead (e.g. streaming already started, then error)
    // 防止二次写入响应头（如流式已开始后再报错）
    if (res.headersSent) return;

    // Map HTTP status code to Anthropic standard error.type
    // 根据状态码映射 Anthropic 标准 error.type
    let errorType = 'api_error';
    if (status === 400 || status === 413) errorType = 'invalid_request_error';
    else if (status === 401 || status === 403) errorType = 'authentication_error';
    else if (status === 404) errorType = 'not_found_error';
    else if (status === 429) errorType = 'rate_limit_error';
    else if (status === 503 || status === 529) errorType = 'overloaded_error';

    log(t('log.error', { status, type: errorType, message }));
    res.writeHead(status, { 'Content-Type': 'application/json', ...(extraHeaders || {}) });
    res.end(JSON.stringify({
        type: "error",
        error: { type: errorType, message: message }
    }));
}

// ▸ Detect if upstream rejects due to unsupported reasoning_effort parameter
// ▸ 检测上游是否因不支持 reasoning_effort 参数而报错
function isReasoningEffortError(errorText) {
    const lower = errorText.toLowerCase();
    // Only trigger when the error actually mentions the reasoning_effort parameter,
    // avoiding false matches on generic errors (e.g. invalid parameter: model)
    //
    // 仅当错误确实提到 reasoning_effort 参数时才触发，
    // 避免误匹配通用错误（如 invalid parameter: model）
    return lower.includes('reasoning_effort') ||
           lower.includes('reasoning effort');
}

// ▸ Only retry another channel on transport failures, throttling or 5xx
// ▸ 仅在传输失败、限流或 5xx 时尝试另一通道
function isFailoverStatus(status) {
    return status === 429 || status >= 500;
}

// ▸ Read the request body as raw Buffers (never decode per chunk, which would
// ▸ corrupt multi-byte characters split across socket reads) and enforce the cap
// ▸ 以原始 Buffer 收集请求体（绝不逐块解码，否则跨读边界的多字节字符会损坏）并执行大小上限
async function readJsonBody(req) {
    const chunks = [];
    let received = 0;
    let tooLarge = false;

    try {
        await new Promise((resolve, reject) => {
            req.on('data', chunk => {
                received += chunk.length;
                if (received > MAX_BODY_BYTES) {
                    tooLarge = true;
                    resolve();          // Answer right away, do not wait for the rest of the upload
                                        // 立即作答，不再等待剩余上传
                    return;
                }
                chunks.push(chunk);
            });
            req.on('end', resolve);
            req.on('error', reject);
        });
    } catch (_) {
        // Client aborted while uploading; nothing useful to answer
        // 客户端上传中断；无需作答
        return { ok: false, aborted: true };
    }

    if (tooLarge) return { ok: false, tooLarge: true };

    try {
        return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
    } catch (_) {
        return { ok: false, tooLarge: false };
    }
}

// ▸ Model routing strategy: exact match → longest fuzzy match → fallback to default slot
// ▸ 模型路由策略：精确匹配 → 最长模糊匹配 → 兜底默认槽位
function findSlot(requestedModel) {
    const modelName = String(requestedModel).toLowerCase().trim();

    // 1. Exact match against Zsh-declared mapping names
    // 1. 精确匹配 Zsh 声明出来的映射名
    let slot = slots.find(s => s.client === modelName);

    // 2. Fuzzy adaptive recognition, prioritize longest (most precise) match
    // 2. 模糊自适应识别，优先最长 (最精确) 匹配
    if (!slot) {
        const candidates = slots.filter(s => modelName.includes(s.client) || s.client.includes(modelName));
        if (candidates.length > 0) {
            candidates.sort((a, b) => b.client.length - a.client.length);
            slot = candidates[0];
        }
    }

    // 3. Fallback to slot 1
    // 3. 兜底匹配槽位 1
    return slot || slots[0];
}

// ▸ Build a route for one specific API channel
// ▸ 针对某个具体 API 通道构建路由
function buildRoute(slot, channel) {
    const useSecondary = channel === 'SECONDARY';
    return {
        format:     useSecondary ? SECONDARY_FORMAT : PRIMARY_FORMAT,
        key:        useSecondary ? SECONDARY_KEY : PRIMARY_KEY,
        base:       useSecondary ? SECONDARY_BASE : PRIMARY_BASE,
        authType:   useSecondary ? SECONDARY_AUTH_TYPE : PRIMARY_AUTH_TYPE,
        targetModel: slot.target,
        reasoning:  slot.reasoning,
        name:       useSecondary ? 'SECONDARY' : 'PRIMARY'
    };
}

// ▸ Resolve the primary route plus an optional alternate channel for failover
// ▸ 解析主路由，并在启用备用通道时给出可用于故障转移的备用路由
function selectRoute(requestedModel) {
    const slot = findSlot(requestedModel);
    const primaryChannel = ENABLE_SECONDARY && slot.api === 'SECONDARY' ? 'SECONDARY' : 'PRIMARY';
    const alternateChannel = primaryChannel === 'PRIMARY' ? 'SECONDARY' : 'PRIMARY';
    const alternateKey = alternateChannel === 'SECONDARY' ? SECONDARY_KEY : PRIMARY_KEY;

    return {
        slot,
        route: buildRoute(slot, primaryChannel),
        alternateRoute: ENABLE_SECONDARY && alternateKey ? buildRoute(slot, alternateChannel) : null
    };
}

// ▸ Build upstream headers for the Anthropic pass-through protocol
// ▸ 为 Anthropic 直连透传协议构建上游请求头
function buildAnthropicHeaders(route, req) {
    const headers = {
        'Content-Type': 'application/json',
        'anthropic-version': req.headers['anthropic-version'] || '2023-06-01'
    };

    // Select Bearer or x-api-key based on auth type
    // 根据认证类型选择 Bearer 或 x-api-key
    if (req.headers['anthropic-beta']) {
        headers['anthropic-beta'] = req.headers['anthropic-beta'];
    }

    if (route.key) {
        if (route.authType === 'bearer') {
            headers['Authorization'] = `Bearer ${route.key}`;
            // OAuth Bearer auth requires the oauth beta flag; merge with client flags instead of overwriting
            // OAuth Bearer 认证需附带 oauth beta 标志；与客户端标志拼接而非覆盖
            if (!headers['anthropic-beta']) {
                headers['anthropic-beta'] = 'oauth-2025-04-20';
            } else if (!headers['anthropic-beta'].includes('oauth-2025-04-20')) {
                headers['anthropic-beta'] += ',oauth-2025-04-20';
            }
        } else {
            headers['x-api-key'] = route.key;
        }
    }

    if (req.headers['x-client-request-id']) {
        headers['x-client-request-id'] = req.headers['x-client-request-id'];
    }

    return headers;
}

// ▸ Tool ID normalization (bidirectional Anthropic ↔ OpenAI format conversion)
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

// ▸ Local token estimate for count_tokens when the upstream has no tokenizer
// ▸ 上游无分词器时用于 count_tokens 的本地 Token 估算
function estimateTokens(body) {
    let ascii = 0;
    let wide = 0;
    let flat = 0;

    const addText = (value) => {
        if (typeof value !== 'string' || value.length === 0) return;
        for (const ch of value) {
            if (ch.codePointAt(0) <= 0x7f) ascii++;
            else wide++;
        }
    };
    const addJson = (value) => {
        if (value === undefined) return;
        try { addText(JSON.stringify(value)); } catch (_) { /* not serializable, skip */ }
    };

    if (typeof body.system === 'string') addText(body.system);
    else if (Array.isArray(body.system)) {
        for (const block of body.system) addText(block && block.text);
    }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    for (const msg of messages) {
        if (typeof msg.content === 'string') {
            addText(msg.content);
            continue;
        }
        if (!Array.isArray(msg.content)) continue;
        for (const part of msg.content) {
            if (part.type === 'text') addText(part.text);
            else if (part.type === 'tool_use') { addText(part.name); addJson(part.input); }
            else if (part.type === 'tool_result') {
                if (typeof part.content === 'string') addText(part.content);
                else if (Array.isArray(part.content)) {
                    for (const inner of part.content) {
                        if (!inner) continue;
                        if (inner.type === 'text') addText(inner.text);
                        else if (inner.type === 'image') flat += 1600;
                    }
                }
            }
            else if (part.type === 'image') flat += 1600;
            else if (part.type === 'document') flat += 2000;
        }
    }

    addJson(body.tools);

    // Rough rule of thumb: ~4 ASCII chars or ~1 wide char per token
    // 粗略经验值：约 4 个 ASCII 字符或 1 个全角字符 ≈ 1 Token
    return Math.ceil(ascii / 4) + wide + flat + 4 + messages.length * 4;
}

// ╔══════════════════════════════════════════════════════════════╗
// ║ 6. Request Protocol Conversion:                             ║
// ║    Anthropic Messages → OpenAI Chat Completions             ║
// ║                                                              ║
// ║ 6. 请求协议转换：Anthropic Messages → OpenAI Chat Completions ║
// ╚══════════════════════════════════════════════════════════════╝

// ▸ Anthropic image/document source → OpenAI image_url content part
// ▸ Anthropic 图片/文档源 → OpenAI image_url 内容块
function toOpenAIImagePart(part) {
    const imageUrl = part?.source?.url
        ? part.source.url
        : `data:${part?.source?.media_type || 'image/jpeg'};base64,${part?.source?.data || ''}`;
    return { type: 'image_url', image_url: { url: imageUrl } };
}

function anthropicToOpenAI(anthBody, route, requestId) {
    const messages = [];

    // ▸ Process System Prompt
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
            for (const block of anthBody.system) {
                if (!(block && block.type === 'text' && block.text)) {
                    log(`[${requestId}] ${t('log.droppedPart', { type: (block && block.type) || 'unknown', where: 'system' })}`);
                }
            }
        }
        if (systemText) {
            messages.push({ role: 'system', content: systemText });
        }
    }

    // ▸ Iterate and process message body
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
            const documents = [];

            for (const part of content) {
                if (!part || typeof part !== 'object') {
                    log(`[${requestId}] ${t('log.droppedPart', { type: 'unknown', where: 'message' })}`);
                    continue;
                }
                if (part.type === 'text') {
                    // ▸ Guard against missing text fields, otherwise "undefined" leaks into the prompt
                    // ▸ 防止缺失 text 字段，否则 "undefined" 会混入提示词
                    textContent += part.text || '';
                }
                else if (part.type === 'image') {
                    images.push(toOpenAIImagePart(part));
                }
                else if (part.type === 'document') {
                    // ▸ Plain-text sources are inlined; base64 payloads are only forwarded
                    // ▸ when explicitly enabled, otherwise they degrade to a placeholder
                    // ▸ 纯文本源直接内联；base64 载荷仅在显式开启时转发，否则降级为占位文本
                    const inlineText = typeof part.text === 'string' ? part.text
                        : (part.source?.type === 'text' && typeof part.source.data === 'string' ? part.source.data : '');
                    if (inlineText) {
                        textContent += (textContent ? '\n' : '') + inlineText;
                    } else if (part.source?.type === 'base64' && CONVERT_PDF_TO_FILE) {
                        documents.push({
                            type: 'file',
                            file: {
                                filename: part.title || 'document.pdf',
                                file_data: `data:${part.source.media_type || 'application/pdf'};base64,${part.source.data || ''}`
                            }
                        });
                    } else {
                        const title = part.title || part.source?.media_type || 'untitled';
                        log(`[${requestId}] ${t('log.documentOmitted', { title })}`);
                        textContent += (textContent ? '\n' : '') + `[document omitted: ${title}]`;
                    }
                }
                else if (part.type === 'tool_use') {
                    toolCalls.push({
                        id: denormalizeToolId(part.id),
                        type: 'function',
                        function: { name: part.name, arguments: JSON.stringify(part.input || {}) }
                    });
                }
                else if (part.type === 'tool_result') {
                    // ▸ Preserve text and images inside tool results instead of dropping them
                    // ▸ 保留工具结果中的文本与图片，避免静默丢失
                    let resContent = '';
                    const resImages = [];
                    if (typeof part.content === 'string') {
                        resContent = part.content;
                    } else if (Array.isArray(part.content)) {
                        for (const inner of part.content) {
                            if (!inner) continue;
                            if (inner.type === 'text' && inner.text) {
                                resContent += (resContent ? '\n' : '') + inner.text;
                            } else if (inner.type === 'image') {
                                resImages.push(toOpenAIImagePart(inner));
                            } else {
                                log(`[${requestId}] ${t('log.droppedPart', { type: inner.type || 'unknown', where: 'tool_result' })}`);
                            }
                        }
                    }
                    toolResults.push({
                        role: 'tool',
                        tool_call_id: denormalizeToolId(part.tool_use_id),
                        content: resImages.length > 0
                            ? [{ type: 'text', text: resContent || ' ' }, ...resImages]
                            : resContent
                    });
                }
                else {
                    log(`[${requestId}] ${t('log.droppedPart', { type: (part && part.type) || 'unknown', where: 'message' })}`);
                }
            }

            // ▸ Assemble OpenAI message structure based on role
            // ▸ 根据 Role 组装 OpenAI 消息结构
            if (role === 'user') {
                if (toolResults.length > 0) {
                    messages.push(...toolResults);
                    // Preserve accompanying text/images instead of silently dropping them
                    // 保留工具结果之外附带的文本/图片，避免静默丢失
                    const extraContent = [];
                    if (textContent) extraContent.push({ type: 'text', text: textContent });
                    if (images.length > 0) extraContent.push(...images);
                    if (documents.length > 0) extraContent.push(...documents);
                    if (extraContent.length > 0) {
                        messages.push({ role: 'user', content: extraContent });
                    }
                } else if (images.length > 0 || documents.length > 0) {
                    messages.push({ role: 'user', content: [{ type: 'text', text: textContent || ' ' }, ...images, ...documents] });
                } else {
                    messages.push({ role: 'user', content: textContent || ' ' });
                }
            }
            else if (role === 'assistant') {
                // ▸ Skip empty assistant messages, some upstreams reject them outright
                // ▸ 跳过空的 assistant 消息，部分上游会直接拒绝
                if (!textContent && toolCalls.length === 0) {
                    continue;
                }
                const oaiMsg = { role: 'assistant' };
                if (textContent) oaiMsg.content = textContent;
                if (toolCalls.length > 0) oaiMsg.tool_calls = toolCalls;
                messages.push(oaiMsg);
            }
        }
    }

    // ▸ Build base request body
    // ▸ 构建基础请求体
    const oaiBody = {
        model: route.targetModel,
        messages,
        max_tokens: anthBody.max_tokens ?? 4096,
        temperature: anthBody.temperature ?? 1.0,
        stream: !!anthBody.stream,
    };

    // ▸ Optional sampling parameters (top_k has no OpenAI equivalent)
    // ▸ 可选采样参数（top_k 无 OpenAI 等价参数）
    if (anthBody.top_p != null) oaiBody.top_p = anthBody.top_p;
    if (Array.isArray(anthBody.stop_sequences) && anthBody.stop_sequences.length > 0) {
        oaiBody.stop = anthBody.stop_sequences;
    }

    // ▸ Opt-in: ask OpenAI-compatible upstreams for usage in streaming mode
    // ▸ 可选：向 OpenAI 兼容上游索取流式模式下的用量（默认关闭以兼容旧端点）
    if (anthBody.stream && STREAM_INCLUDE_USAGE) {
        oaiBody.stream_options = { include_usage: true };
    }

    // ▸ Translate tool definitions: Anthropic tools → OpenAI functions
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

    // ▸ Reasoning depth mapping: budget_tokens → reasoning_effort
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
                // adaptive mode: model decides reasoning depth, maps to OpenAI high level
                // adaptive 模式：由模型自动决定推理深度，映射为 OpenAI 的高深度
                targetEffort = 'high';
            } else {
                targetEffort = 'medium';
            }
        }

        // Always send reasoning_effort; if upstream doesn't support it, auto-degrade via error handler
        // 始终发送 reasoning_effort，若上游不支持则由错误处理模块自动降级重试
        oaiBody.reasoning_effort = targetEffort;
    }

    // ▸ Map Anthropic metadata.user_id → OpenAI user (for tracking)
    // ▸ 映射 Anthropic metadata.user_id → OpenAI user (用于追踪)
    if (anthBody.metadata?.user_id) {
        oaiBody.user = anthBody.metadata.user_id;
    }

    return oaiBody;
}


// ╔══════════════════════════════════════════════════════════════╗
// ║ 7. HTTP Server Core Logic                                    ║
// ║ 7. HTTP 服务核心逻辑                                          ║
// ╚══════════════════════════════════════════════════════════════╝

// ▸ Degradation ladder for unsupported reasoning_effort: max → high → removed
// ▸ 不受支持的 reasoning_effort 降级阶梯：max → high → 移除参数
async function retryWithoutReasoning(route, oaiBody, requestId, abortHolder) {
    const ladder = oaiBody.reasoning_effort === 'max' ? ['high', null] : [null];
    let response = null;
    let errorText = '';
    let deadline = null;

    for (const nextEffort of ladder) {
        if (nextEffort === null) {
            log(`[${requestId}] ${t('log.retryRemove')}`);
            delete oaiBody.reasoning_effort;
        } else {
            log(`[${requestId}] ${t('log.retryDowngrade')}`);
            oaiBody.reasoning_effort = nextEffort;
        }

        // Each retry gets its own timeout protection
        // 每次重试均配备独立的超时保护
        deadline = createDeadline(PROXY_TIMEOUT_MS);
        if (abortHolder) abortHolder.deadline = deadline;
        try {
            response = await fetch(`${route.base}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${route.key}` },
                body: JSON.stringify(oaiBody),
                signal: deadline.controller.signal
            });
        } catch (fetchErr) {
            deadline.clear();
            log(`[${requestId}] ${t('log.retryConnFailed', { detail: fetchErr.message })}`);
            const aborted = fetchErr.name === 'AbortError';
            return {
                ok: false,
                network: true,
                status: aborted ? 504 : 502,
                detail: aborted
                    ? t('error.upstreamTimeout', { detail: fetchErr.message })
                    : t('error.relayUnreachable', { detail: route.base })
            };
        }
        deadline.arm(PROXY_IDLE_TIMEOUT_MS);

        if (response.ok) {
            log(`[${requestId}] ${t('log.retryOk', { status: response.status })}`);
            return { ok: true, response, deadline };
        }

        errorText = await response.text().catch(() => '');
        deadline.clear();
        if (!isReasoningEffortError(errorText)) break;
    }

    return {
        ok: false,
        network: false,
        status: response.status,
        detail: t('error.upstreamRejected', { detail: errorText })
    };
}

// ▸ Single upstream attempt; resolves for any HTTP status, throws never
// ▸ 单次上游尝试；任意 HTTP 状态都正常返回，不抛出异常
async function executeAttempt(route, anthBody, req, requestId, requestStart, abortHolder) {
    const deadline = createDeadline(PROXY_TIMEOUT_MS);
    if (abortHolder) abortHolder.deadline = deadline;
    const startedAt = Date.now();
    let oaiBody = null;
    let response;

    try {
        if (route.format === 'anthropic') {
            const upstreamBody = { ...anthBody, model: route.targetModel };
            response = await fetch(`${route.base}/v1/messages`, {
                method: 'POST',
                headers: buildAnthropicHeaders(route, req),
                body: JSON.stringify(upstreamBody),
                signal: deadline.controller.signal
            });
        } else {
            oaiBody = anthropicToOpenAI(anthBody, route, requestId);
            log(`[${requestId}] ${t('log.upstreamModel', { model: oaiBody.model })}`);
            response = await fetch(`${route.base}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${route.key}` },
                body: JSON.stringify(oaiBody),
                signal: deadline.controller.signal
            });
        }
    } catch (fetchErr) {
        deadline.clear();
        const aborted = fetchErr.name === 'AbortError';
        if (route.format === 'anthropic') {
            log(`[${requestId}] ${t('log.anthropicUpstreamFailed', { detail: fetchErr.message })}`);
        } else {
            log(`[${requestId}] ${t('log.openaiConnFailed', { detail: fetchErr.message })}`);
        }
        return {
            ok: false,
            network: true,
            status: aborted ? 504 : 502,
            detail: aborted
                ? t('error.upstreamTimeout', { detail: fetchErr.message })
                : (route.format === 'anthropic'
                    ? t('error.directUnreachable', { detail: fetchErr.message })
                    : t('error.relayUnreachable', { detail: route.base }))
        };
    }

    // ▸ The response headers are in; switch the watchdog to idle-timeout mode
    // ▸ 已收到响应头，看门狗切换为空闲超时模式
    deadline.arm(PROXY_IDLE_TIMEOUT_MS);
    const channel = route.format === 'anthropic' ? 'Anthropic' : 'OpenAI';
    log(`[${requestId}] <-- ${channel} ${response.status} | ${Date.now() - startedAt}ms`);

    if (response.ok) {
        return { ok: true, response, oaiBody, deadline };
    }

    let errorText = await response.text().catch(() => '');

    // ── Error handling with auto-degradation retry ──
    // ── 错误处理与自动降级重试 ──
    if (route.format !== 'anthropic' && oaiBody?.reasoning_effort && isReasoningEffortError(errorText)) {
        const outcome = await retryWithoutReasoning(route, oaiBody, requestId, abortHolder);
        if (outcome.ok) {
            return { ok: true, response: outcome.response, oaiBody, deadline: outcome.deadline };
        }
        deadline.clear();
        return { ok: false, network: outcome.network, status: outcome.status, detail: outcome.detail };
    }

    deadline.clear();

    if (route.format === 'anthropic') {
        // Try to parse upstream standard error format and forward as-is to avoid nesting
        // 尝试解析上游标准错误格式并原样转发，避免二次嵌套
        try {
            const errJson = JSON.parse(errorText);
            if (errJson.type === 'error' && errJson.error) {
                return { ok: false, network: false, status: response.status, verbatim: errJson };
            }
        } catch (_) { /* Not JSON, fall through to generic error handling */
                       /* 非JSON，走通用错误处理 */ }
        return { ok: false, network: false, status: response.status, detail: t('error.directUpstream', { detail: errorText }) };
    }

    return { ok: false, network: false, status: response.status, detail: t('error.upstreamRejected', { detail: errorText }) };
}

// ▸ Mode A: Anthropic Protocol Direct Pass-Through
// ▸ 模式 A：Anthropic 协议直连透传
async function handleAnthropicPassthrough(req, res, anthBody, response, deadline, requestId, requestStart) {
    if (!anthBody.stream) {
        try {
            const text = await response.text();
            deadline.clear();
            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders(req) });
            res.end(text);
        } catch (err) {
            deadline.clear();
            const aborted = err.name === 'AbortError';
            if (aborted) log(`[${requestId}] ${t('log.idleAbort', { ms: PROXY_IDLE_TIMEOUT_MS })}`);
            sendAnthropicError(res, aborted ? 504 : 502, aborted
                ? t('error.upstreamTimeout', { detail: err.message })
                : t('error.brokenStream'));
        }
        return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
        deadline.clear();
        sendAnthropicError(res, 500, t('error.brokenStream'));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', ...corsHeaders(req) });

    // Send SSE heartbeat every 30s to prevent client 45s liveness timeout
    // 按 30 秒间隔发送 SSE 心跳，防止客户端 45 秒活性超时
    const keepaliveTimer = setInterval(() => {
        try { res.write(':keepalive\n\n'); } catch (_) { /* Connection already closed */
                                                      /* 连接已断 */ }
    }, 30000);

    // Client went away → stop pulling from upstream
    // 客户端断开 → 停止继续消耗上游
    let clientDisconnected = false;
    res.on('close', () => {
        if (!res.writableEnded) {
            clientDisconnected = true;
            log(`[${requestId}] ${t('log.clientAbort')}`);
            try { reader.cancel().catch(() => { /* stream already closed */ }); } catch (_) { /* already closed */ }
        }
    });

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            deadline.arm(PROXY_IDLE_TIMEOUT_MS);
            res.write(value);
        }
    } catch (streamErr) {
        const aborted = streamErr.name === 'AbortError';
        if (aborted && !clientDisconnected) {
            log(`[${requestId}] ${t('log.idleAbort', { ms: PROXY_IDLE_TIMEOUT_MS })}`);
        } else if (!aborted) {
            log(`[${requestId}] ${t('log.streamAborted', { detail: (streamErr.message || '').slice(0, 80) })}`);
        }
    } finally {
        clearInterval(keepaliveTimer);
        deadline.clear();
    }
    res.end();
}

// ▸ Mode B: OpenAI Protocol Bidirectional Conversion (response direction)
// ▸ 模式 B：OpenAI 协议双向转换（响应方向）
async function handleOpenAIResponse(req, res, anthBody, response, deadline, requestId, requestStart, clientRequestedModel) {
    // ── Streaming response conversion (OpenAI SSE → Anthropic SSE) ──
    // ── 流式响应转换 (OpenAI SSE → Anthropic SSE) ──
    if (anthBody.stream) {
        // Check the stream is usable BEFORE writing the 200 header, so a broken
        // body can still be reported with a proper error response
        //
        // 在写入 200 响应头之前先检查流是否可用，保证 body 为空时还能正常返回错误
        const reader = response.body?.getReader();
        if (!reader) {
            deadline.clear();
            sendAnthropicError(res, 500, t('error.brokenStream'));
            return;
        }

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            ...corsHeaders(req)
        });

        // Send SSE heartbeat every 30s to prevent client liveness timeouts
        // 按 30 秒间隔发送 SSE 心跳，防止客户端活性超时
        const keepaliveTimer = setInterval(() => {
            try { res.write(':keepalive\n\n'); } catch (_) { /* Connection already closed */
                                                          /* 连接已断 */ }
        }, 30000);

        // Client went away → stop pulling from upstream
        // 客户端断开 → 停止继续消耗上游
        let clientDisconnected = false;
        res.on('close', () => {
            if (!res.writableEnded) {
                clientDisconnected = true;
                log(`[${requestId}] ${t('log.clientAbort')}`);
                try { reader.cancel().catch(() => { /* stream already closed */ }); } catch (_) { /* already closed */ }
            }
        });

        const messageId = `msg_proxy_${Date.now()}`;
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheCreationTokens = 0;
        let cacheReadTokens = 0;
        let finalFinishReason = 'end_turn';

        // Block state management
        // 块状态管理
        let thinkingBlockOpened = false;
        let textBlockOpened = false;
        const toolBlockStates = {};
        let nextBlockIdx = 0;
        let thinkingBlockIdx = -1;
        let textBlockIdx = -1;

        const closeThinkingBlock = () => {
            if (!thinkingBlockOpened) return;
            res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: thinkingBlockIdx, delta: { type: "signature_delta", signature: "" } })}\n\n`);
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: thinkingBlockIdx })}\n\n`);
            thinkingBlockOpened = false;
        };

        const closeTextBlock = () => {
            if (!textBlockOpened) return;
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: textBlockIdx })}\n\n`);
            textBlockOpened = false;
        };

        const closeToolBlocks = () => {
            for (const key of Object.keys(toolBlockStates)) {
                const state = toolBlockStates[key];
                if (state && state.opened) {
                    res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: state.index })}\n\n`);
                    state.opened = false;
                }
            }
        };

        const closeAllBlocks = () => {
            closeThinkingBlock();
            closeTextBlock();
            closeToolBlocks();
        };

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

        // Send start signal
        // 发送起始信号
        res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: messageId, type: "message", role: "assistant", content: [], model: clientRequestedModel, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })}\n\n`);

        const decoder = new TextDecoder();
        let buffer = '';

        // ▸ One parsed SSE payload → Anthropic events
        // ▸ 单个已解析的 SSE 载荷 → Anthropic 事件
        const processEventData = (data) => {
            if (!data || data === '[DONE]') return;

            let chunk;
            try {
                chunk = JSON.parse(data);
            } catch (parseErr) {
                log(`[${requestId}] ${t('log.sseParseFailed', { detail: (parseErr.message || '').slice(0, 80) })}`);
                return;
            }

            // ▸ Usage is often delivered on a final chunk that has no choices
            // ▸ 用量常出现在没有 choices 的尾块上，因此先于 choices 判空处理
            if (chunk.usage) {
                outputTokens = chunk.usage.completion_tokens ?? outputTokens;
                inputTokens = chunk.usage.prompt_tokens || inputTokens;
                cacheReadTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? cacheReadTokens;
                cacheCreationTokens = chunk.usage.cache_creation_input_tokens
                    ?? chunk.usage.prompt_tokens_details?.cache_creation_tokens
                    ?? cacheCreationTokens;
            }

            if (!chunk.choices?.length) return;

            const delta = chunk.choices[0].delta;
            const finishReason = chunk.choices[0].finish_reason;
            if (finishReason) finalFinishReason = finishReason;

            // ▸ reasoning_content → thinking block (e.g., DeepSeek R1)
            // ▸ reasoning_content → thinking 块 (如 DeepSeek R1)
            if (delta?.reasoning_content) {
                ensureThinkingBlockStart();
                res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: thinkingBlockIdx, delta: { type: "thinking_delta", thinking: delta.reasoning_content } })}\n\n`);
            }

            // ▸ text content → text block (part arrays are tolerated as well)
            // ▸ text content → text 块（同样容忍内容块数组）
            const rawDelta = delta?.content;
            const textDelta = typeof rawDelta === 'string'
                ? rawDelta
                : (Array.isArray(rawDelta)
                    ? rawDelta.map(part => (typeof part === 'string' ? part : (part && typeof part.text === 'string' ? part.text : ''))).join('')
                    : '');
            if (textDelta) {
                closeThinkingBlock();
                ensureTextBlockStart();
                res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: textBlockIdx, delta: { type: "text_delta", text: textDelta } })}\n\n`);
            }

            // ▸ tool_calls processing (close open thinking/text blocks first to keep
            // ▸ blocks strictly sequential as the Anthropic protocol requires)
            // ▸ tool_calls 处理 (先关闭已打开的 thinking/text 块，保证块严格串行)
            if (delta?.tool_calls) {
                closeThinkingBlock();
                closeTextBlock();

                for (const tool of delta.tool_calls) {
                    const oaiIdx = tool.index;
                    if (oaiIdx === undefined) continue;

                    let state = toolBlockStates[oaiIdx];
                    if (!state) {
                        state = { id: tool.id ? normalizeToolId(tool.id) : null, name: tool.function?.name || null, opened: false, buffer: '' };
                        toolBlockStates[oaiIdx] = state;
                    }

                    if (tool.id) state.id = normalizeToolId(tool.id);
                    if (tool.function?.name) state.name = tool.function.name;
                    if (tool.function?.arguments) state.buffer += tool.function.arguments;

                    // When id + name are ready, open content_block_start and replay buffer
                    // 当 id + name 就绪时，打开 content_block_start 并回放缓冲区
                    if (!state.opened && state.id && state.name) {
                        state.opened = true;
                        state.index = nextBlockIdx++;
                        res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: state.index, content_block: { type: "tool_use", id: state.id, name: state.name, input: {} } })}\n\n`);

                        if (state.buffer) {
                            res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: state.index, delta: { type: "input_json_delta", partial_json: state.buffer } })}\n\n`);
                            state.buffer = '';
                        }
                    }

                    // Continuously send parameter fragments
                    // 持续发送参数片段
                    if (state.opened && tool.function?.arguments) {
                        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: state.index, delta: { type: "input_json_delta", partial_json: tool.function.arguments } })}\n\n`);
                    }
                }
            }
        };

        // ▸ Tolerant SSE line handling: "data:" with or without a space, \r tolerated,
        // ▸ comments (":keepalive") and other fields ignored
        // ▸ 宽容的 SSE 行处理：data: 允许有无空格、容忍 \r、忽略注释与其它字段
        const handleLine = (line) => {
            if (!line || line.startsWith(':')) return;
            if (!/^data:\s?/.test(line)) return;
            processEventData(line.replace(/^data:\s?/, '').trim());
        };

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                deadline.arm(PROXY_IDLE_TIMEOUT_MS);
                buffer += decoder.decode(value, { stream: true });

                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) handleLine(line);
            }

            // ▸ Flush a trailing line that arrived without a final newline
            // ▸ 补处理没有以换行结尾的最后一行
            if (buffer) {
                handleLine(buffer);
                buffer = '';
            }

            // ── Stream ended, close all open blocks ──
            // ── 流结束，关闭所有打开的块 ──
            closeAllBlocks();
            const stopReasonMap = { 'stop': 'end_turn', 'length': 'max_tokens', 'tool_calls': 'tool_use', 'content_filter': 'end_turn', 'function_call': 'tool_use' };

            res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: stopReasonMap[finalFinishReason] || 'end_turn', stop_sequence: null }, usage: { output_tokens: outputTokens, input_tokens: inputTokens, cache_creation_input_tokens: cacheCreationTokens, cache_read_input_tokens: cacheReadTokens } })}\n\n`);
            res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
            res.end();
            log(`[${requestId}] ${t('log.streamDone', { in: inputTokens, out: outputTokens, cache: cacheReadTokens, ms: Date.now() - requestStart })}`);

        } catch (streamErr) {
            const aborted = streamErr.name === 'AbortError';
            if (aborted && !clientDisconnected) {
                log(`[${requestId}] ${t('log.idleAbort', { ms: PROXY_IDLE_TIMEOUT_MS })}`);
            } else if (!aborted) {
                log(`[${requestId}] ${t('log.streamAborted', { detail: (streamErr.message || '').slice(0, 80) })}`);
            }
            try { closeAllBlocks(); } catch (_) { /* Connection may already be closed */
                                                  /* 连接可能已断开 */ }
            try {
                res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: outputTokens || 0, input_tokens: inputTokens || 0, cache_creation_input_tokens: cacheCreationTokens || 0, cache_read_input_tokens: cacheReadTokens || 0 } })}\n\n`);
                res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
            } catch (_) { /* Connection may already be closed */
                          /* 连接可能已断开 */ }
            res.end();
        } finally {
            clearInterval(keepaliveTimer);
            deadline.clear();
        }
        return;
    }

    // ── Non-streaming response conversion ──
    // ── 非流式响应转换 ──
    let oaiData;
    try {
        oaiData = await response.json();
    } catch (err) {
        deadline.clear();
        const aborted = err.name === 'AbortError';
        if (aborted) log(`[${requestId}] ${t('log.idleAbort', { ms: PROXY_IDLE_TIMEOUT_MS })}`);
        sendAnthropicError(res, aborted ? 504 : 502, aborted
            ? t('error.upstreamTimeout', { detail: err.message })
            : t('error.brokenStream'));
        return;
    }
    deadline.clear();

    const choice = oaiData.choices?.[0];

    if (!choice) {
        sendAnthropicError(res, 502, t('error.emptyChoice'));
        return;
    }

    const resContent = [];

    // ▸ Extract reasoning/thinking content
    // ▸ 提取推理/思考内容
    if (choice.message?.reasoning_content) {
        resContent.push({ type: 'thinking', thinking: choice.message.reasoning_content, signature: '' });
    }
    // ▸ Extract normal text (some OpenAI-compatible providers return an array of parts)
    // ▸ 提取正常文本（部分 OpenAI 兼容服务会返回内容块数组）
    const rawContent = choice.message?.content;
    let text = '';
    if (typeof rawContent === 'string') {
        text = rawContent.trim();
    } else if (Array.isArray(rawContent)) {
        text = rawContent
            .map(part => (typeof part === 'string' ? part : (part && typeof part.text === 'string' ? part.text : '')))
            .join('')
            .trim();
    }
    if (text) resContent.push({ type: 'text', text });
    // ▸ Extract tool calls
    // ▸ 提取工具调用
    if (choice.message?.tool_calls) {
        for (const tool of choice.message.tool_calls) {
            let parsedInput = {};
            try { parsedInput = JSON.parse(tool.function.arguments); } catch { parsedInput = {}; }
            resContent.push({ type: 'tool_use', id: normalizeToolId(tool.id), name: tool.function.name, input: parsedInput });
        }
    }

    const stopReasonMap = { 'stop': 'end_turn', 'tool_calls': 'tool_use', 'length': 'max_tokens', 'content_filter': 'end_turn', 'function_call': 'tool_use' };

    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders(req) });
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
            cache_creation_input_tokens: oaiData.usage?.cache_creation_input_tokens
                || oaiData.usage?.prompt_tokens_details?.cache_creation_tokens || 0,
            cache_read_input_tokens: oaiData.usage?.prompt_tokens_details?.cached_tokens || 0
        }
    }));
    log(`[${requestId}] ${t('log.nonStreamDone', { in: oaiData.usage?.prompt_tokens || 0, out: oaiData.usage?.completion_tokens || 0, ms: Date.now() - requestStart })}`);
}

// ▸ Core chat endpoint: route → attempt → (optional failover) → response conversion
// ▸ 核心对话端点：路由 → 尝试 → （可选故障转移）→ 响应转换
async function handleMessages(req, res, requestId, requestStart) {
    const bodyResult = await readJsonBody(req);
    if (!bodyResult.ok) {
        if (bodyResult.aborted) return;
        if (bodyResult.tooLarge) {
            sendAnthropicError(res, 413, t('error.bodyTooLarge', { limit: MAX_BODY_BYTES }), { 'Connection': 'close' });
            req.resume();
            return;
        }
        sendAnthropicError(res, 400, t('error.invalidJson'));
        return;
    }

    const anthBody = bodyResult.body;
    if (anthBody.model !== undefined && typeof anthBody.model !== 'string') {
        sendAnthropicError(res, 400, t('error.invalidModel'));
        return;
    }

    // ── Routing decision ──
    // ── 路由决策 ──
    const clientRequestedModel = anthBody.model || slots[0].client;
    const routing = selectRoute(clientRequestedModel);
    log(`[${requestId}] ${t('log.route', { channel: routing.route.name, format: routing.route.format, client: clientRequestedModel, upstream: routing.route.targetModel, stream: !!anthBody.stream, thinking: anthBody.thinking ? anthBody.thinking.type : 'disabled' })}`);

    // ▸ Abort the active upstream once the client is gone (no wasted tokens)
    // ▸ 客户端断开后中止当前上游请求（不浪费 Token）
    const abortHolder = { deadline: null };
    res.on('close', () => {
        if (!res.writableEnded && abortHolder.deadline) {
            try { abortHolder.deadline.controller.abort(); } catch (_) { /* already aborted */ }
        }
    });

    if (!routing.route.key) {
        log(`[${requestId}] ${t('error.keyMissing', { channel: routing.route.name })}`);
    }

    // ── Attempt the primary channel, then the alternate one when allowed ──
    // ── 先尝试主通道，满足条件时再尝试备用通道 ──
    const candidates = [routing.route, routing.alternateRoute].filter(route => route && route.key);
    if (candidates.length === 0) {
        sendAnthropicError(res, 500, t('error.keyMissing', { channel: routing.route.name }));
        return;
    }

    let executed = null;
    let failure = null;

    for (let i = 0; i < candidates.length; i++) {
        const route = candidates[i];
        const result = await executeAttempt(route, anthBody, req, requestId, requestStart, abortHolder);

        if (result.ok) {
            executed = { route, ...result };
            break;
        }

        failure = { route, ...result };
        const alternate = candidates[i + 1];
        if (alternate && !res.destroyed && (result.network || isFailoverStatus(result.status))) {
            log(`[${requestId}] ${t('log.failover', { from: route.name, to: alternate.name, reason: result.status })}`);
            continue;
        }
        break;
    }

    if (!executed) {
        if (failure.verbatim) {
            res.writeHead(failure.status, { 'Content-Type': 'application/json', ...corsHeaders(req) });
            res.end(JSON.stringify(failure.verbatim));
        } else {
            sendAnthropicError(res, failure.status, failure.detail);
        }
        return;
    }

    if (executed.route.format === 'anthropic') {
        await handleAnthropicPassthrough(req, res, anthBody, executed.response, executed.deadline, requestId, requestStart);
    } else {
        await handleOpenAIResponse(req, res, anthBody, executed.response, executed.deadline, requestId, requestStart, clientRequestedModel);
    }
}

// ▸ Token counting endpoint: pass through on Anthropic channels, estimate locally on OpenAI channels
// ▸ Token 计数端点：Anthropic 通道直接透传，OpenAI 通道本地估算
async function handleCountTokens(req, res, requestId, requestStart) {
    const bodyResult = await readJsonBody(req);
    if (!bodyResult.ok) {
        if (bodyResult.aborted) return;
        if (bodyResult.tooLarge) {
            sendAnthropicError(res, 413, t('error.bodyTooLarge', { limit: MAX_BODY_BYTES }), { 'Connection': 'close' });
            req.resume();
            return;
        }
        sendAnthropicError(res, 400, t('error.invalidJson'));
        return;
    }

    const anthBody = bodyResult.body;
    if (anthBody.model !== undefined && typeof anthBody.model !== 'string') {
        sendAnthropicError(res, 400, t('error.invalidModel'));
        return;
    }

    const routing = selectRoute(anthBody.model || slots[0].client);

    const respondEstimate = () => {
        const tokens = estimateTokens(anthBody);
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders(req) });
        res.end(JSON.stringify({ input_tokens: tokens }));
        log(`[${requestId}] ${t('log.countTokensEstimate', { tokens })}`);
    };

    // ▸ OpenAI-compatible channels have no count_tokens endpoint at all
    // ▸ OpenAI 兼容通道根本没有 count_tokens 端点
    if (routing.route.format !== 'anthropic') {
        respondEstimate();
        return;
    }

    const candidates = [routing.route, routing.alternateRoute].filter(route => route && route.key);
    if (candidates.length === 0) {
        sendAnthropicError(res, 500, t('error.keyMissing', { channel: routing.route.name }));
        return;
    }

    let failure = null;

    for (let i = 0; i < candidates.length; i++) {
        const route = candidates[i];
        const deadline = createDeadline(PROXY_TIMEOUT_MS);

        try {
            const response = await fetch(`${route.base}/v1/messages/count_tokens`, {
                method: 'POST',
                headers: buildAnthropicHeaders(route, req),
                body: JSON.stringify({ ...anthBody, model: route.targetModel }),
                signal: deadline.controller.signal
            });
            deadline.arm(PROXY_IDLE_TIMEOUT_MS);

            if (response.ok) {
                const text = await response.text();
                deadline.clear();
                res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders(req) });
                res.end(text);
                return;
            }

            const detail = await response.text().catch(() => '');
            deadline.clear();

            // ▸ Relays without the endpoint report 404/405/501 → fall back to the estimate
            // ▸ 未实现该端点的中转会返回 404/405/501 → 回退本地估算
            if ([404, 405, 501].includes(response.status)) {
                log(`[${requestId}] ${t('log.countTokensFallback', { status: response.status })}`);
                respondEstimate();
                return;
            }

            failure = { status: response.status, detail: t('error.upstreamRejected', { detail }), network: false };
        } catch (err) {
            deadline.clear();
            const aborted = err.name === 'AbortError';
            failure = {
                status: aborted ? 504 : 502,
                detail: aborted
                    ? t('error.upstreamTimeout', { detail: err.message })
                    : t('error.relayUnreachable', { detail: route.base }),
                network: true
            };
        }

        const alternate = candidates[i + 1];
        if (alternate && !res.destroyed && (failure.network || isFailoverStatus(failure.status))) {
            log(`[${requestId}] ${t('log.failover', { from: route.name, to: alternate.name, reason: failure.status })}`);
            continue;
        }
        break;
    }

    sendAnthropicError(res, failure.status, failure.detail);
}

// ▸ CORS preflight: answered before the token check, since browsers never send credentials on it
// ▸ CORS 预检：在令牌校验之前应答，因为浏览器不会在预检中携带凭据
function handlePreflight(req, res) {
    const origin = req.headers.origin || '';
    if (!origin || !originAllowed(origin)) {
        sendAnthropicError(res, 403, t('error.originRejected'));
        return;
    }
    res.writeHead(204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type, anthropic-version, anthropic-beta, x-api-key, authorization, x-client-request-id',
        'Access-Control-Max-Age': '600',
        'Vary': 'Origin'
    });
    res.end();
}

const server = http.createServer(async (req, res) => {
    const pathname = req.url.split('?')[0];
    const requestId = nextRequestId();
    const requestStart = Date.now();
    log(`[${requestId}] --> ${req.method} ${pathname}`);

    // ▸ Health check endpoint (exempt from the access policy)
    // ▸ 心跳检测端点（不受访问策略限制）
    if (req.method === 'HEAD' && pathname === '/') {
        res.writeHead(200);
        res.end();
        return;
    }

    // ▸ CORS preflight
    // ▸ CORS 预检
    if (req.method === 'OPTIONS') {
        handlePreflight(req, res);
        return;
    }

    // ▸ Origin/Host/token guard
    // ▸ 来源/主机/令牌守卫
    const denied = checkAccess(req);
    if (denied) {
        sendAnthropicError(res, denied.status, t(denied.key, denied.vars));
        return;
    }

    // ▸ Model list endpoint: dynamically return slot-configured models
    // ▸ 模型列表端点：动态返回槽位支持的模型
    if (req.method === 'GET' && pathname === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders(req) });
        res.end(JSON.stringify({
            data: slots.map(s => ({ type: "model", id: s.client, display_name: s.client.toUpperCase() }))
        }));
        return;
    }

    // ▸ Token counting endpoint
    // ▸ Token 计数端点
    if (req.method === 'POST' && pathname === '/v1/messages/count_tokens') {
        try {
            await handleCountTokens(req, res, requestId, requestStart);
        } catch (err) {
            log(`[${requestId}] ${t('log.fatal', { detail: err.message })}`);
            const aborted = err.name === 'AbortError';
            sendAnthropicError(res, aborted ? 504 : 500, aborted
                ? t('error.upstreamTimeout', { detail: err.message })
                : t('error.gatewayCrash', { detail: err.message }));
        }
        return;
    }

    // ▸ Core chat endpoint
    // ▸ 核心对话端点
    if (req.method === 'POST' && pathname === '/v1/messages') {
        try {
            await handleMessages(req, res, requestId, requestStart);
        } catch (err) {
            log(`[${requestId}] ${t('log.fatal', { detail: err.message })}`);
            const aborted = err.name === 'AbortError';
            sendAnthropicError(res, aborted ? 504 : 500, aborted
                ? t('error.upstreamTimeout', { detail: err.message })
                : t('error.gatewayCrash', { detail: err.message }));
        }
        return;
    }

    // ▸ 404 fallback route
    // ▸ 404 兜底路由
    log(`[${requestId}] 404 ${req.method} ${req.url}`);
    sendAnthropicError(res, 404, t('error.routeNotFound'));
});

// ╔══════════════════════════════════════════════════════════════╗
// ║ 8. Process Management & Startup                              ║
// ║ 8. 进程管理与启动                                             ║
// ╚══════════════════════════════════════════════════════════════╝
let shuttingDown = false;
const gracefulShutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(t('startup.shuttingDown'));
    server.close(() => process.exit(0));
    // ▸ Long-lived SSE connections must not block the exit forever
    // ▸ 长连接 SSE 不允许无限期阻塞退出
    setTimeout(() => server.closeAllConnections(), 3000).unref();
    setTimeout(() => process.exit(0), 6000).unref();
};
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// ▸ Last-resort safety net: a stray rejection (e.g. from a stream being cancelled)
// ▸ must not take the whole gateway — and every parallel Claude Code session — down.
// ▸ Sync uncaughtException is intentionally NOT handled: continuing after one is unsafe.
// ▸ 最后一道防线：偶发的 Promise 异常（如流被取消时的竞态）不应拖垮整个网关
// ▸ 以及并行的 Claude Code 会话；同步的 uncaughtException 故意不拦截（状态已不可信）
process.on('unhandledRejection', (reason) => {
    const detail = reason && reason.message ? reason.message : String(reason);
    log(t('log.unhandledRejection', { detail }));
});

server.on('error', (err) => {
    console.error(t('startup.listenFailed', { port: PORT, detail: err.message }));
    process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
    log(t('startup.listening', { port: PORT }));
});
