// These are user-supplied excerpts, not search results or a bundled database.
export const REFERENCE_LIMIT = 45000;
export function prepareReferences(entries = []) {
    if (!Array.isArray(entries) || entries.length > 12) throw Error('参考资料最多 12 份。');
    const seen = new Set();
    const sources = entries.map(entry => {
        if (!entry || typeof entry.id !== 'string' || !/^[\w-]{1,80}$/.test(entry.id) || seen.has(entry.id)) throw Error('参考资料编号无效或重复。');
        if (!['novel', 'wiki', 'timeline', 'reference'].includes(entry.kind)) throw Error('参考资料类型不正确。');
        if (typeof entry.title !== 'string' || !entry.title.trim() || entry.title.length > 150 || typeof entry.text !== 'string' || !entry.text.trim()) throw Error('请填写参考资料标题和正文。');
        seen.add(entry.id);
        return { id: entry.id, kind: entry.kind, title: entry.title.trim(), text: entry.text.trim(), provided: true, opened: true };
    });
    if (JSON.stringify(sources).length > REFERENCE_LIMIT) throw Error('参考资料总量超过 4.5 万字符，请保留与当前故事阶段相关的片段。');
    return sources;
}
export function attachSources(result, sources) {
    // A model cannot invent its own source corpus or claim it performed searches.
    const { sources: _untrustedSources, searches: _untrustedSearches, ...content } = result;
    return { ...content, sources: prepareReferences(sources), searches: [] };
}
