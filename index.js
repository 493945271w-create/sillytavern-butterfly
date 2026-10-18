import { KEY, VERSION, emptyLedger, fingerprints, hasLegacyAnchors, migrateLegacyAnchors, project, validateAnalysis, makeBatch, analysisWindow, isMajorCandidate, isVerifiedDivergence } from './core.mjs?v=0.3.0';
import { SelectionGate, selectionAborted, selectionSceneChanged } from './selection.mjs?v=0.3.0';
import { requestAnalysis, requestSelection } from './requests.mjs';
import { readSettings } from './api.mjs';
import { prepareReferences } from './references.mjs';
import { showSettings, showReferences } from './settings-ui.mjs';

const context = () => SillyTavern.getContext();
const owner = () => { const c = context(); return c.chatId ? `${c.groupId ?? c.characters[c.characterId]?.avatar ?? c.characterId}:${c.chatId}` : ''; };
const ledger = () => context().chatMetadata?.[KEY] || emptyLedger();
const listeners = [];
let panel, button, settingsLink, task, controller, timer, revision = 0, disposed = false, stoppedGeneration = false;
let view = { records: [], batches: [], invalid: 0, end: -1 }, hashes = [], preview = { text: '', selected: [] }, status = '打开一份聊天，启用后即可整理。';
let selectionMode = 'pending', previewType = 'normal';
let observedOwner = '', generationEpoch = 0;
const mainGenerationTypes = ['normal', 'regenerate', 'swipe', 'continue'];
const html = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const setStatus = text => { status = text; const node = panel?.querySelector('[data-status]'); if (node) node.textContent = text; };
const clearPrompt = () => context().setExtensionPrompt(KEY, '', 1, 1, false, 0);
async function selectionSnapshot(type = 'normal') {
    const current = owner(), data = structuredClone(ledger());
    const source = type === 'swipe' ? context().chat.slice(0, -1) : context().chat;
    const chat = source.map(m => ({ is_user: !!m.is_user, name: m.name || '', mes: m.mes || '' }));
    const h = await fingerprints(chat);
    if (disposed || !current || current !== owner()) throw selectionAborted('聊天已切换或插件已停用');
    if (JSON.stringify(data) !== JSON.stringify(ledger())) throw selectionSceneChanged('世界线记录在读取期间更新');
    const records = project(data, h).records;
    return { key: JSON.stringify([current, type, h.at(-1), data.enabled, data.inject, records, data.references, readSettings(context())]),
        owner: current, enabled: data.enabled, records, type, sources: prepareReferences(data.references || []),
        messages: chat.slice(-4).map((m, i, arr) => ({ id: chat.length - arr.length + i, role: m.is_user ? 'user' : 'assistant', text: m.mes })) };
}
const selector = new SelectionGate({ snapshot: selectionSnapshot, request: (input, signal) => requestSelection(input, signal, context()), notify: text => { setStatus(text); render(); } });
async function selectForScene(type = 'normal', force = false) {
    if (task) await task;
    previewType = type;
    preview = { text: '', selected: [], canonSelected: [] }; selectionMode = 'pending';
    const pending = selector.select(type, force);
    // select() obtains its snapshot asynchronously; show its progress without making a second request.
    setStatus('正在准备本轮模型选择…');
    try {
        const result = await pending;
        preview = result.prompt; selectionMode = result.mode;
        render();
        if (result.mode === 'fallback') globalThis.toastr?.warning('模型 整理暂不可用，本轮使用已有依据的简要对照。详情见蝴蝶效应面板。', '蝴蝶效应');
        return result;
    } catch (error) { clearPrompt(); setStatus(error.message); throw error; }
    finally { render(); }
}
async function persist(data, expectedOwner = owner()) {
    if (!expectedOwner || expectedOwner !== owner()) throw new Error('聊天已切换，本次结果未写入。');
    context().chatMetadata[KEY] = data;
    await context().saveMetadata();
}
async function refresh(generationType = previewType) {
    const n = ++revision, current = owner(), chat = generationType === 'swipe' ? context().chat.slice(0, -1) : context().chat;
    if (!current) { view = { records: [], batches: [], invalid: 0, end: -1 }; preview = { text: '', selected: [] }; clearPrompt(); render(); return; }
    const initialData = ledger();
    const h = await fingerprints(chat);
    const legacy = hasLegacyAnchors(initialData) ? await fingerprints(chat, 1) : [];
    if (disposed || n !== revision || current !== owner()) return;
    hashes = h;
    let data = ledger();
    if (data === initialData && generationType !== 'swipe') {
        const migration = migrateLegacyAnchors(data, h, legacy);
        if (migration.count) {
            await persist(migration.ledger, current);
            if (disposed || n !== revision || current !== owner()) return;
            data = ledger();
        }
    }
    view = project(data, h);
    const snapshot = await selectionSnapshot(generationType);
    if (disposed || n !== revision || current !== owner()) return;
    const cached = selector.cached?.key === snapshot.key ? selector.cached : null;
    preview = cached?.prompt || { text: '', selected: [], canonSelected: [] };
    selectionMode = cached?.mode || 'pending';
    // Only the awaited generation interceptor installs a prompt. Opening the panel is read-only.
    if (!data.enabled || !data.inject) clearPrompt();
    render();
}
async function analyze() {
    if (task || !owner() || !ledger().enabled) return task;
    const current = owner();
    controller = new AbortController();
    const signal = controller.signal;
    task = (async () => {
        await refresh();
        if (signal.aborted || owner() !== current || !ledger().enabled) return;
        const window = analysisWindow(context().chat, view);
        if (!window) { setStatus('已整理到最新剧情。'); return; }
        const anchor = hashes[window.end];
        const existing = view.records.filter(isMajorCandidate).map(({ id, title, fact, locked, supersededBy, evidence, manuallyEdited, divergenceKey, changedPremise, canon, canonStatus }) => ({ id, title, fact, locked, supersededBy, evidence, manuallyEdited, divergenceKey, changedPremise, canon, canonStatus }));
        setStatus(`正在整理第 ${window.start + 1}–${window.end + 1} 条消息…`); render();
        const result = await requestAnalysis({ messages: window.messages, existing, sources: prepareReferences(ledger().references || []) }, signal, context());
        if (signal.aborted || owner() !== current) throw new Error('聊天已切换或分析已取消，本次未保存。');
        const now = await fingerprints(context().chat);
        if (now[window.end] !== anchor) throw new Error('剧情在分析期间发生变化，请重新整理。');
        const sources = result.sources || [];
        const clean = validateAnalysis(result, window.messages, existing, new Map(sources.map(s => [s.id, s])), new Set(sources.filter(s => s.opened).map(s => s.id)), result.searches || []);
        const data = structuredClone(ledger());
        const usedSourceIds = new Set(clean.events.flatMap(event => event.canonSourceIds));
        data.batches.push(makeBatch(clean, { ...window, hash: anchor, sources: sources.filter(source => usedSourceIds.has(source.id)), searches: [] }));
        await persist(data, current);
        const ready = clean.events.filter(isVerifiedDivergence).length;
        setStatus(`已记录 ${ready} 条重大原著分歧，${clean.events.length-ready} 条待核实；整理到第 ${window.end + 1} 条消息。`);
    })().catch(error => setStatus(error.name === 'AbortError' ? '分析已取消，原记录保留。' : `未保存：${error.message}`))
        .finally(async () => { task = null; controller = null; await refresh(); });
    return task;
}
function pendingQuestions(r) {
    return [...new Set([...(r.openQuestions || []), ...(['pending', 'reference_only', 'conflict'].includes(r.canonStatus) ? [r.canonConflict || r.canonQuery || '原著对照尚缺参考资料。'] : [])])];
}
function recordMarkup(r) {
    const byId = new Map(view.records.map(x => [x.id, x.title]));
    const sourceBatch = view.batches.find(b => b.id === r.batchId);
    const sourceTitles = (sourceBatch?.sources || []).filter(s => r.canonSourceIds.includes(s.id)).map(s => s.title);
    return `<article class="bf-card" data-record="${html(r.id)}">
      <div class="bf-card-top"><span class="bf-tag">${r.supersededBy ? '历史分歧 · 已更新' : isVerifiedDivergence(r) ? '重大原著分歧' : '待核实 · 不发送'}${r.locked ? ' · 已锁定' : ''}</span><span>${r.evidence.map(e => `#${e.messageId}`).join(' · ')}</span></div>
      <h3>${html(r.title)}</h3><small>${r.manuallyEdited ? '当前剧情 · 人工修正' : '当前剧情 · 依据见下方'}</small><p class="bf-fact">${html(r.fact)}</p>
      ${r.parentIds.length ? `<div class="bf-parent">整理的关联 → ${html(r.parentIds.map(id => byId.get(id) || id).join(' / '))}</div>` : ''}
      <div class="bf-rule"><span>原著情况</span><p>${html(r.canon || '尚未核实，不作为正式分歧发送。')}</p></div>
      <div class="bf-rule"><span>改变的重要前提</span><p>${html(r.changedPremise || '尚未核实。')}</p></div>
      ${r.constraint ? `<div class="bf-rule"><span>承接边界</span><p>${html(r.constraint)}</p></div>` : ''}
      <div class="bf-entities">${r.entities.map(e => `<span>${html(e)}</span>`).join('')}</div>
      <details><summary>依据与原著对照</summary>${r.evidence.map(e => `<blockquote>#${e.messageId} ${html(e.quote)}</blockquote>`).join('')}
      <p>${html(({ provided_supported: '所提供资料有对应引文（未联网核验，请留意版本与语境）', cross_checked: '小说与Wiki均有引用支持（仍须留意语境与版本）', novel_only: '两边已查：仅小说有支持，Wiki未提供相关依据', reference_only: '只有百科或时间线参考，缺小说依据', conflict: '来源冲突 · 待核实', pending: '参考资料不足 · 待核实', none: '未作原著对照' })[r.canonStatus] || '原著对照待核实')}：${html(r.canon || r.canonQuery || '当前记录来自聊天摘录。')}</p>
      ${r.wikiQuery ? `<p>待核对：${html(r.wikiQuery)}<br>${html(r.wikiNote || '尚未完成阅读与判断。')}</p>` : ''}
      ${r.canonConflict ? `<p>来源差异：${html(r.canonConflict)}</p>` : ''}
      ${(r.canonEvidence || []).map(p => `<blockquote>${html(p.title)}<br>${html(p.quote)}</blockquote>`).join('')}${sourceTitles.length ? `<small>参考来源：${html(sourceTitles.join(' / '))}</small>` : ''}</details>
      ${pendingQuestions(r).length ? `<details><summary>待核实 · ${pendingQuestions(r).length}</summary><ul>${pendingQuestions(r).map(q => `<li>${html(q)}</li>`).join('')}</ul></details>` : ''}
      <div class="bf-card-actions"><button data-action="edit" data-id="${html(r.id)}">修正</button><button data-action="lock" data-id="${html(r.id)}">${r.locked ? '解除锁定' : '锁定并优先提醒'}</button><button data-action="dismiss" data-id="${html(r.id)}">撤下</button></div>
    </article>`;
}
function render() {
    if (!panel || !panel.open) return;
    // Keep in-progress edits intact while an automatic analysis finishes.
    if (panel.querySelector('[data-editor]')) return;
    const data = ledger(), current = owner();
    const ready = view.records.filter(r => !r.supersededBy && isVerifiedDivergence(r));
    const pending = view.records.filter(r => !r.supersededBy && isMajorCandidate(r) && !isVerifiedDivergence(r));
    const legacy = view.records.filter(r => !r.supersededBy && !isMajorCandidate(r));
    const history = view.records.filter(r => r.supersededBy && isMajorCandidate(r));
    panel.innerHTML = `<header class="bf-header"><div><div class="bf-eyebrow">世界线记录</div><h2>蝴蝶效应 <small>试用版 ${VERSION}</small></h2></div><button class="bf-close" data-action="close" aria-label="关闭蝴蝶效应">×</button></header>
      <p class="bf-intro">只记录与原著有重大区别的已确立变化，用你提供的参考资料核对；发送前由所选模型判断本轮需要哪些分歧。</p>
      
      <div class="bf-chat">${html(context().chatId || '尚未选择聊天')}</div>
      <div class="bf-toolbar"><button data-action="settings">模型设置</button><button data-action="references" ${!current ? 'disabled' : ''}>参考资料 · ${(data.references || []).length}</button><button class="bf-primary" data-action="${data.enabled ? 'analyze' : 'enable'}" ${!current || task ? 'disabled' : ''}>${data.enabled ? '整理接下来的剧情' : '启用当前聊天'}</button>
      ${task ? '<button data-action="cancel">取消分析</button>' : ''}
      <button data-action="select" ${!current || !data.enabled || task || selector.pending ? 'disabled' : ''}>让模型整理发送对照</button>
      ${selector.pending ? '<button data-action="cancel-select">取消选择</button>' : ''}
      <button data-action="export" ${!data.batches.length ? 'disabled' : ''}>导出记录</button>
      ${data.enabled ? '<button data-action="disable">暂停此聊天</button>' : ''}</div>
      <div class="bf-options"><label><input type="checkbox" data-option="auto" ${data.auto ? 'checked' : ''} ${!data.enabled ? 'disabled' : ''}> 回复后检查重大分歧</label><label><input type="checkbox" data-option="inject" ${data.inject ? 'checked' : ''} ${!data.enabled ? 'disabled' : ''}> 将已核实的重大分歧加入下一轮生成</label></div>
      <div class="bf-status" role="status" data-status>${html(status)}</div>
      ${view.batches.at(-1)?.notes?.length ? `<details><summary>本次整理说明</summary><ul>${view.batches.at(-1).notes.map(n => `<li>${html(n)}</li>`).join('')}</ul></details>` : ''}
      <div class="bf-stats"><div><b>${ready.length}</b><span>重大原著分歧</span></div><div><b>${pending.length}</b><span>待核实 · 不发送</span></div><div><b>${view.end < 0 ? '—' : '#' + view.end}</b><span>已整理至</span></div></div>
      <p class="bf-hint">首次从最近 8 条消息开始，之后按长度分批接着整理，每批最多 8 条，正文不截断。${data.inject ? '当前已开启写作约束。' : '当前为预览模式，写作约束尚未加入生成。'}${view.invalid ? ` 有 ${view.invalid} 次历史整理因剧情变化或撤销而停用，原记录仍保留。` : ''}</p>
      <details class="bf-preview"><summary>下一轮发送预览 · ${selectionMode === 'model' ? '模型已整理' : selectionMode === 'fallback' ? '已有依据的简要对照' : selectionMode === 'empty' ? '没有有效记录' : selectionMode === 'unavailable' ? '本轮未加入' : '待模型判断'} · ${preview.groupCount || 0} 组 · ${preview.verifiedGroupCount || 0} 组有资料引文</summary><pre>${html(preview.text || (selectionMode === 'pending' ? '生成前会让模型按事件归组，整理原著情况、当前剧情和改变的前提；也可点击上方按钮预览。' : selectionMode === 'unavailable' ? '本轮资料未完成，未加入正文。' : '本轮没有需要发送的记录。'))}</pre><small>模型 按变化事件合并记录，区分已发生、计划和未确定事项，并说明与原著不同的前提。已有对照直接采用，缺口仅在你提供的参考资料中核对；未核实的差异不下结论。每组保留聊天楼层依据，锁定优先，整组按 6500 字符预算发送。整理失败会提示并使用已有依据的简要对照。</small></details>
      <main class="bf-records">${ready.length ? [...ready].reverse().map(recordMarkup).join('') : '<div class="bf-empty"><div>当前没有已核实的重大原著分歧。</div><p>日常回合没有新条目是正常情况。</p></div>'}</main>
      ${pending.length ? `<details><summary>待核实的重大分歧 · ${pending.length} 条 · 不发送</summary>${pending.map(recordMarkup).join('')}</details>` : ''}
      ${history.length ? `<details><summary>已更新的历史分歧 · ${history.length} 条</summary>${history.map(recordMarkup).join('')}</details>` : ''}
      ${legacy.length ? `<details><summary>旧标准记录 · ${legacy.length} 条 · 暂不发送</summary><p>这些记录尚未通过重大原著分歧筛选。原内容仍在导出记录中。</p></details>` : ''}
      ${view.dismissedRecords?.length ? `<details><summary>已撤下 · ${view.dismissedRecords.length}</summary>${view.dismissedRecords.map(r => `<p>${html(r.title)} <button data-action="restore" data-id="${html(r.id)}">恢复记录</button></p>`).join('')}</details>` : ''}
      ${view.batches.length ? `<footer><button data-action="undo">撤销最近一次整理</button><span>原始聊天和旧表保留。</span></footer>` : ''}`;
}
async function show() {
    if (!panel.open) panel.showModal();
    render(); await refresh();
}
function showEditor(r) {
    const box = document.createElement('form'); box.dataset.editor = r.id; box.className = 'bf-editor';
    box.innerHTML = `<h3>修正记录</h3><label>已发生的变化<textarea name="fact" maxlength="700" required>${html(r.fact)}</textarea></label><label>后续写作约束<textarea name="constraint" maxlength="500">${html(r.constraint)}</textarea></label><p>保存后将用你的修正替代自动摘录发送。来源楼层保持不变；剧情分支改变后，这次修正也会停用。</p><button class="bf-primary" type="submit">保存修正</button> <button type="button" data-action="cancel-edit">取消</button>`;
    panel.append(box); box.querySelector('textarea').focus();
    box.onsubmit = async event => { event.preventDefault(); const form = new FormData(box); await editRecord(r.id, { fact: String(form.get('fact')).trim(), constraint: String(form.get('constraint')).trim(), locked: true }); box.remove(); render(); };
}
async function editRecord(id, changes) {
    selector.cancel(); clearPrompt();
    controller?.abort();
    const current = owner(), h = await fingerprints(context().chat);
    if (current !== owner()) return;
    const data = structuredClone(ledger());
    const previous = data.edits[id];
    const active = previous && h[previous.end] === previous.hash ? previous : {};
    data.edits[id] = { ...active, ...changes, end: h.length - 1, hash: h.at(-1), editedAt: new Date().toISOString() };
    await persist(data, current); await refresh();
}
async function action(event) {
    const target = event.target.closest('[data-action]'); if (!target) return;
    const act = target.dataset.action, data = structuredClone(ledger());
    if (act === 'close') { panel.querySelector('[data-editor]')?.cancel?.(); return panel.close(); }
    if (act === 'settings') return showSettings(panel, context(), saved => { if (saved) { selector.cancel(); controller?.abort(); clearPrompt(); setStatus('模型设置已保存。'); } render(); });
    if (act === 'references') {
        const current = owner();
        return showReferences(panel, data.references, async references => {
            if (owner() !== current) throw Error('聊天已切换，参考资料未写入。');
            selector.cancel(); controller?.abort(); clearPrompt();
            const next = structuredClone(ledger()); next.references = references; await persist(next, current);
            setStatus('参考资料已保存；后续整理和发送前核对会使用这些资料。');
        }, () => void refresh());
    }
    if (act === 'cancel') return controller?.abort();
    if (act === 'cancel-select') { selector.cancel(); return; }
    if (act === 'select') return selectForScene('normal', true);
    if (act === 'cancel-edit') { panel.querySelector('[data-editor]')?.remove(); return render(); }
    if (act === 'enable') { data.enabled = true; data.auto = true; await persist(data); setStatus('已启用。点击“整理接下来的剧情”开始第一次分析。'); return refresh(); }
    if (act === 'disable') { selector.cancel(); controller?.abort(); data.enabled = false; clearPrompt(); await persist(data); return refresh(); }
    if (act === 'analyze') return analyze();
    if (act === 'export') {
        const blob = new Blob([JSON.stringify({ chat: context().chatId, exportedAt: new Date().toISOString(), ledger: data }, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = `蝴蝶效应-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return;
    }
    if (act === 'undo') { selector.cancel(); controller?.abort(); const last = view.batches.at(-1); if (last) { data.batches.find(b => b.id === last.id).revoked = true; await persist(data); setStatus('最近一次整理已撤销，可以重新分析。'); } return refresh(); }
    const record = [...view.records, ...(view.dismissedRecords || [])].find(r => r.id === target.dataset.id); if (!record) return;
    if (act === 'edit') return showEditor(record);
    if (act === 'lock') return editRecord(record.id, { locked: !record.locked });
    if (act === 'dismiss') { await editRecord(record.id, { dismissed: true }); setStatus('已撤下这条记录；导出文件保留原记录。'); }
    if (act === 'restore') return editRecord(record.id, { dismissed: false });
}
function changed() { clearPrompt(); controller?.abort(); panel?.querySelector('[data-editor]')?.cancel?.(); panel?.querySelector('[data-editor]')?.remove(); void refresh().catch(e => setStatus(e.message)); }
function chatChanged() {
    const next = owner();
    if (next === observedOwner) {
        // Host/plugin reload notifications can refer to the same chat. Content
        // validation still rejects stale results; the notification alone is not a cancel.
        void refresh().catch(e => setStatus(e.message));
        return;
    }
    observedOwner = next;
    selector.cancel(); previewType = 'normal'; clearTimeout(timer); changed(); setStatus('已切换聊天，记录与当前存档对应。');
}
function generated() {
    clearTimeout(timer);
    if (stoppedGeneration) return;
    timer = setTimeout(() => { if (ledger().enabled && ledger().auto) void analyze(); else void refresh(); }, 600);
}
async function intercept(_chat, _size, abort, type) {
    clearPrompt();
    if (!ledger().enabled || !ledger().inject || !mainGenerationTypes.includes(type ?? 'normal')) return;
    const current = owner(), generation = generationEpoch;
    const assertCurrent = () => {
        if (disposed) throw selectionAborted('插件已停用');
        if (owner() !== current) throw selectionAborted('聊天已切换');
        if (stoppedGeneration) throw selectionAborted('酒馆发出了停止生成通知');
        if (generation !== generationEpoch) throw selectionAborted('已开始另一轮正文生成');
    };
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            if (task) await task;
            assertCurrent();
            if (!ledger().enabled || !ledger().inject) return;
            const result = await selectForScene(type ?? 'normal', attempt > 0);
            assertCurrent();
            if (!ledger().enabled || !ledger().inject) return;
            const now = await selectionSnapshot(type ?? 'normal');
            assertCurrent();
            if (!ledger().enabled || !ledger().inject) return;
            if (now.key !== result.key) throw selectionSceneChanged('发送前的聊天依据已更新');
            context().setExtensionPrompt(KEY, result.prompt.text, 1, 1, false, 0);
            return;
        } catch (error) {
            // Only the current generation may clear its prompt. A late cancelled
            // request must not erase the prompt of the next chat/generation.
            if (owner() === current && generation === generationEpoch) clearPrompt();
            let failure = error;
            try { assertCurrent(); } catch (cancelled) { failure = cancelled; }
            if (failure.name !== 'AbortError' && (!ledger().enabled || !ledger().inject)) return;
            if (failure.name === 'SceneChangedError' && attempt === 0) {
                setStatus('当前聊天依据已更新，正在重新核对一次…');
                console.info('[Butterfly Continuity] selection retry: scene_changed');
                continue;
            }
            if (failure.name === 'AbortError') {
                setStatus(`本次生成已停止：${failure.message}`);
                console.warn('[Butterfly Continuity] generation cancelled:', failure.message);
                abort(true);
                return;
            }
            preview = { text: '', selected: [], canonSelected: [] }; selectionMode = 'unavailable';
            const reason = failure.name === 'SceneChangedError' ? '聊天依据仍在更新' : '蝴蝶资料准备失败';
            setStatus(`${reason}，本轮未加入蝴蝶资料，正文继续生成。`);
            console.warn('[Butterfly Continuity] selection omitted:', failure.name, failure.message);
            globalThis.toastr?.warning(`${reason}，本轮未加入蝴蝶资料，正文继续生成。`, '蝴蝶效应');
            render();
            return;
        }
    }
}
export function dispose() {
    disposed = true; revision++; clearTimeout(timer); selector.cancel(); controller?.abort(); clearPrompt();
    for (const [name, fn] of listeners) context().eventSource.removeListener(name, fn);
    listeners.length = 0; panel?.querySelector('[data-editor]')?.cancel?.(); button?.remove(); panel?.remove(); settingsLink?.remove(); delete globalThis.ButterflyContinuity_Intercept;
}
export function initialize() {
    if (button?.isConnected) return;
    disposed = false;
    const c = context();
    observedOwner = owner();
    for (const key of ['setExtensionPrompt', 'saveMetadata', 'getRequestHeaders', 'saveSettingsDebounced']) if (typeof c[key] !== 'function') throw new Error(`蝴蝶效应缺少宿主能力：${key}`);
    button = document.createElement('button'); button.id = 'butterfly-continuity-open'; button.textContent = '蝴蝶效应'; button.title = '打开世界线记录'; button.onclick = () => void show(); document.body.append(button);
    panel = document.createElement('dialog'); panel.id = 'butterfly-continuity-panel'; panel.setAttribute('aria-label', '蝴蝶效应 · 世界线记录'); document.body.append(panel);
    panel.addEventListener('cancel', () => panel.querySelector('[data-editor]')?.cancel?.());
    panel.onclick = event => void action(event).catch(e => setStatus(e.message));
    panel.onchange = async event => { const option = event.target.dataset.option; if (!['auto', 'inject'].includes(option)) return; if (option === 'inject') { selector.cancel(); clearPrompt(); } const data = structuredClone(ledger()); data[option] = event.target.checked; await persist(data); await refresh(); };
    settingsLink = document.createElement('div');
    settingsLink.id = 'butterfly-continuity-settings';
    settingsLink.innerHTML = `<button type="button" class="menu_button bf-settings-open" aria-label="蝴蝶效应 · 打开世界线记录" aria-haspopup="dialog" aria-controls="butterfly-continuity-panel">
        <span class="bf-settings-icon fa-solid fa-code-branch" aria-hidden="true"></span>
        <span class="bf-settings-label"><span class="bf-settings-title">蝴蝶效应</span><span class="bf-settings-description">世界线记录</span></span>
        <span class="bf-settings-arrow" aria-hidden="true">›</span>
    </button>`;
    settingsLink.querySelector('button').onclick = () => void show();
    document.querySelector('#extensions_settings')?.append(settingsLink);
    const on = (key, fn) => { const name = c.eventTypes[key]; if (name) { c.eventSource.on(name, fn); listeners.push([name, fn]); } };
    on('CHAT_CHANGED', chatChanged); on('CHAT_LOADED', chatChanged);
    for (const key of ['MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED']) on(key, changed);
    on('GENERATION_ENDED', generated);
    on('GENERATION_STARTED', (type, _options, dryRun) => { if (!dryRun && mainGenerationTypes.includes(type ?? 'normal')) { generationEpoch++; stoppedGeneration = false; clearTimeout(timer); } });
    on('GENERATION_STOPPED', () => { stoppedGeneration = true; selector.cancel(); clearPrompt(); clearTimeout(timer); });
    globalThis.ButterflyContinuity_Intercept = intercept;
    void refresh().catch(e => setStatus(e.message));
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true }); else initialize();
