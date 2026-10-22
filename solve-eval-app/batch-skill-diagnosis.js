'use strict';
const {hash}=require('./monitoring');
const {validateDiagnosis}=require('./skill-diagnosis');
const {requestRating}=require('./llm-rating');
const {contextStats,messagesFor}=require('./rating-context');
const {VERSION,SYSTEM,CONTRACT,buildJointInput}=require('./joint-diagnosis-protocol');
const clone=x=>structuredClone(x),fail=(m,c=400)=>{throw Object.assign(Error(m),{statusCode:c});};
const COLLECTION='service_skill_batch_diagnoses';
function validateLegacyBatch(value,input){
 const report=validateDiagnosis(value,input),byIndex=new Map(report.findings.map(f=>[f.finding_index,f])),selected=new Map(input.selected_findings.map(f=>[f.finding_index,f]));
 const bad=m=>fail('模型诊断结果无效：'+m,502),seen=new Set();
 for(const f of report.findings){const source=selected.get(f.finding_index);if(f.evidence_refs.some(id=>!referenceApplies(input,id,source.rating_id)))bad('引用了其他工单的原文');if(f.requirement_refs.some(id=>!referenceApplies(input,id,source.rating_id)))bad('引用了其他工单的评估要求');}
 if(!Array.isArray(value.groups)||!value.groups.length||value.groups.length>report.findings.length)bad('请输出共性与个例问题汇总');
 const format_normalizations=[];
 const groups=value.groups.map((g,i)=>{
  if(!Array.isArray(g?.finding_indices)||!g.finding_indices.length)bad('汇总第'+(i+1)+'组缺少有效问题序号数组');
  // Only canonical decimal strings have an unambiguous integer meaning. Never
  // coerce null/booleans, infer one-based numbering, or discard duplicate IDs.
  const indices=g.finding_indices.map((n,j)=>{
   if(typeof n==='string'&&/^(0|[1-9]\d*)$/.test(n)){
    const converted=Number(n);
    if(Number.isSafeInteger(converted)){format_normalizations.push({path:'/groups/'+i+'/finding_indices/'+j,from:n,to:converted});return converted;}
   }
   return n;
  });
  if(indices.some(n=>!Number.isSafeInteger(n)||!byIndex.has(n)))bad('汇总第'+(i+1)+'组包含无效问题序号');
  indices.forEach(n=>{if(seen.has(n))bad('汇总问题序号重复：'+n);seen.add(n);});
  const findings=indices.map(n=>byIndex.get(n)),states=new Set(findings.map(f=>[f.validity,f.action,f.cause_status].join('|')));if(states.size!==1)bad('汇总混合了不同证据状态或处理方向');
  for(const key of ['title','explanation','location','suggestion'])if(typeof g[key]!=='string'||!g[key].trim()||g[key].length>12000)bad('汇总缺少有效的'+key);
  const cases=[...new Set(indices.map(n=>selected.get(n).rating_id))];
  return {id:'group_'+(i+1),title:g.title,explanation:g.explanation,location:g.location,suggestion:g.suggestion,finding_indices:indices,rating_ids:cases,case_count:cases.length,kind:cases.length>1?'common':'individual',validity:findings[0].validity,action:findings[0].action,cause_status:findings[0].cause_status};
 });
 if(seen.size!==selected.size)bad('汇总遗漏了所选问题');
 return {...report,groups,case_count:input.record.records.length,finding_count:selected.size,...(format_normalizations.length?{format_normalizations}:{})};
}
function referenceApplies(input,id,ratingId){
 const owner=input.reference_owners[id];return owner==='shared'||owner===ratingId||Array.isArray(owner)&&owner.includes(ratingId);
}
function validateBatch(value,input){
 if(input.output_mode!=='group_first')return validateLegacyBatch(value,input);
 const bad=m=>fail('模型诊断结果无效：'+m,502);
 if(!value||!Array.isArray(value.findings)||!Array.isArray(value.groups)||!value.groups.length)bad('缺少诊断问题汇总或工单核查明细');
 const normalize=n=>typeof n==='string'&&/^(0|[1-9]\d*)$/.test(n)&&Number.isSafeInteger(Number(n))?Number(n):n;
 const members=new Map(),selected=new Map(input.selected_findings.map(f=>[f.finding_index,f]));
 value.groups.forEach(g=>{
  if(!Array.isArray(g?.finding_indices)||!g.finding_indices.length)bad('汇总缺少问题序号');
  const indices=g.finding_indices.map(normalize);
  for(const n of indices){if(!Number.isSafeInteger(n)||!selected.has(n))bad('汇总包含无效问题序号');if(members.has(n))bad('汇总问题序号重复：'+n);members.set(n,g);}
  if(!Array.isArray(g.requirement_refs)||g.requirement_refs.some(id=>!input.reference_index.some(r=>r.id===id&&['G','P'].includes(id[0]))||!indices.some(n=>referenceApplies(input,id,selected.get(n).rating_id))))bad('汇总引用了不适用工单的评估要求');
 });
 if(members.size!==selected.size)bad('汇总遗漏了所选问题');
 // Expand shared recommendations only inside validation. The model returns each
 // revision and verification suite once; source-specific E citations stay separate.
 const expanded=value.findings.map(f=>{
  const g=members.get(f?.finding_index),origin=selected.get(f?.finding_index);if(!g||!origin)bad('问题序号无效或重复');
  return {...g,finding_index:f.finding_index,validity:f.validity,explanation:f.explanation,evidence_refs:f.evidence_refs,skill_refs:g.skill_refs,requirement_refs:g.requirement_refs.filter(id=>referenceApplies(input,id,origin.rating_id)),revision:g.revision,verification_cases:g.verification_cases,missing_materials:[]};
 });
 const report=validateLegacyBatch({...value,findings:expanded},input);
 const groups=report.groups.map((g,i)=>{
  const raw=value.groups[i],detail=report.findings.find(f=>f.finding_index===g.finding_indices[0]),strs=raw.missing_materials;
  if(!Array.isArray(strs)||strs.length>50||strs.some(s=>typeof s!=='string'||!s.trim()||s.length>12000))bad('汇总待补材料应为字符串数组');
  const quotes=ids=>ids.map(id=>clone(input.reference_index.find(r=>r.id===id)));
  return {...g,issue_types:detail.issue_types,coverage:detail.coverage,skill_refs:detail.skill_refs,skill_quotes:detail.skill_quotes,requirement_refs:[...new Set(raw.requirement_refs)],requirement_quotes:quotes([...new Set(raw.requirement_refs)]),revision:detail.revision,verification_cases:detail.verification_cases,missing_materials:strs};
 });
 // Keep the existing report API readable for old consumers; these shared fields
 // are derived locally, never generated once per case by the model.
 return {...report,groups,report_layout:'group_first'};
}
function createBatchSkillDiagnosis({storage,diagnosis,links,getLlmConfig,limiter=fn=>fn(),callModel=(input,config)=>requestRating(input,config,{system:SYSTEM})}){
 const jobs=new Map(),get=id=>storage.byId(COLLECTION,id)||fail('批量诊断不存在',404);
 for(const r of storage.list(COLLECTION).filter(r=>['pending','running'].includes(r.status)))storage.update(COLLECTION,r.id,{status:'failed',phase:'failed',error:'服务重启中断联合诊断，可重新发起；不会自动重发',finished_at:new Date().toISOString()});
 function prepare(body){
  if(!Array.isArray(body.records)||!body.records.length||body.records.length>100||body.records.some(r=>!r||typeof r.rating_id!=='string')||new Set(body.records.map(r=>r?.rating_id)).size!==body.records.length)fail('请选择同场景的 1 至 100 条不重复工单');
  if(!Array.isArray(body.skill_selections)||body.skill_selections.length!==1||!body.skill_selections[0]||typeof body.skill_selections[0].id!=='string')fail('联合诊断请选择一个客服业务 Skill 版本');
  const selection=body.skill_selections[0],service=storage.byId('service_skills',selection.id);if(!service)fail('客服业务 Skill 不存在');
  const initial=diagnosis.currentSource(body.records[0].rating_id),modelSelection=body.model_selection||{profile_id:initial.model_snapshot?.profile_id,model:initial.model_snapshot?.model};
  const prepared=body.records.map(r=>diagnosis.prepare(r.rating_id,{...body,model_selection:modelSelection,finding_indices:r.finding_indices},{skipContextBudget:true})),first=prepared[0];
  if(new Set(prepared.map(p=>p.source.item_id)).size!==prepared.length)fail('同一工单只能选择当前的一条评级');
  if(prepared.some(p=>p.source.batch_id!==first.source.batch_id||p.input.record.scope!==first.input.record.scope||(p.input.record.scene_id&&first.input.record.scene_id?p.input.record.scene_id!==first.input.record.scene_id:p.input.record.scene!==first.input.record.scene)))fail('联合诊断只支持同批次、同场景、同对象工单');
  const items=prepared.map(p=>storage.byId('monitor_batch_items',p.source.item_id));
  for(const item of items){const link=links.state(item);if(['ready','needs_version','needs_definition'].includes(link.status)&&link.code!==service.code)fail('所选工单关联其他客服业务 Skill，请先更正关联');}
  if(storage.list(COLLECTION).some(d=>['pending','running'].includes(d.status)&&d.rating_ids.some(id=>body.records.some(r=>r.rating_id===id)))||storage.list('service_skill_diagnoses').some(d=>['pending','running'].includes(d.status)&&body.records.some(r=>r.rating_id===d.rating_id)))fail('所选工单已有诊断执行中，请等待结果',409);
  const previous=storage.list(COLLECTION).filter(d=>d.status==='completed'&&d.request_snapshot.selected_findings.some(f=>body.records.some(r=>r.rating_id===f.rating_id&&r.finding_indices.includes(f.original_finding_index))));
  if(previous.length&&!body.repeat_reason)fail('所选问题已有联合诊断，请选择重新诊断原因',409);
  const input=buildJointInput(prepared);
  if(input.selected_findings.length>200)fail('一次联合诊断最多选择200个具体问题，请缩小范围');
  const config=clone(getLlmConfig(body.model_selection||{profile_id:first.model_snapshot.profile_id,model:first.model_snapshot.model})),model_snapshot=require('./model-configs').snapshot(config),stats=contextStats(input,SYSTEM);
  if(Buffer.byteLength(JSON.stringify(messagesFor(input,SYSTEM)))>1024*1024||config.rating_options?.max_input_chars&&stats.total_chars>config.rating_options.max_input_chars)fail('联合诊断输入超过预算或1MB，请减少工单或问题数量；未调用模型',409);
  const input_hash=hash(input),source_hash=hash(prepared.map((p,i)=>({input:p.source.request_snapshot,report:p.source.report,route:p.source.route_id,link:links.state(items[i])}))),preparation_hash=hash({input_hash,source_hash,model_snapshot});
  return {input,config,stats,model_snapshot,input_hash,preparation_hash,prepared,items,previous};
 }
 function preview(body){const p=prepare(body);return {preparation_hash:p.preparation_hash,context_stats:p.stats,model_snapshot:p.model_snapshot,service_skills:p.input.service_skills,request_messages:messagesFor(p.input,SYSTEM),prompt_version:VERSION,case_count:p.items.length,finding_count:p.input.selected_findings.length,additional_calls:1,system_prompt:SYSTEM};}
 function start(body){
  if(!body.actor?.trim()||!body.request_id?.trim())fail('请填写维护人和诊断请求编号');
  const request_hash=hash(body),old=storage.find(COLLECTION,d=>d.request_id===body.request_id);if(old){if(old.request_hash!==request_hash)fail('同一诊断请求编号内容不同',409);return clone(old);}
  const p=prepare(body);if(body.preparation_hash!==p.preparation_hash)fail('工单、问题、Skill 或模型已变化，请重新核对输入',409);
  const row=storage.transaction(()=>{
   links.bind({item_ids:p.items.map(i=>i.id),selection:body.skill_selections[0],actor:body.actor});
   return storage.insert(COLLECTION,{kind:'batch',batch_id:p.prepared[0].source.batch_id,scene_id:p.input.record.scene_id,scene:p.input.record.scene,scope:p.input.record.scope,rating_ids:p.prepared.map(p=>p.source.id),item_ids:p.items.map(i=>i.id),status:'pending',phase:'queued',request_id:body.request_id,request_hash,request_snapshot:p.input,request_messages:messagesFor(p.input,SYSTEM),input_hash:p.input_hash,model_snapshot:p.model_snapshot,context_stats:p.stats,system_prompt:SYSTEM,prompt_version:VERSION,prompt_hash:hash(SYSTEM),output_contract:CONTRACT,actor:body.actor,repeat_reason:body.repeat_reason||null,repeat_of:p.previous.map(d=>d.id),excluded_from_statistics:true});
  });
  const job=Promise.resolve().then(()=>limiter(async()=>{
   storage.update(COLLECTION,row.id,{status:'running',phase:'analysing',started_at:new Date().toISOString()});let response;
   try{response=await callModel(clone(p.input),p.config);const report=validateBatch(response.value,p.input);storage.update(COLLECTION,row.id,{status:'completed',phase:'completed',report,validation_version:VERSION,raw_response:response.raw,usage:response.usage||null,cost_estimate:response.cost_estimate||null,elapsed_ms:response.elapsed_ms??null,finished_at:new Date().toISOString()});}
   catch(e){storage.update(COLLECTION,row.id,{status:'failed',phase:'failed',error:e.statusCode?e.message:'联合诊断执行失败，请检查服务后重试',raw_response:response?.raw||e.raw_response||null,usage:response?.usage||e.usage||null,cost_estimate:response?.cost_estimate||e.cost_estimate||null,elapsed_ms:response?.elapsed_ms??e.elapsed_ms??null,finished_at:new Date().toISOString()});}
  })).catch(()=>storage.update(COLLECTION,row.id,{status:'failed',phase:'failed',error:'联合诊断任务中断，请重新发起',finished_at:new Date().toISOString()})).finally(()=>jobs.delete(row.id));jobs.set(row.id,job);return clone(row);
 }
 function reparse(id,body){const d=get(id);if(!body.actor?.trim())fail('请填写维护人');if(d.status==='completed')return clone(d);if(d.status!=='failed'||!d.error?.startsWith('模型诊断结果无效：')||!d.raw_response)fail('没有可重新解析的结果',409);let value;try{value=JSON.parse(d.raw_response);}catch{fail('已保存返回不是有效 JSON');}const report=validateBatch(value,d.request_snapshot);return clone(storage.update(COLLECTION,id,{status:'completed',phase:'completed',report,validation_version:VERSION,error:null,recovery_history:[...(d.recovery_history||[]),{actor:body.actor,at:new Date().toISOString(),previous_error:d.error}]}));}
 function createTask(id,body){
  const d=get(id);if(d.status!=='completed')fail('请等待联合诊断完成',409);
  if(!body.actor?.trim()||!body.request_id?.trim())fail('请填写维护人和保存请求编号');
  const request_hash=hash({id,...body}),old=storage.find('monitor_tasks',t=>t.request_id===body.request_id);if(old){if(old.request_hash!==request_hash)fail('同一保存请求编号内容不同',409);return clone(old);}
  const g=d.report.groups.find(g=>g.id===body.group_id);if(!g||g.action==='no_change')fail('请选择需要处理的汇总问题');
  const origins=d.request_snapshot.selected_findings.filter(f=>g.finding_indices.includes(f.finding_index)),ratings=g.rating_ids.map(id=>storage.byId('monitor_ratings',id)),target_skills=clone(d.request_snapshot.service_skills),findings=d.report.findings.filter(f=>g.finding_indices.includes(f.finding_index));
  const required=(key,fallback)=>{const value=body[key]===undefined?fallback:body[key];if(typeof value!=='string'||!value.trim()||value.length>12000)fail('请完善待办 '+key);return value.trim();};
  return clone(storage.insert('monitor_tasks',{source:'batch_skill_diagnosis',diagnosis_id:id,diagnosis_group_id:g.id,diagnosis_action:g.action,rating_id:ratings[0].id,case_id:ratings[0].case_id,rating_refs:ratings.map(r=>({rating_id:r.id,item_id:r.item_id,route_id:r.route_id,grade:r.report.grade})),diagnosis_snapshot:{prompt_version:d.prompt_version,input_hash:d.input_hash,model_snapshot:d.model_snapshot,report:clone(d.report),target_skills},title:required('title',g.title),description:required('description',g.explanation),goal:required('goal',[...new Set((g.verification_cases?g.verification_cases.map(c=>c.name+'：'+c.expected):findings.flatMap(f=>f.verification_cases.map(c=>c.name+'：'+c.expected))))].join('\n')||g.suggestion),owner:required('owner',body.actor),category:g.action==='modify_skill'?'AI 客服 Skill':g.action==='supplement'?'业务依据或证据':'原客服 AI 能力',priority:'中',status:'待修改',request_id:body.request_id,request_hash,skill_change:{status:'candidate',suggestion:required('suggestion',g.suggestion),reason:required('reason',g.explanation),target_skill:target_skills[0],target_skills,source_findings:origins.map(o=>({...clone(storage.byId('monitor_ratings',o.rating_id).report.findings[o.original_finding_index]),rating_id:o.rating_id,item_id:o.item_id,record_name:o.record_name,finding_index:o.original_finding_index})),diagnosis_group:clone(g)},history:[{at:new Date().toISOString(),actor:body.actor,action:'从多工单联合诊断创建改进待办'}]}));
 }
 return {preview,start,reparse,createTask,get:id=>clone(get(id)),wait:id=>jobs.get(id)||Promise.resolve()};
}
module.exports={createBatchSkillDiagnosis,validateBatch,SYSTEM,VERSION};
