'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function fixture(){
  const ids=new Map(),events=new Map();
  class Element{
    constructor(tag='div',id=''){this.tagName=tag.toUpperCase();this.id=id;this.attributes=new Map();this.children=[];this.parentElement=null;this.dataset={};this.textContent='';this.disabled=false;this.value='';this.hidden=false;this.styles=new Map();this.style={setProperty:(k,v)=>this.styles.set(k,v),removeProperty:k=>this.styles.delete(k)};const classes=new Set();this.classList={add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x)};if(id)ids.set(id,this);}
    get isConnected(){return this===body||!!this.parentElement?.isConnected;}
    append(...nodes){for(const node of nodes){node.remove();this.children.push(node);node.parentElement=this;}}
    prepend(node){node.remove();this.children.unshift(node);node.parentElement=this;}
    remove(){if(this.parentElement){const children=this.parentElement.children;children.splice(children.indexOf(this),1);this.parentElement=null;}}
    contains(node){return node===this||this.children.some(child=>child.contains(node));}
    setAttribute(k,v){this.attributes.set(k,String(v));}
    getAttribute(k){return this.attributes.get(k)??null;}
    removeAttribute(k){this.attributes.delete(k);}
    getBoundingClientRect(){return {width:124};}
    closest(selector){for(let node=this;node;node=node.parentElement){if(selector==='button'&&node.tagName==='BUTTON'||selector==='#view'&&node.id==='view'||selector==='#modalBody'&&node.id==='modalBody'||selector.includes('.actions')&&node.id==='actions')return node;}return null;}
    querySelectorAll(selector){return this.children.flatMap(child=>[...(selector==='button'&&child.tagName==='BUTTON'?[child]:[]),...child.querySelectorAll(selector)]);}
    querySelector(){return null;}
    insertAdjacentElement(position,node){assert.ok(['beforebegin','afterend'].includes(position));const parent=this.parentElement,index=parent.children.indexOf(this);node.remove();parent.children.splice(index+(position==='afterend'?1:0),0,node);node.parentElement=parent;}
  }
  const body=new Element(),root=new Element('div','view'),actions=new Element('div','actions'),button=new Element('button','start'),crumb=new Element('b','crumb'),error=new Element('div','formError'),overlay=new Element('div','overlay'),input=new Element('input','draft');
  crumb.textContent='分析任务';button.textContent='开始执行';input.value='保留的输入';overlay.hidden=false;body.append(crumb,root,overlay);root.append(actions,error,input);actions.append(button);
  const context=vm.createContext({document:{body,getElementById:id=>ids.get(id),createElement:tag=>new Element(tag),addEventListener:(name,fn)=>events.set(name,fn)},Promise,Map,setTimeout,clearTimeout,toast:()=>{},$:id=>ids.get(id)});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/local-loading.js'),'utf8'),context);
  vm.runInContext('let busy=false;'+fs.readFileSync(path.join(__dirname,'../public/workbench.js'),'utf8').split('async function action(')[1].split('const chosenPlan=')[0].replace(/^/,'async function action('),context);
  const run=code=>vm.runInContext(code,context);context.button=button;
  return {run,context,button,root,actions,error,input,crumb,Element,events};
}
test('耗时操作立即反馈，拦截重复点击；失败保留输入并允许重试',async()=>{
  const x=fixture();let reject;x.context.pending=new Promise((_,r)=>reject=r);
  const promise=x.run('action(()=>pending,{button})');
  assert.equal(x.button.getAttribute('aria-busy'),'true');assert.equal(x.button.getAttribute('data-loading-label'),'正在启动…');assert.equal(x.button.disabled,false);
  let blocked=0;x.events.get('click')({target:x.button,preventDefault:()=>blocked++,stopImmediatePropagation:()=>blocked++});assert.equal(blocked,2);
  reject(Error('合成服务暂不可用'));await promise;
  assert.equal(x.error.textContent,'合成服务暂不可用');assert.equal(x.input.value,'保留的输入');assert.equal(x.button.getAttribute('aria-busy'),null);
  await x.run('action(async()=>42,{button})');assert.equal(x.error.textContent,'');assert.equal(x.run('busy'),false);
});
test('确认与启动的连续请求分别显示阶段，重绘按钮后仍保持加载',()=>{
  const x=fixture();x.run('var pendingUi=LocalLoading.start({button});LocalLoading.phase("POST","/api/monitor/batches/b/routing/confirm")');assert.equal(x.button.getAttribute('data-loading-label'),'正在确认本批配置…');
  x.button.remove();const replacement=new x.Element('button','start');replacement.textContent='开始执行';x.actions.append(replacement);
  x.run('LocalLoading.phase("POST","/api/monitor/batches/b/rate")');assert.equal(replacement.getAttribute('aria-busy'),'true');assert.equal(replacement.getAttribute('data-loading-label'),'正在启动分析…');
  replacement.textContent='正在分析';replacement.disabled=true;x.run('LocalLoading.stop(pendingUi)');assert.equal(replacement.textContent,'正在分析');assert.equal(replacement.disabled,true);assert.equal(replacement.getAttribute('aria-busy'),null);
});
test('加载范围留在原操作区域，不改动其他控件或跳转后的页面',()=>{
  const x=fixture();x.run('var pendingUi=LocalLoading.start({button})');assert.equal(x.input.getAttribute('aria-busy'),null);assert.equal(x.root.getAttribute('aria-busy'),null);
  x.root.children.filter(e=>e.className==='local-loading-status').forEach(e=>e.remove());x.crumb.textContent='数据分析';x.run('LocalLoading.phase("GET","/api/monitor")');assert.equal(x.root.children.some(e=>e.className==='local-loading-status'),false);x.run('LocalLoading.stop(pendingUi)');
});
test('触发按钮通过点击捕获，后台刷新不会自行显示加载',async()=>{
  const x=fixture();x.run('LocalLoading.phase("GET","/api/monitor")');assert.equal(x.button.getAttribute('aria-busy'),null);
  x.events.get('click')({target:x.button});await Promise.resolve();x.run('var pendingUi=LocalLoading.start()');assert.equal(x.button.getAttribute('aria-busy'),'true');x.run('LocalLoading.stop(pendingUi)');
  await new Promise(resolve=>setTimeout(resolve,0));assert.equal(x.run('LocalLoading.start()'),null);
});
