import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyLedger, fingerprints, project, validateAnalysis, makeBatch, buildPrompt, analysisWindow } from '../core.mjs';
import { majorFields } from './contrast-fixtures.mjs';
const chat = [{ name: '旁白', mes: '守卫把城门钥匙交给了旅行者。', is_user: false }, { name: '玩家', mes: '我想让桥明天塌掉。', is_user: true }, { name: '旁白', mes: '城门已经打开，车队进入了城内。', is_user: false }];
const messages = chat.map((m, id) => ({ id, role: m.is_user ? 'user' : 'assistant', text: m.mes }));
const event = (ref = 'E1') => ({ ref, ...majorFields(ref), title: '钥匙转交', fact: '旅行者持有城门钥匙。', constraint: '后续应记住钥匙由旅行者持有，直至再次转交。', entities: ['旅行者'], parentRefs: [], evidence: [{ messageId: 0, quote: '守卫把城门钥匙交给了旅行者。' }], openQuestions: ['桥是否会坍塌尚未发生。'] });
test('逐字依据校验，拒绝不存在的引用及用户意愿作为事实', () => {
    assert.equal(validateAnalysis({ events: [event()], notes: [] }, messages).events.length, 1);
    assert.throws(() => validateAnalysis({ events: [{ ...event(), evidence: [{ messageId: 0, quote: '旅行者摧毁了桥。' }] }], notes: [] }, messages), /依据/);
    assert.throws(() => validateAnalysis({ events: [{ ...event(), evidence: [{ messageId: 1, quote: chat[1].mes }] }], notes: [] }, messages), /依据/);
});
test('因果按顺序连接，拒绝循环和不存在的起因', () => {
    const e2 = { ...event('E2'), parentRefs: ['E1'], title: '城门开启' };
    assert.equal(validateAnalysis({ events: [event(), e2], notes: [] }, messages).events.length, 2);
    assert.throws(() => validateAnalysis({ events: [{ ...event(), parentRefs: ['E2'] }, e2], notes: [] }, messages), /因果/);
});
test('不同聊天内容、删改与切换分支会使后续记录失效，返回原分支能恢复', async () => {
    const hashes = await fingerprints(chat), ledger = emptyLedger();
    ledger.batches.push(makeBatch({ events: [event()], notes: [] }, { start: 0, end: 2, hash: hashes[2] }));
    assert.equal(project(ledger, hashes).records.length, 1);
    const changed = structuredClone(chat); changed[0].mes = '守卫收回钥匙。';
    assert.equal(project(ledger, await fingerprints(changed)).records.length, 0);
    assert.equal(project(ledger, await fingerprints(chat.slice(0, 2))).records.length, 0);
    assert.equal(project(ledger, await fingerprints(chat)).records.length, 1);
});
test('新回复不撤销已有事实，手工修正绑定当前分支', async () => {
    const hashes = await fingerprints(chat), ledger = emptyLedger();
    ledger.batches.push(makeBatch({ events: [event()], notes: [] }, { start: 0, end: 0, hash: hashes[0] }));
    const id = ledger.batches[0].events[0].id;
    ledger.edits[id] = { fact: '人工修正', locked: true, end: 2, hash: hashes[2] };
    assert.equal(project(ledger, hashes).records[0].fact, '人工修正');
    assert.equal(project(ledger, hashes.slice(0, 1)).records[0].fact, event().fact);
    assert.equal(project(ledger, await fingerprints([...chat, { mes: '车队停了下来。' }])).records.length, 1);
});
test('待核实影响不注入；未核实的原著引用不作为原著结论', () => {
    const clean = validateAnalysis({ events: [{ ...event(), canon: '原著中桥坍塌了。', canonSourceIds: ['fake'] }], notes: [] }, messages, [], new Map());
    assert.equal(clean.events[0].canon, '');
    const record = makeBatch(clean, { start: 0, end: 2, hash: 'x' }).events[0];
    const prompt = buildPrompt([record], '旅行者');
    assert.equal(prompt.text, ''); assert.deepEqual(prompt.selected, []);
});
test('增量窗口不会重复整理，也不把末尾用户愿望当完整剧情', () => {
    assert.equal(analysisWindow(chat, { end: 2 }), null);
    assert.equal(analysisWindow(chat, { end: 0 }).start, 1);
    assert.equal(analysisWindow(chat.slice(0, 2), { end: -1 }).end, 0);
});
test('撤下记录与撤销分析保留导出原始记录', async () => {
    const hashes = await fingerprints(chat), ledger = emptyLedger();
    ledger.batches.push(makeBatch({ events: [event()], notes: [] }, { start: 0, end: 2, hash: hashes[2] }));
    ledger.edits[ledger.batches[0].events[0].id] = { dismissed: true, end: 2, hash: hashes[2] };
    assert.equal(project(ledger, hashes).records.length, 0);
    assert.equal(ledger.batches[0].events.length, 1);
    ledger.batches[0].revoked = true;
    assert.equal(project(ledger, hashes).end, -1);
});
test('归还钥匙后旧持有约束退出；删除归还剧情则恢复旧状态', async () => {
    const h = await fingerprints(chat), ledger = emptyLedger();
    const first = makeBatch({ events: [event()], notes: [] }, { start: 0, end: 0, hash: h[0] });
    const id = first.events[0].id;
    const second = makeBatch({ events: [{ ...event('E2'), fact: '钥匙已经归还。', constraint: '旅行者已经不持有钥匙。', supersedes: [id] }], notes: [] }, { start: 1, end: 2, hash: h[2] });
    ledger.batches.push(first, second);
    assert.equal(project(ledger, h).records[0].supersededBy, second.events[0].id);
    assert.equal(buildPrompt(project(ledger, h).records).selected.length, 1);
    assert.equal(project(ledger, h.slice(0, 1)).records[0].supersededBy, '');
});
test('撤下中间状态不会让更早的过时约束复活', async () => {
    const h = await fingerprints(chat), ledger = emptyLedger();
    const batch = makeBatch({ events: [event('A'), { ...event('B'), supersedes: ['A'] }, { ...event('C'), supersedes: ['B'] }], notes: [] }, { start: 0, end: 2, hash: h[2] });
    ledger.batches.push(batch);
    ledger.edits[batch.events[1].id] = { dismissed: true, end: 2, hash: h[2] };
    const visible = project(ledger, h).records;
    assert.equal(visible.length, 2);
    assert.equal(buildPrompt(visible).selected.length, 1);
});
