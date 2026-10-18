import { prepareReferences } from './references.mjs';
import { candidateRecord, cleanCandidate, contrastSchema, contrastInstructions, validateContrast, buildContrastPrompt, buildContrastFallback } from './contrast.mjs?v=0.4.0';
export const SELECTION_BUDGET = 6500;
export const selectionSchema = contrastSchema;
export const selectionInstructions = contrastInstructions;
export function makeSelectionInput(snapshot) {
    return prepareSelectionInput({ type:snapshot.type, messages:snapshot.messages, sources:snapshot.sources, records:snapshot.records.filter(r=>!r.supersededBy&&!r.dismissed).map(candidateRecord).filter(Boolean) });
}
export function prepareSelectionInput(input) {
    if(!input||!['normal','regenerate','swipe','continue'].includes(input.type))throw Error('选择请求缺少生成类型');
    if(!Array.isArray(input.messages)||input.messages.length>4||!Array.isArray(input.records)||input.records.length>250)throw Error('选择资料超过本次处理范围；未截断记录');
    const messages=input.messages.map(m=>{
        if(!Number.isSafeInteger(m.id)||!['user','assistant'].includes(m.role)||typeof m.text!=='string')throw Error('场景格式不正确');
        return {id:m.id,role:m.role,text:m.text};
    });
    const records=input.records.map(cleanCandidate);
    if(new Set(records.map(r=>r.id)).size!==records.length)throw Error('候选编号重复');
    const clean={type:input.type,budget:SELECTION_BUDGET,messages,records,sources:prepareReferences(input.sources || [])};
    if(JSON.stringify(clean).length>300000)throw Error('场景和依据超过 30 万字符；未截断资料');
    return clean;
}
export function validateSelectionResult(result,input) {
    const sources=result?.sources||[];
    const groups=validateContrast(result,input,new Map(sources.map(s=>[s.id,s])),new Set(sources.filter(s=>s.opened).map(s=>s.id)),result.searches||[]);
    return {groups,selectedIds:[...new Set(groups.flatMap(g=>g.recordIds))]};
}
export const selectionAborted = (reason = '本轮选择已取消') => new DOMException(reason, 'AbortError');
export const selectionSceneChanged = (reason = '当前聊天内容已更新') => Object.assign(new Error(reason), { name: 'SceneChangedError' });
// This cache belongs to one page instance; decisions never modify the chat ledger.
export class SelectionGate {
    constructor({ snapshot, request, notify = () => {} }) { Object.assign(this, { snapshot, request, notify }); this.cached = null; this.pending = null; this.epoch = 0; }
    cancel() { this.epoch++; this.pending?.controller.abort(); this.cached = null; }
    async select(type = 'normal', force = false) {
        const epoch = this.epoch;
        const snap = await this.snapshot(type);
        if (epoch !== this.epoch || !snap?.enabled) throw selectionAborted();
        if (!force && this.cached?.key === snap.key && this.cached.mode !== 'fallback') return this.cached;
        if (this.pending?.key === snap.key) return this.pending.promise;
        this.pending?.controller.abort();
        const pending = { key: snap.key, controller: new AbortController() };
        this.pending = pending;
        const signal = pending.controller.signal;
        pending.promise = (async () => {
            let decision;
            try {
                const input = makeSelectionInput(snap);
                if (!input.records.length) decision = { mode: 'empty', prompt: buildContrastPrompt([], [], SELECTION_BUDGET), selectedIds: [] };
                else {
                    this.notify('模型 正在整理本轮相关的原著差异…');
                    const result = validateSelectionResult(await this.request(input, signal), input);
                    decision = { mode: 'model', selectedIds: result.selectedIds, prompt: buildContrastPrompt(result.groups, snap.records, SELECTION_BUDGET), groups: result.groups };
                }
            } catch (error) {
                if (signal.aborted || error.name === 'AbortError') throw selectionAborted();
                decision = { mode: 'fallback', error: error.message, selectedIds: [], prompt: buildContrastFallback(snap.records, snap.messages.map(m => m.text).join('\n'), SELECTION_BUDGET) };
            }
            const now = await this.snapshot(type);
            if (signal.aborted || !now?.enabled) throw selectionAborted();
            if (now.owner !== snap.owner) throw selectionAborted('聊天已切换，已丢弃旧聊天的选择');
            if (now.key !== snap.key) throw selectionSceneChanged();
            this.cached = { ...decision, key: snap.key };
            this.notify(decision.mode === 'fallback' ? `模型 选择失败：${decision.error}；本轮使用已有依据生成简要对照。`
                : decision.mode === 'empty' ? '当前没有可发送的有效记录。'
                    : `模型已整理 ${decision.prompt.groupCount} 组变化，关联 ${decision.prompt.selected.length} 条记录；${decision.prompt.verifiedGroupCount} 组有对应引文的参考对照。${decision.prompt.incompletePremiseGroupCount ? `其中 ${decision.prompt.incompletePremiseGroupCount} 组差异说明未完成，已保留事实对照。` : ''}`);
            return this.cached;
        })().finally(() => { if (this.pending === pending) this.pending = null; });
        return pending.promise;
    }
}
