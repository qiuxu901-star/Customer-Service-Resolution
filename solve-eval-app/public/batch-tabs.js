'use strict';
// Batch navigation and reading positions are local UI state, independent of ratings.
const batchWorkspaceStates=new Map();
let batchWorkspaceMounted=null,batchWorkspaceNavigating=false;
function batchWorkspaceState(id){
 if(!batchWorkspaceStates.has(id)){
  let saved={};try{if(typeof sessionStorage!=='undefined')saved=JSON.parse(sessionStorage.getItem('csr-batch-tabs/v1/'+id)||'{}')||{};}catch{}
  batchWorkspaceStates.set(id,{tab:['summary','records','settings'].includes(saved.tab)?saved.tab:null,issueKey:typeof saved.issueKey==='string'?saved.issueKey:null,query:typeof saved.query==='string'?saved.query.slice(0,500):'',detailTab:saved.detailTab==='diagnosis'?'diagnosis':'advice',tenant:typeof saved.tenant==='string'?saved.tenant:'all',scene:typeof saved.scene==='string'?saved.scene:'all',grade:['L0','L1','L2','L3','U'].includes(saved.grade)?saved.grade:'all',markedOnly:saved.markedOnly===true,markType:['all','marked','pending','evaluation','ai'].includes(saved.markType)?saved.markType:saved.markedOnly?'marked':'all',viewedFilter:['viewed','unviewed'].includes(saved.viewedFilter)?saved.viewedFilter:'all',positions:{},recordFilters:null,related:null,routingDrafts:null});
 }
 return batchWorkspaceStates.get(id);
}
function batchPersistState(state){try{if(typeof sessionStorage!=='undefined')sessionStorage.setItem('csr-batch-tabs/v1/'+analysisTaskId,JSON.stringify({tab:state.tab,issueKey:state.issueKey,query:state.query,detailTab:state.detailTab,scene:state.scene,tenant:state.tenant,grade:state.grade,markedOnly:state.markedOnly===true,markType:state.markType,viewedFilter:state.viewedFilter}));}catch{}}
function batchRecordFilters(){return {tenant:tenantFilter,markedOnly:workspaceMarkedOnly,markType:workspaceMarkType,viewed:workspaceViewTab,execution:workspaceExecutionFilter,grade:workspaceRecordStatus,query:workspaceRecordQuery,page:workspaceRecordPage};}
function batchRestoreFilters(state){const f=state.recordFilters||{review:'all',execution:'all',grade:'all',query:'',page:1};tenantFilter=f.tenant||'all';workspaceMarkedOnly=f.markedOnly===true;workspaceMarkType=f.markType||'all';workspaceViewTab=['all','unviewed','viewed'].includes(f.viewed)?f.viewed:'all';workspaceExecutionFilter=f.execution;workspaceRecordStatus=f.grade;workspaceRecordQuery=f.query;workspaceRecordPage=f.page;}
function batchRememberUi({filters=true}={}){
 if(view!=='batches'||!analysisTaskId||batchWorkspaceMounted!==analysisTaskId)return;
 const state=batchWorkspaceState(analysisTaskId);if(filters)state.recordFilters=batchRecordFilters();
 for(const id of (state.tab==='summary'?['batchIssueList','batchIssueScroll']:state.tab==='records'?['batchRecordsScroll']:['batchSettingsScroll'])){const element=$(id);if(element&&Number.isFinite(element.scrollTop))state.positions[id==='batchIssueScroll'?state.issueKey+'|'+state.detailTab:id]=element.scrollTop;}
 const review=batchRoutingReview(activeBatch());
 if(review){const edits=[];for(const group of review.groups){const scene=document.querySelector('[data-routing-scene="'+group.key+'"]'),candidate=document.querySelector('[data-routing-candidate="'+group.key+'"]');if(scene&&candidate&&(scene.value!==(group.scene_id||'')||candidate.value!==(group.selected_candidate_id||'')))edits.push({key:group.key,scene:scene.value,candidate:candidate.value,scope:group.scope});}state.routingDrafts=edits.length?{hash:review.review_hash,edits}:null;}
 batchPersistState(state);
}
function batchRestoreUi(){
 if(view!=='batches'||!analysisTaskId)return;const state=batchWorkspaceState(analysisTaskId);
 for(const id of (state.tab==='summary'?['batchIssueList','batchIssueScroll']:state.tab==='records'?['batchRecordsScroll']:['batchSettingsScroll'])){const element=$(id);if(element)element.scrollTop=state.positions[id==='batchIssueScroll'?state.issueKey+'|'+state.detailTab:id]||0;}
 const review=batchRoutingReview(activeBatch());
 if(state.routingDrafts&&review&&state.routingDrafts.hash===review.review_hash){for(const edit of state.routingDrafts.edits){const scene=document.querySelector('[data-routing-scene="'+edit.key+'"]'),candidate=document.querySelector('[data-routing-candidate="'+edit.key+'"]');if(!scene||!candidate)continue;scene.value=edit.scene;if(edit.scene!==(review.groups.find(g=>g.key===edit.key)?.scene_id||''))candidate.innerHTML=candidateOptions(edit.scene,edit.scope);candidate.value=edit.candidate;const apply=document.querySelector('[data-apply-routing-group="'+edit.key+'"]');if(apply)apply.textContent='应用本组选择（保存修改）';}if(hasUnsavedRouting()){const start=document.querySelector('[data-learning-start]'),rate=document.querySelector('[data-rate-batch]');if(start)start.disabled=true;if(rate)rate.disabled=true;}}
}
function batchIssueDetail(issue,index,state){
 if(!issue)return '<section class="batch-issue-detail"><div class="empty"><h3>没有匹配的问题</h3><p>调整搜索条件，或在「记录与复核」中抽查原文。</p></div></section>';
 if(state.detailTab!=='diagnosis')state.detailTab='advice';
 const change=AnalysisSummary.improvement(issue),reviews=issue.sources.map(s=>(data.rating_reviews||[]).filter(r=>r.rating_id===s.rating_id).at(-1)).filter(Boolean),needsReview=reviews.some(r=>r.decision!=='confirm');
 const diagnosisState=issue.kind==='finding'&&typeof diagnosisIssueStateText==='function'?diagnosisIssueStateText(issue):'';
 return '<section class="batch-issue-detail" id="batchIssueDetail" role="tabpanel" aria-labelledby="batchIssue-'+index+'"><div class="batch-detail-header"><header class="batch-issue-heading"><div><h2>'+esc(issue.title)+'</h2><p>涉及 '+issue.count+' 条工单 · '+issue.sources.length+' 个问题'+(diagnosisState&&!diagnosisState.includes('原因待诊断')?' · '+esc(diagnosisState):'')+'</p></div></header><div class="batch-detail-tabs" role="tablist" aria-label="问题详情">'+[['advice','问题与依据'],['diagnosis',typeof diagnosisIssueTabLabel==='function'?diagnosisIssueTabLabel(issue):'业务 Skill 诊断']].map(([value,label])=>'<button id="batchDetail-'+value+'" role="tab" aria-selected="'+(state.detailTab===value)+'" aria-controls="batchIssueScroll" tabindex="'+(state.detailTab===value?0:-1)+'" data-batch-detail-tab="'+value+'">'+label+'</button>').join('')+'</div></div><div class="batch-issue-scroll" id="batchIssueScroll" role="tabpanel" aria-labelledby="batchDetail-'+state.detailTab+'" tabindex="0">'+(state.detailTab==='diagnosis'?diagnosisIssueHtml(issue):insightIssueExplanation(issue)+(needsReview?'<p class="notice warn">来源中存在人工改判或补证意见，请结合原文与复核记录核对。</p>':''))+'</div><footer class="batch-issue-actions">'+(issue.kind==='finding'?wsButton(typeof diagnosisCount==='function'&&diagnosisCount(issue)?'查看诊断报告':'诊断业务 Skill','data-batch-detail-tab="diagnosis"',true):'')+wsButton(issue.kind==='finding'?'查看涉及记录（'+issue.count+'）':'查看记录并复核','data-batch-related="'+index+'"')+'</footer></section>';
}
function batchSummarySceneName(scene){return scene==='all'?'全部场景':scene==='unmapped'?'历史场景 · 待确认映射':(data.scenes||[]).find(s=>s.id===scene)?.name||'所选场景';}
function batchSummaryRows(id,state=batchWorkspaceState(id)){
 return workspaceRows({batch:id,target:'all',scene:state.scene||'all',tenant:state.tenant||'all'}).filter(row=>recordMatchesMark(row.item,state.markType||'all')&&(!state.viewedFilter||state.viewedFilter==='all'||workspaceViewState(row)===state.viewedFilter)&&(!state.grade||state.grade==='all'||row.status===state.grade));
}
function batchSummaryToolbar(summary,state){
 const common=summary.issues.filter(i=>i.kind==='finding'&&(!i.classification_status||i.classification_status==='classified')),all=batchAllIssue(summary.issues),pending=summary.issues.filter(i=>i.kind==='finding'&&i.classification_status&&i.classification_status!=='classified').reduce((n,i)=>n+i.sources.length,0);
 return '<div class="batch-summary-toolbar" role="group" aria-label="分析总结筛选"><div class="batch-summary-filters"><label>租户 ID<select id="batchSummaryTenant">'+workspaceTenantOptions(state.tenant||'all',analysisTaskId)+'</select></label><label>业务场景<select id="batchSummaryScene" class="select-inline">'+sceneOptions(state.scene||'all')+'</select></label><label>工单评级<select id="batchSummaryGrade" class="select-inline"><option value="all">全部评级</option>'+gradeOrder.map(g=>'<option value="'+g+'" '+(state.grade===g?'selected':'')+'>'+g+' · '+esc(gradeLabels[g])+'</option>').join('')+'</select></label><label>查看状态<select id="batchSummaryViewed">'+[['all','全部'],['unviewed','未查看'],['viewed','已查看']].map(([value,label])=>'<option value="'+value+'" '+(state.viewedFilter===value?'selected':'')+'>'+label+'</option>').join('')+'</select></label><label>问题标记<select id="batchSummaryMarkType">'+recordMarkOptions(state.markType||'all')+'</select></label>'+wsButton('重置','data-summary-reset '+((state.tenant||'all')==='all'&&(state.scene||'all')==='all'&&(state.grade||'all')==='all'&&(state.markType||'all')==='all'&&(state.viewedFilter||'all')==='all'?'disabled':''))+'</div><span class="batch-summary-range" title="'+esc(batchSummarySceneName(state.scene||'all')+' · '+((state.grade||'all')==='all'?'全部评级':state.grade))+'">当前范围 <b>'+summary.total+'</b> 工单 · <b>'+common.length+'</b> 类 · <b>'+(all?.sources.length||0)+'</b> 问题'+(pending?' · '+pending+' 待归类':'')+'</span></div>';
}
function batchResetSummaryReading(state){
 state.positions={...state.positions,batchIssueList:0};for(const key of Object.keys(state.positions))if(key.includes('|'))delete state.positions[key];
 insightIssuePages.clear();state.related=null;state.detailTab='advice';workspaceEvidenceQueue=[];
}
function batchAllIssue(issues){
 const findingGroups=issues.filter(i=>i.kind==='finding'),sources=findingGroups.flatMap(g=>g.sources.map(source=>({...source,category_name:g.title,taxonomy_version:g.taxonomy_version}))),ids=[...new Set(sources.map(s=>s.item_id))];
 return sources.length?{key:'__all_findings__',title:'全部具体问题',kind:'finding',all_findings:true,count:ids.length,ids,sources}:null;
}
function batchDirectoryButton(issue,index,state){
 const waiting=issue.classification_status&&issue.classification_status!=='classified',kind=issue.all_findings?'按工单集中查看':issue.kind!=='finding'?'材料与评估待核对':waiting?'归类处理队列':'跨工单归纳的共同表现';
 return '<button id="batchIssue-'+index+'" role="tab" aria-selected="'+(state.issueKey===issue.key)+'" aria-controls="batchIssueDetail" tabindex="'+(state.issueKey===issue.key?0:-1)+'" data-batch-issue="'+index+'"><span class="batch-directory-name">'+esc(issue.title)+'<small>'+issue.count+' 条工单 · '+issue.sources.length+' 个问题</small><small class="batch-directory-kind">'+kind+'</small></span></button>';
}
function batchSummaryWorkspace(rows,state){
 const summary=AnalysisSummary.aggregate(rows),issues=summary.issues,all=batchAllIssue(issues),q=state.query.trim().toLowerCase(),visible=issues.map((issue,index)=>({issue,index})).filter(({issue})=>!q||[issue.title,...issue.examples,...issue.sources.flatMap(s=>[s.record_name,s.evidence_reason,...(s.quotes||[]).map(q=>q.quote)])].join(' ').toLowerCase().includes(q));
 if(state.issueKey!==all?.key&&!visible.some(({issue})=>issue.key===state.issueKey))state.issueKey=visible[0]?.issue.key||null;
 if(q&&state.issueKey===all?.key)state.issueKey=visible[0]?.issue.key||null;
 const selected=state.issueKey===all?.key?{issue:all,index:-1}:visible.find(({issue})=>issue.key===state.issueKey);
 const inProgress=rows.some(row=>row.rating&&['pending','running'].includes(row.status));
 if(!issues.length){
  const label=!summary.total?'当前筛选没有匹配工单':summary.assessed?'当前范围未列出具体问题':inProgress?'正在生成分析总结':'当前范围尚未形成评级';
  const explanation=!summary.total?'调整业务场景或工单评级后继续查看。':summary.assessed?'当前筛选有 '+summary.total+' 条工单、'+summary.assessed+' 条已评记录；没有问题发现不等于没有工单，可查看原文与评级。':inProgress?'结果返回后会自动显示问题与依据。':'完成场景与方案确认后执行分析。';
  return '<div class="batch-summary-stage">'+batchSummaryToolbar(summary,state)+'<section class="batch-summary-empty"><div class="empty"><h3>'+esc(label)+'</h3><p>'+esc(explanation)+'</p>'+wsButton(summary.total?'查看当前范围工单':'重置筛选',summary.total?'data-summary-records':'data-summary-reset',true)+'</div></section></div>';
 }
 const common=issues.filter(i=>i.kind==='finding'&&(!i.classification_status||i.classification_status==='classified')),pending=issues.filter(i=>i.kind==='finding'&&i.classification_status&&i.classification_status!=='classified'),other=issues.filter(i=>i.kind!=='finding');
 const directory=(label,filter)=>{const list=visible.filter(({issue})=>filter(issue));return list.length?'<p class="batch-directory-section">'+label+'</p>'+list.map(({issue,index})=>batchDirectoryButton(issue,index,state)).join(''):'';};
 return '<div class="batch-summary-stage">'+batchSummaryToolbar(summary,state)+'<div class="batch-summary-workspace" aria-label="本批分析总结"><aside class="batch-issue-rail"><div class="batch-directory-head"><h2>问题概览</h2><label class="batch-issue-search"><span class="sr-only">搜索问题或原文依据</span><input id="batchIssueSearch" type="search" placeholder="搜索问题或原文依据" value="'+esc(state.query)+'" maxlength="500" aria-controls="batchIssueList"></label>'+(q?'<p>找到 '+visible.length+' 组问题</p>':'')+'</div><div class="batch-issue-list" id="batchIssueList" role="tablist" aria-label="本批问题" aria-orientation="vertical">'+(!q&&all?batchDirectoryButton(all,-1,state):'')+directory('共性问题',i=>common.includes(i))+directory('待归类',i=>pending.includes(i))+directory('材料与复核',i=>other.includes(i))+(!visible.length?'<p class="batch-no-results">没有匹配的问题，试试其他关键词。</p>':'')+'</div></aside>'+batchIssueDetail(selected?.issue,selected?.index,state)+'</div></div>';
}
function batchTaskSettings(batch,rows){
 const running=runningRating(batch),confirmed=batchCanRate(batch),stats=workspaceStats(rows);
 return '<div class="batch-settings-content"><h2>任务设置</h2><p class="sub">核对本批检查方式和模型；重新分析会保留历史结果。</p>'+routingConfirmationPanel(batch)+llmBatchPanel(batch)+(confirmed?'<div class="batch-settings-action">'+wsButton(running?'正在分析…':rows.some(r=>r.rating)?'重新执行本批评级':'开始本批分析','data-rate-batch '+(running||!stats.valid?'disabled':''),true)+'<span>分析本批全部 '+stats.valid+' 条有效记录</span></div>':'')+learningPanel(batch.id)+'</div>';
}
const batchTabsOriginalTasks=renderAnalysisTasks;
renderAnalysisTasks=function(){
 const batch=analysisTaskId&&data.batches.find(b=>b.id===analysisTaskId);if(!batch){batchWorkspaceMounted=null;return batchTabsOriginalTasks();}
 batchId=batch.id;const state=batchWorkspaceState(batch.id),rows=workspaceRows({batch:batch.id,target:'all',scene:'all'}),summaryRows=batchSummaryRows(batch.id,state),stats=workspaceStats(rows),issues=AnalysisSummary.aggregate(summaryRows).issues,running=runningRating(batch),hasResults=rows.some(r=>r.rating),confirmed=batchCanRate(batch);
 if(batchWorkspaceMounted!==batch.id){batchRestoreFilters(state);batchWorkspaceMounted=batch.id;}
 state.tab=state.tab||(hasResults?'summary':'settings');if(state.followRun&&running){state.tab='summary';state.followRun=false;}
 state.recordFilters=batchRecordFilters();batchPersistState(state);
 const related=state.related?'<div class="batch-related-banner"><span>当前仅查看：<b>'+esc(state.related.title)+'</b> · '+state.related.ids.length+' 条记录</span>'+wsButton('返回当前问题','data-batch-tab="summary"')+wsButton('查看本批全部记录','data-batch-clear-related')+'</div>':'';
 return '<section class="batch-workspace" data-batch-workspace="'+esc(batch.id)+'"><header class="batch-page-head"><div><button class="link" data-task-list>← 全部分析任务</button><h1>'+esc(batch.name)+'</h1><p>'+esc(batch.source_name)+'</p></div><div class="batch-page-stats"><span>共 <b>'+stats.valid+'</b> 条</span><span>已分析 <b>'+stats.done+'</b> 条</span>'+(stats.counts.failed?'<span>失败 <b>'+stats.counts.failed+'</b> 条</span>':'')+wsButton('查看数据分析','data-analyze-batch="'+esc(batch.id)+'"')+'</div></header>'+(running?'<div class="batch-run-status" role="status">正在分析 · 已处理 '+(running.processed_count||0)+' / '+running.total+' 条，结果陆续更新。</div>':'')+'<div class="batch-page-tabs" role="tablist" aria-label="批次工作区">'+[['summary','分析总结',issues.length+' 类问题'],['records','记录与复核',rows.length+' 条'],['settings','任务设置',confirmed?'已确认':'待确认']].map(([value,label,note])=>'<button id="batchTab-'+value+'" role="tab" aria-selected="'+(state.tab===value)+'" aria-controls="batchPanel-'+value+'" tabindex="'+(state.tab===value?0:-1)+'" data-batch-tab="'+value+'">'+label+' <small>'+note+'</small></button>').join('')+'</div><div class="batch-tab-content"><section class="batch-tab-panel batch-summary-panel" id="batchPanel-summary" role="tabpanel" aria-labelledby="batchTab-summary" '+(state.tab==='summary'?'':'hidden')+'>'+batchSummaryWorkspace(summaryRows,state)+'</section><section class="batch-tab-panel batch-records-panel" id="batchPanel-records" role="tabpanel" aria-labelledby="batchTab-records" '+(state.tab==='records'?'':'hidden')+'>'+related+'<div class="batch-panel-scroll" id="batchRecordsScroll" tabindex="0">'+workspaceRecordsPanel(rows,{task:true})+'</div></section><section class="batch-tab-panel" id="batchPanel-settings" role="tabpanel" aria-labelledby="batchTab-settings" '+(state.tab==='settings'?'':'hidden')+'><div class="batch-panel-scroll" id="batchSettingsScroll" tabindex="0">'+batchTaskSettings(batch,rows)+'</div></section></div></section>';
};
const batchTabsFilteredRows=filteredWorkspaceRows;
filteredWorkspaceRows=function(rows,options={}){const related=view==='batches'&&analysisTaskId?batchWorkspaceState(analysisTaskId).related:null;return batchTabsFilteredRows(related?rows.filter(row=>related.ids.includes(row.item.id)):rows,options);};
const batchTabsRender=render;
render=function(){if(!batchWorkspaceNavigating)batchRememberUi();batchTabsRender();batchRestoreUi();};
function batchNavigate(renderFocus){batchWorkspaceNavigating=true;try{render();}finally{batchWorkspaceNavigating=false;}if(renderFocus)$(renderFocus)?.focus({preventScroll:true});}
document.addEventListener('click',event=>{
 const button=event.target.closest('button');if(!button||button.disabled)return;const leaving=button.dataset.view||button.dataset.nav||button.dataset.workspaceBatch;batchRememberUi({filters:!leaving});
 if(view!=='batches'||!analysisTaskId)return;const d=button.dataset,state=batchWorkspaceState(analysisTaskId),issues=AnalysisSummary.aggregate(insightRows()).issues;
 if(d.batchTab){if(!['summary','records','settings'].includes(d.batchTab))return;state.tab=d.batchTab;workspaceEvidenceQueue=[];batchNavigate('batchTab-'+d.batchTab);}
 if(button.hasAttribute('data-summary-reset')){state.tenant='all';state.scene='all';state.grade='all';state.markedOnly=false;state.markType='all';state.viewedFilter='all';batchResetSummaryReading(state);batchNavigate();}
 if(button.hasAttribute('data-summary-records')){const rows=batchSummaryRows(analysisTaskId,state);state.related={title:batchSummarySceneName(state.scene||'all')+' · '+((state.grade||'all')==='all'?'全部评级':state.grade),ids:rows.map(r=>r.item.id)};state.tab='records';tenantFilter=state.tenant||'all';workspaceMarkType='all';workspaceMarkedOnly=false;workspaceViewTab='all';workspaceExecutionFilter='all';workspaceRecordStatus='all';workspaceRecordQuery='';workspaceRecordPage=1;workspaceEvidenceQueue=[];batchNavigate('batchTab-records');}
 if(d.batchIssue!==undefined){const issue=Number(d.batchIssue)===-1?batchAllIssue(issues):issues[Number(d.batchIssue)];if(!issue)return;state.issueKey=issue.key;batchNavigate('batchIssue-'+d.batchIssue);}
 if(d.batchDetailTab){state.detailTab=d.batchDetailTab==='diagnosis'?'diagnosis':'advice';batchNavigate('batchDetail-'+state.detailTab);}
 if(d.batchRelated!==undefined){const issue=Number(d.batchRelated)===-1?batchAllIssue(issues):issues[Number(d.batchRelated)];if(!issue)return;state.related={title:issue.title,ids:issue.ids};state.tab='records';tenantFilter=state.tenant||'all';workspaceMarkType='all';workspaceMarkedOnly=false;workspaceViewTab='all';workspaceExecutionFilter='all';workspaceRecordStatus='all';workspaceRecordQuery='';workspaceRecordPage=1;workspaceEvidenceQueue=[];batchNavigate('batchTab-records');}
 if(button.hasAttribute('data-batch-clear-related')){state.related=null;workspaceEvidenceQueue=[];workspaceRecordPage=1;batchNavigate('batchTab-records');}
 if(d.batchEvidence){const issue=issues.find(issue=>issue.key===state.issueKey);workspaceEvidenceQueue=issue?.ids||[d.batchEvidence];openWorkspaceEvidence(d.batchEvidence);}
 if(button.hasAttribute('data-learning-start')||button.hasAttribute('data-rate-batch'))state.followRun=true;
},true);
document.addEventListener('input',event=>{
 if(event.target.id!=='batchIssueSearch'||view!=='batches'||!analysisTaskId)return;batchRememberUi();const state=batchWorkspaceState(analysisTaskId),cursor=event.target.selectionStart;state.query=event.target.value.slice(0,500);state.positions.batchIssueList=0;batchNavigate('batchIssueSearch');if(Number.isInteger(cursor))$('batchIssueSearch')?.setSelectionRange?.(cursor,cursor);});
document.addEventListener('scroll',event=>{
 if(view!=='batches'||!analysisTaskId)return;const id=event.target.id;if(!['batchIssueList','batchIssueScroll','batchRecordsScroll','batchSettingsScroll'].includes(id))return;const state=batchWorkspaceState(analysisTaskId);state.positions[id==='batchIssueScroll'?state.issueKey+'|'+state.detailTab:id]=event.target.scrollTop;
},true);
// Both filters apply to summary rows, evidence, and diagnosis selection; task execution stays batch-wide.
document.addEventListener('change',event=>{
 if(view!=='batches'||!analysisTaskId||!['batchSummaryTenant','batchSummaryScene','batchSummaryGrade','batchSummaryMarkType','batchSummaryViewed'].includes(event.target.id))return;
 const state=batchWorkspaceState(analysisTaskId);if(event.target.id==='batchSummaryTenant')state.tenant=event.target.value;else if(event.target.id==='batchSummaryScene')state.scene=event.target.value;else if(event.target.id==='batchSummaryMarkType')state.markType=event.target.value;else if(event.target.id==='batchSummaryViewed')state.viewedFilter=event.target.value;else state.grade=gradeOrder.includes(event.target.value)?event.target.value:'all';
 batchResetSummaryReading(state);batchNavigate();
},true);
document.addEventListener('keydown',event=>{
 const d=event.target.dataset||{};let selector,values,current,next;
 if(d.batchTab){selector='[data-batch-tab][role="tab"]';current=d.batchTab;values=['summary','records','settings'];}
 else if(d.batchDetailTab){selector='[data-batch-detail-tab]';current=d.batchDetailTab;values=['advice','diagnosis'];}
 else if(d.batchIssue!==undefined){selector='[data-batch-issue]';current=d.batchIssue;values=[...document.querySelectorAll(selector)].map(b=>b.dataset.batchIssue);}
 else return;
 const vertical=d.batchIssue!==undefined,keys=vertical?['ArrowUp','ArrowDown']:['ArrowLeft','ArrowRight'];
 if(event.key===keys[0])next=(values.indexOf(current)-1+values.length)%values.length;else if(event.key===keys[1])next=(values.indexOf(current)+1)%values.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=values.length-1;else return;
 event.preventDefault();const buttons=[...document.querySelectorAll(selector)],target=buttons.find(b=>(vertical?b.dataset.batchIssue:d.batchTab?b.dataset.batchTab:b.dataset.batchDetailTab)===values[next]);target?.click();
});
