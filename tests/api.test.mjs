import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBase, completionRequest, customRequest, parseCompletion, hostPost, listModels, writeKey, readKey, cleanSettings } from '../api.mjs';
const config = {url:'https://provider.example/v1/',model:'test-model',timeout:30,maxTokens:4096};
test('normalize full chat endpoint and preserve custom provider path',()=>{
    assert.equal(normalizeBase('https://provider.example/api/v1/chat/completions'),'https://provider.example/api/v1');
    assert.equal(normalizeBase('http://localhost:1234/v1/models/'),'http://localhost:1234/v1');
    for(const value of ['file:///tmp/a','javascript:alert(1)','https://key:password@example.com','https://example.com?key=fake'])assert.throws(()=>normalizeBase(value));
});
test('independent key explicitly overrides host key even when left blank; reasoning opt in',()=>{
    const request=completionRequest(config,'test-only-key','instructions',{type:'object'},{messages:[]});
    assert.equal(request.chat_completion_source,'custom');assert.equal(request.model,'test-model');assert.equal(request.stream,false);
    assert.equal(JSON.parse(request.custom_include_headers).Authorization,'Bearer test-only-key');
    assert.deepEqual(JSON.parse(request.custom_include_body),{max_tokens:4096});
    assert.equal(JSON.parse(customRequest(config,'').custom_include_headers).Authorization,'');
    const extended=completionRequest({...config,reasoning:'medium',tokenField:'max_completion_tokens'},'','x',{},{});
    assert.deepEqual(JSON.parse(extended.custom_include_body),{max_completion_tokens:4096,reasoning_effort:'medium'});
    assert.equal(request.secret_id,undefined);assert.equal(request.reverse_proxy,undefined);
});
test('only non-secret settings survive cleaning; session key is bound to exact URL',()=>{
    const storage=new Map(), adapter={getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
    writeKey(config.url,'dummy-key',adapter);
    assert.equal(readKey(config.url,adapter),'dummy-key');assert.equal(readKey('https://other.example/v1',adapter),'');
    assert.equal(cleanSettings({...config,key:'dummy-key'}).key,undefined);
    writeKey(config.url,'',adapter);assert.equal(storage.size,0);
});
test('parse strict JSON / fenced JSON; do not accept truncation, refusal or hidden reasoning',()=>{
    const wrap=(text,reason='stop')=>({choices:[{finish_reason:reason,message:{content:text}}]});
    assert.deepEqual(parseCompletion(wrap('```json\n{"events":[]}\n```')),{events:[]});
    for(const data of [wrap('{}','length'),wrap('{}','content_filter'),wrap('not JSON'),wrap('[]'),{choices:[{message:{reasoning_content:'{}'}}]},{error:{message:'secret must not be echoed'}}])assert.throws(()=>parseCompletion(data));
    try{parseCompletion({error:{message:'secret must not be echoed'}});}catch(e){assert.doesNotMatch(e.message,/secret must/);}
});
test('host transport preserves CSRF, surfaces HTTP status without leaking upstream body',async()=>{
    let seen;
    const context={getRequestHeaders:()=>({'Content-Type':'application/json','X-CSRF-Token':'test-csrf'})};
    const data=await hostPost('/api/test',{model:'x'},{context,fetchImpl:async(path,options)=>{seen={path,options};return{ok:true,json:async()=>({ok:true})};}});
    assert.equal(data.ok,true);assert.equal(seen.options.headers['X-CSRF-Token'],'test-csrf');
    await assert.rejects(hostPost('/api/test',{}, {context,fetchImpl:async()=>({ok:false,status:401,json:async()=>({secret:'sensitive'})})}),/HTTP 401/);
});
test('cancel and timeout free the request; timeout is a fallback error, not user stop',async()=>{
    const context={getRequestHeaders:()=>({})};
    const pending=async(_url,{signal})=>new Promise((_resolve,reject)=>{const stop=()=>reject(new DOMException('abort','AbortError'));if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true});});
    const controller=new AbortController();const run=hostPost('/api/test',{}, {context,signal:controller.signal,fetchImpl:pending});controller.abort();
    await assert.rejects(run,{name:'AbortError'});
    await assert.rejects(hostPost('/api/test',{}, {context,timeout:.01,fetchImpl:pending}),/等待超过/);
});
