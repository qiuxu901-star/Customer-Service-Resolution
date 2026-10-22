'use strict';
// Opt-in evaluation draft. Production batches remain on their current contract.
const fs=require('node:fs'),path=require('node:path');
const VERSION='field-evaluation/v1-draft';
const INSTRUCTIONS=fs.readFileSync(path.join(__dirname,'skills/customer-performance-evaluation/field-evaluation-draft.md'),'utf8').trim();
const LABELS={ai_analysis_conclusion:'责任结论',ai_key_information:'关键信息提取',ai_core_evidence:'核心证据',ai_cited_policy:'判责依据条款',ai_responsible_party:'责任方'};
const CONTRACT={
 output_assessments:[{source_id:'field_evaluation.targets 中的编号，每个恰好一次',task_relevance:'required | supporting | not_required | unclear',status:'issue | no_issue_found | unknown | not_applicable',reason:'逐项说明检查结论和边界，不能只重复状态',evidence_refs:['E编号；已提供字段须引用自身输出'],finding_ids:['该字段已确认问题的 finding_id；非issue为空']}],
 findings_extension:{finding_id:'唯一编号，如F001',problem_source_ids:['与 occurrences 的 source_id 集合完全一致'],affects_primary_conclusion:'boolean | null',impact:'必须单列的具体处理影响，保留条件和未知边界',occurrences:[{source_id:'实际出错的已提供AI输出source编号',output_refs:['本字段出错原句的E编号'],explanation:'本处原句具体哪里有问题',basis_type:'source_comparison | visible_output | provided_material_scope',comparison_refs:['核对材料E编号；source_comparison时非空']}]},
 material_limitations:[{material:'本次评估未提供、不完整或待核验的材料',status:'not_provided | incomplete | unverified',limits:'具体限制什么判断，不断言AI当时未执行',related_source_ids:['受影响的被评字段编号'],evidence_refs:['真实E编号；缺失材料不得伪造'],ai_handling:'qualified | overstated | not_assessable',finding_ids:['overstated须关联具体问题，其余可为空']}],
 conclusion_usability:{status:'usable | needs_verification | not_usable | not_assessable',reason:'说明当前结论可使用到哪一步',evidence_refs:['结论自身E编号；结论未提供时可为空']}
};
function enabled(input){return input.field_evaluation?.version===VERSION;}
function prepareInput(input){
 const sources=input.sources.filter(s=>s.role==='ai_output');
 const ids=[...new Set([...(input.record?.kind==='tier2'&&input.record?.trace_id?Object.keys(LABELS):[]),...sources.map(s=>s.id)])];
 input.field_evaluation={version:VERSION,stage:'draft',targets:ids.map(id=>({source_id:id,label:LABELS[id]||sources.find(s=>s.id===id)?.label||id,available:sources.some(s=>s.id===id)}))};
 return input;
}
function systemFor(input,base){return enabled(input)?base+'\n\n逐字段评估扩展（本次显式试评生效，优先约束字段定位及材料边界）：\n'+INSTRUCTIONS+'\n在原报告结构中追加以下字段；findings_extension的内容填写到每个findings元素内，不输出名为findings_extension的独立字段：'+JSON.stringify(CONTRACT):base;}
function validateAndAttach(value,input,report,{bad,string}){
 if(!enabled(input))return report;
 const targets=new Map(input.field_evaluation.targets.map(t=>[t.source_id,t]));
 const sources=new Map(input.sources.map(s=>[s.id,s]));
 const references=new Map((input.reference_index||[]).map(r=>[r.id,r]));
 const array=(v,label,max=100)=>{if(!Array.isArray(v)||v.length>max)bad('逐字段评估：'+label+'必须为列表且不超过'+max+'项');return v;};
 const refs=(v,label,{required=false,sourceId}={})=>{
  const ids=array(v,label);
  if(required&&!ids.length)bad('逐字段评估：'+label+'不能为空');
  if(ids.some(id=>typeof id!=='string'||!id.startsWith('E')||!references.has(id)||references.get(id).role==='metadata'||(sourceId&&references.get(id).source!==sourceId)))bad('逐字段评估：'+label+'引用不存在或未对应本处字段');
  return [...new Set(ids)];
 };
 const same=(a,b)=>a.length===b.length&&a.every(id=>b.includes(id));
 const findingIds=new Set(),bySource=new Map();
 const findings=value.findings.map((f,index)=>{
  const id=string(f.finding_id,'问题编号').trim();
  if(!/^F\d{3,}$/.test(id)||findingIds.has(id))bad('逐字段评估：问题编号无效或重复');
  findingIds.add(id);
  if(!Array.isArray(f.problem_source_ids)||!f.problem_source_ids.length)bad('逐字段评估：每个问题必须明确出错字段');
  if(f.affects_primary_conclusion!==null&&typeof f.affects_primary_conclusion!=='boolean')bad('逐字段评估：必须说明是否影响责任结论');
  string(f.impact,'处理影响');
  const seenSources=new Set();
  const occurrences=array(f.occurrences,'问题出现明细',30).map(o=>{
   if(!o||typeof o!=='object'||sources.get(o.source_id)?.role!=='ai_output'||seenSources.has(o.source_id))bad('逐字段评估：每处问题必须对应唯一已提供AI输出，核对材料不能当作出错字段');
   seenSources.add(o.source_id);
   const output_refs=refs(o.output_refs,'问题原句',{required:true,sourceId:o.source_id});
   if(!['source_comparison','visible_output','provided_material_scope'].includes(o.basis_type))bad('逐字段评估：判断依据类型不正确');
   const comparison_refs=refs(o.comparison_refs,'核对材料',{required:o.basis_type==='source_comparison'});
   if(output_refs.some(ref=>comparison_refs.includes(ref)))bad('逐字段评估：不能把同一原句同时当作出错内容和其独立对照依据');
   if(![...output_refs,...comparison_refs].every(ref=>report.findings[index].evidence_refs?.includes(ref)))bad('逐字段评估：问题引用必须覆盖每处原句和核对材料');
   const explanation=string(o.explanation,'本处问题说明').trim();
   if(!bySource.has(o.source_id))bySource.set(o.source_id,new Set());bySource.get(o.source_id).add(id);
   const quote=ref=>{const r=references.get(ref);return {id:ref,source:r.source,label:r.label,role:r.role,text:r.text,...(r.path!==undefined?{source_path:r.path}:{start:r.start,end:r.end})};};
   return {source_id:o.source_id,source_label:sources.get(o.source_id).label,output_refs,output_quotes:output_refs.map(quote),explanation,basis_type:o.basis_type,comparison_refs,comparison_quotes:comparison_refs.map(quote)};
  });
  if(!occurrences.length||!same([...seenSources],[...new Set(f.problem_source_ids)]))bad('逐字段评估：出错字段与各处原句必须一一对应，不能只列位置');
  return {...report.findings[index],finding_id:id,occurrences};
 });
 const assessments=array(value.output_assessments,'各项输出评估',50),seenTargets=new Set();
 const output_assessments=assessments.map(a=>{
  if(!a||typeof a!=='object'||!targets.has(a.source_id)||seenTargets.has(a.source_id))bad('逐字段评估：输出评估编号不存在或重复');
  seenTargets.add(a.source_id);const target=targets.get(a.source_id);
  if(!['required','supporting','not_required','unclear'].includes(a.task_relevance)||!['issue','no_issue_found','unknown','not_applicable'].includes(a.status))bad('逐字段评估：输出状态或任务相关性无效');
  if(!target.available&&!['unknown','not_applicable'].includes(a.status))bad('逐字段评估：未提供字段不能宣称已检查或确认出错');
  if(a.status==='not_applicable'&&a.task_relevance!=='not_required')bad('逐字段评估：不适用必须说明本次任务不要求该项');
  const evidence_refs=refs(a.evidence_refs,'单项评估依据',{required:target.available});
  if(target.available&&!evidence_refs.some(id=>references.get(id).source===a.source_id))bad('逐字段评估：单项评估必须引用自身输出');
  const ids=array(a.finding_ids,'单项关联问题');
  if(new Set(ids).size!==ids.length||ids.some(id=>!findingIds.has(id))||!same(ids,[...(bySource.get(a.source_id)||[])]))bad('逐字段评估：单项状态与具体问题不对应');
  if((a.status==='issue')!==!!ids.length)bad('逐字段评估：已确认问题必须逐项标明，正常或未知字段不能挂出错明细');
  return {source_id:a.source_id,label:target.label,available:target.available,task_relevance:a.task_relevance,status:a.status,reason:string(a.reason,'单项判断理由').trim(),evidence_refs,finding_ids:ids};
 });
 if(seenTargets.size!==targets.size)bad('逐字段评估：必须覆盖本次所有被评输出目标');
 const material_limitations=array(value.material_limitations,'材料限制',30).map(m=>{
  if(!m||typeof m!=='object'||!['not_provided','incomplete','unverified'].includes(m.status)||!['qualified','overstated','not_assessable'].includes(m.ai_handling))bad('逐字段评估：材料限制状态不正确');
  const related_source_ids=array(m.related_source_ids,'材料限制涉及字段');
  if(related_source_ids.some(id=>!targets.has(id)))bad('逐字段评估：材料限制涉及字段不存在');
  const ids=array(m.finding_ids,'材料限制关联问题');
  if(ids.some(id=>!findingIds.has(id)))bad('逐字段评估：材料限制关联的问题不存在');
  if(m.ai_handling==='overstated'&&(!ids.length||!related_source_ids.length||!ids.some(id=>findings.find(f=>f.finding_id===id)?.occurrences.some(o=>related_source_ids.includes(o.source_id)))))bad('逐字段评估：确定性越界必须关联受影响输出的具体问题，不能仅凭材料缺失认错');
  const evidence_refs=refs(m.evidence_refs,'材料限制依据');
  if(m.ai_handling==='qualified'&&(ids.length||!evidence_refs.some(id=>references.get(id).role==='ai_output'&&related_source_ids.includes(references.get(id).source))))bad('逐字段评估：声称AI已保留边界须引用其明确表述，不能仅凭原始材料推定');
  return {material:string(m.material,'材料名称').trim(),status:m.status,limits:string(m.limits,'材料限制的判断范围').trim(),related_source_ids:[...new Set(related_source_ids)],evidence_refs,ai_handling:m.ai_handling,finding_ids:[...new Set(ids)]};
 });
 for(const f of findings)for(const o of f.occurrences.filter(o=>o.basis_type==='provided_material_scope')){
  if(!material_limitations.some(m=>m.ai_handling==='overstated'&&m.finding_ids.includes(f.finding_id)&&m.related_source_ids.includes(o.source_id)))bad('逐字段评估：已确认缺来源的确定性越界须与材料限制关联，不能仍称AI处理无法判断');
 }
 const c=value.conclusion_usability;
 if(!c||!['usable','needs_verification','not_usable','not_assessable'].includes(c.status))bad('逐字段评估：必须说明结论可用性');
 const primaryId=sources.has('ai_analysis_conclusion')?'ai_analysis_conclusion':sources.has('ai_reply')?'ai_reply':null;
 const evidence_refs=refs(c.evidence_refs,'结论可用性依据',{required:!!primaryId});
 if(primaryId&&!evidence_refs.some(id=>references.get(id).source===primaryId))bad('逐字段评估：结论可用性须引用实际结论');
 if(!primaryId&&c.status!=='not_assessable')bad('逐字段评估：未提供最终结论时不能判断其可用性');
 if(c.status==='usable'&&(bySource.has(primaryId)||findings.some(f=>f.affects_primary_conclusion===true)))bad('逐字段评估：存在影响责任结论的已确认问题时不能宣称结论可用');
 if(c.status==='not_usable'&&!findings.some(f=>f.affects_primary_conclusion===true)&&!bySource.has(primaryId))bad('逐字段评估：不能仅凭材料限制确认结论有错不可用');
 const conclusion_usability={status:c.status,reason:string(c.reason,'结论可用性理由').trim(),evidence_refs};
 return {...report,field_evaluation_version:VERSION,output_assessments,findings,material_limitations,conclusion_usability,requires_review:report.requires_review||material_limitations.length>0||output_assessments.some(a=>a.status==='unknown')||c.status!=='usable'};
}
module.exports={VERSION,INSTRUCTIONS,CONTRACT,enabled,prepareInput,systemFor,validateAndAttach};
