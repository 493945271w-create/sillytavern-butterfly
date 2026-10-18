import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeRequest, nativeFetch, nativeText, parseResearch, nativeResearch, nativeModels, safeWebUrl } from '../native.mjs';
import { cleanSettings, normalizeBase, SETTINGS_KEY } from '../api.mjs';
import { requestAnalysis } from '../requests.mjs';
import { validateAnalysis, makeBatch, project, buildPrompt, validateCanon } from '../core.mjs';

const quote = '守卫已经将唯一的城门钥匙交给旅行者，允许他的车队从城门进入。';
const canon = '原作中城门封锁，旅行者的车队没有钥匙，只能绕道入城。';
const question = '测试作品中旅行者的车队为什么绕道入城？';
const config = provider => cleanSettings({provider,search:true,url:provider==='gemini'?'https://google.example/v1beta':'https://openai.example/v1',model:'fixture-model',timeout:30,maxTokens:4096});
const openai = (text, search = false) => ({status:'completed',output:[
    ...(search ? [{type:'web_search_call',status:'completed',action:{type:'search',queries:['测试作品 车队 城门']}}] : []),
    {type:'reasoning',summary:[{type:'summary_text',text:'Do not use this as evidence.'}]},
    {type:'message',role:'assistant',content:[{type:'output_text',text,annotations:search?[{type:'url_citation',url:'https://source.example/chapter-2',title:'测试来源',start_index:0,end_index:text.length}]:[]}]}]});
const gemini = (text, search = false) => ({candidates:[{finishReason:'STOP',content:{parts:[{thought:true,text:'Do not use this as evidence.'},{text}]},
    ...(search?{groundingMetadata:{webSearchQueries:['测试作品 车队 城门'],groundingChunks:[{web:{uri:'https://source.example/chapter-2',title:'测试来源'}}],
        groundingSupports:[{segment:{text},groundingChunkIndices:[0]}],searchEntryPoint:{renderedContent:'<p>Search Suggestions</p>'}}}:{})}]});
const wrapped = (provider, text, search) => (provider==='gemini'?gemini:openai)(text,search);
const candidate = source => ({ref:'event-1',title:'车队通路变化',fact:quote,constraint:'',entities:['旅行者'],parentRefs:[],supersedes:[],
    importance:'major',changeState:'established',divergenceKey:'city-access',changedPremise:'当前取得唯一钥匙，改变了原作必须绕道的前提。',
    evidence:[{messageId:1,quote}],canon:source?canon:'',canonQuery:question,canonSourceIds:source?[source.id]:[],
    canonEvidence:source?[{sourceId:source.id,quote:canon}]:[],wikiQuery:'',wikiOutcome:'unreviewed',wikiNote:'',canonConflict:'',openQuestions:[]});

test('native modes use the same configured model and activate provider-owned tools only for research',()=>{
    for(const provider of ['openai','gemini']) {
        const research=nativeRequest(config(provider),'test-key','instructions','query',true);
        const analysis=nativeRequest(config(provider),'test-key','instructions','{}',false);
        assert.equal(analysis.body.tools,undefined);
        assert.equal(research.url,analysis.url);
        assert.equal(research.url.includes('/chat/completions'),false);
        assert.equal(research.headers['X-CSRF-Token'],undefined);
        if(provider==='openai') {
            assert.deepEqual(research.body.tools,[{type:'web_search'}]);assert.equal(research.body.tool_choice,'required');
            assert.equal(research.body.model,'fixture-model');assert.equal(research.body.store,false);
        } else {assert.deepEqual(research.body.tools,[{google_search:{}}]);assert.match(research.url,/fixture-model:generateContent$/);}
    }
    assert.throws(()=>cleanSettings({...config('openai'),provider:'compatible'}),/不能自动联网/);
    assert.throws(()=>nativeRequest(config('gemini'),'','x','y',true),/密钥/);
    assert.equal(normalizeBase('https://api.example/v1/responses'),'https://api.example/v1');
    assert.equal(normalizeBase('https://api.example/v1beta/models/gemini-test:generateContent'),'https://api.example/v1beta');
    assert.throws(()=>cleanSettings({...config('gemini'),url:'https://api.example/v1beta/openai'}),/兼容入口/);
});

test('only tool completion plus actual citation metadata can produce OpenAI web evidence',()=>{
    const valid=parseResearch(openai(canon,true),'openai',[question]);
    assert.equal(valid.sources[0].kind,'web_summary');assert.equal(valid.sources[0].provided,false);
    assert.equal(valid.sources[0].text,canon);
    assert.throws(()=>parseResearch(openai('我已经联网了 https://fake.example'),'openai',[question]),/没有.*web_search/);
    const noCitations=openai(canon,true);noCitations.output.at(-1).content[0].annotations=[];
    assert.throws(()=>parseResearch(noCitations,'openai',[question]),/来源引用/);
    const unsafe=openai(canon,true);unsafe.output.at(-1).content[0].annotations[0].url='javascript:alert(1)';
    assert.throws(()=>parseResearch(unsafe,'openai',[question]),/来源引用/);
    assert.equal(safeWebUrl('https://user:pass@example.com/'),'');
});

test('Gemini requires query records and matching grounded segments; thought parts are never evidence',()=>{
    const valid=parseResearch(gemini(canon,true),'gemini',[question]);
    assert.equal(valid.sources[0].text,canon);assert.match(valid.searches[0].entryPoint,/Search Suggestions/);
    const wrong=gemini(canon,true);wrong.candidates[0].groundingMetadata.groundingSupports[0].segment.text='Do not use this as evidence.';
    assert.throws(()=>parseResearch(wrong,'gemini',[question]),/来源引用/);
    const unsearched=gemini(canon,true);unsearched.candidates[0].groundingMetadata.webSearchQueries=[];
    assert.throws(()=>parseResearch(unsearched,'gemini',[question]),/实际搜索记录/);
    assert.throws(()=>nativeText({...openai('{}'),status:'incomplete'},'openai'),/未完成/);
    const truncated=gemini('{}');truncated.candidates[0].finishReason='MAX_TOKENS';
    assert.throws(()=>nativeText(truncated,'gemini'),/未正常完成/);
});

test('native fetch omits cookies, disallows redirects, sanitizes failures and supports cancellation',async()=>{
    const req=nativeRequest(config('openai'),'test-key','x','y',true);
    await nativeFetch(req,{fetchImpl:async(_url,options)=>{
        assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
        return{ok:true,json:async()=>openai(canon,true)};
    }});
    await assert.rejects(nativeFetch(req,{fetchImpl:async()=>({ok:false,status:401,json:async()=>({message:'secret-value'})})}),/HTTP 401/);
    await assert.rejects(nativeFetch(req,{fetchImpl:async()=>{throw new TypeError('test-key');}}),/CORS/);
    const controller=new AbortController();controller.abort();let called=false;
    await assert.rejects(nativeFetch(req,{signal:controller.signal,fetchImpl:async()=>{called=true;}}),{name:'AbortError'});
    assert.equal(called,false);
    const pending=async(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('abort','AbortError')),{once:true}));
    await assert.rejects(nativeFetch(req,{timeout:.01,fetchImpl:pending}),/等待超过/);
});

test('native model lists use provider headers and preserve manually selectable model names',async()=>{
    for(const provider of ['openai','gemini']) {
        const models=await nativeModels(config(provider),'test-key',{fetchImpl:async(url,options)=>{
            assert.match(url,/\/models$/);assert.equal(options.method,'GET');assert.equal(options.body,undefined);
            return{ok:true,json:async()=>provider==='gemini'?{models:[{name:'models/example-gemini',supportedGenerationMethods:['generateContent']}]}:{data:[{id:'example-gpt'}]}};
        }});
        assert.equal(models.length,1);assert.doesNotMatch(models[0],/^models\//);
    }
});

test('both providers send native tool payloads, review mock evidence, and persist usable sourced records',async()=>{
    for(const provider of ['openai','gemini']) {
        let calls=0;const payloads=[];const context={extensionSettings:{[SETTINGS_KEY]:config(provider)}};
        const result=await requestAnalysis({messages:[{id:1,role:'assistant',text:quote}],existing:[],sources:[]},new AbortController().signal,context,{
            key:'test-key',fetchImpl:async(url,options)=>{
                calls++;const body=JSON.parse(options.body);payloads.push(body);
                assert.equal(url,nativeRequest(config(provider),'test-key','x','y').url);
                const inputText=provider==='gemini'?body.contents[0].parts[0].text:body.input;
                if(calls===2) {
                    assert.ok(body.tools?.length);assert.deepEqual(JSON.parse(inputText),{questions:[question]});
                    assert.doesNotMatch(inputText,/唯一的城门钥匙交给/);
                    return{ok:true,json:async()=>wrapped(provider,canon,true)};
                }
                const input=JSON.parse(inputText);const source=input.sources[0];
                if(calls===3) {assert.equal(source.kind,'web_summary');assert.equal(source.text,canon);}
                const response={events:[candidate(source)],notes:[],sources:[{id:'invented',text:'fake'}],searches:[{queries:['fake']}]};
                return{ok:true,json:async()=>wrapped(provider,JSON.stringify(response))};
            }});
        assert.equal(calls,3);assert.equal(payloads.filter(p=>p.tools).length,1);
        assert.equal(result.sources.some(s=>s.id==='invented'),false);assert.deepEqual(result.searches[0].requestedQueries,[question]);
        const known=new Map(result.sources.map(s=>[s.id,s])),opened=new Set(known.keys());
        const clean=validateAnalysis(result,[{id:1,role:'assistant',text:quote}],[],known,opened);
        assert.equal(clean.events[0].canonStatus,'web_supported');
        const batch=makeBatch(clean,{start:0,end:1,hash:'fixture',sources:result.sources,searches:result.searches});
        const view=project({version:1,batches:[batch],edits:{}},['','fixture']);
        const prompt=buildPrompt(view.records).text;
        assert.match(prompt,/原生联网摘要/);assert.match(prompt,/没有钥匙/);assert.match(prompt,/唯一的城门钥匙交给/);
        assert.doesNotMatch(prompt,/未联网核验/);assert.equal(batch.searches.length,1);
        assert.equal(validateCanon({...candidate(result.sources[0]),canonConflict:'两个版本冲突'},known,opened).canonStatus,'conflict');
    }
});

test('an unsupported search aborts analysis instead of silently using a model claim',async()=>{
    let calls=0;
    await assert.rejects(requestAnalysis({messages:[{id:1,role:'assistant',text:quote}],existing:[],sources:[]},null,
        {extensionSettings:{[SETTINGS_KEY]:config('openai')}},{key:'test-key',fetchImpl:async()=>{
            calls++;return{ok:true,json:async()=>openai(calls===1?JSON.stringify({events:[candidate()],notes:[]}):canon)};
        }}),/没有.*web_search/);
    assert.equal(calls,2);
});

test('ordinary turns do not search and cancellation after search never reaches the final review',async()=>{
    const context={extensionSettings:{[SETTINGS_KEY]:config('gemini')}};
    let calls=0;
    const result=await requestAnalysis({messages:[{id:1,role:'assistant',text:quote}],sources:[]},null,context,{key:'test-key',fetchImpl:async()=>{
        calls++;return{ok:true,json:async()=>gemini(JSON.stringify({events:[],notes:[]}))};
    }});
    assert.equal(calls,1);assert.deepEqual(result.searches,[]);
    const controller=new AbortController();calls=0;
    await assert.rejects(requestAnalysis({messages:[{id:1,role:'assistant',text:quote}],sources:[]},controller.signal,context,{key:'test-key',fetchImpl:async()=>{
        calls++;
        return{ok:true,json:async()=>{if(calls===2){controller.abort();return gemini(canon,true);}return gemini(JSON.stringify({events:[candidate()],notes:[]}));}};
    }}),{name:'AbortError'});
    assert.equal(calls,2);
});
