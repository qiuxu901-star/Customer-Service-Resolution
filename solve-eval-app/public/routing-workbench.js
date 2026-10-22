'use strict';
let routingReturnBatch=null;
function batchRoutingReview(batch){return batch&&(data.batch_routing_reviews||[]).find(r=>r.batch_id===batch.id);}
function batchCanRate(batch){return !!batchRoutingReview(batch)?.confirmed;}
function hasUnsavedRouting(){const state=batchRoutingReview(activeBatch());return !!state?.groups.some(g=>{const scene=document.querySelector('[data-routing-scene="'+g.key+'"]'),candidate=document.querySelector('[data-routing-candidate="'+g.key+'"]');return scene&&candidate&&(scene.value!==(g.scene_id||'')||candidate.value!==(g.selected_candidate_id||''));});}
function routingEvaluationLabel(binding,revision){return !binding?'尚未确定本组评估方式':binding.kind==='basic_evaluation'?'仅使用公共评估标准':'公共标准＋'+binding.definition.name+' · r'+(revision?.number||'?');}
function routingSkillSummary(group){
  const flow=group.evaluation_flow,flowHtml=flow?'<p class="meta">评估分支：'+esc(flow.branch.implicit?'默认评估配置':flow.branch.name)+' · 执行流程：'+esc(flow.flow.name)+' · 每条 '+flow.model_calls+' 次模型调用</p>':'';
  if(group.selected_binding?.kind==='basic_evaluation')return flowHtml+'<p class="sub">本组按公共评估标准评估：诉求回应、信息利用、分析质量、实际帮助和证据边界。没有场景专项检查，也可正常评级。</p>';
  const skills=group.service_skills||[];
  return flowHtml+'<div class="routing-skill-summary"><p class="meta">监测方案正文 '+PlanDocument.documentOf(group.selected_binding?.definition||{}).length+' 字符；以下关联仅用于诊断时推荐，不发送到表现初评。</p>'+(skills.length?skills.map(s=>'<p class="'+(s.ready?'meta':'notice warn')+'">'+esc(s.code)+'@'+esc(s.version)+' · '+esc(s.ready?s.modules.map(m=>(m.id||'全文')+'（'+m.chars+' 字符）').join('、'):s.reason)+'</p>').join(''):'<p class="meta">未关联客服 Skill；不影响表现评估，可在诊断时选择。</p>')+'</div>';
}
function routingConfirmationPanel(batch){
  const state=batchRoutingReview(batch);if(!state)return '<section class="panel routing-panel"><h3>评估方式确认</h3><p>请刷新后读取本批确认状态。</p></section>';
  const groupHtml=g=>{
    const binding=g.selected_binding,revision=data.revisions.find(r=>r.id===binding?.revision_id);
    const option=(id,name,selected)=>'<option value="'+esc(id)+'" '+(selected?'selected':'')+'>'+esc(name)+'</option>';
    const choices='<option value="">请选择本组检查方式</option>'+option('__basic__','仅使用公共评估标准（无场景专项检查）',binding?.kind==='basic_evaluation')+(binding&&binding.kind!=='basic_evaluation'&&!g.choices.some(c=>c.candidate_id===g.selected_candidate_id)?option(g.selected_candidate_id,binding.definition.name+(state.confirmed?' · 已确认冻结版本':' · 当前绑定版本'),true):'')+g.choices.map(c=>option(c.candidate_id,'公共标准＋'+c.name+' · r'+(data.revisions.find(r=>r.id===c.revision_id)?.number||'?'),c.candidate_id===g.selected_candidate_id)).join('');
    const sceneChoices=sceneOptions(g.scene_id,false)+(state.confirmed&&g.scene_id&&!data.scenes.some(s=>s.id===g.scene_id&&s.status==='active')?option(g.scene_id,g.scene_name+' · 已确认版本',true):'');
    return '<details class="routing-group" '+(!g.ready&&!state.confirmed?'open ':'')+'data-routing-group="'+g.key+'"><summary><div><strong>'+esc(g.scene_name)+' <span>× '+esc(targetNames[g.scope])+'</span></strong><p class="meta">'+g.count+' 条记录'+(g.declared_scene&&g.declared_scene!==g.scene_name?' · 文件原填：'+esc(g.declared_scene):'')+'</p><p class="routing-summary-plan">'+esc(routingEvaluationLabel(binding,revision))+'</p></div><span class="badge '+(state.confirmed?'good':g.ready?'':'warn')+'">'+(state.confirmed?'已确认':g.ready?(binding?.kind==='basic_evaluation'?'公共标准 · 待确认':'场景方案 · 待确认'):'待处理')+'</span></summary><div class="routing-group-body"><p class="routing-selection">'+esc(routingEvaluationLabel(binding,revision))+'</p><p class="sub">'+esc(state.confirmed?'本组评估方式及版本已固定':g.ready&&binding?.kind==='basic_evaluation'?(g.choices.length?'本组已选择仅使用公共评估标准，请核对后整批确认。':'未配置场景专属方案，已使用公共评估标准；核对后可正常开始评级。'):g.ready?(g.choices.length===1?'找到唯一可用方案，已预选；请核对后整批确认。':'已识别多套可用方案，请核对当前选择，也可调整。'):g.reason)+'</p>'+routingSkillSummary(g)+'<div class="routing-group-controls"><label class="field">所属场景<select data-routing-scene="'+g.key+'">'+sceneChoices+'</select></label><label class="field">检查方式<select data-routing-candidate="'+g.key+'">'+choices+'</select></label><button class="btn" data-apply-routing-group="'+g.key+'">'+(state.confirmed?'调整本组方案':'应用本组选择')+'</button></div><div class="actions"><button class="link" data-routing-plans="'+g.key+'">'+(g.choices.length?'查看 / 补充监测方案 ↗':'添加场景专项检查（可选） ↗')+'</button><details><summary>查看本组记录与当前方案</summary><p>'+g.item_ids.map(id=>esc(data.batch_items.find(i=>i.id===id)?.record_snapshot?.name||id)).join('、')+'</p>'+(binding?'<pre>'+esc(JSON.stringify(binding.definition,null,2))+'</pre>':'<p>尚无已绑定方案。</p>')+'</details></div></div></details>';
  };
  return '<section class="panel routing-panel routing-confirmation" id="batchRoutingPanel"><div class="routing-steps"><span>01 数据已导入</span><b>02 核对场景</b><span>03 开始分析</span></div><div class="panel-head"><div><h3>核对后即可开始 <span class="badge '+(state.confirmed?'good':'warn')+'">'+(state.confirmed?'整批已确认':'尚未整批确认')+'</span></h3><p class="sub">按“意图场景 × 评估对象”核对全部 '+state.valid_count+' 条有效记录、'+state.group_count+' 个分组。当前筛选条件不缩小确认范围。</p></div><button class="btn" data-refresh-routing>重新匹配方案</button></div>'+(state.import_failed_count?'<p class="routing-warning">另有 '+state.import_failed_count+' 行导入失败，未形成有效记录，不参与本批评级；请查看失败行并修正后重导。</p>':'')+(state.pending_group_count?'<div class="notice warn">还有 '+state.pending_group_count+' 个分组待处理。请先确认记录属于哪个场景；没有场景专属方案时，按公共评估标准评级。</div>':'')+'<div class="routing-groups">'+[...state.groups].sort((a,b)=>Number(a.ready)-Number(b.ready)).map(groupHtml).join('')+'</div>'+(state.confirmed?'<div class="routing-confirmed"><b>已由 '+esc(state.confirmed_by)+' 确认 · '+esc(formatTime(state.confirmed_at))+'</b><p class="sub">可以开始本批评级。修改任何分组的场景或方案后，需要重新确认整批。</p></div>':'<div class="routing-confirm-footer"><label class="routing-ack"><input type="checkbox" id="routingAcknowledged" '+(!state.can_confirm?'disabled':'')+'>我已逐组核对本批全部有效记录的场景、评估对象、评估方式（公共标准或公共标准＋场景方案）及版本</label><button class="btn primary" id="confirmBatchRouting" disabled>确认本批评估方式</button><p class="sub">确认只固定评估方式，不会立即执行评级。'+(!state.can_confirm?'请先处理上方所有待处理分组。':'')+'</p></div>')+'</section>';
}
async function refreshBatchRouting(id){const state=data.batch_routing_reviews.find(r=>r.batch_id===id);await request('POST','/api/monitor/batches/'+id+'/routing/refresh',{review_hash:state.review_hash,actor:actor()});await refresh();}
// Configuration publishing does not update the routes saved at import time.
async function refreshRoutingAfterConfiguration(){
  const id=routingReturnBatch||(typeof analysisTaskId!=='undefined'?analysisTaskId:null);
  const state=id&&batchRoutingReview({id});
  if(!state||state.confirmed||!state.pending_group_count)return false;
  await refreshBatchRouting(id);return true;
}

function routingPlanWorkspace(key){
  const batch=activeBatch(),state=batchRoutingReview(batch),group=state.groups.find(g=>g.key===key);routingReturnBatch=batch.id;
  if(!group.scene_id){show('scenes');toast('先维护业务场景，再返回本批选择场景与监测方案');return;}
  openEvaluationSettings(group.scene_id,group.scope);
}
const renderBeforeRoutingConfirmation=render;
render=function(){renderBeforeRoutingConfirmation();if(routingReturnBatch&&view!=='batches')$('view').insertAdjacentHTML('afterbegin','<div class="notice routing-return">正在补充批次监测方案。方案文档确认后即可按场景与评估对象匹配，无需生成或复核候选。 <button class="link" data-return-routing>返回本批并重新匹配 ↗</button></div>');};
document.addEventListener('change',event=>{
  if(event.target.id==='routingAcknowledged'){$('confirmBatchRouting').disabled=!event.target.checked||hasUnsavedRouting();if(hasUnsavedRouting())toast('请先点击“应用本组选择”保存修改，再确认整批');}
  const key=event.target.dataset.routingScene;if(key){const state=batchRoutingReview(activeBatch()),group=state.groups.find(g=>g.key===key),select=document.querySelector('[data-routing-candidate="'+key+'"]');select.innerHTML=candidateOptions(event.target.value,group.scope);if(select.options.length===2)select.selectedIndex=1;}
  if(event.target.dataset.routingScene||event.target.dataset.routingCandidate){if($('routingAcknowledged'))$('routingAcknowledged').checked=false;if($('confirmBatchRouting'))$('confirmBatchRouting').disabled=true;const groupKey=event.target.dataset.routingScene||event.target.dataset.routingCandidate;document.querySelector('[data-apply-routing-group="'+groupKey+'"]').textContent='应用本组选择（保存修改）';const rate=document.querySelector('[data-rate-batch]');if(rate){rate.disabled=true;rate.textContent='请先保存方案调整并重新确认';}}
});
document.addEventListener('click',event=>{
  const button=event.target.closest('button');if(!button||button.disabled||busy)return;
  const d=button.dataset;
  if(d.routingPlans)routingPlanWorkspace(d.routingPlans);
  if(d.applyRoutingGroup)action(async()=>{const batch=activeBatch(),state=batchRoutingReview(batch),key=d.applyRoutingGroup;await request('POST','/api/monitor/batches/'+batch.id+'/routing/group',{review_hash:state.review_hash,group_key:key,scene_id:document.querySelector('[data-routing-scene="'+key+'"]').value,candidate_id:document.querySelector('[data-routing-candidate="'+key+'"]').value,actor:actor()});await refresh();toast('本组选择已保存，请核对并重新确认整批方案');});
  if(button.hasAttribute('data-refresh-routing'))action(async()=>{await refreshBatchRouting(activeBatch().id);toast('匹配结果已更新，请核对当前整批确认状态');});
  if(button.id==='confirmBatchRouting')action(async()=>{if(!$('routingAcknowledged').checked)throw Error('请先核对本批全部分组');if(hasUnsavedRouting())throw Error('请先应用本组选择，保存修改后再确认整批');const batch=activeBatch(),state=batchRoutingReview(batch);await request('POST','/api/monitor/batches/'+batch.id+'/routing/confirm',{review_hash:state.review_hash,confirmed:true,group_keys:state.groups.map(g=>g.key),actor:actor()});await refresh();toast('本批监测方案已全部确认，可以开始评级');});
  if(button.hasAttribute('data-return-routing'))action(async()=>{const id=routingReturnBatch;batchId=id;sceneFilter='all';scope='all';selectedGrade='all';view='batches';routingReturnBatch=null;await refresh();await refreshBatchRouting(id);});
});
