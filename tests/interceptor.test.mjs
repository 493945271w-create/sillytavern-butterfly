import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import { group, clause, majorFields } from './contrast-fixtures.mjs';
import { KEY, fingerprints, emptyLedger } from '../core.mjs';
async function host() {
    const chat=[{is_user:false,name:'旅人',mes:'旅人已获得城门钥匙。'},{is_user:true,name:'玩家',mes:'去开那扇门。'},{is_user:false,name:'旅人',mes:'上一轮回复。'}];
    const data=emptyLedger();data.enabled=true;data.inject=true;
    const h=await fingerprints(chat);
    data.batches=[{id:'batch',start:0,end:0,hash:h[0],events:[{id:'key',...majorFields(),title:'钥匙',fact:'摘要',constraint:'',entities:[],parentIds:[],evidence:[{messageId:0,quote:chat[0].mes}],openQuestions:[]}]}];
    let resolveReply, startRequest, captured, saves=0, requests=0, beforeReply;
    const started=new Promise(r=>startRequest=r), reply=new Promise(r=>resolveReply=r);
    const prompts=[],events=new Map();
    const c={chat,chatId:'test',characters:[{avatar:'card.png'}],characterId:0,chatMetadata:{[KEY]:data},setExtensionPrompt:(_k,text)=>prompts.push(text),saveMetadata:async()=>{saves++;},eventSource:{on:(n,f)=>events.set(n,f),removeListener(){}},eventTypes:Object.fromEntries(['CHAT_CHANGED','CHAT_LOADED','MESSAGE_UPDATED','GENERATION_STOPPED','GENERATION_STARTED','GENERATION_ENDED'].map(x=>[x,x]))};
    c.getRequestHeaders=()=>({'Content-Type':'application/json'});c.saveSettingsDebounced=()=>{};
    c.extensionSettings={butterfly_continuity_api_v1:{url:'https://provider.example/v1',model:'fixture-model',timeout:30,maxTokens:6000}};
    const node=()=>({isConnected:true,open:false,dataset:{},setAttribute(){},addEventListener(){},append(){},remove(){},querySelector(selector){return selector==='button'?{}:null;}});
    const context=vm.createContext({SillyTavern:{getContext:()=>c},document:{readyState:'loading',addEventListener(){},createElement:node,body:node(),querySelector(){return null;}},crypto,URL,TextEncoder,DOMException,AbortController,structuredClone,setTimeout,clearTimeout,console,
        fetch:async(url,options)=>{
            assert.equal(url,'/api/backends/chat-completions/generate');
            requests++;captured=JSON.parse(JSON.parse(options.body).messages[1].content);startRequest();
            return{ok:true,status:200,json:async()=>{const result=await reply;beforeReply?.();return{choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]};}};
        }});
    const cache=new Map();
    function module(name){
        name=name.split('?')[0].replace('./','');
        if(cache.has(name))return cache.get(name);
        const loading=(async()=>{
            const m=new vm.SourceTextModule(await fs.readFile(new URL('../'+name,import.meta.url),'utf8'),{context,identifier:name});
            await m.link(module);return m;
        })();
        cache.set(name,loading);return loading;
    }
    const entry=await module('index.js');await entry.evaluate();entry.namespace.initialize();
    return {c,events,prompts,started,resolveReply,get captured(){return captured;},get saves(){return saves;},get requests(){return requests;},set beforeReply(fn){beforeReply=fn;},intercept:context.ButterflyContinuity_Intercept,dispose:()=>entry.namespace.dispose()};
}
test('真实拦截器等待 模型 编号后才安装单标签提示；包含最新输入且不保存聊天',async()=>{
    const h=await host(); const aborted=[];
    h.c.chat.push({is_user:true,name:'玩家',mes:'刚输入的最新行动'});
    const run=h.intercept([],0,x=>aborted.push(x),'normal');await h.started;
    assert.equal(h.prompts.filter(Boolean).length,0);
    assert.equal(h.captured.messages.at(-1).text,'刚输入的最新行动');
    h.resolveReply({groups:[group([clause('key','旅人已获得城门钥匙。')])]});await run;
    assert.match(h.prompts.at(-1),/^<butterfly_continuity>/);assert.equal((h.prompts.at(-1).match(/<butterfly_continuity>/g)||[]).length,1);
    assert.deepEqual(aborted,[]);assert.equal(h.saves,0);h.dispose();
});
test('重新抽取回复时不把待替换的旧回复交给选择器',async()=>{
    const h=await host(),aborted=[];
    const run=h.intercept([],0,x=>aborted.push(x),'swipe');await h.started;
    assert.ok(h.captured.messages.every(m=>m.text!=='上一轮回复。'));assert.equal(h.captured.messages.at(-1).role,'user');
    h.resolveReply({groups:[group([clause('key','旅人已获得城门钥匙。')])]});await run;assert.deepEqual(aborted,[]);h.dispose();
});
test('切换聊天或停止生成后，即便后台随后完成也不能发送旧选择',async()=>{
    for(const event of ['CHAT_CHANGED','GENERATION_STOPPED']){
        const h=await host(),aborted=[];const run=h.intercept([],0,x=>aborted.push(x),'normal');await h.started;
        if(event==='CHAT_CHANGED')h.c.chatId='other';h.events.get(event)();
        h.resolveReply({groups:[group([clause('key','旅人已获得城门钥匙。')])]});await run;
        assert.equal(h.prompts.filter(Boolean).length,0);assert.deepEqual(aborted,[true]);h.dispose();
    }
});
test('同一聊天重复加载通知不会中断正在准备的正文',async()=>{
    const h=await host(),aborted=[];
    try {
        const run=h.intercept([],0,x=>aborted.push(x),'normal');await h.started;
        h.events.get('CHAT_CHANGED')();
        h.resolveReply({groups:[group([clause('key','旅人已获得城门钥匙。')])]});await run;
        assert.deepEqual(aborted,[]);assert.match(h.prompts.at(-1),/^<butterfly_continuity>/);assert.equal(h.requests,1);
    } finally {h.dispose();}
});
test('同一聊天在选择期间修改最新消息，会用最新消息重新选择一次',async()=>{
    const h=await host(),aborted=[];
    try {
        const run=h.intercept([],0,x=>aborted.push(x),'normal');await h.started;
        h.c.chat.at(-1).mes='旅人现在到了北城门。';
        h.resolveReply({groups:[group([clause('key','旅人已获得城门钥匙。')])]});await run;
        assert.deepEqual(aborted,[]);assert.equal(h.requests,2);
        assert.equal(h.captured.messages.at(-1).text,'旅人现在到了北城门。');assert.equal(h.prompts.filter(Boolean).length,1);assert.equal(h.saves,0);
    } finally {h.dispose();}
});
test('消息持续更新时有重试上限，丢弃旧资料但不终止正文',async()=>{
    const h=await host(),aborted=[];
    try {
        h.beforeReply=()=>{h.c.chat.at(-1).mes+='继续变化。';};
        const run=h.intercept([],0,x=>aborted.push(x),'normal');await h.started;
        h.resolveReply({groups:[group([clause('key','旅人已获得城门钥匙。')])]});await run;
        assert.deepEqual(aborted,[]);assert.equal(h.requests,2);assert.equal(h.prompts.filter(Boolean).length,0);assert.equal(h.saves,0);
    } finally {h.dispose();}
});
test('用户停止后，辅助 quiet 生成不得重新放行旧正文',async()=>{
    const h=await host(),aborted=[];
    try {
        const run=h.intercept([],0,x=>aborted.push(x),'normal');await h.started;
        h.events.get('GENERATION_STOPPED')();h.events.get('GENERATION_STARTED')('quiet',{},false);
        h.resolveReply({groups:[group([clause('key','旅人已获得城门钥匙。')])]});await run;
        assert.deepEqual(aborted,[true]);assert.equal(h.prompts.filter(Boolean).length,0);
    } finally {h.dispose();}
});
