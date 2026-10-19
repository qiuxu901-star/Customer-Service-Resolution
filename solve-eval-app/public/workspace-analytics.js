'use strict';
// Analytics has its own range: opening a task must not silently narrow the dashboard.
let analyticsBatch='all',analyticsFrom='',analyticsTo='';
let dashboardDrills=[];
function analyticsOptions(){return {batch:analyticsBatch,target:scope,scene:sceneFilter,from:analyticsFrom,to:analyticsTo};}
function analyticsSnapshot(){return AnalyticsData.collect(data,analyticsOptions(),item=>{const resolved=effectiveItem(item);return {...resolved,record_snapshot:{...resolved.record_snapshot,analytics_scene_id:sceneOf(resolved.record_snapshot,resolved.case_id)}};});}
function analyticsPercent(value){return value===null||value===undefined?'—':(value*100).toFixed(1)+'%';}
function dashboardDrill(label,rows,extra='',primary=false,selectionLabel=label){const id=dashboardDrills.push({label:selectionLabel,rows})-1;return wsButton(label,'data-dashboard-drill="'+id+'" '+extra,primary);}
function dashboardMetric(label,value,detail,rows,modifier=''){
  const id=dashboardDrills.push({label,rows})-1;
  return '<button class="dashboard-metric '+modifier+'" data-dashboard-drill="'+id+'"><span>'+label+'</span><strong>'+value+'</strong><small>'+detail+'</small><span class="dashboard-metric-link">查看对应记录 ›</span></button>';
}
function dashboardToolbar(){
  return '<form id="analyticsRangeForm" class="dashboard-toolbar"><label>数据范围<select id="analyticsBatchFilter"><option value="all" '+(analyticsBatch==='all'?'selected':'')+'>全部导入数据 · 去重统计</option>'+sortedBatches().map(b=>'<option value="'+esc(b.id)+'" '+(analyticsBatch===b.id?'selected':'')+'>'+esc(b.name)+'</option>').join('')+'</select></label><label>业务日期<input id="analyticsFrom" aria-label="业务开始日期" type="date" value="'+esc(analyticsFrom)+'"></label><span class="dashboard-date-separator">至</span><label><span class="sr-only">业务结束日期</span><input id="analyticsTo" aria-label="业务结束日期" type="date" value="'+esc(analyticsTo)+'"></label><button class="btn" type="submit">应用</button>'+wsButton('重置为全部','data-dashboard-reset')+'<span id="analyticsRangeError" class="error" role="alert"></span></form>';
}
function dashboardOverview(snapshot){
  const rows=snapshot.rows,m=AnalyticsData.metrics(rows),c=m.counts,graded=rows.filter(r=>gradeOrder.includes(r.status));
  const metrics=dashboardMetric('去重业务记录',m.valid+'<em>条</em>','本范围有效会话 / 工单',snapshot.unique)+
    dashboardMetric('已评覆盖率',analyticsPercent(m.coverage),m.done+' / '+m.valid+' 条业务记录（已评含 U）',graded)+
    dashboardMetric('完整方案可交付率',analyticsPercent(m.delivery),c.L3+' 条 L3 / '+m.evaluable+' 条可评价记录',rows.filter(r=>r.status==='L3'),'positive')+
    dashboardMetric('有效辅助覆盖率',analyticsPercent(m.assisted),(c.L2+c.L3)+' 条 L2 + L3 / '+m.evaluable+' 条可评价记录',rows.filter(r=>['L2','L3'].includes(r.status)),'positive')+
    dashboardMetric('关键错误率',analyticsPercent(m.error),c.L0+' 条 L0 / '+m.evaluable+' 条可评价记录',rows.filter(r=>r.status==='L0'),'negative')+
    dashboardMetric('无法判断占比',analyticsPercent(m.unknown),c.U+' 条 U / '+m.done+' 条已评记录',rows.filter(r=>r.status==='U'));
  const distribution=gradeOrder.map(g=>{const id=dashboardDrills.push({label:g+' · '+gradeLabels[g],rows:rows.filter(r=>r.status===g)})-1;return '<button data-dashboard-drill="'+id+'"><span class="grade-pill grade-'+g+'">'+g+'</span><span>'+esc(gradeLabels[g])+'</span><b>'+c[g]+'<small> 条</small></b><span class="dashboard-distribution-bar"><i class="grade-'+g+'" style="width:'+(m.done?c[g]/m.done*100:0)+'%"></i></span></button>';}).join('');
  const pending=snapshot.operations.filter(r=>['pending','routing_pending','running'].includes(r.status)),failed=snapshot.operations.filter(r=>r.status==='failed'),excluded=snapshot.operations.filter(r=>r.status==='not_applicable'),invalid=rows.filter(r=>r.status==='import_failed');
  return '<section class="dashboard-section" aria-label="整体能力"><div class="dashboard-section-head"><div><span class="dashboard-step">A</span><h2>整体能力</h2><p>AI 有多少成果可以交付，多少工作仍需人工补齐？</p></div></div><div class="dashboard-provenance"><strong>'+snapshot.batchCount+' 个批次</strong><span>累计导入 '+snapshot.rawCount+' 行</span><span>有效导入 '+snapshot.rawValid+' 行</span><span>重复版本 '+snapshot.duplicates+' 行</span><span>去重后 '+m.valid+' 条业务记录</span></div><div class="dashboard-metrics">'+metrics+'</div>'+(!m.done?'<p class="dashboard-empty-note">尚未形成评级；完成分析后显示能力指标。</p>':'')+'<div class="panel dashboard-distribution"><div class="panel-head"><h3>能力等级分布</h3><span class="sub">已评 '+m.done+' 条 · 点击查看记录</span></div><div class="dashboard-distribution-items">'+distribution+'</div></div><div class="dashboard-statuses">'+dashboardDrill('待分析 '+pending.length,pending)+dashboardDrill('执行失败 '+failed.length,failed)+dashboardDrill('方案不适用 '+excluded.length,excluded)+dashboardDrill('导入失败 '+invalid.length,invalid)+'</div>'+insightDetails('dashboard-metric-definitions','查看指标口径','<p>完整方案可交付率 = L3 /（L0 + L1 + L2 + L3）；有效辅助覆盖率 =（L2 + L3）/ 可评价记录；关键错误率 = L0 / 可评价记录；无法判断占比 = U / 已评记录。可交付与辅助覆盖存在包含关系。</p><p>全部批次纳入统计，同来源、同评估对象、相同业务编号只计一次，采用当前匹配版本下最新有效评级。最新导入尚未完成时保留该记录已有的有效结果；没有有效结果的记录保留待处理状态。人工复核单独保留，不覆盖模型指标。导入失败不计入业务记录分母。</p><p>指标反映 AI 输出能力；实际解决率、人工采纳率与节省工时需对应业务结果支持。</p>')+'</section>';
}
function dashboardProblems(snapshot){
  const rows=snapshot.rows,summary=AnalysisSummary.aggregate(rows),issues=summary.issues;
  function issueHtml(issue,index){const list=rows.filter(r=>issue.ids.includes(r.item.id));return '<article class="dashboard-issue"><span class="insight-number">'+(index+1)+'</span><div><h3>'+esc(AnalysisSummary.short(issue.title,36))+' <small>'+issue.count+' 条</small></h3><p>'+esc(AnalysisSummary.short(issue.examples[0],80))+'</p><p class="dashboard-advice"><b>建议</b>'+esc(AnalysisSummary.short(issue.suggestions[0]||'核对对应记录，确认具体改进动作。',80))+'</p><span class="dashboard-issue-scene">'+esc(issue.scenes.slice(0,2).join('、')||'场景待确认')+(issue.scenes.length>2?'等 '+issue.scenes.length+' 个场景':'')+'</span></div>'+dashboardDrill('查看记录',list,'aria-label="'+esc('查看'+issue.title+'的记录')+'"',false,issue.title)+'</article>';}
  const sceneGroups=new Map();for(const row of snapshot.unique){const rec=row.item.record_snapshot,key=rec.analytics_scene_id||rec.scene||'unmapped';if(!sceneGroups.has(key))sceneGroups.set(key,{name:rec.scene_snapshot?.name||rec.scene||'待确认场景',rows:[]});sceneGroups.get(key).rows.push(row);}
  const scenes=[...sceneGroups.values()].map(g=>({...g,m:AnalyticsData.metrics(g.rows),affected:g.rows.filter(r=>AnalysisSummary.record(r).findings.length||['L0','L1','U'].includes(r.status)).length})).sort((a,b)=>b.affected-a.affected||b.rows.length-a.rows.length);
  const sceneTable=list=>'<div class="table-scroll"><table class="batch-table dashboard-scene-table"><thead><tr><th>业务场景</th><th>记录 / 问题</th><th>可交付率</th><th></th></tr></thead><tbody>'+list.map(g=>'<tr><td>'+esc(g.name)+'</td><td>'+g.rows.length+' / '+g.affected+'</td><td>'+analyticsPercent(g.m.delivery)+'</td><td>'+dashboardDrill('查看',g.rows,'',false,g.name)+'</td></tr>').join('')+'</tbody></table></div>';
  return '<section class="dashboard-section" aria-label="主要问题"><div class="dashboard-section-head"><div><span class="dashboard-step">B</span><h2>主要问题</h2><p>问题在哪里，优先改什么？</p></div></div><div class="dashboard-problem-grid"><section class="panel dashboard-problem-panel"><div class="panel-head"><h3>优先改进</h3><span class="sub">涉及 '+summary.affected+' 条记录</span></div><p class="dashboard-problem-lead">'+esc(summary.conclusion)+'</p>'+(issues.length?issues.slice(0,3).map(issueHtml).join(''):'<div class="empty">'+(summary.assessed?'当前评级未列出明确问题，可抽查关键记录。':'完成评级后，将展示问题与建议。')+'</div>')+(issues.length>3?insightDetails('dashboard-other-issues','其他问题（'+(issues.length-3)+'）',issues.slice(3).map((x,i)=>issueHtml(x,i+3)).join('')):'')+'</section><section class="panel dashboard-scene-panel"><div class="panel-head"><h3>问题集中场景</h3></div><p class="sub">问题记录含明确发现、L0 / L1 缺口及 U；按记录去重。</p>'+(scenes.length?sceneTable(scenes.slice(0,5))+(scenes.length>5?insightDetails('dashboard-all-scenes','其他场景（'+(scenes.length-5)+'）',sceneTable(scenes.slice(5))):''):'<div class="empty">当前范围暂无场景记录。</div>')+'</section></div></section>';
}
function dashboardTrendChart(points){
  if(points.length<4)return '';
  const W=650,H=210,left=36,right=625,top=15,bottom=175,first=Date.parse(points[0].day),last=Date.parse(points.at(-1).day);
  const x=p=>left+(Date.parse(p.day)-first)/(last-first||1)*(right-left),y=v=>bottom-v*(bottom-top);
  const series=[['delivery','可交付率','#315e4d',''],['assisted','辅助覆盖率','#507da2','6 3'],['error','关键错误率','#a85a46','2 3'],['unknown','无法判断占比','#9c7a36','8 3 2 3']];
  const paths=series.map(([key,label,color,dash])=>{let segment=[],parts=[];for(const p of points){if(p[key]===null){if(segment.length)parts.push(segment);segment=[];}else segment.push(x(p).toFixed(1)+','+y(p[key]).toFixed(1));}if(segment.length)parts.push(segment);return parts.map(s=>'<polyline points="'+s.join(' ')+'" fill="none" stroke="'+color+'" stroke-width="2" stroke-dasharray="'+dash+'"/>').join('')+points.filter(p=>p[key]!==null).map(p=>'<circle cx="'+x(p)+'" cy="'+y(p[key])+'" r="3" fill="'+color+'"><title>'+p.day+' '+label+' '+analyticsPercent(p[key])+' · 已评 '+p.done+' 条</title></circle>').join('');}).join('');
  return '<div class="dashboard-chart-legend">'+series.map(([,label,color,dash])=>'<span><i style="border-color:'+color+';border-top-style:'+(dash?'dashed':'solid')+'"></i>'+label+'</span>').join('')+'</div><svg class="dashboard-trend-chart" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="按业务日期展示四项能力指标趋势，下方表格提供精确值和样本量">'+[0,.5,1].map(v=>'<line x1="'+left+'" x2="'+right+'" y1="'+y(v)+'" y2="'+y(v)+'" stroke="#e6ece8"/><text x="0" y="'+(y(v)+4)+'">'+v*100+'%</text>').join('')+paths+[points[0],points[Math.floor(points.length/2)],points.at(-1)].map(p=>'<text text-anchor="'+(p===points[0]?'start':p===points.at(-1)?'end':'middle')+'" x="'+x(p)+'" y="200">'+p.day.slice(5)+'</text>').join('')+'</svg>';
}
function dashboardImprovement(snapshot){
  const points=AnalyticsData.trend(snapshot.rows),runs=AnalyticsData.comparisons(data,snapshot.unique,analyticsOptions());
  const table=list=>'<div class="table-scroll"><table class="batch-table dashboard-trend-table"><thead><tr><th>业务日期</th><th>已评 / 全部</th><th>可交付</th><th>辅助覆盖</th><th>关键错误</th><th>无法判断</th></tr></thead><tbody>'+list.map(p=>'<tr><td>'+dashboardDrill(p.day,p.rows)+'</td><td>'+p.done+' / '+p.valid+'</td><td>'+analyticsPercent(p.delivery)+'</td><td>'+analyticsPercent(p.assisted)+'</td><td>'+analyticsPercent(p.error)+'</td><td>'+analyticsPercent(p.unknown)+'</td></tr>').join('')+'</tbody></table></div>';
  return '<section class="dashboard-section" aria-label="改进效果"><div class="dashboard-section-head"><div><span class="dashboard-step">C</span><h2>改进效果</h2><p>看业务日期上的变化，再用固定底单验证改动。</p></div></div><div class="dashboard-improvement-grid"><section class="panel dashboard-trend-panel"><div class="panel-head"><h3>能力变化趋势</h3><span class="sub">按业务发生日期</span></div>'+(points.length?dashboardTrendChart(points)+(points.length<4?'<p class="dashboard-empty-note">当前只有 '+points.length+' 个业务日期，先展示实际指标；积累更多日期后显示趋势线。</p>':'')+table(points.slice(-7))+(points.length>7?insightDetails('dashboard-all-dates','查看全部 '+points.length+' 个日期',table(points.slice(0,-7))):''):'<div class="empty">当前范围没有可用业务日期，暂未形成趋势。</div>')+(snapshot.undated?'<p class="sub">另有 '+snapshot.undated+' 条记录缺少业务日期，未按导入时间补入趋势。</p>':'')+'</section><section class="panel dashboard-comparison-panel"><div class="panel-head"><h3>同底单前后复验</h3></div>'+(runs.length?'<div class="dashboard-comparison-number"><strong>'+runs.filter(r=>r.before.verdict==='conflict'&&r.after.verdict==='consistent').length+'<small> / '+runs.length+'</small></strong><span>记录的事实矛盾已消除</span></div><p class="sub">相同底单、同一检查点。只核验登记输出或隔离回放，具体版本与依据见报告。</p>'+runs.slice(-3).map(r=>'<div class="dashboard-comparison-row"><span>'+esc(data.cases.find(c=>c.id===r.case_id)?.record?.name||r.case_snapshots?.[0]?.record?.name||'复验记录')+'</span>'+wsButton('查看报告','data-run="'+esc(r.id)+'"')+'</div>').join('')+(runs.length>3?insightDetails('dashboard-all-comparisons','其他复验（'+(runs.length-3)+'）',runs.slice(0,-3).map(r=>'<p>'+wsButton('查看报告 '+esc(r.id),'data-run="'+esc(r.id)+'"')+'</p>').join('')):''):'<div class="dashboard-comparison-empty"><span class="dashboard-empty-mark">—</span><h4>暂无同底单前后复验</h4><p>固定同一批记录完成修改前后复验后，在这里查看改善结果与对应报告。</p></div>')+'<div class="dashboard-comparison-actions">'+wsButton('查看诊断与复验','data-view="runs"')+'</div></section></div></section>';
}
renderWorkspaceAnalytics=function(){
  if(!data.batches.some(b=>b.id===analyticsBatch))analyticsBatch='all';
  batchId=analyticsBatch;dashboardDrills=[];
  const snapshot=analyticsSnapshot();
  return heading('','数据分析','从整体能力，到主要问题，再到改进效果。')+dashboardToolbar()+(analyticsBatch!=='all'?'<div class="notice">当前查看单批数据。'+wsButton('返回全部导入数据','data-dashboard-reset')+'</div>':'')+(snapshot.olderEffective?'<p class="dashboard-effective-note">'+snapshot.olderEffective+' 条记录的最新执行尚未形成有效结论，当前采用已有的最新有效评级。</p>':'')+dashboardOverview(snapshot)+dashboardProblems(snapshot)+dashboardImprovement(snapshot);
};
// A metric drill-through carries the exact selected versions, including older valid ratings.
const dashboardOriginalFiltered=filteredWorkspaceRows;
filteredWorkspaceRows=function(rows,options={}){return dashboardOriginalFiltered(insightSelection?.rows||rows,options);};
const dashboardOriginalEvidence=evidenceRow;
evidenceRow=function(id){return insightSelection?.rows?.find(r=>r.item.id===id)||dashboardOriginalEvidence(id);};
function dashboardOpenRows(label,rows){
  insightSelection={label,rows,ids:rows.map(r=>r.item.id),origin:'analytics',batch:analyticsBatch,scope,scene:sceneFilter};
  workspaceRecordsBatch=analyticsBatch;workspaceReviewTab='all';workspaceExecutionFilter='all';workspaceRecordStatus='all';workspaceRecordQuery='';workspaceRecordPage=1;workspaceEvidenceQueue=[];show('records');
}
document.addEventListener('submit',e=>{
  if(e.target.id!=='analyticsRangeForm')return;e.preventDefault();
  const from=$('analyticsFrom').value,to=$('analyticsTo').value;
  if(from&&to&&from>to){$('analyticsRangeError').textContent='开始日期不能晚于结束日期';return;}
  analyticsBatch=$('analyticsBatchFilter').value;analyticsFrom=from;analyticsTo=to;render();
});
document.addEventListener('change',e=>{if(e.target.id==='analyticsBatchFilter'){analyticsBatch=e.target.value;render();}});
document.addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b||b.disabled)return;const d=b.dataset;
  if(d.dashboardDrill!==undefined){const drill=dashboardDrills[Number(d.dashboardDrill)];if(drill)dashboardOpenRows(drill.label,drill.rows);}
  if(b.hasAttribute('data-dashboard-reset')){analyticsBatch='all';analyticsFrom='';analyticsTo='';scope='all';sceneFilter='all';insightSelection=null;render();}
});
document.addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b||b.disabled)return;const d=b.dataset;
  if(d.view==='analytics'||d.nav==='analytics'){analyticsBatch='all';analyticsFrom='';analyticsTo='';scope='all';sceneFilter='all';workspacePageFilters.delete('analytics');}
  if(d.analyzeBatch){analyticsBatch=d.analyzeBatch;analyticsFrom='';analyticsTo='';}
  if(d.workspaceAction==='analytics'){const context=d.actionContext?JSON.parse(d.actionContext):workspaceContext;analyticsBatch=context.batch_id==='latest'?'all':context.batch_id||'all';analyticsFrom='';analyticsTo='';}
  if(b.hasAttribute('data-insight-return')&&insightSelection?.origin==='analytics')analyticsBatch=insightSelection.batch==='latest'?'all':insightSelection.batch;
},true);
