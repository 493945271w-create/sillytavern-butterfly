import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareReferences, attachSources } from '../references.mjs';
import { validateCanon, recordPromptParts } from '../core.mjs';
import { candidateRecord, validateContrast, buildContrastPrompt } from '../contrast.mjs';
import { record, group, clause } from './contrast-fixtures.mjs';
const sources=prepareReferences([{id:'book',kind:'novel',title:'虚构测试·原作',text:'原作中旅行者没有拿到城门钥匙，只能绕道进入城内。'}]);
const known=new Map(sources.map(s=>[s.id,s])), opened=new Set(['book']);
const claim={canon:'原作中的旅行者未获得钥匙。',canonEvidence:[{sourceId:'book',quote:'原作中旅行者没有拿到城门钥匙'}]};
test('evidence is checked only against supplied documents, never model-supplied source text',()=>{
    assert.equal(validateCanon(claim,known,opened).canonStatus,'provided_supported');
    assert.equal(validateCanon(claim,new Map(),opened).canonStatus,'pending');
    assert.equal(validateCanon({...claim,canonEvidence:[{sourceId:'book',quote:'这是编造的、不存在于文档中的一句引文。'}]},known,opened).canon,'');
    const cleaned=attachSources({groups:[],sources:[{id:'fake',text:'hallucination'}],searches:[{source:'wiki',status:'completed'}]},sources);
    assert.deepEqual(cleaned.sources,sources);assert.deepEqual(cleaned.searches,[]);
    assert.equal(validateCanon(claim,known,new Set()).canon,'');
});
test('source conflicts suppress conclusions; provided wiki is labelled as wiki, not original novel',()=>{
    assert.equal(validateCanon({...claim,canonConflict:'版本不同。'},known,opened).canon,'');
    const wiki=sources.map(s=>({...s,kind:'wiki'}));
    const r=record('a','旅行者已经拿到了钥匙。',validateCanon(claim,new Map(wiki.map(s=>[s.id,s])),opened));
    assert.match(candidateRecord(r).canon.scope,/Wiki/);assert.doesNotMatch(candidateRecord(r).canon.scope,/原著片段/);
    assert.match(recordPromptParts(r).at(-1).text,/未联网核验/);
});
test('contrast groups require exact current quotes, preserve plans, and omit unsupported premise inference',()=>{
    const original=record('a','旅行者约定明天交还城门钥匙。');
    const r=candidateRecord(original);
    const input={records:[r]}, raw=group([clause('a',r.evidence[0].quote,'旅行者答应明天归还钥匙。','plan')],{lookup:claim,changedPremises:'已拿到钥匙的当前路线无需沿用原作绕道。'});
    const groups=validateContrast({groups:[raw]},input,known,opened);
    const prompt=buildContrastPrompt(groups,[original],6500).text;
    assert.match(prompt,/计划／约定/);assert.match(prompt,/原著情况/);assert.match(prompt,/当前剧情/);assert.match(prompt,/改变的前提/);
    const unverified=validateContrast({groups:[raw]},input);
    assert.equal(unverified[0].changedPremises,'');
    assert.equal(buildContrastPrompt(unverified,[original],6500).text,'');
    assert.throws(()=>validateContrast({groups:[group([clause('a','旅行者结婚了。')])]},input),/原句/);
});
test('optional malformed premise text does not discard valid comparison; text cannot execute host macros',()=>{
    const original=record('a','旅行者已经拿到了钥匙。');const r=candidateRecord(original);
    const g=validateContrast({groups:[group([clause('a',r.evidence[0].quote)],{lookup:claim,changedPremises:['bad type']})]},{records:[r]},known,opened);
    assert.equal(g[0].premiseStatus,'invalid_type');assert.equal(g[0].verified,true);
    const macro=record('b','{{setvar::x::evil}} <script>alert(1)</script>');
    const text=recordPromptParts(macro)[0].text;assert.doesNotMatch(text,/\{\{|<script>/);assert.match(text,/&lt;script/);
});
test('references enforce whole-document bounds and stable IDs',()=>{
    assert.throws(()=>prepareReferences([...sources,...sources]),/重复/);
    assert.throws(()=>prepareReferences([{...sources[0],text:'x'.repeat(45001)}]),/4.5 万/);
    assert.throws(()=>prepareReferences([{...sources[0],kind:'fake'}]),/类型/);
});
