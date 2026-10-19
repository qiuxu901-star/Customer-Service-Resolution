'use strict';
// Batch navigation and reading positions are local UI state, independent of ratings.
const batchWorkspaceStates=new Map();
let batchWorkspaceMounted=null,batchWorkspaceNavigating=false;
function batchWorkspaceState(id){
 if(!batchWorkspaceStates.has(id)){
  let saved={};try{if(typeof sessionStorage!=='undefined')saved=JSON.parse(sessionStorage.getItem('csr-batch-tabs/v1/'+id)||'{}')||{};}catch{}
  batchWorkspaceStates.set(id,{tab:['summary','records','settings'].includes(saved.tab)?saved.tab:null,issueKey:typeof saved.issueKey==='string'?saved.issueKey:null,query:typeof saved.query==='string'?saved.query.slice(0,500):'',detailTab:saved.detailTab==='sources'?'sources':'advice',positions:{},recordFilters:null,related:null,routingDrafts:null});
 }
 return batchWorkspaceStates.get(id);
}
function batchPersistState(state){try{if(typeof sessionStorage!=='undefined')sessionStorage.setItem('csr-batch-tabs/v1/'+analysisTaskId,JSON.stringify({tab:state.tab,issueKey:state.issueKey,query:state.query,detailTab:state.detailTab}));}catch{}}
function batchRecordFilters(){return {review:workspaceReviewTab,execution:workspaceExecutionFilter,grade:workspaceRecordStatus,query:workspaceRecordQuery,page:workspaceRecordPage};}
function batchRestoreFilters(state){const f=state.recordFilters||{review:'all',execution:'all',grade:'all',query:'',page:1};workspaceReviewTab=f.review;workspaceExecutionFilter=f.execution;workspaceRecordStatus=f.grade;workspaceRecordQuery=f.query;workspaceRecordPage=f.page;}
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
function batchIssueSources(issue){
 return issue.sources.map(source=>{const review=(data.rating_reviews||[]).filter(r=>r.rating_id===source.rating_id).at(-1);return '<article class="batch-source"><div class="batch-source-head"><strong>'+esc(source.record_name)+'</strong><span class="grade-pill grade-'+esc(source.grade)+'">'+esc(source.grade)+'</span></div><p><b>评估发现：</b>'+esc(source.description)+'</p><p><b>原始建议：</b>'+esc(source.suggestion||'未提供具体建议')+'</p>'+(source.quotes||[]).map(q=>'<blockquote>'+esc(q.quote)+'</blockquote>').join('')+(review?'<div class="notice"><b>人工复核 · '+esc(review.grade)+'</b><p>'+esc(review.reason)+'</p>'+(review.evidence?'<p>依据：'+esc(review.evidence)+'</p>':'')+'</div>':'')+wsButton('查看原文与评估','data-batch-evidence="'+esc(source.item_id)+'"')+'</article>';}).join('');
}
function batchIssueDetail(issue,index,state){
 if(!issue)return '<section class="batch-issue-detail"><div class="empty"><h3>没有匹配的问题</h3><p>调整搜索条件，或在「记录与复核」中抽查原文。</p></div></section>';
 const change=AnalysisSummary.improvement(issue),reviews=issue.sources.map(s=>(data.rating_reviews||[]).filter(r=>r.rating_id===s.rating_id).at(-1)).filter(Boolean),needsReview=reviews.some(r=>r.decision!=='confirm');
 return '<section class="batch-issue-detail" id="batchIssueDetail" role="tabpanel" aria-labelledby="batchIssue-'+index+'"><header class="batch-issue-heading"><div><h2>'+esc(issue.title)+'</h2><p>涉及 '+issue.count+' 条记录 · '+esc(change.target)+'</p></div></header><div class="batch-detail-tabs" role="tablist" aria-label="问题详情">'+[['advice','问题与建议'],['sources','依据与案例（'+issue.count+'）']].map(([value,label])=>'<button id="batchDetail-'+value+'" role="tab" aria-selected="'+(state.detailTab===value)+'" aria-controls="batchIssueScroll" tabindex="'+(state.detailTab===value?0:-1)+'" data-batch-detail-tab="'+value+'">'+label+'</button>').join('')+'</div><div class="batch-issue-scroll" id="batchIssueScroll" role="tabpanel" aria-labelledby="batchDetail-'+state.detailTab+'" tabindex="0">'+(state.detailTab==='sources'?batchIssueSources(issue):'<dl class="insight-change-fields"><div><dt>问题</dt><dd>'+esc(issue.examples[0])+'</dd></div><div><dt>改进建议</dt><dd>'+esc(issue.suggestions[0]||'先核对对应记录，明确具体问题及修改方向。')+'</dd></div><div><dt>为什么要改</dt><dd>'+esc(change.why)+'</dd></div><div><dt>改后怎么看效果</dt><dd>'+esc(change.goal)+'</dd></div></dl>'+(needsReview?'<p class="notice warn">来源中存在人工改判或补证意见，请在「依据与案例」中先核对。</p>':'')+'<p class="batch-issue-note">问题和建议来自已保存的评估；原因及验证方向为整理建议，修改 Skill 前请核对原文。</p>')+'</div><footer class="batch-issue-actions">'+(issue.kind==='finding'?wsButton('整理为 AI 客服 Skill 改进待办','data-insight-improve="'+index+'"',true):'')+wsButton(issue.kind==='finding'?'查看涉及记录（'+issue.count+'）':'查看记录并复核','data-batch-related="'+index+'"')+'</footer></section>';
}
function batchSummaryWorkspace(rows,state){
 const summary=AnalysisSummary.aggregate(rows),issues=summary.issues,q=state.query.trim().toLowerCase(),visible=issues.map((issue,index)=>({issue,index})).filter(({issue})=>!q||[issue.title,...issue.examples,...issue.suggestions].join(' ').toLowerCase().includes(q));
 if(!visible.some(({issue})=>issue.key===state.issueKey))state.issueKey=visible[0]?.issue.key||null;
 const selected=visible.find(({issue})=>issue.key===state.issueKey);
 const inProgress=rows.some(row=>row.rating&&['pending','running'].includes(row.status));
 if(!issues.length)return '<section class="batch-summary-empty"><h2>本批分析总结</h2><div class="empty"><h3>'+esc(summary.assessed?'本批未列出明确问题':inProgress?'正在生成分析总结':'尚未形成分析总结')+'</h3><p>'+esc(summary.assessed?'可到记录与复核抽查关键记录，暂不生成 Skill 修改建议。':inProgress?'分析正在执行，结果返回后会在这里生成问题目录。':'先在任务设置中核对场景和检查方式，再开始分析。')+'</p>'+wsButton(summary.assessed?'查看记录':inProgress?'查看执行详情':'前往任务设置','data-batch-tab="'+(summary.assessed?'records':'settings')+'"',true)+'</div></section>';
 return '<div class="batch-summary-workspace" aria-label="本批分析总结"><aside class="batch-issue-rail"><div class="batch-directory-head"><h2>问题目录 <span>'+issues.length+'</span></h2><label class="batch-issue-search"><span class="sr-only">搜索问题或建议</span><input id="batchIssueSearch" type="search" placeholder="搜索问题或建议" value="'+esc(state.query)+'" maxlength="500" aria-controls="batchIssueList"></label><p>'+ (q?'找到 '+visible.length+' 类问题':'按评估等级及涉及记录数排序')+'</p></div><div class="batch-issue-list" id="batchIssueList" role="tablist" aria-label="本批问题" aria-orientation="vertical">'+(visible.length?visible.map(({issue,index})=>'<button id="batchIssue-'+index+'" role="tab" aria-selected="'+(state.issueKey===issue.key)+'" aria-controls="batchIssueDetail" tabindex="'+(state.issueKey===issue.key?0:-1)+'" data-batch-issue="'+index+'"><span class="batch-directory-order">'+(index+1)+'</span><span class="batch-directory-name">'+esc(issue.title)+'<small>'+esc(AnalysisSummary.improvement(issue).target)+'</small></span><span class="batch-directory-count">'+issue.count+' 条</span></button>').join(''):'<p class="batch-no-results">没有匹配的问题，试试其他关键词。</p>')+'</div></aside>'+batchIssueDetail(selected?.issue,selected?.index,state)+'</div>';
}
function batchTaskSettings(batch,rows){
 const running=runningRating(batch),confirmed=batchCanRate(batch),stats=workspaceStats(rows);
 return '<div class="batch-settings-content"><h2>任务设置</h2><p class="sub">核对本批检查方式和模型；重新分析会保留历史结果。</p>'+routingConfirmationPanel(batch)+llmBatchPanel(batch)+(confirmed?'<div class="batch-settings-action">'+wsButton(running?'正在分析…':rows.some(r=>r.rating)?'重新执行本批评级':'开始本批分析','data-rate-batch '+(running||!stats.valid?'disabled':''),true)+'<span>分析本批全部 '+stats.valid+' 条有效记录</span></div>':'')+learningPanel(batch.id)+'</div>';
}
const batchTabsOriginalTasks=renderAnalysisTasks;
renderAnalysisTasks=function(){
 const batch=analysisTaskId&&data.batches.find(b=>b.id===analysisTaskId);if(!batch){batchWorkspaceMounted=null;return batchTabsOriginalTasks();}
 batchId=batch.id;const state=batchWorkspaceState(batch.id),rows=workspaceRows({batch:batch.id,target:'all',scene:'all'}),stats=workspaceStats(rows),issues=AnalysisSummary.aggregate(rows).issues,running=runningRating(batch),hasResults=rows.some(r=>r.rating),confirmed=batchCanRate(batch);
 if(batchWorkspaceMounted!==batch.id){batchRestoreFilters(state);batchWorkspaceMounted=batch.id;}
 state.tab=state.tab||(hasResults?'summary':'settings');if(state.followRun&&running){state.tab='summary';state.followRun=false;}
 state.recordFilters=batchRecordFilters();batchPersistState(state);
 const related=state.related?'<div class="batch-related-banner"><span>当前仅查看：<b>'+esc(state.related.title)+'</b> · '+state.related.ids.length+' 条记录</span>'+wsButton('返回当前问题','data-batch-tab="summary"')+wsButton('查看本批全部记录','data-batch-clear-related')+'</div>':'';
 return '<section class="batch-workspace" data-batch-workspace="'+esc(batch.id)+'"><header class="batch-page-head"><div><button class="link" data-task-list>← 全部分析任务</button><h1>'+esc(batch.name)+'</h1><p>'+esc(batch.source_name)+'</p></div><div class="batch-page-stats"><span>共 <b>'+stats.valid+'</b> 条</span><span>已分析 <b>'+stats.done+'</b> 条</span>'+(stats.counts.failed?'<span>失败 <b>'+stats.counts.failed+'</b> 条</span>':'')+wsButton('查看数据分析','data-analyze-batch="'+esc(batch.id)+'"')+'</div></header>'+(running?'<div class="batch-run-status" role="status">正在分析 · 已处理 '+(running.processed_count||0)+' / '+running.total+' 条，结果陆续更新。</div>':'')+'<div class="batch-page-tabs" role="tablist" aria-label="批次工作区">'+[['summary','分析总结',issues.length+' 类问题'],['records','记录与复核',rows.length+' 条'],['settings','任务设置',confirmed?'已确认':'待确认']].map(([value,label,note])=>'<button id="batchTab-'+value+'" role="tab" aria-selected="'+(state.tab===value)+'" aria-controls="batchPanel-'+value+'" tabindex="'+(state.tab===value?0:-1)+'" data-batch-tab="'+value+'">'+label+' <small>'+note+'</small></button>').join('')+'</div><div class="batch-tab-content"><section class="batch-tab-panel batch-summary-panel" id="batchPanel-summary" role="tabpanel" aria-labelledby="batchTab-summary" '+(state.tab==='summary'?'':'hidden')+'>'+batchSummaryWorkspace(rows,state)+'</section><section class="batch-tab-panel batch-records-panel" id="batchPanel-records" role="tabpanel" aria-labelledby="batchTab-records" '+(state.tab==='records'?'':'hidden')+'>'+related+'<div class="batch-panel-scroll" id="batchRecordsScroll" tabindex="0">'+workspaceRecordsPanel(rows,{task:true})+'</div></section><section class="batch-tab-panel" id="batchPanel-settings" role="tabpanel" aria-labelledby="batchTab-settings" '+(state.tab==='settings'?'':'hidden')+'><div class="batch-panel-scroll" id="batchSettingsScroll" tabindex="0">'+batchTaskSettings(batch,rows)+'</div></section></div></section>';
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
 if(d.batchIssue!==undefined){const issue=issues[Number(d.batchIssue)];if(!issue)return;state.issueKey=issue.key;batchNavigate('batchIssue-'+d.batchIssue);}
 if(d.batchDetailTab){state.detailTab=d.batchDetailTab==='sources'?'sources':'advice';batchNavigate('batchDetail-'+state.detailTab);}
 if(d.batchRelated!==undefined){const issue=issues[Number(d.batchRelated)];if(!issue)return;state.related={title:issue.title,ids:issue.ids};state.tab='records';workspaceReviewTab='all';workspaceExecutionFilter='all';workspaceRecordStatus='all';workspaceRecordQuery='';workspaceRecordPage=1;workspaceEvidenceQueue=[];batchNavigate('batchTab-records');}
 if(button.hasAttribute('data-batch-clear-related')){state.related=null;workspaceEvidenceQueue=[];workspaceRecordPage=1;batchNavigate('batchTab-records');}
 if(d.batchEvidence){const issue=issues.find(issue=>issue.key===state.issueKey);workspaceEvidenceQueue=issue?.ids||[d.batchEvidence];openWorkspaceEvidence(d.batchEvidence);}
 if(button.hasAttribute('data-learning-start')||button.hasAttribute('data-rate-batch'))state.followRun=true;
},true);
document.addEventListener('input',event=>{
 if(event.target.id!=='batchIssueSearch'||view!=='batches'||!analysisTaskId)return;batchRememberUi();const state=batchWorkspaceState(analysisTaskId),cursor=event.target.selectionStart;state.query=event.target.value.slice(0,500);state.positions.batchIssueList=0;batchNavigate('batchIssueSearch');if(Number.isInteger(cursor))$('batchIssueSearch')?.setSelectionRange?.(cursor,cursor);
});
document.addEventListener('scroll',event=>{
 if(view!=='batches'||!analysisTaskId)return;const id=event.target.id;if(!['batchIssueList','batchIssueScroll','batchRecordsScroll','batchSettingsScroll'].includes(id))return;const state=batchWorkspaceState(analysisTaskId);state.positions[id==='batchIssueScroll'?state.issueKey+'|'+state.detailTab:id]=event.target.scrollTop;
},true);
document.addEventListener('keydown',event=>{
 const d=event.target.dataset||{};let selector,values,current,next;
 if(d.batchTab){selector='[data-batch-tab][role="tab"]';current=d.batchTab;values=['summary','records','settings'];}
 else if(d.batchDetailTab){selector='[data-batch-detail-tab]';current=d.batchDetailTab;values=['advice','sources'];}
 else if(d.batchIssue!==undefined){selector='[data-batch-issue]';current=d.batchIssue;values=[...document.querySelectorAll(selector)].map(b=>b.dataset.batchIssue);}
 else return;
 const vertical=d.batchIssue!==undefined,keys=vertical?['ArrowUp','ArrowDown']:['ArrowLeft','ArrowRight'];
 if(event.key===keys[0])next=(values.indexOf(current)-1+values.length)%values.length;else if(event.key===keys[1])next=(values.indexOf(current)+1)%values.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=values.length-1;else return;
 event.preventDefault();const buttons=[...document.querySelectorAll(selector)],target=buttons.find(b=>(vertical?b.dataset.batchIssue:d.batchTab?b.dataset.batchTab:b.dataset.batchDetailTab)===values[next]);target?.click();
});
