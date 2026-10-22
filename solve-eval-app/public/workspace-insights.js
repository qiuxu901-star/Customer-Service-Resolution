'use strict';
// Summaries are derived from the saved, current-route ratings; no extra model call.
let insightSelection=null;
const insightDisclosures=new Map();
function insightDetails(key,label,body,extra=''){
  return '<details class="insight-details '+extra+'" data-insight-disclosure="'+esc(key)+'"'+(insightDisclosures.get(key)?' open':'')+'><summary>'+label+'</summary><div class="insight-details-body">'+body+'</div></details>';
}
document.addEventListener('toggle',e=>{const key=e.target.dataset?.insightDisclosure;if(key)insightDisclosures.set(key,e.target.open);},true);
function insightRows(){return view==='batches'&&analysisTaskId?batchSummaryRows(analysisTaskId):workspaceRows({});}
// Performance findings keep the problem and its evidence together; changes belong to diagnosis.
function findingLocationHtml(f,sources=[],{compact=false}={}){
 const location=FindingPresentation.locations(f,sources),main=location.main?.label||'未明确';
 if(compact)return '<span class="finding-main-location">'+esc(main)+'</span>';
 return '<div class="finding-locations"><p><span class="finding-location-label">主要问题位置：</span><span class="finding-main-location">'+esc(main)+'</span></p>'+(location.others.length?'<p class="finding-related-locations">同一问题也出现在：'+esc(location.others.map(x=>x.label).join('、'))+'。</p>':'')+'</div>';
}
function insightFindingHtml(f,{sources=[],recordName='',count=0,showSuggestion=false}={}){
 const quotes=(f.quotes||(f.quote?[{quote:f.quote,source:f.source}]:[])).filter(q=>typeof q.quote==='string'&&q.quote.trim());
 const quoteHtml=q=>{
  const source=sources.find(s=>s.id===q.source),label=q.label||source?.label||q.source||'原始材料';
  const role=q.role||source?.role,roleName={ai_output:'AI 输出',context:'会话陈述',human_context:'人工意见',evidence:'导入证据'}[role];
  return '<div class="finding-quote"><p class="finding-citation">'+esc([label,roleName,q.id].filter(Boolean).join(' · '))+'</p><blockquote>'+esc(q.quote)+'</blockquote></div>';
 };
 const ai=quotes.filter(q=>(q.role||sources.find(s=>s.id===q.source)?.role)==='ai_output');
 const location=FindingPresentation.locations(f,sources),targetIds=new Set(location.items.map(x=>x.id));
 const outputs=targetIds.size?ai.filter(q=>targetIds.has(q.source)):ai;
 const comparison=quotes.filter(q=>!outputs.includes(q));
 const effect=FindingPresentation.impact(f);
 const group=(label,items)=>items.length?'<div class="finding-quote-group"><h5>'+label+'</h5>'+items.slice(0,2).map(quoteHtml).join('')+(items.length>2?'<details class="finding-more-quotes"><summary>其他引用（'+(items.length-2)+'）</summary>'+items.slice(2).map(quoteHtml).join('')+'</details>':'')+'</div>':'';
 const evidence=group('AI 相关输出',outputs)+group('核对材料',comparison);
 const section=(number,label,body,kind='')=>'<section class="finding-section '+kind+'"><h4><span aria-hidden="true">'+number+'</span>'+label+'</h4>'+body+'</section>';
 return '<div class="finding-explanation">'+(recordName?'<p class="finding-case">'+(count>1?'本类涉及 '+count+' 条记录，以下以「'+esc(recordName)+'」为例。其他记录请展开来源案例逐条核对。':'来源：'+esc(recordName))+'</p>':'')+
 findingLocationHtml(f,sources)+
 section('01','哪里有问题','<p>'+esc(FindingPresentation.problem(f)||'原评估未说明具体问题，请先核对记录。')+'</p>','finding-problem')+
 (effect.text?'<p class="finding-impact"><strong>对处理的影响：</strong>'+esc(effect.text)+'</p>':'')+
 section('02','依据是什么',(f.evidence_reason?'<p>'+esc(f.evidence_reason)+'</p>':'')+(evidence||'<p class="finding-unavailable">未保存可展示的原文引用，请查看完整上下文并复核。</p>'),'finding-evidence')+
 (showSuggestion&&f.suggestion?section('03','建议怎么处理','<p>'+esc(f.suggestion)+'</p>','finding-action'):'')+'</div>';
}
const insightIssuePages=new Map();
const insightSourceKey=s=>JSON.stringify([s.rating_id,s.finding_index]);
function insightIssuePool(){return view==='analytics'&&typeof dashboardProblemIssues!=='undefined'?dashboardProblemIssues:AnalysisSummary.aggregate(insightRows()).issues;}
function insightCell(text,fallback){const value=String(text||fallback||'');return value.length>110?'<details class="issue-cell-more"><summary>'+esc(AnalysisSummary.short(value,85))+'</summary><p>'+esc(value)+'</p></details>':esc(value);}
function insightOrderedSources(issue){
 const records=new Map();for(const source of issue.sources){if(!records.has(source.item_id))records.set(source.item_id,[]);records.get(source.item_id).push(source);}return [...records.values()].flatMap(group=>group.sort((a,b)=>FindingPresentation.priority(a)-FindingPresentation.priority(b)||(a.finding_index??Number.MAX_SAFE_INTEGER)-(b.finding_index??Number.MAX_SAFE_INTEGER)));
}
function insightIssueExplanation(issue){
 const ordered=insightOrderedSources(issue),page=Math.min(insightIssuePages.get(issue.key)||0,Math.max(0,Math.ceil(ordered.length/10)-1)),sources=ordered.slice(page*10,page*10+10);
 const definition=issue.all_findings?'按工单查看问题位置与处理影响；点击具体问题核对原文和依据。':issue.category?.definition||'按工单核对具体问题；问题位置与核对材料分开展示。';
 const rows=sources.map((source,index)=>{
  const first=index===0||sources[index-1].item_id!==source.item_id,rowspan=sources.filter(s=>s.item_id===source.item_id).length,recordCount=ordered.filter(s=>s.item_id===source.item_id).length;
  const review=(data.rating_reviews||[]).filter(r=>r.rating_id===source.rating_id).at(-1),findingNumber=Number.isInteger(source.finding_index)?'问题 '+(source.finding_index+1):'材料核对';
  const rating=(data.ratings||[]).find(r=>r.id===source.rating_id),materials=rating?.request_snapshot?.sources||[],item=(data.batch_items||[]).find(i=>i.id===source.item_id);
  const open=Number.isInteger(source.finding_index)?'data-finding-open="'+esc(insightSourceKey(source))+'" data-finding-item="'+esc(source.item_id)+'"':'data-workspace-evidence="'+esc(source.item_id)+'"';
  return '<tr data-finding-key="'+esc(insightSourceKey(source))+'">'+(first?'<td class="issue-record-cell" rowspan="'+rowspan+'"><div class="issue-record-heading"><strong>'+esc(source.record_name)+'</strong>'+(gradeOrder.includes(source.grade)?'<span class="grade-pill grade-'+esc(source.grade)+'" aria-label="工单评级 '+esc(source.grade)+'">'+esc(source.grade)+'</span>':'')+'</div><small>'+esc(source.scene||source.classification?.scene||'')+'</small><span class="issue-record-count">'+(issue.all_findings?'本工单 ':'本类 ')+recordCount+' 个问题'+(source.total_finding_count>recordCount?' · 工单共 '+source.total_finding_count+' 个问题':'')+'</span>'+'<span class="review-state record-view-'+workspaceViewState({item:item||{id:source.item_id},rating})+'">'+(workspaceViewState({item:item||{id:source.item_id},rating})==='viewed'?'已查看':'未查看')+'</span>'+recordMarkBadges(item||{},source.rating_id)+'<div class="issue-record-actions">'+(item?workspaceMarkButton(item,source.rating_id):'')+wsButton('查看工单全部问题','data-finding-record="'+esc(source.item_id)+'" data-finding-rating="'+esc(source.rating_id)+'"')+'</div>'+'</td>':'')+
  '<td class="issue-location-cell">'+findingLocationHtml(source,materials,{compact:true})+'</td><td class="issue-problem-cell"><span class="issue-finding-number">'+findingNumber+'</span>'+(issue.all_findings?'<span class="issue-category-tag">'+esc(source.category_name||'待归类')+'</span>':'')+'<p>'+esc(FindingPresentation.problem(source))+'</p>'+(review?'<small class="issue-review-note">'+esc(review.decision==='confirm'?'人工已复核':'存在改判或补证意见，请核对')+'</small>':'')+'</td><td class="issue-impact-cell"><p>'+esc(FindingPresentation.impact(source).text||'—')+'</p></td><td class="issue-action-cell">'+wsButton('查看问题与依据',open)+'</td></tr>';
 }).join('');
 return '<div class="issue-compact issue-evidence-list"><section class="issue-common-summary"><span class="issue-common-label">'+(issue.all_findings?'全部具体问题':issue.category?'本类共性表现':'待核对的问题')+'</span><p>'+esc(definition)+'</p></section><div class="issue-table-wrap"><table class="issue-summary-table issue-evidence-table issue-location-table"><thead><tr><th>来源工单</th><th>主要问题位置</th><th>哪里有问题</th><th>对处理的影响</th><th>核对依据</th></tr></thead><tbody>'+rows+'</tbody></table></div><div class="issue-table-footer"><span>显示 '+(ordered.length?page*10+1:0)+'–'+Math.min((page+1)*10,ordered.length)+' / '+ordered.length+' 个问题 · 每页10个问题</span><div>'+wsButton('上一页','data-issue-page="'+esc(issue.key)+'" data-page="'+(page-1)+'" '+(page===0?'disabled':''))+wsButton('下一页','data-issue-page="'+esc(issue.key)+'" data-page="'+(page+1)+'" '+((page+1)*10>=ordered.length?'disabled':''))+'</div></div>'+(issue.classification_status?'<div class="actions">'+wsButton(issue.classification_status==='classified'?'核对本类归类':'整理这些问题','data-classify-issue="'+esc(issue.key)+'"')+'</div>':'')+'</div>';
}
function insightSourceEvidenceHtml(source){return insightFindingHtml(source);}
function insightFrozenContextHtml(source){
 const rating=(data.ratings||[]).find(r=>r.id===source.rating_id),sources=(rating?.request_snapshot?.sources||[]).filter(s=>['ai_output','context','human_context','evidence'].includes(s.role));
 return sources.length?'<details class="issue-full-context"><summary>展开本次评估保存的完整上下文</summary>'+sources.map(s=>'<section><h4>'+esc(s.label||s.id)+'</h4><pre>'+esc(s.text||'未保存正文')+'</pre></section>').join('')+'</details>':'';
}
document.addEventListener('click',event=>{
 const button=event.target.closest('button');if(!button||button.disabled)return;const d=button.dataset;
 if(d.findingRecord){openWorkspaceEvidence(d.findingRecord,false,{ratingId:d.findingRating});return;}
 if(d.findingOpen){let ref;try{ref=JSON.parse(d.findingOpen);}catch{return;}if(!Array.isArray(ref)||typeof ref[0]!=='string'||!Number.isInteger(ref[1])||ref[1]<0)return;openWorkspaceEvidence(d.findingItem,false,{ratingId:ref[0],findingIndex:ref[1]});return;}
 if(d.issuePage){insightIssuePages.set(d.issuePage,Math.max(0,Number(d.page)||0));const issue=insightIssuePool().find(i=>i.key===d.issuePage);if(view==='analytics'&&issue)modal('<h2 id="modalTitle">'+esc(issue.title)+'</h2>'+insightIssueExplanation(issue));else render();}
 if(d.issueEvidence){const issues=insightIssuePool(),issue=issues.find(i=>i.sources.some(s=>insightSourceKey(s)===d.issueEvidence)),source=issue?.sources.find(s=>insightSourceKey(s)===d.issueEvidence);if(!source)return;
  modal('<h2 id="modalTitle">'+esc(source.record_name)+' · '+(Number.isInteger(source.finding_index)?'问题 '+(source.finding_index+1):'材料核对')+'</h2>'+insightSourceEvidenceHtml(source)+insightFrozenContextHtml(source)+wsButton('查看工单与复核','data-workspace-evidence="'+esc(source.item_id)+'"'));
 }
 if(d.classifyIssue){const issue=insightIssuePool().find(x=>x.key===d.classifyIssue);if(issue)openIssueClassification(view==='batches'?analysisTaskId:batchId,issue.sources.map(insightSourceKey));}
},false);
function insightIssueHtml(issue,index){
 const change=AnalysisSummary.improvement(issue),reviews=issue.sources.map(s=>(data.rating_reviews||[]).filter(r=>r.rating_id===s.rating_id).at(-1)).filter(Boolean),needsReview=reviews.some(r=>r.decision!=='confirm');
 const sourceHtml=issue.sources.map(s=>'<article class="insight-source"><strong>'+esc(s.record_name)+'</strong>'+insightSourceEvidenceHtml(s)+wsButton('查看原文与评估','data-workspace-evidence="'+esc(s.item_id)+'"')+'</article>').join('');
 return '<article class="insight-issue insight-change"><div class="insight-issue-title"><span class="insight-number">'+(index+1)+'</span><h3>'+esc(issue.title)+'</h3><span>涉及 '+issue.count+' 条记录</span><span class="badge">'+esc(typeof diagnosisIssueStateText==='function'?diagnosisIssueStateText(issue):change.target)+'</span></div>'+insightIssueExplanation(issue)+(needsReview?'<p class="notice warn">来源中有人工作出改判或要求补证，请先核对复核意见，再决定是否改 Skill。</p>':'')+'<div class="actions">'+(issue.kind==='finding'?wsButton('诊断业务 Skill','data-diagnose-issue="'+index+'"',true):wsButton('先查看记录并复核','data-insight-issue="'+index+'"'))+wsButton('查看涉及记录','data-insight-issue="'+index+'" aria-label="'+esc('查看'+issue.title+'涉及的'+issue.count+'条记录')+'"')+'</div></article>';
}
function insightSummaryHtml(rows,key,title){
 const summary=AnalysisSummary.aggregate(rows),issues=summary.issues;
 return '<section class="panel insight-overview" aria-label="'+title+'"><div class="panel-head"><h2>'+title+'</h2><span class="insight-range">共 '+summary.total+' 条 · 已分析 '+summary.assessed+' 条'+(summary.remaining?' · '+summary.remaining+' 条待处理':'')+(summary.excluded?' · '+summary.excluded+' 条方案不适用':'')+'</span></div><p class="insight-lead">'+esc(summary.assessed?'已归纳 '+issues.length+' 类问题，先核对表现问题，再选择是否诊断业务 Skill。':summary.conclusion)+'</p>'+(summary.assessed?'<p class="sub">问题和依据来自本范围已保存的评估；原因和修改方案在业务 Skill 诊断中核实；每次诊断由人工选择具体工单和问题后发起。</p><div class="insight-priorities">'+(issues.length?issues.slice(0,3).map(insightIssueHtml).join(''):'<p class="notice">本批未列出明确问题，暂不生成 Skill 修改建议，可抽查关键记录。</p>')+'</div>':'')+'<div class="insight-summary-more">'+(issues.length>3?insightDetails(key+'-issues','展开其余 '+(issues.length-3)+' 类问题',issues.slice(3).map((g,i)=>insightIssueHtml(g,i+3)).join('')):'')+(summary.assessed?insightDetails(key+'-method','查看总结口径','<p>按当前材料和匹配内容一致的评级以及独立归类记录，依分类定义版本和类别编号归并；尚未归类、未分类、需重新归类分别保留。涉及条数按记录去重，同一记录可涉及多个问题。先展示涉及 L0 的问题，再按涉及记录数排列；这只是核对顺序，不等于业务严重程度。问题与依据逐条对应来源工单，完整上下文按需展开。</p><p>人工复核独立保留；材料不足先补充依据，不自动当作客服 Skill 缺陷。整理待办不会修改评级，也不会自动发布客服 Skill。'+(summary.remaining?'本范围仍有待处理记录，当前为阶段性总结。':'')+'</p>'):'')+'</div></section>';
}
function insightSkillEditor(index){return openIssueDiagnosis(index);}

function skillChangeDocument(task){const change=task.skill_change;if(!change)return '';return '# '+task.title+'\n\n状态：待维护人核对、修改及验证（此说明不是已发布 Skill）\n\n目标 Skill：'+(change.target_skill?change.target_skill.code+' @ '+change.target_skill.version:'尚未指定')+'\n负责人：'+task.owner+'\n\n## 问题\n'+task.description+'\n\n## 建议怎么改\n'+change.suggestion+'\n\n## 为什么要改\n'+change.reason+'\n\n## 改后如何验证\n'+task.goal+'\n\n## 来源案例\n'+change.source_findings.map(s=>'### '+s.record_name+'\n评级记录：'+s.rating_id+'\n原评估发现：'+s.description+'\n原评估建议：'+(s.suggestion||'未提供')+'\n'+(s.quotes||[]).map(q=>'> '+q.quote).join('\n')+(s.review?'\n人工复核（需核对依据）：'+s.review.reason:'')).join('\n\n')+'\n\n## 使用边界\n本说明来自评估发现和整理建议，需结合原文与有效业务规则核对；不从个案阈值、缺失材料或历史等级创造业务政策。修改后用原问题案例和原本正确的案例验证，不把评估等级上升直接当作修复成功。\n';}
const insightTaskEditor=taskEditor;
taskEditor=function(runId,caseId,id){
 const task=data.tasks.find(t=>t.id===id);if(task?.source==='record_attention')return openAttentionTask(id);if(!task?.skill_change)return insightTaskEditor(runId,caseId,id);const change=task.skill_change;
 modal('<div class="skill-change-editor"><h2 id="modalTitle">'+esc(task.title)+'</h2><p class="sub">负责人：'+esc(task.owner)+' · '+esc(task.status)+' · 目标 Skill：'+esc(change.target_skills?.length?change.target_skills.map(s=>s.code+' @ '+s.version).join('；'):change.target_skill?change.target_skill.code+' @ '+change.target_skill.version:'尚未指定')+'</p><div class="notice">'+(task.diagnosis_action&&task.diagnosis_action!=='modify_skill'?'诊断待办已保存。按结论核查执行、补充材料或复核评估，保留处理依据。':'改进说明已保存。下一步：下载给 Skill 维护人，按建议修改，再用案例验证实际输出。')+'</div><dl class="insight-change-fields"><div><dt>问题</dt><dd>'+esc(task.description)+'</dd></div><div><dt>建议怎么改</dt><dd>'+esc(change.suggestion)+'</dd></div><div><dt>为什么要改</dt><dd>'+esc(change.reason)+'</dd></div><div><dt>改后如何验证</dt><dd>'+esc(task.goal)+'</dd></div></dl>'+(task.diagnosis_id?wsButton('查看来源诊断报告','data-diagnosis-open="'+esc(task.diagnosis_id)+'"'):'')+wsButton('下载改进说明（Markdown）','data-skill-change-download="'+esc(id)+'"',true)+'<details class="skill-change-export"><summary>查看完整改进说明与来源</summary><textarea readonly aria-label="可复制的客服 Skill 改进说明">'+esc(skillChangeDocument(task))+'</textarea></details><details class="skill-change-export"><summary>登记处理进度</summary><label class="field">当前状态<select id="ratingTaskStatus">'+['待修改','修改中','待复验'].map(s=>'<option '+(s===task.status?'selected':'')+'>'+s+'</option>').join('')+'</select></label><label class="field">进度说明<textarea id="ratingTaskNote"></textarea></label><p class="sub">此处只登记进度，是否修复需结合修改后的实际输出验证。</p>'+wsButton('保存进度','id="saveRatingTaskProgress"')+'</details><div id="formError" class="error"></div></div>');
 $('saveRatingTaskProgress').onclick=()=>action(async()=>{await request('PATCH','/api/monitor/rating-tasks/'+id,{status:$('ratingTaskStatus').value,note:$('ratingTaskNote').value,actor:actor()});await refresh();taskEditor(null,null,id);toast('待办进度已保存');});
};

const insightOriginalTasks=renderAnalysisTasks;
renderAnalysisTasks=function(){
  const batch=analysisTaskId&&data.batches.find(b=>b.id===analysisTaskId);
  if(!batch)return insightOriginalTasks();
  batchId=batch.id;
  const rows=workspaceRows({batch:batch.id,target:'all',scene:'all'}),s=workspaceStats(rows),running=runningRating(batch),confirmed=batchCanRate(batch),hasResults=rows.some(r=>r.rating);
  const summaryRows=batchSummaryRows(batch.id);
  let confirmationAction='';
  let routing=routingConfirmationPanel(batch);if(!routing.includes('data-learning-start'))routing=routing.replace(/<div class="routing-confirm-footer">[\s\S]*?<\/div>/,match=>{confirmationAction=match;return '';});
  const config=routing+llmBatchPanel(batch);
  const configHtml=running?insightDetails('task-'+batch.id,'查看任务详情',config):hasResults&&confirmed?insightDetails('task-'+batch.id,'任务详情与重新分析',config+'<div class="actions">'+wsButton('重新执行本批评级','data-rate-batch',true)+'</div>'):config;
  const progress=running?'<div class="notice" role="status">正在分析 · 已处理 '+(running.processed_count||0)+' / '+running.total+' 条。以下为阶段性总结。</div>':'';
  const runAction=(!hasResults||running||!confirmed)&&!routing.includes('data-learning-start')?'<div class="task-sticky-actions">'+(confirmed?'<div class="task-run-actions">'+wsButton(running?'正在分析…':'开始本批分析','data-rate-batch '+(running||!s.valid?'disabled':''),true)+'</div>':confirmationAction||'<p class="sub">请刷新后读取本批监测方案。</p>')+'</div>':'';
  return '<button class="link workspace-back" data-task-list>← 全部分析任务</button>'+heading('',esc(batch.name),esc(batch.source_name),wsButton('查看数据分析','data-analyze-batch="'+esc(batch.id)+'"'))+progress+(hasResults?insightSummaryHtml(summaryRows,'batch-'+batch.id,'本批分析总结'):'')+configHtml+workspaceRecordsPanel(rows,{task:true})+runAction;
};
// The full analytics dashboard is rendered by workspace-analytics.js.
const insightOriginalFiltered=filteredWorkspaceRows;
filteredWorkspaceRows=function(rows,options={}){return insightOriginalFiltered(insightSelection?rows.filter(r=>insightSelection.ids.includes(r.item.id)):rows,options);};
const insightOriginalRecords=renderWorkspaceRecords;
renderWorkspaceRecords=function(){return (insightSelection?'<div class="insight-filter-banner"><div><strong>'+esc(insightSelection.label)+'</strong><span>涉及 '+insightSelection.ids.length+' 条记录</span></div>'+wsButton(insightSelection.origin==='batches'?'返回本批总结':'返回分析总结','data-insight-return')+wsButton('清除范围筛选','data-insight-clear')+'</div>':'')+insightOriginalRecords();};

function insightRecordHtml(row){
  if(row.rating?.report&&(row.rating.report.task_summary||row.rating.request_snapshot?.sources))return llmReportHtml(row.rating);
  const r=AnalysisSummary.record(row),rating=row.rating,report=rating?.report,graded=gradeOrder.includes(row.status);
  const grade=graded?row.status+' · '+gradeLabels[row.status]:statusNames[row.status]||row.status;
  const extra=r.findings.slice(1).map(f=>'<article class="insight-extra"><h4>'+esc(f.title||f.type)+'</h4>'+insightFindingHtml(f,{sources:rating?.request_snapshot?.sources||[]})+'</article>').join('');
  const sources=rating?.request_snapshot?.sources||[];
  const finding=r.findings[0],quotes=finding?.quotes|| (finding?.quote?[{quote:finding.quote,source:finding.source}]:[]);
  const evidence=quotes.map(q=>'<blockquote>'+esc(q.quote)+'</blockquote><p class="meta">'+esc(sources.find(s=>s.id===q.source)?.label||q.source||'')+'</p>').join('');
  const full=rating?.request_snapshot?llmReportHtml(rating):'<p>'+esc(r.conclusion)+'</p><pre>'+esc(JSON.stringify(report||{status:row.status,error:rating?.error||row.item.error},null,2))+'</pre>';
  return '<section class="insight-record-summary"><div class="insight-record-label"><h3>表现评估</h3><span class="grade-pill grade-'+esc(row.status)+'">'+esc(grade)+'</span></div><h3>评估结论</h3>'+evaluationConclusionHtml(report||{summary:r.conclusion})+outputReadabilityHtml(report||{})+'<section class="report-findings" aria-label="具体问题与依据"><h3>具体问题与依据</h3>'+(finding?insightFindingHtml(finding,{sources}):'<dl class="insight-answer"><div><dt>当前状态</dt><dd>'+esc(r.problem)+'</dd></div><div><dt>核对方向</dt><dd>'+esc(r.advice)+'</dd></div></dl>')+extra+'</section></section>'+insightDetails('record-'+row.item.id+'-evidence','查看判断依据',(evidence||'<p class="sub">'+esc(r.missing.length?'待补材料：'+r.missing.join('、'):'打开完整评级查看判断过程与引用依据。')+'</p>')+insightDetails('record-'+row.item.id+'-full','完整评级与运行详情',full));
}
// Reading and review share the same source-left, conclusion-right workspace.
function insightRecordWorkspaceHtml(row){
  if(!row.rating?.report?.grade)return insightRecordHtml(row);
  const rating=row.rating;
  return '<div class="record-detail-tabs" role="tablist" aria-label="工单评估与诊断"><button id="recordDetailTab-performance" role="tab" aria-selected="true" aria-controls="recordDetailPanel-performance" data-record-detail-tab="performance">表现评估</button><button id="recordDetailTab-diagnosis" role="tab" aria-selected="false" aria-controls="recordDetailPanel-diagnosis" tabindex="-1" data-record-detail-tab="diagnosis">业务 Skill 诊断 <span class="record-diagnosis-status" data-record-diagnosis-label="'+esc(rating.id)+'">'+esc(diagnosisRecordState(rating).label)+'</span></button></div><div id="recordDetailPanel-performance" class="record-detail-panel" role="tabpanel" aria-labelledby="recordDetailTab-performance" tabindex="0">'+insightRecordHtml(row)+'</div><div id="recordDetailPanel-diagnosis" class="record-detail-panel" role="tabpanel" aria-labelledby="recordDetailTab-diagnosis" tabindex="0" hidden>'+diagnosisHistoryHtml(rating,undefined,{footerActions:true})+'</div>';
}
function insightSelectRecordTab(tab,focus=false){
  if(!['performance','diagnosis'].includes(tab))return;
  for(const name of ['performance','diagnosis']){
    const button=$('recordDetailTab-'+name),panel=$('recordDetailPanel-'+name);if(!button||!panel)return;
    const selected=name===tab;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;panel.hidden=!selected;
    if(selected&&focus)button.focus();
  }
}
const insightOriginalEvidence=openWorkspaceEvidence;
openWorkspaceEvidence=function(id,editing=false,options={}){
  if(editing)return insightOriginalEvidence(id,true);
  rememberReviewDraft();let row=evidenceRow(id);if(!row)return;
  if(options.ratingId){const frozen=(data.ratings||[]).find(r=>r.id===options.ratingId&&r.item_id===id);if(!frozen)return;row={...row,rating:frozen,status:frozen.report?.grade||frozen.status};}
  if(options.sourceSnapshot)row={...row,rating:null,status:'pending'};
  prepareEvidenceQueue(id);workspaceEvidenceId=id;workspaceEvidenceEditing=false;
  const rating=row.rating,rec=options.sourceSnapshot||rating?.record_snapshot||row.item.record_snapshot,review=workspaceLatestReview(rating?.id),index=workspaceEvidenceQueue.indexOf(id),previous=workspaceEvidenceQueue[index-1],next=workspaceEvidenceQueue[index+1];
  const source=rec.business_record?businessRecordHtml(rec):'<h4>原始会话</h4><blockquote>'+esc(rec.session_text||'未提供')+'</blockquote><h4>AI 回复</h4><blockquote>'+esc(rec.ai_reply||'未提供')+'</blockquote><details><summary>证据与来源</summary><pre>'+esc(JSON.stringify(rec.evidence||[],null,2))+'</pre></details>';
  const tasks=(data.tasks||[]).filter(t=>t.rating_id===rating?.id||(t.rating_refs||[]).some(r=>r.rating_id===rating?.id));
  const reviewHtml=review?'<p><strong>'+esc(review.status)+' · 人工 '+esc(review.grade)+'</strong></p><p>'+esc(review.reason)+'</p><p class="meta">'+esc(review.actor)+' · '+esc(formatTime(review.created_at))+'</p>':'';
  modal('<div class="evidence-heading"><div><h2 id="modalTitle">'+esc(rec.name)+'</h2><p class="sub">'+esc(rec.scene||'场景待确认')+' · '+esc(targetNames[rec.scope]||'对象待确认')+'</p></div><div class="evidence-heading-actions">'+workspaceMarkButton(row.item,rating?.id)+'<span class="evidence-position">'+(index+1)+' / '+workspaceEvidenceQueue.length+'</span></div></div><div class="evidence-columns"><section class="evidence-source"><h3 class="review-source-title">工单关键信息</h3>'+source+'</section><section class="evidence-result insight-record-body">'+insightRecordWorkspaceHtml(row)+recordAttentionHtml(row)+(review?insightDetails('record-'+id+'-review','历史人工复核记录',reviewHtml):'')+(tasks.length?insightDetails('record-'+id+'-tasks','关联改进待办（'+tasks.length+'）',tasks.map(t=>'<p><strong>'+esc(t.title||t.description)+'</strong> · '+esc(t.status)+'</p>').join('')):'')+'</section></div><footer class="evidence-footer"><div class="actions">'+wsButton('上一条','data-evidence-step="'+esc(previous||'')+'" '+(!previous?'disabled':''))+wsButton('下一条','data-evidence-step="'+esc(next||'')+'" '+(!next?'disabled':''))+'</div><div class="actions">'+(rating?.report?.grade?'<span class="record-diagnosis-actions" data-record-diagnosis-actions="'+esc(rating.id)+'">'+diagnosisRecordFooterActions(rating)+'</span>'+workspaceMarkButton(row.item,rating.id):wsButton('查看所属任务','data-workspace-batch="'+esc(row.item.batch_id)+'"'))+'</div></footer>');
  document.querySelector('.modal').classList.add('evidence-drawer','insight-record-drawer');if(!options.sourceSnapshot)noteRecordViewed(row);
  if(Number.isInteger(options.findingIndex)){const target=document.querySelector('[data-record-finding="'+options.findingIndex+'"]');target?.focus?.({preventScroll:true});target?.scrollIntoView?.({block:'start'});}
};
// Remove the compact-reading modifier before any other modal or the review workspace.
const insightOriginalModal=modal;
modal=function(html){document.querySelector('.modal').classList.remove('insight-record-drawer');insightOriginalModal(html);};
const insightOriginalLlmReport=llmReportHtml;
llmReportHtml=function(rating){return '<div class="insight-full-report">'+insightOriginalLlmReport(rating)+'</div>';};

document.addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b||b.disabled)return;const d=b.dataset;
  if(d.recordDetailTab)insightSelectRecordTab(d.recordDetailTab);
  if(d.insightImprove!==undefined)insightSkillEditor(Number(d.insightImprove));
  if(d.skillChangeDownload){const task=data.tasks.find(t=>t.id===d.skillChangeDownload);if(task?.skill_change){const url=URL.createObjectURL(new Blob([skillChangeDocument(task)],{type:'text/markdown;charset=utf-8'})),link=document.createElement('a');link.href=url;link.download='客服Skill改进说明-'+task.id+'.md';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}}
  if(d.insightIssue!==undefined){
    const issue=AnalysisSummary.aggregate(insightRows()).issues[Number(d.insightIssue)];if(!issue)return;
    const origin=view,originBatch=origin==='batches'?analysisTaskId:batchId;
    insightSelection={ids:issue.ids,label:issue.title,origin,batch:originBatch,scope:origin==='batches'?'all':scope,scene:origin==='batches'?'all':sceneFilter,tenant:origin==='batches'?batchWorkspaceState(analysisTaskId).tenant:tenantFilter};
    workspaceRecordsBatch=originBatch;tenantFilter=insightSelection.tenant||'all';scope=insightSelection.scope;sceneFilter=insightSelection.scene;
    workspaceMarkType='all';workspaceMarkedOnly=false;workspaceViewTab='all';workspaceExecutionFilter='all';workspaceRecordStatus='all';workspaceRecordQuery='';workspaceRecordPage=1;workspaceEvidenceQueue=[];
    show('records');
  }
  if(b.hasAttribute('data-insight-return')){
    const selection=insightSelection;if(!selection)return;insightSelection=null;workspaceEvidenceQueue=[];scope=selection.scope;sceneFilter=selection.scene;tenantFilter=selection.tenant||'all';batchId=selection.batch;
    if(selection.origin==='batches')analysisTaskId=selection.batch;
    show(selection.origin);
  }
  if(b.hasAttribute('data-insight-clear')){insightSelection=null;workspaceRecordPage=1;workspaceEvidenceQueue=[];render();}
},false);
document.addEventListener('keydown',e=>{
  const tab=e.target.dataset?.recordDetailTab;if(!tab||!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
  e.preventDefault();insightSelectRecordTab(e.key==='Home'?'performance':e.key==='End'?'diagnosis':tab==='performance'?'diagnosis':'performance',true);
});
document.addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b||b.disabled)return;const d=b.dataset;
  if(d.view||d.nav||d.workspaceBatch||d.analyticsRecords||d.dataScene||d.workspaceAction||b.hasAttribute('data-all-records'))insightSelection=null;
},true);
document.addEventListener('change',e=>{if(['workspacePageScope','sceneFilter','workspaceDataBatch','workspaceTenantFilter'].includes(e.target.id))insightSelection=null;},true);

if(typeof location!=='undefined'){const requestedView=new URLSearchParams(location.search).get('view');if(['analytics','records','batches'].includes(requestedView))view=requestedView;}
