'use strict';
let workspaceMarkType='all';
let attentionTaskStage='all';
const pendingRecordViews=new Set();
let recordPreviewGeneration=0;
function recordRevision(row){return row.rating?'rating:'+row.rating.id:'record:'+(row.item.current_route_id||row.item.record_hash||'original');}
function workspaceViewState(row){return (data.record_views||[]).some(v=>v.item_id===row.item.id&&v.revision_key===recordRevision(row))?'viewed':'unviewed';}
function recordMatchesMark(item,type='all'){
  const marks=item.attention_marks||[];
  return type==='pending'?(item.focus_marked===true&&(!attentionTaskFor(item)||attentionTaskFor(item).status==='待分析')):type==='all'||type==='marked'&&(item.focus_marked===true||marks.length>0)||type==='evaluation'&&marks.some(m=>m.type==='evaluation')||type==='ai'&&marks.some(m=>m.type==='ai');
}
function recordMarkOptions(selected='all'){return [['all','全部'],['marked','已标记'],['pending','待分析'],['evaluation','评估不符合'],['ai','AI 客服有问题']].map(([value,label])=>'<option value="'+value+'" '+(selected===value?'selected':'')+'>'+label+'</option>').join('');}
function recordMarkBadges(item,ratingId){
  const marks=item.attention_marks||[];
  return marks.length?marks.map(m=>'<span class="record-problem-tag mark-'+m.type+'">'+(m.type==='evaluation'?'评估不符合':'AI 客服有问题')+(m.rating_id&&m.rating_id!==ratingId?' · 较早评估':'')+'</span>').join(''):item.focus_marked?'<span class="record-problem-tag mark-legacy">已标记 · '+esc(attentionTaskFor(item)?.status||'待分析')+'</span>':'';
}
workspaceMarkButton=function(item,ratingId){
  const marked=item.focus_marked===true||(item.attention_marks||[]).length>0;
  const task=attentionTaskFor(item);
  return '<button type="button" class="btn record-mark'+(marked?' is-marked':'')+'" data-record-mark="'+esc(item.id)+'" data-mark-item="'+esc(item.id)+'"'+(marked?' data-cancel-mark="'+esc(item.id)+'"':'')+(ratingId?' data-mark-rating="'+esc(ratingId)+'"':'')+' aria-pressed="'+marked+'" aria-label="'+(marked?'取消标记':'标记')+'：'+esc(item.record_snapshot?.name||'工单')+'">'+wsIcon('flag')+'<span>'+(marked?'取消标记':'标记')+'</span></button>'+(marked&&task?wsButton('查看待办','data-task-edit="'+esc(task.id)+'"'):'');
};
function recordAttentionHtml(row){
  const task=attentionTaskFor(row.item);
  const marks=row.item.attention_marks||[],history=row.item.attention_history||[];
  if(!marks.length&&!history.length&&!row.item.focus_marked)return '';
  const note=mark=>'<article class="record-problem-note"><h4>'+(mark.type==='evaluation'?'评估不符合 · 完善评估标准':'AI 客服有问题 · 完善 AI 客服')+'</h4><p>'+esc(mark.reason)+'</p>'+(mark.suggestion?'<p><strong>'+(mark.type==='evaluation'?'合理判断 / 标准完善建议':'AI 客服改进方案')+'</strong><br>'+esc(mark.suggestion)+'</p>':'')+'<small>'+esc(mark.actor)+' · '+esc(formatTime(mark.at))+(mark.rating_id&&mark.rating_id!==row.rating?.id?' · 来自较早评估':'')+'</small></article>';
  return '<section class="record-attention-notes"><h3>问题跟进</h3>'+(task?'<p class="notice">'+esc(task.status)+' · '+wsButton('查看待办','data-task-edit="'+esc(task.id)+'"')+'</p>':'')+marks.map(note).join('')+(!marks.length&&row.item.focus_marked&&(!task||task.status==='待分析')?'<p class="sub">已进入待分析，可在改进待办中补充疑点、问题分类和方案。</p>':'')+(history.length?'<details><summary>标记历史（'+history.length+' 次）</summary>'+history.slice().reverse().map(h=>'<section><p class="meta">'+esc(h.actor)+' · '+esc(formatTime(h.at))+'</p>'+(h.marks.length?h.marks.map(note).join(''):'<p class="sub">取消问题标记</p>')+'</section>').join('')+'</details>':'')+'</section>';
}
function attentionTaskFor(item){return data.tasks.find(t=>t.source==='record_attention'&&t.attention_item_id===item.id&&t.status!=='已撤回');}
function openRecordMarkEditor(id,ratingId){
  const item=data.batch_items.find(i=>i.id===id);if(!item)return;
  const existing=attentionTaskFor(item);if(existing)return openAttentionTask(existing.id);
  const detailOpen=!$('overlay').hidden&&document.querySelector('.modal').classList.contains('evidence-drawer');
  const rating=ratingId||evidenceRow(id)?.rating?.id||null;
  return action(async()=>{
    const result=await request('POST','/api/monitor/batch-items/'+encodeURIComponent(id)+'/attention',{rating_id:rating});
    Object.assign(item,result.item);const existingTask=data.tasks.find(t=>t.id===result.task.id);if(existingTask)Object.assign(existingTask,result.task);else data.tasks.push(result.task);render();
    if(detailOpen)openWorkspaceEvidence(id,false,{ratingId:rating});
    toast('已标记，已进入改进待办 · 待分析');
  });
}
function cancelRecordMark(id,ratingId){
  const item=data.batch_items.find(i=>i.id===id);if(!item)return;
  const task=attentionTaskFor(item),baseVersion=item.attention_version||0,taskVersion=task?.version||0;
  const detailOpen=!$('overlay').hidden&&document.querySelector('.modal').classList.contains('evidence-drawer');
  const needsConfirmation=!!task&&task.status!=='待分析';
  const save=note=>action(async()=>{
    const result=await request('POST','/api/monitor/batch-items/'+encodeURIComponent(id)+'/attention/cancel',{base_version:baseVersion,task_version:taskVersion,confirm_withdraw:needsConfirmation,note});
    Object.assign(item,result.item);if(result.task){const old=data.tasks.find(t=>t.id===result.task.id);if(old)Object.assign(old,result.task);}
    render();if(detailOpen)openWorkspaceEvidence(id,false,{ratingId:ratingId||null});else hideModal();
    toast(result.task?'已取消标记，关联待办已撤回':'已取消标记');
  });
  if(!needsConfirmation)return save('');
  modal('<h2 id="modalTitle">取消标记并撤回待办？</h2><p>'+esc(item.record_snapshot?.name||'工单')+'</p><p class="notice">关联待办当前为「'+esc(task.status)+'」。取消后会从当前改进列表撤回，已有分析和处理历史保留。</p><label class="field">撤回说明（选填）<textarea id="cancelAttentionNote" maxlength="6000" placeholder="例如：核查后确认无问题，或误操作"></textarea></label><div id="formError" class="error" role="alert"></div><div class="form-actions">'+wsButton('返回','id="keepAttentionMark"')+wsButton('确认取消并撤回','id="confirmCancelAttention"',true)+'</div>');
  $('keepAttentionMark').onclick=()=>{if(detailOpen)openWorkspaceEvidence(id,false,{ratingId:ratingId||null});else openAttentionTask(task.id);};
  $('confirmCancelAttention').onclick=()=>save($('cancelAttentionNote').value);
}
function openAttentionTask(id){
  const task=data.tasks.find(t=>t.id===id);if(!task)return;
  if(task.status==='已撤回'){modal('<h2 id="modalTitle">'+esc(task.title)+'</h2><p class="notice">标记已取消，此待办已撤回。</p><p>原有分析与处理记录保留，重新标记会进入待分析。</p><details><summary>查看撤回前的分析与处理历史</summary>'+(task.analysis_marks||[]).map(m=>'<article class="record-problem-note"><h4>'+esc(m.type==='evaluation'?'评估不符合':'AI 客服有问题')+'</h4><p>'+esc(m.reason)+'</p><p>'+esc(m.suggestion)+'</p></article>').join('')+task.history.map(h=>'<article class="task-history"><strong>'+esc(h.action)+'</strong><p>'+esc(h.note||'')+'</p><small>'+esc(h.actor)+' · '+esc(formatTime(h.at))+'</small></article>').join('')+'</details>'+wsButton('重新标记','data-mark-item="'+esc(task.attention_item_id)+'"')+wsButton('查看原文与评估','data-attention-source="'+esc(task.id)+'"'));return;}
  const fields=[['evaluation','评估不符合','完善评估标准','评估哪里判断不对，依据是什么？','合理判断 / 标准完善建议'],['ai','AI 客服有问题','完善 AI 客服','具体是哪段 AI 输出有错漏，影响是什么？','AI 客服改进方案']];
  modal('<h2 id="modalTitle">'+esc(task.title)+'</h2><p class="sub">先记录疑点，分析清楚后再推进改进。待分析阶段可随时保存草稿。</p><div class="notice">当前状态：'+esc(task.status)+' · 标记来源已保留</div><div class="actions">'+wsButton('查看原文与评估','data-attention-source="'+esc(task.id)+'"')+'</div>'+(task.initial_note?'<p>'+esc(task.initial_note)+'</p>':'')+fields.map(([type,label,target,placeholder,suggestion])=>{const old=(task.analysis_marks||[]).find(m=>m.type===type);return '<section class="problem-mark-section"><label class="problem-mark-choice"><input type="checkbox" id="problemMark-'+type+'" '+(old?'checked':'')+'>'+label+'<small>'+target+'</small></label><div id="problemMarkFields-'+type+'" '+(old?'':'hidden')+'><label class="field">'+(type==='evaluation'?'评估不符合的原因':'AI 问题与原文位置')+'<textarea id="problemReason-'+type+'" maxlength="6000" placeholder="'+placeholder+'">'+esc(old?.reason||'')+'</textarea></label><label class="field">'+suggestion+'<textarea id="problemSuggestion-'+type+'" maxlength="6000">'+esc(old?.suggestion||'')+'</textarea></label></div></section>';}).join('')+'<div class="form-grid"><label class="field">负责人<input id="attentionOwner" maxlength="6000" value="'+esc(task.owner||'')+'"></label><label class="field">处理阶段<select id="attentionStatus">'+['待分析','待修改','修改中','待复验','无需改进'].map(status=>'<option '+(status===task.status?'selected':'')+'>'+status+'</option>').join('')+'</select></label></div><label class="field">验收目标<textarea id="attentionGoal" maxlength="6000">'+esc(task.goal||'')+'</textarea></label><label class="field">分析 / 进度备注<textarea id="attentionNote" maxlength="6000" placeholder="可先记疑点；无需改进时请说明原因">'+esc(task.analysis_note||'')+'</textarea></label><p class="sub">进入待修改、修改中或待复验前，请补齐问题原因、改进建议、负责人和验收目标。</p><details><summary>处理历史</summary>'+task.history.slice().reverse().map(h=>'<article class="task-history"><strong>'+esc(h.action)+'</strong><p>'+esc(h.note||'')+'</p><small>'+esc(h.actor)+' · '+esc(formatTime(h.at))+'</small></article>').join('')+'</details><div id="formError" class="error" role="alert"></div><div class="form-actions">'+wsButton('取消标记','data-cancel-mark="'+esc(task.attention_item_id)+'"')+wsButton('保存','id="saveAttentionTask"',true)+'</div>');
  for(const [type]of fields)$('problemMark-'+type).onchange=()=>{$('problemMarkFields-'+type).hidden=!$('problemMark-'+type).checked;};
  $('saveAttentionTask').onclick=()=>action(async()=>{
    const marks=fields.filter(([type])=>$('problemMark-'+type).checked).map(([type])=>({type,reason:$('problemReason-'+type).value,suggestion:$('problemSuggestion-'+type).value}));
    const result=await request('PATCH','/api/monitor/attention-tasks/'+encodeURIComponent(id),{base_version:task.version||0,status:$('attentionStatus').value,marks,owner:$('attentionOwner').value,goal:$('attentionGoal').value,note:$('attentionNote').value});
    Object.assign(task,result.task);const item=data.batch_items.find(i=>i.id===result.item.id);if(item)Object.assign(item,result.item);render();openAttentionTask(id);toast('待办已保存 · '+result.task.status);
  });
}
document.addEventListener('click',e=>{
  const button=e.target.closest('button');if(!button||button.disabled)return;
  if(button.dataset.cancelMark)cancelRecordMark(button.dataset.cancelMark,button.dataset.markRating);
  if(button.dataset.attentionSource){const task=data.tasks.find(t=>t.id===button.dataset.attentionSource),ref=task?.rating_refs?.[0];if(ref)openWorkspaceEvidence(ref.item_id,false,{ratingId:ref.rating_id,sourceSnapshot:ref.rating_id?null:task.record_snapshot});}
});
function noteRecordViewed(row){
  if(typeof requestAnimationFrame!=='function'||!row.item.case_id||['pending','running'].includes(row.rating?.status)||workspaceViewState(row)==='viewed')return;
  const id=row.item.id,key=id+'|'+recordRevision(row),generation=++recordPreviewGeneration;if(pendingRecordViews.has(key))return;
  requestAnimationFrame(()=>requestAnimationFrame(async()=>{
    try{
      const columns=document.querySelector('.evidence-columns'),body=$('modalBody');
      if(generation!==recordPreviewGeneration||$('overlay').hidden||workspaceEvidenceId!==id||!columns||columns.parentElement!==body)return;
      const rect=columns.getBoundingClientRect();if(rect.width<=0||rect.height<=0||getComputedStyle(columns).visibility==='hidden')return;
      pendingRecordViews.add(key);
      const result=await request('POST','/api/monitor/batch-items/'+encodeURIComponent(id)+'/view',{rating_id:row.rating?.id||null});
      data.record_views=data.record_views||[];if(!data.record_views.some(v=>v.id===result.view.id))data.record_views.push(result.view);
      render();
    }catch(error){toast('查看状态未保存：'+error.message+'，重新打开详情可重试');}
    finally{pendingRecordViews.delete(key);}
  }));
}

document.addEventListener('change',e=>{if(e.target.id==='attentionTaskStage'){attentionTaskStage=e.target.value;render();}});
