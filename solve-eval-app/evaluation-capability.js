'use strict';
const {createHash}=require('node:crypto');
const SKILL_ID='customer-performance-evaluation';
const SKILL_DOCUMENT=require('node:fs').readFileSync(require('node:path').join(__dirname,'skills',SKILL_ID,'SKILL.md'),'utf8');
const clone=x=>structuredClone(x),hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=(message,statusCode=400)=>{throw Object.assign(Error(message),{statusCode});};
const EXECUTOR_VERSION='evaluation-flow/v1';
const STEP_TYPES=[
  {type:'prepare',name:'整理本条材料',executor:'program',required:true},
  {type:'material_check',name:'检查材料提供情况',executor:'program',required:false},
  {type:'evidence_quote_check',name:'证据摘录初筛',executor:'program',required:false},
  {type:'evaluate',name:'按场景检查并定级',executor:'model',required:true},
  {type:'validate',name:'校验引用、分数与等级',executor:'program',required:true},
  {type:'save',name:'保存报告',executor:'program',required:true}
];
const SOURCE_KEYS=['ai_key_information','ai_responsible_party','ai_analysis_conclusion','ai_cited_policy','ai_core_evidence','journey_dialogue_text','transcript_text'];
const CONDITIONS=['always','has_context','has_ai_output'];
const DEFAULT_CONFIGURATION={schema_version:1,default_flow_id:'standard',branches:[],flows:[{id:'standard',name:'标准表现评估',steps:['prepare','evaluate','validate','save'].map(type=>({id:type,type,condition:'always',options:{}}))}]};
function configurationOf(revision){return clone(revision?.capability||DEFAULT_CONFIGURATION);}
function normalizeConfiguration(value,{storage,checkResources=true}={}){
  const c=clone(value);if(!c||c.schema_version!==1||!Array.isArray(c.flows)||!c.flows.length||c.flows.length>30||!Array.isArray(c.branches)||c.branches.length>300)fail('评估能力配置格式无效');
  const id=(v,label)=>{if(typeof v!=='string'||! /^[a-zA-Z0-9_-]{1,100}$/.test(v))fail(label+'标识无效');return v;};
  const text=(v,label)=>{if(typeof v!=='string'||!v.trim()||v.length>100)fail('请填写1至100字的'+label);return v.trim();};
  const flowIds=new Set();c.flows=c.flows.map(f=>{id(f.id,'流程');if(flowIds.has(f.id))fail('流程标识重复');flowIds.add(f.id);if(!Array.isArray(f.steps)||f.steps.length<4||f.steps.length>12)fail('每条流程需有4至12个步骤');const stepIds=new Set(),types=new Set();const steps=f.steps.map(s=>{id(s.id,'步骤');if(stepIds.has(s.id)||types.has(s.type))fail('流程中的步骤不可重复');stepIds.add(s.id);types.add(s.type);const spec=STEP_TYPES.find(x=>x.type===s.type);if(!spec)fail('执行能力尚未接入：'+String(s.type));const condition=s.condition||'always';if(!CONDITIONS.includes(condition)||spec.required&&condition!=='always')fail('基础步骤必须始终执行，条件仅用于可选步骤');const options=s.options||{};if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>k!=='source_ids')||s.type!=='material_check'&&Object.keys(options).length)fail('步骤参数无效');if(options.source_ids&&(!Array.isArray(options.source_ids)||options.source_ids.length>7||options.source_ids.some(k=>!SOURCE_KEYS.includes(k))||new Set(options.source_ids).size!==options.source_ids.length))fail('材料检查字段无效');return {id:s.id,type:s.type,condition,options:clone(options)};});
    for(const s of STEP_TYPES.filter(s=>s.required))if(!types.has(s.type))fail('流程缺少基础步骤：'+s.name);
    const p=t=>steps.findIndex(s=>s.type===t);if(p('prepare')!==0||p('save')!==steps.length-1||p('validate')!==steps.length-2||p('evaluate')!==steps.length-3)fail('流程顺序应为整理材料、可选检查、模型评估、结果校验、保存报告');
    return {id:f.id,name:text(f.name,'流程名称'),steps};});
  if(!flowIds.has(c.default_flow_id))fail('默认流程不存在');
  const pairs=new Set(),branchIds=new Set();c.branches=c.branches.map(b=>{id(b.id,'分支');if(branchIds.has(b.id))fail('分支标识重复');branchIds.add(b.id);if(typeof b.scene_id!=='string'||!b.scene_id||!['bot','frontline','tier2','shared'].includes(b.scope)||typeof b.selection_id!=='string'||!b.selection_id||typeof b.enabled!=='boolean'||!flowIds.has(b.flow_id))fail('分支场景、对象、方案或流程不完整');const pair=b.scene_id+':'+b.scope;if(pairs.has(pair))fail('同一场景与对象只能配置一个生效分支');pairs.add(pair);
    if(checkResources&&storage&&b.enabled){const scenes=require('./scenes').createScenes({storage}),scene=storage.byId('business_scenes',b.scene_id);if(!scene||scene.status!=='active'||(b.scope!=='shared'&&!scene.scopes.includes(b.scope)))fail('分支场景已停用或与对象不相容',409);if(b.selection_id!=='__basic__')scenes.binding(b.selection_id,b.scene_id,b.scope==='shared'?scene.scopes:[b.scope]);}
    return {id:b.id,name:text(b.name,'分支名称'),scene_id:b.scene_id,scope:b.scope,selection_id:b.selection_id,flow_id:b.flow_id,enabled:b.enabled};});
  return {schema_version:1,default_flow_id:c.default_flow_id,branches:c.branches,flows:c.flows};
}
function branchFor(configuration,scene_id,scope){return configuration.branches.find(b=>b.scene_id===scene_id&&b.scope===scope)||configuration.branches.find(b=>b.scene_id===scene_id&&b.scope==='shared');}
function resolveFlow(configuration,{scene_id,scope,binding},revision){
  const c=normalizeConfiguration(configuration,{checkResources:false}),b=branchFor(c,scene_id,scope);
  const selected=binding?.kind==='basic_evaluation'?'__basic__':binding?.selection_id||binding?.candidate_id||binding?.revision_id;
  if(b&&!b.enabled)fail('该场景的评估分支已停用，请在评估员 Skill 中调整后重新确认',409);
  if(b&&b.selection_id!==selected)fail('当前方案与评估分支绑定的版本不同，请重新选择分支指定的监测方案并确认',409);
  const flow=c.flows.find(f=>f.id===(b?.flow_id||c.default_flow_id));
  return {skill_id:SKILL_ID,skill_definition_hash:hash(SKILL_DOCUMENT),executor_version:EXECUTOR_VERSION,evaluator_revision_id:revision?.id||null,evaluator_version:revision?.version||null,configuration_hash:hash(c),branch:b?clone(b):{id:'confirmed-plan',name:'沿用本批已确认方案',scene_id:scene_id||null,scope:scope||null,selection_id:selected||null,flow_id:flow.id,enabled:true,implicit:true},flow:clone(flow),model_calls:1,max_model_calls:2};
}
function catalog(storage){const scenes=require('./scenes').createScenes({storage}),plans=[];for(const scene of storage.list('business_scenes').filter(s=>s.status==='active'))for(const scope of scene.scopes)for(const p of storage.list('monitor_plans')){try{const b=scenes.binding(p.current_revision_id,scene.id,[scope]);plans.push({scene_id:scene.id,scene_name:scene.name,scope,plan_id:p.id,selection_id:b.selection_id||b.candidate_id,revision_id:b.revision_id,name:b.definition.name,revision_number:storage.byId('monitor_revisions',b.revision_id)?.number});}catch{}}
  return {step_types:clone(STEP_TYPES),conditions:clone(CONDITIONS),source_keys:clone(SOURCE_KEYS),plans};}
function programCheck(type,input,options){
  if(type==='material_check'){const keys=options.source_ids||[],present=new Set(input.sources.map(s=>s.id));return {type,checked_source_ids:keys,present_source_ids:keys.filter(k=>present.has(k)),missing_source_ids:keys.filter(k=>!present.has(k)),note:'仅反映本次材料是否提供；缺失不证明未执行，也不自动决定等级'};}
  const source=input.sources.find(s=>s.id==='ai_core_evidence'),contexts=input.sources.filter(s=>s.role==='context');const lines=source?.text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean)||[];
  if(!lines.length||!contexts.length)return {type,status:'insufficient_material',source_ids:[...(source?[source.id]:[]),...contexts.map(s=>s.id)],note:'缺少AI证据摘录或录音转录，不能执行逐行原文检索'};
  const matches=lines.filter(line=>contexts.some(s=>s.text.includes(line))).length;return {type,status:'screened',source_ids:[source.id,...contexts.map(s=>s.id)],checked_lines:lines.length,exact_match_lines:matches,unmatched_lines:lines.length-matches,note:'严格逐行检索初筛；格式、说话人标签或合理归纳均可能导致未匹配，须结合原文作语义核验，不能仅凭未匹配判错'};
}
async function runFlow({input,snapshot,config,callModel,validateOutput,onProgress=()=>{},onInput=()=>{},checkBudget=()=>{}}){
  const current=clone(input),steps=snapshot.flow.steps.map(s=>({...clone(s),name:STEP_TYPES.find(t=>t.type===s.type).name,status:'pending'}));let response,report;
  for(const step of steps){
    const applies=step.condition==='always'||current.sources.some(s=>s.role===(step.condition==='has_context'?'context':'ai_output'));
    if(!applies){step.status='skipped';step.finished_at=new Date().toISOString();onProgress(clone(steps));continue;}
    step.status='running';step.started_at=new Date().toISOString();onProgress(clone(steps));
    try{
      if(['material_check','evidence_quote_check'].includes(step.type)){step.result=programCheck(step.type,current,step.options);(current.program_checks||=[]).push(clone(step.result));}
      if(step.type==='evaluate'){checkBudget(current);onInput(clone(current));response=await callModel(clone(current),config);}
      if(step.type==='validate')report=validateOutput(response.value,current);
      // The caller commits the report; keep save pending until that commit succeeds.
      if(step.type==='save'){onProgress(clone(steps));return {response,report,input:current,steps};}
      step.status='completed';step.finished_at=new Date().toISOString();onProgress(clone(steps));
    }catch(e){step.status='failed';step.error=e.message;step.finished_at=new Date().toISOString();onProgress(clone(steps));e.flow_response=response;e.flow_steps=clone(steps);e.flow_input=current;throw e;}
  }
}
function interruptedSteps(steps,message){return steps?.map(s=>s.status==='running'?{...s,status:'failed',error:message,finished_at:new Date().toISOString()}:s);}
function completedSteps(steps){return steps.map(s=>s.type==='save'?{...s,status:'completed',finished_at:new Date().toISOString()}:s);}
module.exports={SKILL_ID,SKILL_DOCUMENT,EXECUTOR_VERSION,STEP_TYPES,SOURCE_KEYS,DEFAULT_CONFIGURATION,configurationOf,normalizeConfiguration,branchFor,resolveFlow,catalog,runFlow,completedSteps,interruptedSteps,hash};
