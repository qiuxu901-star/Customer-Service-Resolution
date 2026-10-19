'use strict';
const workspaceReviewDrafts=new Map(),workspacePageFilters=new Map();
let workspaceReviewTab='all',workspaceExecutionFilter='all',workspaceEvidenceQueue=[],workspaceEvidenceId=null,workspaceEvidenceEditing=false;
const iconPaths={chat:'M4 4h16v12H9l-5 4V4Z M8 8h8 M8 12h5',upload:'M12 16V3 M7 8l5-5 5 5 M4 15v5h16v-5',chart:'M4 20h16 M7 16v-5 M12 16V5 M17 16V8',search:'M15.5 15.5 21 21 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',list:'M8 6h12 M8 12h12 M8 18h12 M3 6h1 M3 12h1 M3 18h1',check:'M5 12l4 4L19 6',clock:'M12 7v5l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',book:'M3 4h7l2 2 2-2h7v15h-7l-2 2-2-2H3V4Z M12 6v15',settings:'M4 7h16 M4 17h16 M8 4v6 M16 14v6',layers:'m12 3 10 5-10 5L2 8l10-5Z M2 12l10 5 10-5 M2 16l10 5 10-5',arrow:'M5 12h14 M13 6l6 6-6 6',plus:'M12 5v14 M5 12h14'};
function wsIcon(name){return '<svg class="ws-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+(iconPaths[name]||iconPaths.chat)+'"/></svg>';}
const unpolishedShow=show;
show=function(next,options={}){
  if(options.restore){
    workspacePageFilters.set(view,{scope,scene:sceneFilter,batch:batchId,recordBatch:workspaceRecordsBatch});
    const saved=workspacePageFilters.get(next);
    scope=saved?.scope||(['plans','services'].includes(next)?'frontline':'all');sceneFilter=saved?.scene||'all';
    if(next==='analytics')batchId=saved?.batch||'all';
    if(next==='records')workspaceRecordsBatch=saved?.recordBatch||'all';
  }
  unpolishedShow(next);
};
workspaceSceneFilter=function(){return '<div class="workspace-scope-bar"><label>评估对象<select id="workspacePageScope">'+(['plans','services'].includes(view)?['frontline','tier2','linked']:['all','frontline','tier2','linked']).map(s=>'<option value="'+s+'" '+(scope===s?'selected':'')+'>'+targetNames[s]+'</option>').join('')+'</select></label><label>业务场景<select id="sceneFilter">'+sceneOptions(sceneFilter)+'</select></label><span class="scope-caption">'+(['plans','services'].includes(view)?'配置范围':'当前查看范围')+'</span></div>';};
const unpolishedHeading=heading;
heading=function(kicker,title,sub,buttons=''){
  const simpler={plans:'监测方案',scenes:'业务场景',services:'客服业务 Skills',tasks:'改进待办',cases:'案例库',models:'模型配置',flow:'流程指引'};
  return unpolishedHeading('',simpler[view]||title,sub,buttons);
};
const unpolishedAgent=renderAgentWorkspace;
renderAgentWorkspace=function(){
  let html=unpolishedAgent();
  html=html.replace('>新对话</button>','>'+wsIcon('plus')+'新对话</button>').replace('>历史对话</button>','>'+wsIcon('clock')+'历史对话</button>');
  html=html.replace('<span class="agent-emblem">✦</span>','<span class="agent-emblem">'+wsIcon('chat')+'</span>');
  for(const [old,name] of [['▤','upload'],['◫','chart'],['⌕','search']])html=html.replaceAll('<span class="quick-symbol">'+old+'</span>','<span class="quick-symbol">'+wsIcon(name)+'</span>');
  html=html.replaceAll('<span class="quick-arrow">↗</span>','<span class="quick-arrow">'+wsIcon('arrow')+'</span>');
  return html;
};
function reviewState(row){const latest=workspaceLatestReview(row.rating?.id);if(latest)return latest.status==='待补充'?'needs_info':'reviewed';return gradeOrder.includes(row.status)?'pending':'unrated';}
function normalizeRecordFilter(){
  if(workspaceRecordStatus==='review'){workspaceReviewTab='pending';workspaceRecordStatus='all';}
  else if(['routing_pending','pending','running','failed','import_failed','not_applicable','actionable'].includes(workspaceRecordStatus)){workspaceExecutionFilter=workspaceRecordStatus;workspaceRecordStatus='all';}
}
function filteredWorkspaceRows(rows,{ignoreReview=false}={}){
  normalizeRecordFilter();
  return rows.filter(r=>(workspaceRecordStatus==='all'||(workspaceRecordStatus==='assisted'?['L2','L3'].includes(r.status):r.status===workspaceRecordStatus))&&
    (workspaceExecutionFilter==='all'||(workspaceExecutionFilter==='actionable'?['routing_pending','pending','running','failed'].includes(r.status):r.status===workspaceExecutionFilter))&&
    (ignoreReview||workspaceReviewTab==='all'||reviewState(r)===workspaceReviewTab)&&
    (!workspaceRecordQuery||[r.item.id,r.item.record_snapshot?.name,r.item.record_snapshot?.source_record_id,r.item.record_snapshot?.session_text,JSON.stringify(r.item.record_snapshot?.business_record||{}),r.rating?.report?.summary].some(x=>String(x||'').toLowerCase().includes(workspaceRecordQuery.toLowerCase()))));
}
workspaceRecordsPanel=function(rows,{task=false}={}){
  const matching=filteredWorkspaceRows(rows),base=filteredWorkspaceRows(rows,{ignoreReview:true}),pageSize=12,pages=Math.max(1,Math.ceil(matching.length/pageSize));workspaceRecordPage=Math.min(workspaceRecordPage,pages);
  const page=matching.slice((workspaceRecordPage-1)*pageSize,workspaceRecordPage*pageSize);
  const reviewNames={pending:'待复核',needs_info:'待补充',reviewed:'已复核',unrated:'尚未评级'};
  return '<section class="panel workspace-record-panel"><div class="panel-head"><h3>'+(task?'本批记录':'记录明细')+' <span class="badge">'+matching.length+' 条</span></h3>'+(task?wsButton('跨批次查找','data-view="records"'):'')+'</div><div class="review-tabs" role="tablist" aria-label="复核状态">'+[['all','全部记录'],['pending','待复核'],['needs_info','待补充'],['reviewed','已复核']].map(([v,label])=>'<button role="tab" aria-selected="'+(workspaceReviewTab===v)+'" class="'+(workspaceReviewTab===v?'active':'')+'" data-review-tab="'+v+'">'+label+' <span>'+(v==='all'?base.length:base.filter(r=>reviewState(r)===v).length)+'</span></button>').join('')+'</div><form id="workspaceRecordSearch" class="record-filters"><label class="record-search"><span class="sr-only">搜索记录</span><input id="workspaceRecordQuery" placeholder="搜索编号、记录名称或原文" value="'+esc(workspaceRecordQuery)+'"></label><label class="filter-select"><span>模型等级</span><select id="workspaceRecordStatus" aria-label="模型等级"><option value="all">全部等级</option>'+gradeOrder.map(g=>'<option value="'+g+'" '+(workspaceRecordStatus===g?'selected':'')+'>'+g+' · '+gradeLabels[g]+'</option>').join('')+'<option value="assisted" '+(workspaceRecordStatus==='assisted'?'selected':'')+'>L2 / L3 · 有效辅助</option></select></label><label class="filter-select"><span>执行状态</span><select id="workspaceExecutionFilter" aria-label="执行状态"><option value="all">全部状态</option>'+['routing_pending','pending','running','failed','import_failed','not_applicable','actionable'].map(v=>'<option value="'+v+'" '+(workspaceExecutionFilter===v?'selected':'')+'>'+esc(statusNames[v]||'全部待处理')+'</option>').join('')+'</select></label><button class="btn" type="submit">搜索</button>'+wsButton('重置','data-reset-workspace-records')+'</form><div class="table-scroll"><table class="batch-table insight-record-table"><thead><tr><th>记录</th><th>结论摘要</th><th>操作</th></tr></thead><tbody>'+page.map(r=>{const reviewed=workspaceLatestReview(r.rating?.id),state=reviewState(r);return '<tr><td><strong class="record-title">'+esc(r.item.record_snapshot?.name||'导入第'+r.item.row_number+'行')+'</strong><small>'+esc(r.item.record_snapshot?.scene||'场景待确认')+' · '+esc(targetNames[r.item.record_snapshot?.scope]||'对象待确认')+'</small></td><td><span class="insight-list-conclusion">'+esc(AnalysisSummary.short(AnalysisSummary.record(r).conclusion,75))+'</span><div class="insight-list-meta"><span class="grade-pill grade-'+esc(r.status)+'">'+esc(gradeOrder.includes(r.status)?r.status:statusNames[r.status]||r.status)+'</span><span class="review-state state-'+state+'">'+reviewNames[state]+(reviewed?' · 人工 '+esc(reviewed.grade):'')+'</span></div></td><td>'+(r.item.case_id?wsButton('查看 ›','data-workspace-evidence="'+esc(r.item.id)+'"')+(r.status==='routing_pending'?wsButton('处理匹配','data-workspace-batch="'+esc(r.item.batch_id)+'"'):''):wsButton('查看原因','data-import-error="'+esc(r.item.id)+'"'))+'</td></tr>';}).join('')+'</tbody></table></div>'+(!matching.length?'<div class="empty"><h3>暂无符合条件的记录</h3><p>调整等级、执行状态或复核页签，查看其他记录。</p>'+wsButton('重置筛选','data-reset-workspace-records')+'</div>':'')+'<div class="workspace-pagination"><span>共 '+matching.length+' 条 · 第 '+workspaceRecordPage+' / '+pages+' 页</span><div class="actions">'+wsButton('上一页','data-record-page="'+(workspaceRecordPage-1)+'" '+(workspaceRecordPage===1?'disabled':''))+wsButton('下一页','data-record-page="'+(workspaceRecordPage+1)+'" '+(workspaceRecordPage===pages?'disabled':''))+'</div></div></section>';
};
const unpolishedAnalysisTasks=renderAnalysisTasks;
renderAnalysisTasks=function(){
  let html=unpolishedAnalysisTasks();if(!analysisTaskId)return html;
  const confirmed=batchCanRate(activeBatch());
  let footer='';
  html=html.replace(/<div class="routing-confirm-footer">[\s\S]*?<\/div>/,match=>{if(!confirmed)footer=match;return '';});
  html=html.replace(/<div class="task-run-actions">[\s\S]*?<\/div>/,match=>{if(confirmed)footer=match;return '';});
  return html+'<div class="task-sticky-actions">'+footer+'</div>';
};
function evidenceRow(id){const item=data.batch_items.find(i=>i.id===id);return item?workspaceRows({batch:item.batch_id,target:'all',scene:'all'}).find(r=>r.item.id===id):null;}
function reviewForm(rating){
  const draft=workspaceReviewDrafts.get(rating.id)||{decision:'confirm',grade:rating.report.grade,reason:'',evidence:''};
  return '<div class="inline-review"><p class="sub">对照左侧原文填写，未提交内容在本次页面内保留。</p><label class="field">复核操作<select id="workspaceReviewDecision"><option value="confirm" '+(draft.decision==='confirm'?'selected':'')+'>确认模型初判</option><option value="change" '+(draft.decision==='change'?'selected':'')+'>修改结论</option><option value="needs_info" '+(draft.decision==='needs_info'?'selected':'')+'>要求补充材料</option></select></label><label class="field">人工等级<select id="workspaceReviewGrade" '+(draft.decision!=='change'?'disabled':'')+'>'+gradeOrder.map(g=>'<option '+(g===draft.grade?'selected':'')+'>'+g+'</option>').join('')+'</select></label><label class="field">判断理由 / 待补充内容<textarea id="workspaceReviewReason" maxlength="12000">'+esc(draft.reason)+'</textarea></label><label class="field">证据引用<textarea id="workspaceReviewEvidence" maxlength="12000" placeholder="引用原文片段、有效政策或已核实事实">'+esc(draft.evidence)+'</textarea></label><div id="formError" class="error" role="alert"></div></div>';
}
function rememberReviewDraft(){if(!workspaceEvidenceEditing)return;const row=evidenceRow(workspaceEvidenceId);if(!row?.rating||!$('workspaceReviewDecision'))return;workspaceReviewDrafts.set(row.rating.id,{decision:$('workspaceReviewDecision').value,grade:$('workspaceReviewGrade').value,reason:$('workspaceReviewReason').value,evidence:$('workspaceReviewEvidence').value});}
function prepareEvidenceQueue(id){
  if(workspaceEvidenceQueue.includes(id))return;
  const rows=view==='batches'?workspaceRows({batch:analysisTaskId,target:'all',scene:'all'}):workspaceRows({batch:workspaceRecordsBatch});
  workspaceEvidenceQueue=filteredWorkspaceRows(rows).filter(r=>r.item.case_id).map(r=>r.item.id);if(!workspaceEvidenceQueue.includes(id))workspaceEvidenceQueue=[id];
}
openWorkspaceEvidence=function(id,editing=false){
  rememberReviewDraft();const row=evidenceRow(id);if(!row)return;prepareEvidenceQueue(id);workspaceEvidenceId=id;workspaceEvidenceEditing=editing&&!!row.rating?.report?.grade;
  const rec=row.item.record_snapshot,rating=row.rating,review=workspaceLatestReview(rating?.id),index=workspaceEvidenceQueue.indexOf(id),previous=workspaceEvidenceQueue[index-1],next=workspaceEvidenceQueue[index+1];
  const source=rec.business_record?businessRecordHtml(rec):'<h4>原始会话</h4><blockquote>'+esc(rec.session_text||'未提供')+'</blockquote><h4>AI 回复</h4><blockquote>'+esc(rec.ai_reply||'未提供')+'</blockquote><details><summary>证据与来源</summary><pre>'+esc(JSON.stringify(rec.evidence,null,2))+'</pre></details>';
  const result=insightRecordHtml(row);
  const linked=data.tasks.filter(t=>t.rating_id===rating?.id||(t.rating_refs||[]).some(r=>r.rating_id===rating?.id));
  modal('<div class="evidence-heading"><div><h2 id="modalTitle">'+esc(rec.name)+'</h2><p class="sub">'+esc(rec.scene||'场景待确认')+' · '+esc(targetNames[rec.scope])+' · '+esc(data.batches.find(b=>b.id===row.item.batch_id)?.name)+'</p></div><span class="evidence-position">'+(index+1)+' / '+workspaceEvidenceQueue.length+'</span></div><div class="evidence-columns"><section class="evidence-source"><h3>导入数据</h3>'+source+'</section><section class="evidence-result">'+result+(rating?.report?.grade?'<section class="review-section"><h3>人工复核 '+(review?'<span class="review-state state-'+(review.status==='待补充'?'needs_info':'reviewed')+'">'+esc(review.status)+' · 人工 '+esc(review.grade)+'</span>':'')+'</h3>'+(review?'<p>'+esc(review.reason)+'</p><p class="meta">'+esc(review.actor)+' · '+esc(formatTime(review.created_at))+'</p>':workspaceEvidenceEditing?'':'<p class="sub">人工判断独立保存，保留模型原结论。</p>')+(workspaceEvidenceEditing?reviewForm(rating):wsButton(review?'追加复核':'开始人工复核','data-workspace-review="'+esc(rating.id)+'"',true))+'</section>':'')+'<section class="evidence-improvements"><h3>关联改进待办</h3>'+linked.map(t=>'<div class="linked-task"><strong>'+esc(t.title||t.description)+'</strong><span>'+esc(t.status)+' · '+esc(t.owner)+'</span></div>').join('')+(!linked.length?'<p class="sub">确认问题后，可创建待办或关联已有事项。</p>':'')+(rating?.report?.grade?wsButton('创建 / 关联改进待办','data-rating-task="'+esc(rating.id)+'"'):'')+'</section></section></div><footer class="evidence-footer"><div class="actions">'+wsButton('上一条','data-evidence-step="'+esc(previous||'')+'" '+(!previous?'disabled':''))+wsButton('下一条','data-evidence-step="'+esc(next||'')+'" '+(!next?'disabled':''))+'</div><div class="actions">'+(workspaceEvidenceEditing?wsButton('返回结论','data-workspace-evidence="'+esc(id)+'"')+wsButton('保存复核','data-save-inline-review')+wsButton(next?'保存并下一条':'保存并结束','data-save-inline-review="next"',true):wsButton('带到助手继续提问','data-discuss-evidence="'+esc(id)+'"')+wsButton('沉淀案例','data-curate-case="'+esc(row.item.case_id)+'"'))+'</div></footer>');
  document.querySelector('.modal').classList.add('evidence-drawer');
};
workspaceReviewEditor=function(id){const rating=data.ratings.find(r=>r.id===id);if(rating)openWorkspaceEvidence(rating.item_id,true);};
async function saveInlineReview(moveNext){
  rememberReviewDraft();const row=evidenceRow(workspaceEvidenceId),id=row.rating.id,draft=workspaceReviewDrafts.get(id),next=workspaceEvidenceQueue[workspaceEvidenceQueue.indexOf(workspaceEvidenceId)+1];
  await request('POST','/api/monitor/ratings/'+id+'/review',{...draft,actor:actor()});workspaceReviewDrafts.delete(id);workspaceEvidenceEditing=false;await refresh();
  if(moveNext&&next)openWorkspaceEvidence(next,true);else if(moveNext)hideModal();else openWorkspaceEvidence(row.item.id);
  toast(moveNext&&next?'复核已保存，已打开下一条':'复核已保存');
}
function ratingTaskEditor(id){
  rememberReviewDraft();const rating=data.ratings.find(r=>r.id===id),row=evidenceRow(rating.item_id),title=row.item.record_snapshot.name+' · 改进';
  modal('<h2 id="modalTitle">创建或关联改进待办</h2><p class="sub">'+esc(row.item.record_snapshot.name)+' · 模型 '+esc(rating.report.grade)+'</p><div class="task-editor-content"><label class="field">处理方式<select id="ratingTaskExisting"><option value="">创建新待办</option>'+data.tasks.filter(t=>t.status!=='已复验').map(t=>'<option value="'+esc(t.id)+'">关联：'+esc(t.title||t.description)+'</option>').join('')+'</select></label><div id="ratingTaskFields"><label class="field">事项名称<input id="ratingTaskTitle" value="'+esc(title)+'" maxlength="6000"></label><div class="form-grid"><label class="field">改进对象<select id="ratingTaskCategory">'+['原客服 AI 能力','业务依据或证据','监测方案'].map(v=>'<option '+(v===(rating.report.grade==='U'?'业务依据或证据':'原客服 AI 能力')?'selected':'')+'>'+v+'</option>').join('')+'</select></label><label class="field">优先级<select id="ratingTaskPriority"><option>高</option><option selected>中</option><option>低</option></select></label></div><label class="field">问题说明<textarea id="ratingTaskDescription" maxlength="6000">'+esc(AnalysisSummary.record(row).problem)+'</textarea></label><label class="field">验收目标<textarea id="ratingTaskGoal" maxlength="6000" placeholder="说明需要补齐的事实、修正的行为及对应验收依据">'+esc(AnalysisSummary.record(row).advice)+'</textarea></label><label class="field">负责人<input id="ratingTaskOwner" maxlength="100"></label></div><div id="formError" class="error" role="alert"></div></div><div class="form-actions">'+wsButton('返回原记录','data-workspace-evidence="'+esc(row.item.id)+'"')+wsButton('保存关联','id="saveRatingTask"',true)+'</div>');
  document.querySelector('.modal').classList.add('task-editor-drawer');$('ratingTaskExisting').onchange=()=>{$('ratingTaskFields').hidden=!!$('ratingTaskExisting').value;};
  $('saveRatingTask').onclick=()=>action(async()=>{await request('POST','/api/monitor/ratings/'+id+'/tasks',{task_id:$('ratingTaskExisting').value,title:$('ratingTaskTitle').value,description:$('ratingTaskDescription').value,goal:$('ratingTaskGoal').value,owner:$('ratingTaskOwner').value,priority:$('ratingTaskPriority').value,category:$('ratingTaskCategory').value,actor:actor()});await refresh();workspaceEvidenceEditing=false;openWorkspaceEvidence(row.item.id);toast('改进待办已关联，原记录与评级依据保留');});
}
const originalTaskEditor=taskEditor;
taskEditor=function(runId,caseId,id){
  const task=data.tasks.find(t=>t.id===id);if(task?.source!=='record_rating')return originalTaskEditor(runId,caseId,id);
  modal('<h2 id="modalTitle">'+esc(task.title)+'</h2><p>'+esc(task.description)+'</p><p class="sub">负责人：'+esc(task.owner)+' · '+esc(task.category)+'</p><div class="notice"><strong>验收目标</strong><p>'+esc(task.goal)+'</p></div><label class="field">当前状态<select id="ratingTaskStatus">'+['待修改','修改中','待复验'].map(s=>'<option '+(s===task.status?'selected':'')+'>'+s+'</option>').join('')+'</select></label><label class="field">进度说明<textarea id="ratingTaskNote"></textarea></label><p class="sub">完成需对应的有效复验报告；此处仅登记处理进度。</p><details><summary>处理历史</summary>'+task.history.map(h=>'<div class="task-history"><strong>'+esc(h.action)+'</strong><p>'+esc(h.note||'')+'</p><small>'+esc(h.actor)+' · '+esc(formatTime(h.at))+'</small></div>').join('')+'</details><div id="formError" class="error"></div><div class="form-actions">'+wsButton('保存进度','id="saveRatingTaskProgress"',true)+'</div>');
  $('saveRatingTaskProgress').onclick=()=>action(async()=>{await request('PATCH','/api/monitor/rating-tasks/'+id,{status:$('ratingTaskStatus').value,note:$('ratingTaskNote').value,actor:actor()});hideModal();await refresh();toast('待办进度已保存');});
};
renderTasks=function(){
  const tasks=data.tasks.filter(t=>{const ids=[t.case_id,...(t.rating_refs||[]).map(r=>r.case_id)];return data.cases.some(c=>ids.includes(c.id)&&matchesCase(c.record)&&sceneMatches(c.record,c.id));});
  return heading('','改进待办','围绕 AI 客服 Skill 保存修改要求和来源，修改后验证实际输出。')+'<section class="panel"><div class="panel-head"><h3>改进事项 <span class="badge">'+tasks.length+'</span></h3></div>'+(tasks.length?'<div class="table-scroll"><table class="batch-table"><thead><tr><th>问题与目标</th><th>负责人 / 对象</th><th>状态</th><th>操作</th></tr></thead><tbody>'+tasks.map(t=>'<tr><td><strong>'+esc(t.title||t.description)+'</strong><small>'+esc(t.goal||'按原诊断报告验证修改')+'</small></td><td>'+esc(t.owner)+'<small>'+esc(t.category||'原诊断问题')+'</small></td><td><span class="badge task-state task-state-'+({'待修改':'pending','修改中':'active','待复验':'verify','已复验':'done'}[t.status]||'pending')+'">'+esc(t.status)+'</span></td><td>'+wsButton(t.skill_change?'查看改进说明':'更新进展','data-task-edit="'+esc(t.id)+'"')+((t.rating_refs||[]).length?wsButton('查看来源','data-workspace-evidence="'+esc(t.rating_refs[0].item_id)+'"'):'')+'</td></tr>').join('')+'</tbody></table></div>':'<div class="empty"><h3>当前范围暂无改进待办</h3><p>在本批分析总结中整理 Skill 改进，或在记录详情中创建待办。</p>'+wsButton('查看记录','data-view="records"')+'</div>')+'</section>';
};
const unpolishedRender=render;
render=function(){
  unpolishedRender();document.querySelector('.scope').hidden=true;
  document.body.classList.toggle('batch-detail-page',view==='batches'&&!!analysisTaskId);
  const icons={home:'chat',batches:'list',records:'check',tasks:'clock',analytics:'chart',cases:'book',plans:'list',scenes:'layers',services:'layers',models:'settings',evaluator:'book',flow:'book'};
  document.querySelectorAll('#nav [data-view]').forEach(b=>{b.innerHTML=wsIcon(icons[b.dataset.view])+'<span>'+names[b.dataset.view]+'</span>';});
};
document.addEventListener('input',e=>{if(['workspaceReviewReason','workspaceReviewEvidence'].includes(e.target.id))rememberReviewDraft();});
document.addEventListener('change',e=>{
  if(e.target.id==='workspacePageScope'){scope=e.target.value;planId=null;workspaceEvidenceQueue=[];render();}
  if(e.target.id==='workspaceExecutionFilter'){workspaceExecutionFilter=e.target.value;workspaceRecordPage=1;workspaceEvidenceQueue=[];render();}
  if(['sceneFilter','workspaceRecordStatus'].includes(e.target.id))workspaceEvidenceQueue=[];
  if(e.target.id==='workspaceReviewDecision'){$('workspaceReviewGrade').disabled=e.target.value!=='change';if(e.target.value==='needs_info')$('workspaceReviewGrade').value='U';else if(e.target.value==='confirm')$('workspaceReviewGrade').value=evidenceRow(workspaceEvidenceId).rating.report.grade;rememberReviewDraft();}
  if(e.target.id==='workspaceReviewGrade')rememberReviewDraft();
});
document.addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b||b.disabled)return;const d=b.dataset;
  if(b.hasAttribute('data-history-toggle'))openWorkspaceHistory();
  if(b.hasAttribute('data-new-conversation')&&!workspaceChatBusy)$('workspaceChatInput')?.focus({preventScroll:true});
  if(d.reviewTab){workspaceReviewTab=d.reviewTab;workspaceRecordPage=1;workspaceEvidenceQueue=[];render();}
  if(b.hasAttribute('data-reset-workspace-records')){workspaceReviewTab='all';workspaceRecordStatus='all';workspaceExecutionFilter='all';workspaceRecordQuery='';workspaceRecordPage=1;workspaceEvidenceQueue=[];render();}
  
  if(d.evidenceStep){rememberReviewDraft();openWorkspaceEvidence(d.evidenceStep,workspaceEvidenceEditing);}
  if(b.hasAttribute('data-save-inline-review'))action(()=>saveInlineReview(d.saveInlineReview==='next'));
  if(d.ratingTask)ratingTaskEditor(d.ratingTask);
});

// Reset before existing drill-through handlers apply their target filters.
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b||b.disabled)return;const d=b.dataset;if(d.view==='records'||d.workspaceBatch||d.analyticsRecords||d.dataScene||d.workspaceAction==='batch'){workspaceReviewTab='all';workspaceExecutionFilter='all';workspaceEvidenceQueue=[];}if(d.view||d.nav)workspaceEvidenceQueue=[];if(d.grade){workspaceReviewTab='all';workspaceExecutionFilter='all';workspaceRecordStatus=d.grade;workspaceRecordPage=1;workspaceEvidenceQueue=[];}},true);
document.addEventListener('submit',e=>{if(e.target.id==='workspaceRecordSearch')workspaceEvidenceQueue=[];},true);

const originalWorkspaceLlmReport=llmReportHtml;
llmReportHtml=function(rating){return originalWorkspaceLlmReport(rating).replace('待人工复核','模型建议复核');};


function workspaceHistoryResults(query=''){
  const keyword=query.trim().toLowerCase(),matches=workspaceConversations.filter(c=>!keyword||String(c.title||'新对话').toLowerCase().includes(keyword));
  return matches.map(c=>'<button class="conversation-link '+(workspaceConversation?.id===c.id?'active':'')+'" data-conversation="'+esc(c.id)+'" '+(workspaceConversation?.id===c.id?'aria-current="true" ':'')+(workspaceChatBusy?'disabled ':'')+'><strong>'+esc(c.title||'新对话')+'</strong><small>'+(workspaceConversation?.id===c.id?'当前对话 · ':'')+esc(formatTime(c.updated_at||c.created_at))+'</small></button>').join('')+(!matches.length?'<div class="empty"><p>'+(keyword?'没有找到相关对话，试试其他关键词。':'开始沟通后，对话会保存在这里。')+'</p></div>':'');
}
function openWorkspaceHistory(){
  modal('<div class="conversation-drawer-heading"><h2 id="modalTitle">历史对话</h2><p class="sub">'+workspaceConversations.length+' 条对话'+(workspaceChatBusy?' · 助手回复完成后可切换':' · 选择后继续沟通')+'</p></div><label class="conversation-search">搜索对话<input id="workspaceHistorySearch" type="search" placeholder="输入对话标题关键词" autocomplete="off" aria-controls="workspaceHistoryResults"></label><div class="conversation-drawer-list" id="workspaceHistoryResults">'+workspaceHistoryResults()+'</div><div id="formError" class="error" role="alert"></div>');
  document.querySelector('.modal').classList.add('conversation-drawer');document.querySelector('.modal').setAttribute('aria-modal','true');document.querySelector('.top').inert=true;
}
document.addEventListener('input',e=>{if(e.target.id==='workspaceHistorySearch')$('workspaceHistoryResults').innerHTML=workspaceHistoryResults(e.target.value);});
document.addEventListener('keydown',e=>{
  const dialog=document.querySelector('.modal');if(e.key!=='Tab'||$('overlay').hidden||!dialog.classList.contains('conversation-drawer'))return;
  const controls=[...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[href]')],first=controls[0],last=controls.at(-1);
  if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
});
