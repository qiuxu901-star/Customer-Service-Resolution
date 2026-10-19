'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('工作台按真实脚本顺序初始化，文档编辑重构后各导航仍可渲染',async()=>{
  const elements=new Map();
  function node(id){if(!elements.has(id))elements.set(id,{id,value:'',innerHTML:'',textContent:'',hidden:false,offsetHeight:70,style:{setProperty(){}},classList:{add(){},remove(){},toggle(){}},setAttribute(){},removeAttribute(){},focus(){},remove(){},insertAdjacentHTML(){},querySelector(){return node('nested');},querySelectorAll(){return [];}});return elements.get(id);}
  const events=new Map(),bootstrap={plans:[],revisions:[],candidates:[],cases:[],runs:[],services:[],tasks:[],scenes:[],scene_assignments:[],unmapped_scenes:[],examples:[],batches:[],batch_items:[],ratings:[],rating_runs:[],item_routes:[],batch_routing_reviews:[],routing_confirmations:[],rating_contract:{version:'test',grades:{},dimensions:{}},current_judge:{hash:'test'},model_config:{profiles:[],configured:false},workspace_mode:'isolated_preview'};
  const context=vm.createContext({document:{getElementById:node,querySelector:node,querySelectorAll:()=>[],addEventListener(){},body:{classList:{add(){},remove(){},toggle(){},contains(){return false;}},style:{setProperty(){}}}},window:{addEventListener:(event,fn)=>events.set(event,fn),scrollTo(){}},localStorage:{getItem:()=>'',setItem(){}},fetch:async()=>({ok:true,json:async()=>structuredClone(bootstrap)}),setTimeout:()=>1,clearTimeout(){},structuredClone,crypto:require('node:crypto').webcrypto,XLSX:{}});
  const publicDir=path.join(__dirname,'../public'),html=fs.readFileSync(path.join(publicDir,'workbench.html'),'utf8');
  for(const match of html.matchAll(/<script src="\/([^"]+)"/g)){if(match[1].startsWith('vendor/'))continue;vm.runInContext(fs.readFileSync(path.join(publicDir,match[1]),'utf8'),context,{filename:match[1]});}
  await events.get('DOMContentLoaded')();
  assert.match(node('connection').textContent,/已连接/);assert.doesNotMatch(node('view').innerHTML,/无法加载/);
  for(const view of ['plans','cases','runs','services','tasks','scenes','flow','models','home','batches','records','analytics']){vm.runInContext('show('+JSON.stringify(view)+')',context);assert.ok(node('view').innerHTML.length>0,view);}
  vm.runInContext('show("home")',context);assert.match(node('view').innerHTML,/workspaceChatForm/);assert.doesNotMatch(node('view').innerHTML,/完整方案等级分布|data-rate-batch/);
  vm.runInContext('show("analytics")',context);assert.match(node('view').innerHTML,/能力等级分布/);assert.doesNotMatch(node('view').innerHTML,/data-rate-batch|routingAcknowledged/);
});
