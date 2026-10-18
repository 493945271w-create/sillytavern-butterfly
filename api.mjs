import { nativeRequest, nativeFetch, nativeText, nativeModels } from './native.mjs';
export const SETTINGS_KEY = 'butterfly_continuity_api_v1';
export const DEFAULT_SETTINGS = Object.freeze({ provider: 'compatible', search: false, url: '', model: '', timeout: 180, maxTokens: 6000, reasoning: '', tokenField: 'max_tokens' });
export function normalizeBase(value) {
    let url;
    try { url = new URL(String(value).trim()); } catch { throw Error('请填写完整的 API 地址（http:// 或 https://）。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('API 地址只能使用 HTTP/HTTPS，不要在地址中放密钥、查询参数或账号密码。');
    url.pathname = url.pathname.replace(/\/(?:chat\/completions|responses|models(?:\/[\w.-]+:generateContent)?)\/?$/, '').replace(/\/+$/, '');
    return url.toString().replace(/\/+$/, '');
}
export function cleanSettings(value) {
    const url = normalizeBase(value.url), model = String(value.model || '').trim();
    if (model.length > 200) throw Error('模型名称过长。');
    const timeout = Number(value.timeout ?? 180), maxTokens = Number(value.maxTokens ?? 6000);
    if (!Number.isInteger(timeout) || timeout < 15 || timeout > 600) throw Error('等待时间应为 15–600 秒。');
    if (!Number.isInteger(maxTokens) || maxTokens < 512 || maxTokens > 32000) throw Error('输出上限应为 512–32000 tokens。');
    const reasoning = String(value.reasoning || ''), tokenField = value.tokenField || 'max_tokens';
    if (!['', 'low', 'medium', 'high'].includes(reasoning) || !['max_tokens', 'max_completion_tokens'].includes(tokenField)) throw Error('模型参数不正确。');
    const provider = value.provider || 'compatible', search = value.search === true || value.search === 'on';
    if (!['compatible', 'openai', 'gemini'].includes(provider)) throw Error('请选择支持的接口类型。');
    if (search && provider === 'compatible') throw Error('普通 Chat Completions 连接不能自动联网；请改用支持原生搜索的接口类型。');
    if (provider === 'gemini' && /\/openai$/.test(new URL(url).pathname)) throw Error('Gemini 原生接口请使用 /v1beta 基础地址，不是 /v1beta/openai 兼容入口。');
    return { provider, search, url, model, timeout, maxTokens, reasoning: provider === 'gemini' ? '' : reasoning, tokenField };
}
export function readSettings(context) { return { ...DEFAULT_SETTINGS, ...context.extensionSettings?.[SETTINGS_KEY] }; }
// A refresh in this tab retains the key; chat exports and server settings do not contain it.
// Scope keys to the exact destination so switching providers cannot reuse an old key.
export function keySlot(url) { return `${SETTINGS_KEY}:key:${normalizeBase(url)}`; }
export function readKey(url, storage = globalThis.sessionStorage) { try { return storage?.getItem(keySlot(url)) || ''; } catch { return ''; } }
export function writeKey(url, key, storage = globalThis.sessionStorage) {
    const slot = keySlot(url);
    if (key.trim()) storage.setItem(slot, key.trim()); else storage.removeItem(slot);
}
export function customRequest(settings, key = '') {
    return {
        chat_completion_source: 'custom', custom_url: normalizeBase(settings.url),
        // Always override the host's custom Authorization, including for keyless local servers.
        custom_include_headers: JSON.stringify({ Authorization: key ? `Bearer ${key}` : '' }),
    };
}
export function completionRequest(settings, key, instructions, schema, input) {
    const config = cleanSettings(settings);
    if (!config.model) throw Error('请先在“模型设置”中填写或选择模型。');
    const extra = { [config.tokenField]: config.maxTokens };
    if (config.reasoning) extra.reasoning_effort = config.reasoning;
    return { ...customRequest(config, key), model: config.model, stream: false,
        messages: [
            { role: 'system', content: `${instructions}\n只返回一个 JSON 对象，不使用 Markdown 围栏。所有必填字段均须保留；不适用的字符串填空、数组填 []。遵守如下 JSON Schema：\n${JSON.stringify(schema)}` },
            { role: 'user', content: JSON.stringify(input) },
        ], custom_include_body: JSON.stringify(extra),
    };
}
export const jsonInstructions = (instructions, schema) => `${instructions}\n只返回一个 JSON 对象，不使用 Markdown 围栏。所有必填字段均须保留；不适用的字符串填空、数组填 []。遵守如下 JSON Schema：\n${JSON.stringify(schema)}`;
export function parseCompletion(data) {
    if (data?.error) throw Error('模型接口返回错误，请核对地址、密钥、模型权限及服务余额。');
    const choice = data?.choices?.[0];
    if (choice?.finish_reason === 'length') throw Error('模型输出达到上限，结果不完整。请提高输出上限或减少本次资料。');
    if (choice?.finish_reason === 'content_filter') throw Error('请求被模型服务拦截。');
    let content = choice?.message?.content;
    if (Array.isArray(content)) content = content.filter(p => p.type === 'text').map(p => p.text).join('');
    if (typeof content !== 'string' || !content.trim()) throw Error('模型没有返回文字结果。');
    content = content.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1').trim();
    let result;
    try { result = JSON.parse(content); } catch { throw Error('模型返回的 JSON 无法解析；原记录保留。请选择能稳定输出 JSON 的模型。'); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error('模型结果必须是 JSON 对象。');
    return result;
}
export async function hostPost(path, body, { context, signal, timeout = 180, fetchImpl = fetch }) {
    const controller = new AbortController();
    let timedOut = false;
    const stop = () => controller.abort();
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout * 1000);
    try {
        const response = await fetchImpl(path, { method: 'POST', headers: context.getRequestHeaders(), signal: controller.signal, body: JSON.stringify(body) });
        if (!response.ok) throw Error(`模型接口 HTTP ${response.status}；请核对模型设置和服务状态。`);
        let data;
        try { data = await response.json(); } catch { throw Error('接口没有返回 JSON，请核对 API 基础地址。'); }
        return data;
    } catch (error) {
        if (timedOut) throw Error(`模型等待超过 ${timeout} 秒；原记录保留，可稍后重试。`);
        if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
        // Do not echo upstream errors that may contain credentials or prompt text.
        if (error instanceof TypeError) throw Error('无法连接酒馆后端，请检查连接及代理。');
        throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
}
export async function completeJson(context, instructions, schema, input, signal, options = {}) {
    const settings = cleanSettings(options.settings || readSettings(context));
    const key = options.key ?? readKey(settings.url);
    if (settings.provider !== 'compatible') {
        const request = nativeRequest(settings, key, jsonInstructions(instructions, schema), JSON.stringify(input));
        const data = await nativeFetch(request, { signal, timeout: settings.timeout, fetchImpl: options.fetchImpl });
        return parseCompletion({ choices: [{ message: { content: nativeText(data, settings.provider) } }] });
    }
    return parseCompletion(await hostPost('/api/backends/chat-completions/generate', completionRequest(settings, key, instructions, schema, input), { context, signal, timeout: settings.timeout, fetchImpl: options.fetchImpl }));
}
export async function listModels(context, settings, key, signal) {
    settings = cleanSettings(settings);
    if (settings.provider !== 'compatible') return nativeModels(settings, key, { signal });
    const data = await hostPost('/api/backends/chat-completions/status', customRequest(settings, key), { context, signal, timeout: 30 });
    if (data?.error || !Array.isArray(data?.data)) throw Error('读取模型列表失败；服务可能没有 /models 接口，可以直接手填模型名。');
    return [...new Set(data.data.map(m => m.id).filter(id => typeof id === 'string'))].sort();
}
