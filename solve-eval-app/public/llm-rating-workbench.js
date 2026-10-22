'use strict';
let ratingPollTimer=null,ratingPolling=false;
const batchModelChoices=new Map();
function runningRating(batch){return batch&&(data.rating_runs||[]).find(r=>r.batch_id===batch.id&&r.status==='running');}
function usageText(value){return Number.isFinite(value)?value.toLocaleString():'未知';}
function ratingUsageHtml(rows){
  if(!rows.length)return '';
  const sum=key=>{const known=rows.filter(r=>Number.isFinite(r.usage?.[key]));return known.length?known.reduce((n,r)=>n+r.usage[key],0).toLocaleString()+(known.length<rows.length?'（'+(rows.length-known.length)+' 条未知）':''):'未知';};
  const costs=rows.filter(r=>r.cost_estimate),currencies=[...new Set(costs.map(r=>r.cost_estimate.currency))];
  const price=currencies.length===1?currencies[0]+' '+costs.reduce((n,r)=>n+r.cost_estimate.amount,0).toFixed(6)+(costs.length<rows.length?'（仅 '+costs.length+' 条已知费用小计）':'（估算）'):'未知（未配费率、用量分类不足或币种不同）';
  return '<div class="rating-usage"><p class="meta">供应商实际用量：输入 '+sum('prompt_tokens')+' · 输出 '+sum('completion_tokens')+' · 缓存读取 '+sum('cached_tokens')+' · 缓存写入 '+sum('cache_write_tokens')+' · 推理 '+sum('reasoning_tokens')+'</p><p class="meta">费用 '+esc(price)+'；缓存与推理 Token 属于用量细分，不能与总量重复相加。失败请求已知用量也计入。</p></div>';
}
function selectedRatingProfile(batch){const selection=batchModelChoices.get(batch.id)||data.model_config?.default_selection;return data.model_config?.profiles.find(p=>p.id===selection?.profile_id);}
function llmBatchPanel(batch){
 if(!batch)return '';
 const run=(data.rating_runs||[]).filter(r=>r.batch_id===batch.id&&r.kind==='llm_record_rating').at(-1),running=run?.status==='running';
 const items=[...new Map(data.batch_items.filter(i=>i.batch_id===batch.id&&i.case_id).map(i=>[i.case_id,i])).values()],states=items.map(i=>ratingState(data.ratings.filter(r=>r.item_id===i.id&&r.route_id===i.current_route_id).at(-1)));
 const failed=states.filter(s=>s==='failed').length,skipped=states.filter(s=>s==='not_applicable').length;
 const def=data.model_config?.default_model,profile=selectedRatingProfile(batch),capability=profile?.cache_capability;
 return '<section class="panel llm-batch-panel"><div class="panel-head"><div><span class="eyebrow">LLM / 自动评级</span><h3>'+(running?'正在逐条评级':'开始分析前核对')+'</h3><p class="sub">所有记录按公共标准评估；配置场景方案后增加专项检查；会分析本批全部有效记录。</p></div>'+(failed&&!running?'<button class="btn" data-retry-llm>仅重试失败记录（'+failed+'）</button>':'')+'</div><label class="field">本批使用模型<select id="batchRatingModel" '+(running?'disabled':'')+'><option value="">'+esc(def?'全局默认 · '+def.profile_name+' / '+def.model:'请选择模型（未配置默认）')+'</option>'+modelOptions(batchModelChoices.get(batch.id))+'</select></label><p class="sub">默认自动使用，可为本次调整。启动后固定模型、原文及方案版本。本次先评估 AI 表现；业务 Skill 在你选择诊断后读取。</p><p class="meta">评估员：'+esc((data.evaluator_skill?.revisions||[]).find(r=>r.id===data.evaluator_skill?.active_revision_id)?.name||'客服 AI 评估员')+' '+esc('v'+((data.evaluator_skill?.revisions||[]).find(r=>r.id===data.evaluator_skill?.active_revision_id)?.number||'?'))+' · <button class="link" data-view="evaluator">查看规则</button></p><p class="meta" id="ratingCacheCapability">'+esc((capability?.label||'缓存能力未知')+'：'+(capability?.note||'仍需逐条发送完整选中规则，实际命中量以供应商返回为准'))+'</p>'+(run?'<div class="llm-progress"><div><strong>'+esc(run.model_snapshot?.profile_name)+' / '+esc(run.model_snapshot?.model)+'</strong><span>'+esc({running:'评级中',completed:'已完成',completed_with_errors:'部分失败',interrupted:'服务中断'}[run.status]||run.status)+'</span></div><progress max="'+run.total+'" value="'+(run.processed_count||0)+'" aria-label="本批评级进度"></progress><p>已处理 '+(run.processed_count||0)+' / '+run.total+' · 有效评级 '+(run.completed_count||0)+' · 失败 '+(run.failed_count||0)+' · 不适用 '+(run.not_applicable_count||0)+'</p><p class="meta">'+esc(formatTime(run.created_at))+' · '+esc(run.rating_version)+' · 刷新页面可继续查看进度</p></div>':'')+(run?ratingUsageHtml((data.ratings||[]).filter(r=>r.run_id===run.id)):'')+(skipped?'<p class="sub"><button class="link" data-grade="not_applicable">查看 '+skipped+' 条方案不适用记录</button>；不计入等级分布和 U。</p>':'')+'</section>';
}
const renderHomeBeforeLlm=renderHome;
renderHome=function(){let html=renderHomeBeforeLlm();const batch=activeBatch(),running=runningRating(batch);html=html.replace('<div class="stats batch-stats">',llmBatchPanel(batch)+'<div class="stats batch-stats">');if(running)html=html.replace(/(<button[^>]*data-rate-batch)[^>]*>[^<]*<\/button>/,'$1 disabled>正在评级 '+(running.processed_count||0)+' / '+running.total+'</button>');if(data.rating_contract?.llm_enabled)html=html.replace(/<button class="link" data-assess-item="[^"]+">补充评估<\/button>/g,'');return html;};
async function startLlmBatch(retryFailed=false){
 const batch=activeBatch();if(!batch)throw Error('请先选择具体批次');if(hasUnsavedRouting())throw Error('请先保存方案调整，再确认本批方案');if(!batchCanRate(batch))throw Error('请先整批确认监测方案');
 const value=$('batchRatingModel')?.value,selection=value?JSON.parse(value):undefined;
 if(!selection&&!data.model_config?.configured)throw Error('尚未配置默认 LLM，请在本批选择模型或前往模型配置');
 const result=await request('POST','/api/monitor/batches/'+batch.id+'/rate',{actor:actor(),request_id:AppIds.newId(),model_selection:selection,retry_failed:retryFailed});selectedRatingRun='latest';await refresh();toast('已开始 LLM 自动评级 · '+result.run.total+' 条，结果逐条保存');
}
const renderBeforeLlm=render;
render=function(){renderBeforeLlm();clearTimeout(ratingPollTimer);if((data.rating_runs||[]).some(r=>r.status==='running'))ratingPollTimer=setTimeout(pollLlmRating,1500);};
async function pollLlmRating(){if(ratingPolling)return;if(busy||!$('overlay').hidden){ratingPollTimer=setTimeout(pollLlmRating,1500);return;}ratingPolling=true;try{await refresh();}catch{ratingPollTimer=setTimeout(pollLlmRating,3000);}finally{ratingPolling=false;}}
function evaluationConclusionHtml(r){
 const {raw,key_points,unresolved,legacy}=AnalysisSummary.conclusionParts(r);
 const paragraph=(label,text)=>{
  const content=text.replace(/\s+/g,' ').trim(),long=content.length>90;
  return '<div class="evaluation-conclusion-part"><h4>'+label+'</h4><p>'+esc(long?content.slice(0,90)+'…':content)+'</p>'+(long?'<details><summary>展开完整说明</summary><p>'+esc(content)+'</p></details>':'')+'</div>';
 };
 return '<div class="evaluation-conclusion-parts">'+paragraph('关键点是什么',key_points)+paragraph('没解决什么',unresolved)+'</div>'+(legacy&&raw?'<details class="legacy-conclusion"><summary>查看原结论</summary><p class="sub">此历史报告未按新规范单独记录评价原因，当前保留原有判断，未重新评估。</p><p>'+esc(raw)+'</p></details>':'');
}
function outputReadabilityHtml(r,refs=[]){
 const assessment=r.output_readability;
 if(!assessment)return '<section class="output-readability" aria-label="AI 输出可读性"><div class="panel-head"><h3>AI 输出可读性</h3><span class="badge">未评估</span></div><p class="sub">此历史报告未记录可读性判断；使用新标准重新评估后展示。</p></section>';
 const label={clear:'清楚易理解',needs_improvement:'需要改进',unknown:'暂无法判断'}[assessment.status]||'暂无法判断';
 const labels={evidence_not_linked:'结论与依据未挂钩',buried_conclusion:'结论埋没或文字成墙',redundant_noise:'重复或无关内容过多',uncertainty_mixed:'已知与待核实混同',audience_mixed:'内部判据与对外话术混同'};
 const quotes=(assessment.evidence_refs||[]).map(id=>refs.find(ref=>ref.id===id)).filter(Boolean);
 const evidence=quotes.length?'<details class="assistance-evidence"><summary>查看可读性判断依据</summary>'+quotes.map(q=>'<p class="meta">'+esc(q.label||q.source||q.id)+'</p><blockquote>'+esc(q.text)+'</blockquote>').join('')+'</details>':'';
 const suggestions=(assessment.recommendations||[]).map(rec=>{const example=rec.rewrite_example||{};return '<article class="readability-recommendation"><p><strong>改进建议：</strong>'+esc(rec.suggestion)+'</p><h4>改写示范（供客服参考）</h4><dl class="readability-rewrite">'+[['disposition','【处置结论】'],['basis','【核验依据】'],['pending_verification','【待客服核实】'],['driver_message','【建议对司话术】']].filter(([key])=>example[key]!==null&&example[key]!==undefined).map(([key,title])=>'<div><dt>'+title+'</dt><dd>'+esc(example[key])+'</dd></div>').join('')+'</dl></article>';}).join('');
 return '<section class="output-readability" aria-label="AI 输出可读性"><div class="panel-head"><h3>AI 输出可读性</h3><span class="badge '+(assessment.status==='clear'?'good':'warn')+'">'+esc(label)+'</span></div>'+(assessment.target?'<p class="meta">评估范围：'+esc(assessment.target.label)+'</p>':'')+'<p>'+esc(assessment.reason)+'</p>'+((assessment.issue_types||[]).length?'<p class="readability-issues">'+assessment.issue_types.map(t=>'<span>'+esc(labels[t]||t)+'</span>').join('')+'</p>':'')+evidence+(suggestions?'<details class="readability-suggestions"><summary>查看改进建议与改写示范</summary>'+suggestions+'</details>':'')+'</section>';
}
function assistanceReportHtml(r,refs=[],{includeTask=true}={}){
 const section=(title,body)=>'<section class="assistance-section"><h3>'+title+'</h3>'+body+'</section>';
 const evidence=ids=>{
  const quotes=(ids||[]).map(id=>refs.find(ref=>ref.id===id)).filter(Boolean);
  return quotes.length?'<details class="assistance-evidence"><summary>查看原文依据</summary>'+quotes.map(q=>'<p class="meta">'+esc(q.label||q.source||q.id)+'</p><blockquote>'+esc(q.text)+'</blockquote>').join('')+'</details>':'';
 };
 if(!r.task_summary)return '<p class="notice">此为历史报告，未记录新版的任务、具体帮助和剩余工作；请展开原报告核对。</p>';
 const contributions=(r.helpful_contributions||[]).map(c=>'<article class="assistance-item"><h4>'+esc(c.result)+'</h4><p><strong>为什么能确认：</strong>'+esc(c.evidence_reason)+'</p><p><strong>帮客服减少的工作：</strong>'+esc(c.benefit)+'</p>'+evidence(c.evidence_refs)+'</article>').join('');
 const remaining=(r.remaining_work||[]).map(w=>'<article class="assistance-item"><span class="badge">'+esc(w.kind==='redo'?'需重做核心工作':'补充确认')+'</span><h4>'+esc(w.work)+'</h4><p><strong>为什么还要做：</strong>'+esc(w.reason)+'</p>'+evidence(w.evidence_refs)+'</article>').join('');
 const uncertain=[...(r.missing_materials||[]),...(r.dimensions||[]).filter(d=>d.status==='unknown').map(d=>d.name+'：'+d.reason)];
 const unknown=uncertain.length?'<ul>'+[...new Set(uncertain)].map(m=>'<li>'+esc(m)+'</li>').join('')+'</ul>':'<p class="sub">本次未列出影响判断的待核实事项。</p>';
 return '<div class="assistance-report">'+(includeTask?section('本次任务','<p>'+esc(r.task_summary)+'</p>'):'')+section('已经提供的帮助',contributions||'<p class="sub">本次未确认可由材料支持的具体帮助；不等于已证明没有帮助，请结合结论和待核实事项。</p>')+section('仍需客服完成的工作',remaining||'<p class="sub">本次未列出任务范围内的剩余工作。</p>')+section('暂不能判断的事项',unknown)+'</div>';
}
function llmReportHtml(rating){
 const r=rating.report,run=data.rating_runs.find(x=>x.id===rating.run_id),binding=rating.monitor_binding,revision=data.revisions.find(x=>x.id===binding?.revision_id),status=r?.grade||({pending:'待评',running:'评级中',failed:'评级失败',not_applicable:'方案不适用'}[rating.status]||'待评');
 const sources=rating.request_snapshot?.sources||[],refs=rating.request_snapshot?.reference_index||[];
 const rulesHtml=f=>f.rule_refs?.length?'<details><summary>对应规则</summary>'+f.rule_refs.map(id=>'<blockquote>'+esc(refs.find(r=>r.id===id)?.text||id)+'</blockquote>').join('')+'</details>':'';
 const label=r?.task_summary?({L0:'存在关键错误',L1:'帮助有限',L2:'有明确帮助，仍需补齐',L3:'本次任务已完成',U:'目前无法判断'}[r.grade]||'方案不适用'):'';
 const dimensions=r?'<h3>逐项检查</h3><div class="llm-dimensions">'+r.dimensions.map(d=>'<article class="card"><div class="panel-head"><h4>'+esc(d.name)+'</h4><span class="badge '+(d.status==='pass'?'good':'warn')+'">'+esc({pass:'通过',gap:'缺口',error:'错误',unknown:'未知'}[d.status])+(d.score!==undefined?' · '+d.score+'/'+d.max_score:'')+'</span></div><p>'+esc(d.reason)+'</p><small>引用：'+esc(d.evidence_refs.join('、')||'未取得依据')+'</small></article>').join('')+'</div>':'';
 const findings=r?'<section class="report-findings" aria-label="具体问题与依据"><div class="report-findings-heading"><h3>具体问题与依据</h3><span>'+r.findings.length+' 个问题</span></div>'+FindingPresentation.ordered(r.findings).map(({finding:f,index})=>'<article class="card llm-finding" data-record-finding="'+index+'" tabindex="-1"><div class="report-finding-heading"><span>问题 '+(index+1)+'</span><h4>'+esc(f.title||f.type)+'</h4></div>'+insightFindingHtml(f,{sources,showSuggestion:true})+rulesHtml(f)+'</article>').join('')+(!r.findings.length?'<p class="sub">本次未列出已确认的具体问题。</p>':'')+'</section>':'';
 const redo=(r?.remaining_work||[]).filter(w=>w.kind==='redo');
 const boundary=redo.length?'<div class="report-use-boundary"><strong>核心工作仍需重做</strong>'+redo.map(w=>'<p>'+esc(w.work)+'</p>').join('')+'</div>':'';
 const locations=r?.findings?.filter(f=>FindingPresentation.locations(f,sources).main?.id==='ai_analysis_conclusion').length||0;
 const locationSummary=r?.findings?.length?'<p class="report-location-summary">共 '+r.findings.length+' 个问题'+(locations?' · '+locations+' 个涉及责任结论':'')+'</p>':'';
 return '<section class="llm-report"><div class="llm-report-summary"><span class="grade-pill grade-'+esc(r?.grade||rating.status)+'">'+esc(status)+'</span> <strong>'+esc(label)+'</strong>'+(r?.requires_review?'<span class="badge warn">待人工复核</span>':'')+'<h3>评估结论</h3>'+(r?evaluationConclusionHtml(r):'<p>'+esc(rating.error||'等待模型返回结果')+'</p>')+boundary+locationSummary+'</div>'+(r?(r.task_summary?'<p class="evaluation-task-line"><strong>本次任务：</strong>'+esc(r.task_summary)+'</p>':'')+outputReadabilityHtml(r,refs)+findings+'<details class="assistance-detail"><summary>查看具体帮助、剩余工作与依据</summary>'+assistanceReportHtml(r,refs,{includeTask:false})+'</details><details class="assistance-detail"><summary>查看详细检查与判级依据</summary>'+(r.grade_basis?evaluatorBasisHtml(r.grade_basis):'')+dimensions+(!r.task_summary?'<h3>原报告缺失材料</h3><p>'+esc(r.missing_materials.join('；')||'无')+'</p>':'')+'</details>':'')+'<details class="assistance-detail"><summary>评估版本与运行信息</summary><p class="meta">模型 '+esc(rating.model_snapshot?.profile_name)+' / '+esc(rating.model_snapshot?.model)+' · '+(binding?.kind==='basic_evaluation'?'公共评估标准 · 无场景专项检查':esc(binding?.definition?.name)+' r'+esc(revision?.number||'?'))+'</p>'+evaluatorRatingVersions(rating)+(rating.evaluation_flow?'<details><summary>本次执行流程 · '+esc(rating.evaluation_flow.flow.name)+'</summary>'+capabilityStepRunsHtml(rating.step_runs,rating.status)+'</details>':'')+ratingUsageHtml([rating])+(rating.context_stats?'<p class="meta">本次输入字符量：'+esc(rating.context_stats.total_chars)+'</p>':'')+'</details><details><summary>冻结输入、原文索引与本次模型原始返回</summary><p class="sub">输入摘要 '+esc(rating.input_hash)+' · 提示词 '+esc(run?.prompt_version||rating.rating_version)+'</p><pre>'+esc(JSON.stringify(rating.request_snapshot,null,2))+'</pre><h4>系统评级要求</h4><pre>'+esc(run?.system_prompt)+'</pre><h4>模型原始返回</h4><pre>'+esc(rating.raw_response||'尚未返回')+'</pre></details></section>';

}
const ratingDetailBeforeLlm=ratingDetail;
ratingDetail=function(itemId){const row=currentBatchRows().find(r=>r.item.id===itemId),rating=row?.rating;if(rating?.report?.method!=='llm_plan_document'&&!rating?.request_snapshot)return ratingDetailBeforeLlm(itemId);const record=rating.record_snapshot||effectiveItem(data.batch_items.find(i=>i.id===itemId)).record_snapshot;modal('<h2 id="modalTitle">'+esc(record.name)+' · LLM 评级报告</h2>'+llmReportHtml(rating)+'<h3>导入原始材料</h3>'+(record.business_record?businessRecordHtml(record):'<blockquote>'+esc(record.session_text)+'</blockquote><blockquote>'+esc(record.ai_reply)+'</blockquote>')+'<details><summary>本条历史评级</summary><pre>'+esc(JSON.stringify(data.ratings.filter(r=>r.item_id===itemId),null,2))+'</pre></details>');};
document.addEventListener('change',e=>{if(e.target.id==='batchRatingModel'){const batch=activeBatch();if(batch){batchModelChoices.set(batch.id,e.target.value?JSON.parse(e.target.value):undefined);const capability=selectedRatingProfile(batch)?.cache_capability;if($('ratingCacheCapability'))$('ratingCacheCapability').textContent=(capability?.label||'缓存能力未知')+'：'+(capability?.note||'正文仍逐条发送，实际命中量以供应商返回为准');}}});
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b||b.disabled||busy)return;if(b.hasAttribute('data-retry-llm'))action(()=>startLlmBatch(true));});

function evaluatorRatingVersions(rating){
 const ev=rating.evaluator_skill_snapshot||rating.request_snapshot?.evaluator_skill,skills=rating.request_snapshot?.service_skills||[];
 return '<div class="evaluator-report-versions"><p class="meta">评估员 Skill '+esc(ev?ev.name+' '+ev.version+' · '+ev.content_hash.slice(0,12):'历史版本未独立记录；可查看当次系统提示词')+'</p><p class="meta">关联客服 Skill：'+esc(rating.request_snapshot?.evaluation_stage==='performance'?'本阶段未读取；监测方案关联仅用于诊断推荐':skills.length?skills.map(s=>s.code+'@'+s.version+(s.record_usage_verified?'':'（运行版本待核验）')).join('；'):'未关联')+'</p>'+(ev?'<details><summary>本次评估员规则全文（固定快照）</summary><pre>'+esc(ev.document)+'</pre></details>':'')+'</div>';
}
