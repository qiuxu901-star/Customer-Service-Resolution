'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../public/workbench.js'),'utf8');
const requestSource=source.slice(source.indexOf('async function request('),source.indexOf('async function refresh('));
function requestWith(response){return vm.runInNewContext(requestSource+';request',{fetch:async()=>response,JSON,Error});}
test('旧服务纯文本404转为可操作错误，网关非JSON响应不泄漏原文',async()=>{
 const missing=requestWith({ok:false,status:404,json:async()=>{throw SyntaxError('Unexpected token o');}});
 await assert.rejects(missing('GET','/api/monitor/conversations'),e=>/接口不存在.*404/.test(e.message)&&/重启/.test(e.message)&&!e.message.includes('Unexpected token'));
 const gateway=requestWith({ok:false,status:502,json:async()=>{throw SyntaxError('SECRET upstream response');}});
 await assert.rejects(gateway('POST','/api/monitor/conversations/1/messages',{}),e=>/无效数据.*502/.test(e.message)&&!e.message.includes('SECRET'));
});
test('JSON业务错误和成功响应保持原有契约',async()=>{
 await assert.rejects(requestWith({ok:false,status:409,json:async()=>({error:'请先整批确认'})})('POST','/api/test',{}),/请先整批确认/);
 assert.equal((await requestWith({ok:true,status:200,json:async()=>({ok:true})})('GET','/api/test')).ok,true);
});
