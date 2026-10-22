'use strict';
const {createHash}=require('node:crypto');
const FieldEvaluation=require('./field-evaluation');
const fingerprint=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function fragments(text,{paragraphs=false}={}){
  let value;
  try{value=JSON.parse(text);}catch{try{if(!/^\s*[\[{]/.test(text))throw Error();value=JSON.parse('['+text.trim().replace(/,\s*$/,'')+']');}catch{
    let offset=0;return (text.match(paragraphs?/[\s\S]+?(?:\n[ \t]*\n|$)/g:/[^\n]*(?:\n|$)/g)||[]).filter(Boolean).map(part=>{const segment={text:part,start:offset,end:offset+part.length};offset+=part.length;return segment;});
  }}
  const rows=[];
  function walk(v,path){
    if(v&&typeof v==='object'){const entries=Object.entries(v);if(entries.length){for(const [k,child]of entries)walk(child,path+'/'+k.replace(/~/g,'~0').replace(/\//g,'~1'));return;}}
    rows.push({path,text:typeof v==='string'?v:JSON.stringify(v),value_type:v===null?'null':Array.isArray(v)?'array':typeof v});
  }
  walk(value,'');return rows;
}
function referenceIndex(input){
  const refs=[];let p=0,s=0,e=0,g=0;
  const add=(source,prefix)=>{for(const part of fragments(source.text,{paragraphs:prefix!=='E'})){const n=prefix==='G'?++g:prefix==='P'?++p:prefix==='S'?++s:++e;refs.push({id:prefix+String(n).padStart(3,'0'),source:source.id,role:source.role,label:source.label,...(source.presentation?{presentation:source.presentation}:{}),...part});}};
  if(input.evaluator_skill)add({id:'evaluator_skill',role:'evaluator_skill',label:'评估员 Skill '+input.evaluator_skill.version,text:input.evaluator_skill.document},'G');
  add({id:'monitoring_plan',role:'monitoring_plan',label:'监测方案',text:input.monitoring_plan.document},'P');
  for(const source of input.sources)add(source,source.role==='service_skill'?'S':'E');
  return refs;
}
function messagesFor(input,system){
  system=FieldEvaluation.systemFor(input,system);
  if(!input.reference_index)return [{role:'system',content:system},{role:'user',content:JSON.stringify(input)}];
  const {document,...plan}=input.monitoring_plan;
  // Source metadata appears once per source, not once per line. Otherwise the
  // citation index itself can cost more than the rules it is meant to compact.
  const groups=new Map();
  for(const {id,source,role,label,text,path,value_type,presentation}of input.reference_index){
    if(!groups.has(source))groups.set(source,{source,role,label,...(presentation?{presentation}:{}),segments:[]});
    groups.get(source).segments.push({id,...(path!==undefined?{path}:{}),...(value_type?{value_type}:{}),text});
  }
  const refs=[...groups.values()];
  const {document:evaluatorDocument,...evaluatorMeta}=input.evaluator_skill||{};
  if(input.output_mode==='group_first'){
    const fixed={contract_version:input.contract_version,target_skill:input.service_skills.map(s=>({code:s.code,version:s.version,modules:s.modules.map(m=>({id:m.id,key:m.key}))})),rules:refs.filter(r=>['evaluator_skill','monitoring_plan','service_skill'].includes(r.role))};
    const dynamic={cases:input.record.records.map(r=>({case_id:r.case_id,requirement_refs:r.requirement_refs,materials:refs.filter(s=>s.source.startsWith(r.case_id+':'))})),selected_findings:input.selected_findings.map(f=>({finding_index:f.finding_index,case_id:f.case_id,description:f.description,evidence_refs:f.evidence_refs})),material_notes:input.material_notes,user_notes:input.user_notes};
    return [{role:'system',content:system},{role:'user',content:JSON.stringify(fixed)},{role:'user',content:JSON.stringify(dynamic)}];
  }
  const fixed={contract_version:input.contract_version,...(input.classification_catalog?{classification_catalog:input.classification_catalog}:{}),...(input.evaluator_skill?{evaluator_skill:evaluatorMeta}:{}),monitoring_plan:plan,service_skills:input.service_skills,rules:refs.filter(r=>['evaluator_skill','monitoring_plan','service_skill'].includes(r.role))};
  const dynamic={record:input.record,sources:refs.filter(r=>!['evaluator_skill','monitoring_plan','service_skill'].includes(r.role)),material_notes:input.material_notes,...(input.field_evaluation?{field_evaluation:input.field_evaluation}:{}),...(input.program_checks?{program_checks:input.program_checks}:{}),...(input.selected_findings?{selected_findings:input.selected_findings,diagnosis_context:input.diagnosis_context,user_notes:input.user_notes}:{})};
  return [{role:'system',content:system},{role:'user',content:JSON.stringify(fixed)},{role:'user',content:JSON.stringify(dynamic)}];
}
function contextStats(input,system){
  const messages=messagesFor(input,system),fixed=messages[0].content+messages[1].content,dynamic=messages[2]?.content||'';
  return {evaluator_chars:input.evaluator_skill?.document.length||0,plan_chars:input.output_mode==='group_first'?input.reference_index.filter(r=>r.role==='monitoring_plan').reduce((n,r)=>n+r.text.length,0):input.monitoring_plan.document.length,skill_chars:input.sources.filter(s=>s.role==='service_skill').reduce((n,s)=>n+s.text.length,0),record_chars:input.sources.filter(s=>s.role!=='service_skill').reduce((n,s)=>n+s.text.length,0),fixed_chars:fixed.length,dynamic_chars:dynamic.length,total_chars:fixed.length+dynamic.length,prefix_hash:fingerprint(fixed),body_required:true};
}
module.exports={fragments,referenceIndex,messagesFor,contextStats};
