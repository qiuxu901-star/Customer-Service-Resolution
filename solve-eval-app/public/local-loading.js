'use strict';
// Shared feedback for user actions. Background polling never starts an indicator.
const LocalLoading=(()=>{
  let trigger=null,active=null;
  const get=id=>document.getElementById(id);
  function capture(event){
    const button=event.submitter||event.target?.closest?.('button');
    if(!button)return;
    if(button.getAttribute?.('aria-busy')==='true'&&button.classList?.contains?.('is-local-loading')){
      event.preventDefault();event.stopImmediatePropagation();return;
    }
    const current={button};trigger=current;
    // Browsers can run microtasks between capture and delegated click handlers.
    // Keep the initiating control for the entire event dispatch.
    setTimeout(()=>{if(trigger===current)trigger=null;},0);
  }
  document.addEventListener('click',capture,true);
  document.addEventListener('submit',capture,true);
  function labelFor(button){
    if(button?.dataset?.loadingLabel)return button.dataset.loadingLabel;
    const label=button?.textContent?.trim()||'';
    if(/读取文件|预览/.test(label))return '正在准备预览…';
    if(/开始|执行|重新分析|重试|试用/.test(label))return '正在启动…';
    if(/导入/.test(label))return '正在导入…';
    if(/诊断/.test(label))return '正在准备诊断…';
    if(/生成|整理/.test(label))return '正在生成…';
    if(/测试|连接/.test(label))return '正在测试连接…';
    if(/校验|核对/.test(label))return '正在核对…';
    if(/刷新|读取|查看/.test(label))return '正在加载…';
    if(/保存|提交|确认|启用|应用|关联|标记|取消/.test(label))return '正在保存…';
    return '正在处理…';
  }
  function mark(op,button){
    if(!button?.setAttribute)return;
    if(!op.controls.has(button)){
      op.controls.set(button,{busy:button.getAttribute('aria-busy'),disabled:button.getAttribute('aria-disabled'),label:button.getAttribute('aria-label')});
      const width=button.getBoundingClientRect?.().width;
      if(width)button.style.setProperty('--loading-button-width',width+'px');
      button.classList.add('is-local-loading');button.setAttribute('aria-busy','true');button.setAttribute('aria-disabled','true');
    }
    if(button.getAttribute('data-loading-label')!==op.label)button.setAttribute('data-loading-label',op.label);
    if(button.getAttribute('aria-label')!==op.label)button.setAttribute('aria-label',op.label);
  }
  function sameButton(op,button){
    if(op.id)return button.id===op.id;
    if(op.keys.length)return op.keys.every(([key,value])=>button.dataset?.[key]===value);
    return button.textContent?.trim()===op.originalLabel;
  }
  function sync(){
    const op=active;if(!op||!op.root?.isConnected)return;
    if(op.root.id==='view'&&get('crumb')?.textContent!==op.page)return;
    let button=op.button?.isConnected?op.button:[...op.root.querySelectorAll('button')].find(b=>sameButton(op,b));
    if(button)mark(op,button);
    if(!op.notice.isConnected){
      const anchor=button?.closest('.form-actions,.task-run-actions,.routing-confirm-footer,.batch-settings-action,.actions')||button;
      if(anchor?.parentElement&&op.root.contains(anchor))anchor.insertAdjacentElement('beforebegin',op.notice);
      else{
        const heading=op.root.querySelector('.batch-page-head,.heading,h2');
        if(heading)heading.insertAdjacentElement('afterend',op.notice);else op.root.prepend(op.notice);
      }
    }
    if(op.message.textContent!==op.label)op.message.textContent=op.label;
  }
  function start(options={}){
    const button=options.button||trigger?.button;
    if(!button?.closest||!document.createElement)return null;
    const root=button.closest('#modalBody')||button.closest('#view');if(!root)return null;
    const notice=document.createElement('div'),message=document.createElement('span'),spinner=document.createElement('span');
    notice.className='local-loading-status';notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');
    spinner.className='local-loading-spinner';spinner.setAttribute('aria-hidden','true');notice.append(spinner,message);
    const op={button,root,notice,message,id:button.id,keys:Object.entries(button.dataset||{}).filter(([key])=>key!=='loadingLabel'),originalLabel:button.textContent?.trim(),label:options.label||labelFor(button),controls:new Map(),page:get('crumb')?.textContent};
    active=op;sync();button.scrollIntoView?.({block:'nearest',inline:'nearest'});return op;
  }
  function stop(op){
    if(!op)return;
    if(active===op)active=null;
    op.notice.remove();
    for(const [button,previous]of op.controls){
      button.classList.remove('is-local-loading');button.removeAttribute('data-loading-label');button.style.removeProperty('--loading-button-width');
      for(const [attr,value]of [['aria-busy',previous.busy],['aria-disabled',previous.disabled],['aria-label',previous.label]]){
        if(value===null)button.removeAttribute(attr);else button.setAttribute(attr,value);
      }
    }
  }
  function phase(method,url){
    if(!active)return;
    let label;
    if(method==='GET'){
      if(url==='/api/monitor')label='正在更新结果…';
    }else if(/\/batches\/preview$/.test(url))label='正在生成导入预览…';
    else if(/\/batches$/.test(url))label='正在导入工单…';
    else if(/\/routing\/confirm$/.test(url))label='正在确认本批配置…';
    else if(/\/rate$/.test(url))label='正在启动分析…';
    else if(/(?:diagnoses|batch-skill-diagnoses)\/preview$/.test(url))label='正在核对诊断输入…';
    else if(/(?:\/diagnoses|\/batch-skill-diagnoses|\/trial|\/trials)$/.test(url))label='正在启动'+(/diagnos/.test(url)?'诊断':'试用')+'…';
    else if(/\/generate$/.test(url))label='正在生成…';
    else if(/\/model-test$/.test(url))label='正在测试连接…';
    else if(/\/discover$/.test(url))label='正在读取可用模型…';
    if(label){active.label=label;sync();}
  }
  // Let the browser paint before reading a workbook or preparing a large request.
  function paint(){return new Promise(resolve=>{let finished=false;const done=()=>{if(finished)return;finished=true;resolve();};setTimeout(done,40);requestAnimationFrame(()=>setTimeout(done,0));});}
  if(typeof MutationObserver!=='undefined')new MutationObserver(sync).observe(document.body,{childList:true,subtree:true});
  return {start,stop,phase,paint};
})();
