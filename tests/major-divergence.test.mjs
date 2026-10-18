import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAnalysis, makeBatch, project, emptyLedger, fingerprints, buildPrompt, isVerifiedDivergence } from '../core.mjs';
import { buildContrastFallback, candidateRecord, cleanCandidate } from '../contrast.mjs';
import { SelectionGate } from '../selection.mjs';
import { prepareReferences } from '../references.mjs';
import { record, majorFields } from './contrast-fixtures.mjs';

const messages=[{id:2,role:'assistant',text:'原本遇难的守卫获救，城门钥匙已经正式交给了旅行者。'}];
const sources=prepareReferences([{id:'book',kind:'novel',title:'虚构原作·城门',text:'原作中城门封锁，车队没有钥匙而无法入城。'}]);
const known=new Map(sources.map(s=>[s.id,s])),opened=new Set(['book']);
const event=extra=>({ref:'E1',...majorFields(),title:'城门通路改变',fact:messages[0].text,constraint:'',entities:['旅行者'],parentRefs:[],supersedes:[],evidence:[{messageId:2,quote:messages[0].text}],openQuestions:[],...extra});
const validate=(events,existing=[])=>validateAnalysis({events,notes:[]},messages,existing,known,opened);

test('日常、计划、缺少具体差异均不入库，空回合正常推进',()=>{
    const result=validate([event({importance:'minor'}),event({changeState:'plan'}),event({changedPremise:''}),event({canonQuery:''})]);
    assert.deepEqual(result.events,[]);assert.match(result.notes[0],/排除 4 条/);
    assert.equal(validate([event()]).events.length,1);
});
test('重大候选缺少原作引文只保留待核实，锁定也不会绕过发送检查',()=>{
    const candidate=validateAnalysis({events:[event()],notes:[]},messages).events[0];
    const r={...candidate,id:'pending',locked:true,parentIds:[]};
    assert.equal(r.canonStatus,'pending');assert.equal(isVerifiedDivergence(r),false);
    assert.equal(candidateRecord(r),null);assert.equal(buildPrompt([r]).text,'');
    assert.equal(buildContrastFallback([r],'守卫').text,'');
});
test('旧标准记录保留在账本，发送失败回退也不会混入普通日常',async()=>{
    const legacy=record('old','旅行者正在喝茶。',{divergencePolicyVersion:undefined,locked:true});
    const ledger=emptyLedger(),hashes=await fingerprints([{mes:'旧故事'}]);
    ledger.batches=[{id:'legacy',end:0,hash:hashes[0],events:[legacy]}];
    const active=project(ledger,hashes).records;
    assert.equal(active.length,1);assert.equal(active[0].evidence[0].quote,'旅行者正在喝茶。');
    assert.equal(buildPrompt(active).text,'');assert.equal(buildContrastFallback(active,'旅行者').text,'');
    const snapshot=async()=>({key:'one',owner:'chat',enabled:true,type:'normal',messages:[],sources:[],records:active});
    const gate=new SelectionGate({snapshot,request:async()=>{throw Error('不应请求模型');}});
    assert.equal((await gate.select()).mode,'empty');
});
test('同题更新需要合并旧条目并带本次新依据，普通重复记录会拒绝',()=>{
    const old=record('prior','守卫此前已经把钥匙借给旅行者。');
    assert.throws(()=>validate([event()],[old]),/合并更新/);
    const revised=event({supersedes:['prior'],evidence:[old.evidence[0],{messageId:2,quote:messages[0].text}]});
    assert.equal(validate([revised],[old]).events[0].evidence.length,2);
    assert.throws(()=>validate([{...revised,evidence:[old.evidence[0]]}],[old]),/本次剧情的新依据/);
    assert.throws(()=>validate([revised],[{...old,locked:true}]),/锁定/);
});
test('待核实的新版本不撤销已核实旧版本，核实后再取代，回档恢复',async()=>{
    const chat=[{mes:'守卫获救。'},{mes:'守卫正式转交钥匙。'}],h=await fingerprints(chat),ledger=emptyLedger();
    const old=record('prior');
    const pending=record('revision','守卫正式转交钥匙。',{supersedes:['prior'],canonStatus:'pending',canon:''});
    ledger.batches=[{id:'a',end:0,hash:h[0],events:[old]},{id:'b',end:1,hash:h[1],events:[pending]}];
    assert.equal(project(ledger,h).records[0].supersededBy,'');
    Object.assign(pending,majorFields());
    assert.equal(project(ledger,h).records[0].supersededBy,'revision');
    assert.equal(project(ledger,h.slice(0,1)).records[0].supersededBy,'');
});
test('候选清洗拒绝未核实资料，模型失败回退保留具体原著差异',()=>{
    const current=record('verified');
    const c=candidateRecord(current);
    assert.throws(()=>cleanCandidate({...c,canon:{verified:false,text:'',scope:''}}),/未核实/);
    const output=buildContrastFallback([current,record('daily','他们聊了一会儿。',{importance:'minor',locked:true})],'旅人');
    assert.deepEqual(output.selected,['verified']);assert.ok(output.text.includes(current.changedPremise));
    assert.doesNotMatch(output.text,/他们聊了一会儿/);
});
