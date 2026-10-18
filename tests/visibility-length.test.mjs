import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprints, emptyLedger, project, makeBatch, migrateLegacyAnchors, analysisWindow } from '../core.mjs';
import { prepareButterflyInput } from '../analysis.mjs';

const story = [
    { name: '旅行者', is_user: true, mes: '向守卫借钥匙。' },
    { name: '旁白', is_user: false, mes: '守卫交出钥匙。' },
];
const event = { ref: 'key', title: '借到钥匙', fact: '旅行者持有钥匙。', constraint: '', entities: ['旅行者'], parentRefs: [], evidence: [{ messageId: 1, quote: '守卫交出钥匙。' }], canonSourceIds: [], openQuestions: [] };

test('隐藏旧楼层后续写：旧事实、手工修正、分析中的锚点保持有效', async () => {
    const hashes = await fingerprints(story), ledger = emptyLedger();
    ledger.batches.push(makeBatch({ events: [event], notes: [] }, { start: 0, end: 1, hash: hashes[1] }));
    ledger.edits[ledger.batches[0].events[0].id] = { fact: '手工确认持有钥匙', hash: hashes[1], end: 1 };
    const next = [...story.map(m => ({ ...m, is_system: true })), { name: '旁白', mes: '旅行者进入城内。' }];
    const after = await fingerprints(next);
    assert.equal(after[1], hashes[1]);
    const visible = project(ledger, after);
    assert.equal(visible.invalid, 0);
    assert.equal(visible.records[0].fact, '手工确认持有钥匙');
    for (const changed of [next.map((m, i) => i === 1 ? { ...m, mes: '守卫拒绝借出钥匙。' } : m), next.slice(1), next.map((m,i) => i === 1 ? {...m, is_user: true} : m)]) {
        assert.equal(project(ledger, await fingerprints(changed)).records.length, 0);
    }
});

test('只迁移能验证的旧锚点，不复活已经换分支的记录，不改写原账本', async () => {
    const old = await fingerprints(story, 1), current = await fingerprints(story);
    const ledger = emptyLedger();
    ledger.batches.push(makeBatch({ events: [event], notes: [] }, { start: 0, end: 1, hash: old[1] }));
    ledger.edits[ledger.batches[0].events[0].id] = { hash: old[1], end: 1, locked: true };
    ledger.batches.push({ ...ledger.batches[0], id: 'other-branch', hash: 'unknown-history' });
    const upgraded = migrateLegacyAnchors(ledger, current, old);
    assert.equal(upgraded.count, 2);
    assert.equal(project(upgraded.ledger, current).records.length, 1);
    assert.equal(project(upgraded.ledger, current).invalid, 1);
    assert.equal(ledger.batches[0].hash, old[1]);
    assert.equal(migrateLegacyAnchors(upgraded.ledger, current, old).count, 0);
    const hiddenOld = await fingerprints(story.map(m => ({ ...m, is_system: true })), 1);
    assert.equal(migrateLegacyAnchors(ledger, current, hiddenOld).count, 0);
});

test('2.4 万字符正文完整通过前后端，多个长楼层按连续消息分批且无遗漏', () => {
    const chat = Array.from({ length: 8 }, (_, i) => ({ name: i % 2 ? '旁白' : '旅行者', is_user: i % 2 === 0, mes: i % 2 ? '正文内容'.repeat(6000) : `请求 ${i}` }));
    let end = -1;
    const seen = [];
    while (true) {
        const window = analysisWindow(chat, { end });
        if (!window) break;
        const prepared = prepareButterflyInput(window);
        assert.equal(window.messages.at(-1).role, 'assistant');
        assert.equal(window.start, end + 1);
        assert.deepEqual(prepared.messages, window.messages);
        for (const m of prepared.messages) { assert.equal(m.text, chat[m.id].mes); seen.push(m.id); }
        end = window.end;
    }
    assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('边界恰好落在用户消息后时，用户请求仍与下一条正文一起处理', () => {
    const chat = [story[1], { ...story[0], mes: '问'.repeat(10000) }, { ...story[1], mes: '答'.repeat(44000) }];
    chat[0] = { ...chat[0], mes: '文'.repeat(20000) };
    const first = analysisWindow(chat, { end: -1 });
    assert.equal(first.end, 0);
    const next = analysisWindow(chat, { end: first.end });
    assert.deepEqual(next.messages.map(m => m.id), [1, 2]);
    assert.equal(next.messages[1].text.length, 44000);
    assert.equal(prepareButterflyInput(next).messages.length, 2);
});

test('超限仍明确报错，不截断正文或跳过未整理楼层', () => {
    const large = { ...story[1], mes: '文'.repeat(50001) };
    assert.throws(() => analysisWindow([large], { end: -1 }), /未截断/);
    assert.throws(() => prepareButterflyInput({ messages: [{ id: 0, role: 'assistant', text: large.mes }] }), /5 万/);
    assert.throws(() => prepareButterflyInput({ messages: [0, 1].map(id => ({ id, role: 'assistant', text: '文'.repeat(30000) })) }), /5.5 万/);
    const first = analysisWindow([story[1], large], { end: -1 });
    assert.equal(first.end, 0);
    assert.throws(() => analysisWindow([story[1], large], { end: first.end }), /未截断/);
});
