'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const publicDir=path.join(__dirname,'../public'),source=fs.readFileSync(path.join(publicDir,'request-id.js'),'utf8');
function load(crypto,extra={}){const context=vm.createContext({crypto,...extra});vm.runInContext(source,context);return context;}
test('原生 UUID 可用时使用原生，缺少 randomUUID 时通过 getRandomValues 生成 v4',()=>{
  assert.equal(load({randomUUID:()=> 'native-uuid'}).AppIds.newId(),'native-uuid');
  let count=0;const crypto=Object.freeze({getRandomValues:bytes=>{bytes.fill(++count);return bytes;}}),ctx=load(crypto),a=ctx.AppIds.newId(),b=ctx.AppIds.newId();
  assert.match(a,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);assert.notEqual(a,b);assert.equal(crypto.randomUUID,undefined);
});
test('无 crypto 或浏览器方法抛错时仍能生成不重复的请求标识',()=>{
  for(const crypto of [undefined,{}, {randomUUID:()=>{throw Error('unavailable');},getRandomValues:()=>{throw Error('unavailable');}}]){
    const ctx=load(crypto,{Date:{now:()=>123},Math:{random:()=>0.5}}),ids=Array.from({length:1000},()=>ctx.AppIds.newId());assert.equal(new Set(ids).size,1000);assert.ok(ids.every(id=>typeof id==='string'&&id.length>0));
  }
});
test('无 randomUUID 的浏览器实际执行文件读取和预览请求；同一草稿重试保留请求编号',async()=>{
  const elements={importFile:{files:[{name:'合成.json',text:async()=>JSON.stringify([{ticket_id:'SYN-1',intent_scene:'合成场景',ai_process_text:'原始 AI 日志'}])}]},importScope:{value:'tier2'},importSheet:{value:''},importSheetField:{hidden:true},importSource:{value:'合成系统'},importNote:{value:'兼容性测试'}};
  const calls=[],ctx=load({getRandomValues:bytes=>require('node:crypto').randomFillSync(bytes)},{
    $:id=>elements[id],actor:()=> '测试维护人',ExcelImport:require('../public/excel-import'),request:async(method,url,body)=>{calls.push({method,url,body:structuredClone(body)});return {rows:[],counts:{total:1,ready:0,pending:1,invalid:0}};},previewModal:()=>{},
    importCases:null,importDraft:null,importPreview:null,importWorkbook:null,importWorkbookFile:null
  });
  const imported=fs.readFileSync(path.join(publicDir,'import-workbench.js'),'utf8');
  vm.runInContext(imported.slice(imported.indexOf('async function prepareImportWorkbook'),imported.indexOf('function selectedImportKind')),ctx);
  vm.runInContext(imported.slice(imported.indexOf('async function parseImportFile'),imported.indexOf('function previewModal')),ctx);
  await ctx.importCases();assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/monitor/batches/preview');assert.equal(calls[0].body.records[0].ai_process_text,'原始 AI 日志');assert.ok(calls[0].body.request_id);
  await ctx.previewDraft();assert.equal(calls[1].body.request_id,calls[0].body.request_id);
});
