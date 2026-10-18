import { DEFAULT_SETTINGS, SETTINGS_KEY, readSettings, cleanSettings, normalizeBase, readKey, writeKey, listModels } from './api.mjs';
import { prepareReferences } from './references.mjs';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

export function showSettings(panel, context, done) {
    const settings = readSettings(context), form = document.createElement('form');
    form.className = 'bf-editor bf-config'; form.dataset.editor = 'settings';
    form.innerHTML = `<h3>独立模型设置</h3>
      <p>分析使用 OpenAI 兼容的 Chat Completions 接口。聊天片段和参考资料会通过酒馆服务器发往你填写的地址，费用按该服务计费。</p>
      <label>API 基础地址<input name="url" type="url" required placeholder="https://你的服务地址/v1" value="${escape(settings.url)}"></label>
      <label>API 密钥<input name="key" type="password" autocomplete="off" placeholder="无需密钥的本地服务可留空"></label>
      <p>密钥仅保存在本浏览器会话中，刷新可保留；关闭会话后可能需要重新填写。聊天导出文件不包含密钥。使用远程酒馆时请通过 HTTPS 或可信隧道访问。</p>
      <label>模型<input name="model" list="bf-model-list" placeholder="选择列表中的模型，或手填完整模型名" value="${escape(settings.model)}"></label>
      <datalist id="bf-model-list"></datalist><button type="button" data-load-models>读取模型列表</button>
      <label>最长等待（秒）<input name="timeout" type="number" min="15" max="600" value="${settings.timeout}"></label>
      <label>输出上限（tokens）<input name="maxTokens" type="number" min="512" max="32000" value="${settings.maxTokens}"></label>
      <label>输出上限字段<select name="tokenField"><option value="max_tokens">max_tokens（通常使用）</option><option value="max_completion_tokens">max_completion_tokens（部分推理模型）</option></select></label>
      <label>思考强度<select name="reasoning"><option value="">服务默认（不发送此参数）</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
      <p>只有服务支持 reasoning_effort 时才选择思考强度。读取列表不生成内容；启用自动整理、预览和发送前筛选会调用所选模型。</p>
      <div role="status" data-form-status></div><div class="bf-toolbar"><button type="submit" class="bf-primary">保存设置</button><button type="button" data-cancel>返回</button></div>`;
    panel.replaceChildren(form);
    const field = name => form.elements.namedItem(name), note = message => { form.querySelector('[data-form-status]').textContent = message; };
    field('key').value = readKey(settings.url);
    field('reasoning').value = settings.reasoning; field('tokenField').value = settings.tokenField;
    // A changed destination must never inherit the previously displayed key.
    field('url').addEventListener('input', () => { field('key').value = readKey(field('url').value); });
    const controller = new AbortController();
    form.cancel = () => controller.abort();
    const values = () => Object.fromEntries(new FormData(form));
    form.querySelector('[data-cancel]').onclick = () => { controller.abort(); form.remove(); done(false); };
    form.querySelector('[data-load-models]').onclick = async event => {
        const button = event.currentTarget; button.disabled = true; note('正在读取模型列表…');
        try {
            const models = await listModels(context, { ...DEFAULT_SETTINGS, ...values() }, field('key').value.trim(), controller.signal);
            if (!form.isConnected) return;
            form.querySelector('datalist').replaceChildren(...models.map(id => { const option = document.createElement('option'); option.value = id; return option; }));
            note(`已读取 ${models.length} 个模型，请在“模型”输入框选择或手填。`); field('model').focus();
        } catch (error) { if (form.isConnected) note(error.message); } finally { button.disabled = false; }
    };
    form.onsubmit = event => {
        event.preventDefault();
        try {
            const raw = values(), clean = cleanSettings(raw);
            if (!clean.model) throw Error('请填写完整模型名。');
            writeKey(clean.url, raw.key);
            context.extensionSettings[SETTINGS_KEY] = clean; context.saveSettingsDebounced();
            controller.abort(); form.remove(); done(true);
        } catch (error) { note(error.message); }
    };
    field('url').focus();
}

export function showReferences(panel, entries, save, done) {
    let draft = structuredClone(entries || []);
    const form = document.createElement('form'); form.className = 'bf-editor bf-config'; form.dataset.editor = 'references';
    form.innerHTML = `<h3>当前聊天的参考资料</h3>
      <p>填写你有权使用的原著片段、Wiki 资料或设定。每份资料应保留来源、版本、发生阶段和上下文。总共最多 12 份、4.5 万字符；每次整理都会向所选模型发送这些资料。</p>
      <p>这是手动提供资料，不会自动联网，也不会自动读取你的世界书。程序只核对引用是否存在；内容真假和推论是否成立仍需查看。</p>
      <div data-ref-list></div>
      <label>类型<select name="kind"><option value="novel">原著片段</option><option value="wiki">Wiki / 百科</option><option value="timeline">时间线</option><option value="reference">其他参考设定</option></select></label>
      <label>标题、来源与阶段<input name="title" maxlength="150" placeholder="例如：原著第三章 · 入城前"></label>
      <label>参考正文<textarea name="text" rows="8" placeholder="粘贴需要核对的资料片段"></textarea></label>
      <label>也可从 TXT / Markdown 文件读取正文<input name="file" type="file" accept=".txt,.md,text/plain,text/markdown"></label>
      <button type="button" data-add>加入资料列表</button><div role="status" data-form-status></div>
      <div class="bf-toolbar"><button type="submit" class="bf-primary">保存资料</button><button type="button" data-cancel>返回</button></div>`;
    panel.replaceChildren(form);
    const field = name => form.elements.namedItem(name), note = message => { form.querySelector('[data-form-status]').textContent = message; };
    const render = () => {
        const list = form.querySelector('[data-ref-list]'); list.innerHTML = draft.length ? draft.map((r, i) => `<details><summary>${escape(r.title)} · ${r.text.length} 字符</summary><pre>${escape(r.text)}</pre><button type="button" data-remove="${i}">移除这份资料</button></details>`).join('') : '<p>暂未添加参考资料。候选缺少原著依据时会保留在待核实区，不发送正文。</p>';
        list.querySelectorAll('[data-remove]').forEach(button => { button.onclick = () => { draft.splice(Number(button.dataset.remove), 1); render(); }; });
    };
    field('file').onchange = async () => {
        try {
            const file = field('file').files[0]; if (!file) return;
            if (file.size > 200000) throw Error('文件过大，请提取当前阶段需要的片段后再导入。');
            field('text').value = await file.text(); if (!field('title').value) field('title').value = file.name;
            note('正文已读入，请确认后点击“加入资料列表”。');
        } catch (error) { note(error.message); }
    };
    const add = () => {
        const candidate = { id: `ref-${crypto.randomUUID()}`, kind: field('kind').value, title: field('title').value, text: field('text').value };
        draft = prepareReferences([...draft, candidate]); field('title').value = ''; field('text').value = ''; field('file').value = ''; render(); note('已加入列表，点击“保存资料”后生效。');
    };
    form.querySelector('[data-add]').onclick = () => { try { add(); } catch (error) { note(error.message); } };
    form.querySelector('[data-cancel]').onclick = () => { form.remove(); done(); };
    form.onsubmit = async event => {
        event.preventDefault();
        try {
            if (field('text').value.trim() || field('title').value.trim()) add();
            await save(prepareReferences(draft)); form.remove(); done();
        } catch (error) { note(error.message); }
    };
    render();
}
