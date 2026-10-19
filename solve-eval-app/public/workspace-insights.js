'use strict';
// Summaries are derived from the saved, current-route ratings; no extra model call.
let insightSelection=null;
const insightDisclosures=new Map();
function insightDetails(key,label,body,extra=''){
  return '<details class="insight-details '+extra+'" data-insight-disclosure="'+esc(key)+'"'+(insightDisclosures.get(key)?' open':'')+'><summary>'+label+'</summary><div class="insight-details-body">'+body+'</div></details>';
}
document.addEventListener('toggle',e=>{const key=e.target.dataset?.insightDisclosure;if(key)insightDisclosures.set(key,e.target.open);},true);
function insightRows(){return workspaceRows(view==='batches'?{batch:analysisTaskId,target:'all',scene:'all'}:{});}
function insightIssueHtml(issue,index){
 const change=AnalysisSummary.improvement(issue),reviews=issue.sources.map(s=>(data.rating_reviews||[]).filter(r=>r.rating_id===s.rating_id).at(-1)).filter(Boolean),needsReview=reviews.some(r=>r.decision!=='confirm');
 const sourceHtml=issue.sources.map(s=>'<article class="insight-source"><strong>'+esc(s.record_name)+'</strong><p>'+esc(s.description)+'</p>'+(s.suggestion?'<p>原评估建议：'+esc(s.suggestion)+'</p>':'')+(s.quotes||[]).map(q=>'<blockquote>'+esc(q.quote)+'</blockquote>').join('')+wsButton('查看原文与评估','data-workspace-evidence="'+esc(s.item_id)+'"')+'</article>').join('');
 return '<article class="insight-issue insight-change"><div class="insight-issue-title"><span class="insight-number">'+(index+1)+'</span><h3>'+esc(issue.title)+'</h3><span>涉及 '+issue.count+' 条记录</span><span class="badge">'+esc(change.target)+'</span></div><dl class="insight-change-fields"><div><dt>问题</dt><dd>'+esc(issue.examples[0])+'</dd></div><div><dt>改进建议</dt><dd>'+esc(issue.suggestions[0]||'先核对对应记录，明确具体问题及修改方向。')+'</dd></div><div><dt>为什么要改</dt><dd>'+esc(change.why)+'</dd></div><div><dt>改后怎么看效果</dt><dd>'+esc(change.goal)+'</dd></div></dl>'+(needsReview?'<p class="notice warn">来源中有人工作出改判或要求补证，请先核对复核意见，再决定是否改 Skill。</p>':'')+insightDetails('issue-'+issue.key,'查看来源和各条记录的建议（'+issue.count+' 条）',sourceHtml)+'<div class="actions">'+(issue.kind==='finding'?wsButton('整理为 AI 客服 Skill 改进待办','data-insight-improve="'+index+'"',true):wsButton('先查看记录并复核','data-insight-issue="'+index+'"'))+wsButton('查看涉及记录','data-insight-issue="'+index+'" aria-label="'+esc('查看'+issue.title+'涉及的'+issue.count+'条记录')+'"')+'</div></article>';
}
function insightSummaryHtml(rows,key,title){
 const summary=AnalysisSummary.aggregate(rows),issues=summary.issues;
 return '<section class="panel insight-overview" aria-label="'+title+'"><div class="panel-head"><h2>'+title+'</h2><span class="insight-range">共 '+summary.total+' 条 · 已分析 '+summary.assessed+' 条'+(summary.remaining?' · '+summary.remaining+' 条待处理':'')+(summary.excluded?' · '+summary.excluded+' 条方案不适用':'')+'</span></div><p class="insight-lead">'+esc(summary.assessed?'已归纳 '+issues.length+' 类问题，先核对来源，再决定怎样完善 AI 客服 Skill。':summary.conclusion)+'</p>'+(summary.assessed?'<p class="sub">问题和建议来自本范围已保存的评估；原因与验收方向为整理建议，需结合原文核对。保存待办后可导出改进说明，供修改 Skill 使用。</p><div class="insight-priorities">'+(issues.length?issues.slice(0,3).map(insightIssueHtml).join(''):'<p class="notice">本批未列出明确问题，暂不生成 Skill 修改建议，可抽查关键记录。</p>')+'</div>':'')+'<div class="insight-summary-more">'+(issues.length>3?insightDetails(key+'-issues','展开其余 '+(issues.length-3)+' 类问题',issues.slice(3).map((g,i)=>insightIssueHtml(g,i+3)).join('')):'')+(summary.assessed?insightDetails(key+'-method','查看总结口径','<p>按当前材料和匹配内容一致的最新评级，依同一方案、问题类型与规则引用归并。涉及条数按记录去重，同一记录可涉及多个问题。先展示涉及 L0 的问题，再按涉及记录数排列；这只是核对顺序，不等于业务严重程度。问题和建议取代表记录，各条原始建议可展开查看。</p><p>人工复核独立保留；材料不足先补充依据，不自动当作客服 Skill 缺陷。整理待办不会修改评级，也不会自动发布客服 Skill。'+(summary.remaining?'本范围仍有待处理记录，当前为阶段性总结。':'')+'</p>'):'')+'</div></section>';
}
function insightSkillEditor(index){
 const issue=AnalysisSummary.aggregate(insightRows()).issues[index];if(!issue||issue.kind!=='finding')return;const change=AnalysisSummary.improvement(issue),requestId=AppIds.newId(),sources=issue.sources.filter(s=>s.rating_id&&Number.isInteger(s.finding_index)),ratingIds=[...new Set(sources.map(s=>s.rating_id))];
 if(!ratingIds.length)return;const services=(data.services||[]).filter(s=>sources.every(source=>!s.scope||s.scope===source.scope)&&sources.every(source=>!s.scene_id||!source.scene_id||s.scene_id===source.scene_id));
 modal('<div class="skill-change-editor"><h2 id="modalTitle">整理 AI 客服 Skill 改进待办</h2><p class="sub">'+esc(issue.title)+' · 来自 '+issue.count+' 条记录。下面已替你整理好，可直接修改后保存。</p><div class="notice">这是给客服 Skill 维护人的修改说明。保存后到「改进待办」继续处理，不会自动修改或发布 Skill。</div><label class="field">问题<textarea id="skillChangeProblem" maxlength="6000">'+esc(issue.examples.join('\n'))+'</textarea></label><label class="field">建议怎么改<textarea id="skillChangeSuggestion" maxlength="6000">'+esc(issue.suggestions.join('\n')||'结合来源原文补充具体修改要求。')+'</textarea></label><label class="field">为什么要改<textarea id="skillChangeReason" maxlength="6000">'+esc(change.why)+'</textarea></label><label class="field">改后如何验证<textarea id="skillChangeGoal" maxlength="6000">'+esc(change.goal)+'</textarea></label><div class="form-grid"><label class="field">准备修改哪份客服 Skill<select id="skillChangeTarget"><option value="">暂不指定，先保存改进说明</option>'+services.map(s=>'<option value="'+esc(s.id)+'">'+esc(s.code+' · '+s.version)+'</option>').join('')+'</select></label><label class="field">负责人<input id="skillChangeOwner" value="'+esc($('actor').value)+'" maxlength="100"></label></div><p class="sub">原评估是否正确需先核对；缺少业务政策时，不把个案结论写成新政策。来源记录会随待办保留。</p><div id="formError" class="error"></div><div class="form-actions">'+wsButton('保存改进待办','id="saveSkillChange"',true)+'</div></div>');
 $('saveSkillChange').onclick=()=>action(async()=>{const result=await request('POST','/api/monitor/ratings/'+ratingIds[0]+'/tasks',{request_id:requestId,rating_ids:ratingIds,finding_refs:sources.map(s=>({rating_id:s.rating_id,finding_index:s.finding_index})),title:issue.title+' · 客服 Skill 改进',category:'AI 客服 Skill',priority:issue.rank===3?'高':'中',description:$('skillChangeProblem').value,suggestion:$('skillChangeSuggestion').value,reason:$('skillChangeReason').value,goal:$('skillChangeGoal').value,service_skill_id:$('skillChangeTarget').value||null,owner:$('skillChangeOwner').value,actor:actor()});await refresh();taskEditor(null,null,result.task.id);toast('已保存，可导出改进说明并继续完善客服 Skill');});
}
function skillChangeDocument(task){const change=task.skill_change;if(!change)return '';return '# '+task.title+'\n\n状态：待维护人核对、修改及验证（此说明不是已发布 Skill）\n\n目标 Skill：'+(change.target_skill?change.target_skill.code+' @ '+change.target_skill.version:'尚未指定')+'\n负责人：'+task.owner+'\n\n## 问题\n'+task.description+'\n\n## 建议怎么改\n'+change.suggestion+'\n\n## 为什么要改\n'+change.reason+'\n\n## 改后如何验证\n'+task.goal+'\n\n## 来源案例\n'+change.source_findings.map(s=>'### '+s.record_name+'\n评级记录：'+s.rating_id+'\n原评估发现：'+s.description+'\n原评估建议：'+(s.suggestion||'未提供')+'\n'+(s.quotes||[]).map(q=>'> '+q.quote).join('\n')+(s.review?'\n人工复核（需核对依据）：'+s.review.reason:'')).join('\n\n')+'\n\n## 使用边界\n本说明来自评估发现和整理建议，需结合原文与有效业务规则核对；不从个案阈值、缺失材料或历史等级创造业务政策。修改后用原问题案例和原本正确的案例验证，不把评估等级上升直接当作修复成功。\n';}
const insightTaskEditor=taskEditor;
taskEditor=function(runId,caseId,id){
 const task=data.tasks.find(t=>t.id===id);if(!task?.skill_change)return insightTaskEditor(runId,caseId,id);const change=task.skill_change;
 modal('<div class="skill-change-editor"><h2 id="modalTitle">'+esc(task.title)+'</h2><p class="sub">负责人：'+esc(task.owner)+' · '+esc(task.status)+' · 目标 Skill：'+esc(change.target_skill?change.target_skill.code+' @ '+change.target_skill.version:'尚未指定')+'</p><div class="notice">改进说明已保存。下一步：下载给 Skill 维护人，按建议修改，再用案例验证实际输出。</div><dl class="insight-change-fields"><div><dt>问题</dt><dd>'+esc(task.description)+'</dd></div><div><dt>建议怎么改</dt><dd>'+esc(change.suggestion)+'</dd></div><div><dt>为什么要改</dt><dd>'+esc(change.reason)+'</dd></div><div><dt>改后如何验证</dt><dd>'+esc(task.goal)+'</dd></div></dl>'+wsButton('下载改进说明（Markdown）','data-skill-change-download="'+esc(id)+'"',true)+'<details class="skill-change-export"><summary>查看完整改进说明与来源</summary><textarea readonly aria-label="可复制的客服 Skill 改进说明">'+esc(skillChangeDocument(task))+'</textarea></details><details class="skill-change-export"><summary>登记处理进度</summary><label class="field">当前状态<select id="ratingTaskStatus">'+['待修改','修改中','待复验'].map(s=>'<option '+(s===task.status?'selected':'')+'>'+s+'</option>').join('')+'</select></label><label class="field">进度说明<textarea id="ratingTaskNote"></textarea></label><p class="sub">此处只登记进度，是否修复需结合修改后的实际输出验证。</p>'+wsButton('保存进度','id="saveRatingTaskProgress"')+'</details><div id="formError" class="error"></div></div>');
 $('saveRatingTaskProgress').onclick=()=>action(async()=>{await request('PATCH','/api/monitor/rating-tasks/'+id,{status:$('ratingTaskStatus').value,note:$('ratingTaskNote').value,actor:actor()});await refresh();taskEditor(null,null,id);toast('待办进度已保存');});
};

const insightOriginalTasks=renderAnalysisTasks;
renderAnalysisTasks=function(){
  const batch=analysisTaskId&&data.batches.find(b=>b.id===analysisTaskId);
  if(!batch)return insightOriginalTasks();
  batchId=batch.id;
  const rows=workspaceRows({batch:batch.id,target:'all',scene:'all'}),s=workspaceStats(rows),running=runningRating(batch),confirmed=batchCanRate(batch),hasResults=rows.some(r=>r.rating);
  let confirmationAction='';
  let routing=routingConfirmationPanel(batch);if(!routing.includes('data-learning-start'))routing=routing.replace(/<div class="routing-confirm-footer">[\s\S]*?<\/div>/,match=>{confirmationAction=match;return '';});
  const config=routing+llmBatchPanel(batch);
  const configHtml=running?insightDetails('task-'+batch.id,'查看任务详情',config):hasResults&&confirmed?insightDetails('task-'+batch.id,'任务详情与重新分析',config+'<div class="actions">'+wsButton('重新执行本批评级','data-rate-batch',true)+'</div>'):config;
  const progress=running?'<div class="notice" role="status">正在分析 · 已处理 '+(running.processed_count||0)+' / '+running.total+' 条。以下为阶段性总结。</div>':'';
  const runAction=(!hasResults||running||!confirmed)&&!routing.includes('data-learning-start')?'<div class="task-sticky-actions">'+(confirmed?'<div class="task-run-actions">'+wsButton(running?'正在分析…':'开始本批分析','data-rate-batch '+(running||!s.valid?'disabled':''),true)+'</div>':confirmationAction||'<p class="sub">请刷新后读取本批监测方案。</p>')+'</div>':'';
  return '<button class="link workspace-back" data-task-list>← 全部分析任务</button>'+heading('',esc(batch.name),esc(batch.source_name),wsButton('查看数据分析','data-analyze-batch="'+esc(batch.id)+'"'))+progress+(hasResults?insightSummaryHtml(rows,'batch-'+batch.id,'本批分析总结'):'')+configHtml+workspaceRecordsPanel(rows,{task:true})+runAction;
};
// The full analytics dashboard is rendered by workspace-analytics.js.
const insightOriginalFiltered=filteredWorkspaceRows;
filteredWorkspaceRows=function(rows,options={}){return insightOriginalFiltered(insightSelection?rows.filter(r=>insightSelection.ids.includes(r.item.id)):rows,options);};
const insightOriginalRecords=renderWorkspaceRecords;
renderWorkspaceRecords=function(){return (insightSelection?'<div class="insight-filter-banner"><div><strong>'+esc(insightSelection.label)+'</strong><span>涉及 '+insightSelection.ids.length+' 条记录</span></div>'+wsButton(insightSelection.origin==='batches'?'返回本批总结':'返回分析总结','data-insight-return')+wsButton('清除范围筛选','data-insight-clear')+'</div>':'')+insightOriginalRecords();};

function insightRecordHtml(row){
  const r=AnalysisSummary.record(row),rating=row.rating,report=rating?.report,graded=gradeOrder.includes(row.status);
  const grade=graded?row.status+' · '+gradeLabels[row.status]:statusNames[row.status]||row.status;
  const extra=r.findings.slice(1).map(f=>'<article class="insight-extra"><h4>'+esc(f.description)+'</h4><p><b>建议：</b>'+esc(f.suggestion||'需结合依据进一步复核')+'</p></article>').join('');
  const sources=rating?.request_snapshot?.sources||[];
  const finding=r.findings[0],quotes=finding?.quotes|| (finding?.quote?[{quote:finding.quote,source:finding.source}]:[]);
  const evidence=quotes.map(q=>'<blockquote>'+esc(q.quote)+'</blockquote><p class="meta">'+esc(sources.find(s=>s.id===q.source)?.label||q.source||'')+'</p>').join('');
  const full=rating?.request_snapshot?llmReportHtml(rating):'<p>'+esc(r.conclusion)+'</p><pre>'+esc(JSON.stringify(report||{status:row.status,error:rating?.error||row.item.error},null,2))+'</pre>';
  return '<section class="insight-record-summary"><div class="insight-record-label"><h3>分析结论</h3><span class="grade-pill grade-'+esc(row.status)+'">'+esc(grade)+'</span></div><p class="insight-record-lead">'+esc(AnalysisSummary.short(r.conclusion,80))+'</p><dl class="insight-answer"><div><dt>'+(graded?'主要问题':'当前状态')+'</dt><dd>'+esc(AnalysisSummary.short(r.problem,100))+'</dd></div><div><dt>建议</dt><dd>'+esc(AnalysisSummary.short(r.advice,110))+'</dd></div></dl>'+(extra?insightDetails('record-'+row.item.id+'-more','其他问题（'+(r.findings.length-1)+'）',extra):'')+'</section>'+insightDetails('record-'+row.item.id+'-evidence','查看判断依据',(evidence||'<p class="sub">'+esc(r.missing.length?'待补材料：'+r.missing.join('、'):'打开完整评级查看判断过程与引用依据。')+'</p>')+insightDetails('record-'+row.item.id+'-full','完整评级与运行详情',full));
}
// Reading and review share the same source-left, conclusion-right workspace.
const insightOriginalEvidence=openWorkspaceEvidence;
openWorkspaceEvidence=function(id,editing=false){
  if(editing)return insightOriginalEvidence(id,true);
  rememberReviewDraft();const row=evidenceRow(id);if(!row)return;
  prepareEvidenceQueue(id);workspaceEvidenceId=id;workspaceEvidenceEditing=false;
  const rec=row.item.record_snapshot,rating=row.rating,review=workspaceLatestReview(rating?.id),index=workspaceEvidenceQueue.indexOf(id),previous=workspaceEvidenceQueue[index-1],next=workspaceEvidenceQueue[index+1];
  const source=rec.business_record?businessRecordHtml(rec):'<h4>原始会话</h4><blockquote>'+esc(rec.session_text||'未提供')+'</blockquote><h4>AI 回复</h4><blockquote>'+esc(rec.ai_reply||'未提供')+'</blockquote><details><summary>证据与来源</summary><pre>'+esc(JSON.stringify(rec.evidence||[],null,2))+'</pre></details>';
  const tasks=(data.tasks||[]).filter(t=>t.rating_id===rating?.id||(t.rating_refs||[]).some(r=>r.rating_id===rating?.id));
  const reviewHtml=review?'<p><strong>'+esc(review.status)+' · 人工 '+esc(review.grade)+'</strong></p><p>'+esc(review.reason)+'</p><p class="meta">'+esc(review.actor)+' · '+esc(formatTime(review.created_at))+'</p>':'';
  modal('<div class="evidence-heading"><div><h2 id="modalTitle">'+esc(rec.name)+'</h2><p class="sub">'+esc(rec.scene||'场景待确认')+' · '+esc(targetNames[rec.scope]||'对象待确认')+'</p></div><span class="evidence-position">'+(index+1)+' / '+workspaceEvidenceQueue.length+'</span></div><div class="evidence-columns"><section class="evidence-source"><h3>导入数据</h3>'+source+'</section><section class="evidence-result insight-record-body">'+insightRecordHtml(row)+(review?insightDetails('record-'+id+'-review','人工复核记录',reviewHtml):'')+(tasks.length?insightDetails('record-'+id+'-tasks','关联改进待办（'+tasks.length+'）',tasks.map(t=>'<p><strong>'+esc(t.title||t.description)+'</strong> · '+esc(t.status)+'</p>').join('')):'')+'</section></div><footer class="evidence-footer"><div class="actions">'+wsButton('上一条','data-evidence-step="'+esc(previous||'')+'" '+(!previous?'disabled':''))+wsButton('下一条','data-evidence-step="'+esc(next||'')+'" '+(!next?'disabled':''))+'</div><div class="actions">'+(rating?.report?.grade?wsButton('创建改进待办','data-rating-task="'+esc(rating.id)+'"')+wsButton(review?'追加复核':'人工复核','data-workspace-review="'+esc(rating.id)+'"',true):wsButton('查看所属任务','data-workspace-batch="'+esc(row.item.batch_id)+'"'))+'</div></footer>');
  document.querySelector('.modal').classList.add('evidence-drawer','insight-record-drawer');
};
// Remove the compact-reading modifier before any other modal or the review workspace.
const insightOriginalModal=modal;
modal=function(html){document.querySelector('.modal').classList.remove('insight-record-drawer');insightOriginalModal(html);};
const insightOriginalLlmReport=llmReportHtml;
llmReportHtml=function(rating){return '<div class="insight-full-report">'+insightOriginalLlmReport(rating)+'</div>';};

document.addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b||b.disabled)return;const d=b.dataset;
  if(d.insightImprove!==undefined)insightSkillEditor(Number(d.insightImprove));
  if(d.skillChangeDownload){const task=data.tasks.find(t=>t.id===d.skillChangeDownload);if(task?.skill_change){const url=URL.createObjectURL(new Blob([skillChangeDocument(task)],{type:'text/markdown;charset=utf-8'})),link=document.createElement('a');link.href=url;link.download='客服Skill改进说明-'+task.id+'.md';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}}
  if(d.insightIssue!==undefined){
    const issue=AnalysisSummary.aggregate(insightRows()).issues[Number(d.insightIssue)];if(!issue)return;
    const origin=view,originBatch=origin==='batches'?analysisTaskId:batchId;
    insightSelection={ids:issue.ids,label:issue.title,origin,batch:originBatch,scope:origin==='batches'?'all':scope,scene:origin==='batches'?'all':sceneFilter};
    workspaceRecordsBatch=originBatch;scope=insightSelection.scope;sceneFilter=insightSelection.scene;
    workspaceReviewTab='all';workspaceExecutionFilter='all';workspaceRecordStatus='all';workspaceRecordQuery='';workspaceRecordPage=1;workspaceEvidenceQueue=[];
    show('records');
  }
  if(b.hasAttribute('data-insight-return')){
    const selection=insightSelection;if(!selection)return;insightSelection=null;workspaceEvidenceQueue=[];scope=selection.scope;sceneFilter=selection.scene;batchId=selection.batch;
    if(selection.origin==='batches')analysisTaskId=selection.batch;
    show(selection.origin);
  }
  if(b.hasAttribute('data-insight-clear')){insightSelection=null;workspaceRecordPage=1;workspaceEvidenceQueue=[];render();}
},false);
document.addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b||b.disabled)return;const d=b.dataset;
  if(d.view||d.nav||d.workspaceBatch||d.analyticsRecords||d.dataScene||d.workspaceAction||b.hasAttribute('data-all-records'))insightSelection=null;
},true);
document.addEventListener('change',e=>{if(['workspacePageScope','sceneFilter','workspaceDataBatch'].includes(e.target.id))insightSelection=null;},true);

if(typeof location!=='undefined'){const requestedView=new URLSearchParams(location.search).get('view');if(['analytics','records','batches'].includes(requestedView))view=requestedView;}
