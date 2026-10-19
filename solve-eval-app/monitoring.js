'use strict';
const crypto = require('crypto');
const {adaptRecord}=require('./public/business-import');
const hash = x => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const clone = x => structuredClone(x);
const now = () => new Date().toISOString();
const scopes = ['bot', 'frontline', 'tier2', 'linked'];
const JUDGE_VERSION = 'call-count-consistency/v2';
const PlanDocument = require('./public/plan-document');
const {selectSkill,planSkills}=require('./skill-context');
const fail = (message, code=400) => { const error=new Error(message); error.statusCode=code; throw error; };
const requireText = (value,label) => { if(typeof value!=='string'||!value.trim())fail('请填写'+label); return value.trim(); };
function extractContactClaim(reply) {
  for(const clause of String(reply||'').split(/[。；;\n]/)) {
    if(/[？?]/.test(clause))continue;
    if(/不能|不得|禁止|不应|无法判断|如果|假如|若|是否|不要|并非|不是|不能认定/.test(clause))continue;
    if(/未见.{0,8}拨打|未拨打|没有拨打|无外呼记录|没有呼叫记录/.test(clause))return {count:0,quote:clause.trim()};
    const m=clause.match(/(?:外呼|拨打|呼叫|联系)(?:过|了)?\s*(\d+)\s*(?:次|通)/);
    if(m&&Number.isSafeInteger(Number(m[1])))return {count:Number(m[1]),quote:clause.trim()};
  }
  return null;
}
function auditContact(record) {
  const claim=extractContactClaim(record.ai_reply);
  const matching=(record.evidence||[]).filter(e=>e.type==='telecom_cdr'&&e.context_id===record.context_id);
  const trusted=matching.filter(e=>e.status==='available'&&e.source_verified&&e.source&&Number.isSafeInteger(e.fields?.call_count)&&e.fields.call_count>=0);
  const evidence=trusted[0]||matching[0];
  const result={check_id:'contact_claim_consistency',verdict:'unjudged',evidence_refs:[],findings:[],unknown_reasons:[],claim};
  if(new Set(trusted.map(e=>e.fields.call_count)).size>1){result.unknown_reasons.push('同订单已确认话单快照次数冲突，需明确适用底单');return result;}
  if(!claim){result.unknown_reasons.push('无法从回复可靠提取联系次数陈述；本检查点不评价整体判责');return result;}
  if(!record.context_id||!evidence?.context_id||evidence.context_id!==record.context_id){result.unknown_reasons.push('缺少同一订单/会话的证据关联，不能将其他话单用于判断');return result;}
  if(!evidence||evidence.status!=='available'||!evidence.source_verified||!evidence.source||!Number.isSafeInteger(evidence.fields?.call_count)||evidence.fields.call_count<0){result.unknown_reasons.push('缺少有来源且经业务确认的有效话单次数');return result;}
  result.evidence_refs=[evidence.id];
  result.evidence_snapshot_hash=hash(evidence);
  const actual=evidence.fields.call_count;
  // 声称未联系仅在存在呼叫记录时形成矛盾；数量比较核对事实，不推导责任或退款。
  result.verdict=claim.count===actual?'consistent':'conflict';
  result.actual_call_count=actual;
  if(result.verdict==='conflict')result.findings.push({type:'FACT_CONTRADICTION',summary:'回复的联系记录陈述与上传话单矛盾',quote:claim.quote,evidence_id:evidence.id,actual_call_count:actual,claimed_call_count:claim.count,root_cause_status:'unresolved',suggestion:'先采信实际话单并修正事实陈述；结合业务Skill定义与执行记录再定位根因，不直接推导责任或退款。'});
  return result;
}
const JUDGE_HASH = hash({version:JUDGE_VERSION,audit:auditContact.toString(),extract:extractContactClaim.toString()});
function auditRecord(record){
  if(record.business_record)return {check_id:'contact_claim_consistency',verdict:'unjudged',evidence_refs:[],findings:[],unknown_reasons:['业务导入原文已保存；尚未接入AI处理记录解析与对应评估能力，不将人工回复、处理意见或业务解决状态当作AI表现结论'],claim:null};
  return auditContact(record);
}
function createMonitoring({storage,getLlmConfig,modelGenerate,modelReplay}) {
  const list=collection=>storage.list(collection);
  const entity=(collection,id)=>storage.byId(collection,id)||fail('记录不存在',404);
  const revision=plan=>entity('monitor_revisions',plan.current_revision_id);
  function validatePlan(body) {
    const name=requireText(body.name,'方案名称'),scene=requireText(body.scene,'场景名称');
    const scope=body.scope||'frontline';if(!scopes.includes(scope))fail('评估对象无效');
    const participants=scope==='linked'?[...new Set(body.participants||[])]:[scope];
    if(participants.some(x=>!scopes.slice(0,3).includes(x))||(scope==='linked'&&participants.length<2))fail('联动至少选择两个实际参与对象');
    if(PlanDocument.hasDocument(body)&&typeof body.document!=='string')fail('方案文档应为文本');
    const document=PlanDocument.documentOf(body);
    const checkType=body.check_type||'contact_claim_consistency';if(!['contact_claim_consistency','custom'].includes(checkType))fail('检查类型无效');
    const refs=Array.isArray(body.service_refs)?body.service_refs:[];
    const serviceRefs=refs.map(id=>entity('service_skills',id));
    if(serviceRefs.some(s=>(body.scene_id?s.scene_id!==body.scene_id:s.scene!==scene)||!participants.includes(s.scope)))fail('客服业务版本与场景或参与对象不相容，请重新选择');
    if(body.service_bindings!==undefined&&(!Array.isArray(body.service_bindings)||body.service_bindings.some(b=>!b||typeof b.id!=='string'||!Array.isArray(b.modules))||new Set(body.service_bindings.map(b=>b.id)).size!==body.service_bindings.length))fail('Skill 定义选择无效');
    const service_bindings=serviceRefs.map(s=>{const supplied=(body.service_bindings||[]).find(b=>b.id===s.id),selected=selectSkill(s,supplied);if(supplied?.modules?.length&&selected.needs_confirmation)fail(selected.reason);return {id:s.id,content_hash:selected.content_hash,modules:selected.selected.map(m=>({key:m.key,id:m.id,content_hash:m.content_hash}))};});
    return {name,scene,scene_id:body.scene_id||null,scene_snapshot:body.scene_snapshot||null,scene_code:String(body.scene_code||scene),scope,participants,check_type:checkType,document,service_refs:serviceRefs.map(s=>s.id),service_bindings};
  }
  function savePlan(body,id) {
    const data=validatePlan(body),actor=requireText(body.actor,'业务维护人');
    const plan=id?entity('monitor_plans',id):null;
    if(plan&&body.base_revision_id!==plan.current_revision_id)fail('方案已有新修订，请刷新后再保存',409);
    return storage.transaction(()=>{
      const p=plan||storage.insert('monitor_plans',{name:data.name,scene:data.scene,scene_id:data.scene_id,scope:data.scope,current_revision_id:null});
      const old=plan?revision(p):null;
      const r=storage.insert('monitor_revisions',{plan_id:p.id,number:(old?.number||0)+1,parent_revision_id:old?.id||null,data:clone(data),content_hash:hash(data),actor,confirmed:false,confirmed_by:null,confirmed_at:null});
      storage.update('monitor_plans',p.id,{name:data.name,scene:data.scene,scene_id:data.scene_id,scope:data.scope,current_revision_id:r.id});
      return clone(r);
    });
  }
  function confirm(id,body) {
    const p=entity('monitor_plans',id),r=revision(p);if(body.revision_id!==r.id)fail('请确认当前修订',409);
    if(!PlanDocument.ready(PlanDocument.documentOf(r.data)))fail('方案文档为空或仍有待补齐内容，请完善完整文档后确认');
    const pending=planSkills(r.data,id=>storage.byId('service_skills',id)).filter(s=>!s.ready);if(pending.length)fail(pending.map(s=>s.code+'：'+s.reason).join('；'),409);
    if(r.confirmed)return clone(r);
    return clone(storage.update('monitor_revisions',r.id,{confirmed:true,confirmed_by:requireText(body.actor,'确认人'),confirmed_at:now()}));
  }
  async function generate(id,body) {
    const p=entity('monitor_plans',id),r=revision(p);if(body.revision_id!==r.id||!r.confirmed)fail('先确认当前业务修订',409);
    const requestedMode=body.mode||'local';if(!['local','model'].includes(requestedMode))fail('生成方式无效');
    let suggestions=null,modelSnapshot=null;
    if(requestedMode==='model') {
      const config=getLlmConfig(body.model_selection);if(!config.base_url||!config.model||!config.api_key)fail('尚未配置生成模型，可先生成受限的本地检查草案',409);
      suggestions=await modelGenerate(PlanDocument.canonical(r.data),config);
      modelSnapshot=require('./model-configs').snapshot(config);
      if(!suggestions||!Array.isArray(suggestions.questions)||!Array.isArray(suggestions.checks)||suggestions.questions.some(q=>typeof q!=='string')||suggestions.checks.some(c=>typeof c.description!=='string'))fail('模型整理结果格式无效，未保存候选',502);
    }
    if(p.current_revision_id!==r.id)fail('生成期间方案已修改，请基于当前修订重新生成',409);
    const checkType=r.data.check_type;
    const definition={
      name:r.data.name,scene:r.data.scene,scene_id:r.data.scene_id,scene_snapshot:r.data.scene_snapshot,scope:r.data.scope,participants:r.data.participants,executor_version:JUDGE_VERSION,executor_hash:JUDGE_HASH,
      document:PlanDocument.documentOf(r.data),
      checks:[{id:checkType,supported:checkType==='contact_claim_consistency',description:checkType==='contact_claim_consistency'?'核对回复中的联系次数陈述与话单；不推导责任、退款或整体L3':r.data.name+'（按完整方案文档核对）'}],
      input_schema:{type:'object',required:['scope','scene','ai_reply','evidence'],properties:{
        scope:{enum:scopes},scene:{type:'string'},ai_reply:{type:'string'},
        evidence:{type:'array',items:{type:'object',required:['id','type','status','source','source_verified','fields'],properties:{
          id:{type:'string'},type:{type:'string'},status:{enum:['available','missing','timeout']},
          source:{type:'string'},source_verified:{type:'boolean'},context_id:{type:'string'},fields:{type:'object'}
        }}}
      }},
      output_schema:{type:'object',required:['verdict','checks','unknown_reasons'],properties:{verdict:{enum:['conflict','consistent','unjudged']},checks:{type:'array'},unknown_reasons:{type:'array'}}},
      service_refs:r.data.service_refs.map(ref=>{const s=entity('service_skills',ref);return {id:s.id,code:s.code,version:s.version,content_hash:s.content_hash,runtime_verified:false};}),
      service_bindings:clone(r.data.service_bindings||[]),
      tool_bindings:[],limits:['仅支持联系记录事实一致性检查','上传来源由业务确认，未直接连接生产话单系统','自定义判据仍需接入执行器，不能自动认定通过']
    };
    return clone(storage.insert('monitor_candidates',{plan_id:id,revision_id:r.id,revision_hash:r.content_hash,definition,content_hash:hash(definition),method:requestedMode==='model'?'model_assisted_constrained':'local_supported_check',model_suggestions:suggestions,model_snapshot:modelSnapshot,business_approved:false,approved_by:null,published:false}));
  }
  function approve(candidateId,body) {
    const c=entity('monitor_candidates',candidateId),p=entity('monitor_plans',c.plan_id);if(c.revision_id!==p.current_revision_id)fail('候选已过期，请基于当前修订重新生成',409);
    return clone(storage.update('monitor_candidates',c.id,{business_approved:true,approved_by:requireText(body.actor,'候选复核人'),approved_at:now()}));
  }
  function normalizeRecord(body) {
    body=adaptRecord(body);
    if(!['bot','frontline','tier2'].includes(body.scope))fail('样本必须属于一个独立对象');
    const scene=body.business_record?(body.scene_snapshot?.name||String(body.scene||'').trim()||'待确认场景'):requireText(body.scene,'样本场景'),reply=body.business_record?'':requireText(body.ai_reply,'客服实际回复');
    const evidence=Array.isArray(body.evidence)?body.evidence:[];
    const used=new Set();
    const clean=evidence.map(e=>{const id=requireText(e.id,'证据编号');if(used.has(id))fail('证据编号重复');used.add(id);if(!['available','missing','timeout'].includes(e.status))fail('证据状态无效');if(e.type==='telecom_cdr'&&e.status==='available'&&(!Number.isSafeInteger(e.fields?.call_count)||e.fields.call_count<0))fail('话单次数必须是非负整数');return {id,type:requireText(e.type,'证据类型'),status:e.status,source:String(e.source||''),source_verified:e.source_verified===true,captured_at:String(e.captured_at||''),context_id:String(e.context_id||''),fields:clone(e.fields||{})};});
    const expected=body.expected||null;if(expected&&!['conflict','consistent','unjudged'].includes(expected.verdict))fail('业务预期无效');
    return {name:requireText(body.name,'样本名称'),scope:body.scope,scene,scene_id:body.scene_id||null,scene_snapshot:body.scene_snapshot||null,context_id:String(body.context_id||''),session_text:String(body.session_text||''),ai_reply:reply,evidence:clean,tool_calls:Array.isArray(body.tool_calls)?clone(body.tool_calls):[],service_ref:body.service_ref?clone(body.service_ref):null,source_type:body.source_type==='synthetic'?'synthetic':'uploaded',expected:expected?{verdict:expected.verdict,reason:requireText(expected.reason,'预期判断依据'),confirmed_by:requireText(expected.confirmed_by,'预期确认人')}:null,...(body.business_record?{business_record:clone(body.business_record)}:{})};
  }
  function addCase(body) {
    const actor=requireText(body.actor,'材料登记人'),record=normalizeRecord(body),key=body.source_record_id?String(body.source_record_id):null;
    if(key){const old=list('monitor_cases').find(c=>c.source_record_id===key);if(old){if(old.content_hash!==hash(record))fail('同一来源记录内容发生变化，请使用新记录编号',409);return clone(old);}}
    return clone(storage.insert('monitor_cases',{record,content_hash:hash(record),source_record_id:key,actor}));
  }
  function importService(body) {
    const code=requireText(body.code,'业务Skill编码'),version=requireText(body.version,'业务Skill版本'),scene=requireText(body.scene,'业务Skill场景');
    if(!scopes.slice(0,3).includes(body.scope))fail('业务Skill需属于一个对象');
    const raw=typeof body.raw==='string'?body.raw.trim():'',source=requireText(body.source,'业务Skill来源');
    const digest=hash({raw});const existing=list('service_skills').filter(s=>s.code===code&&s.version===version&&s.scope===body.scope).at(-1);
    if(existing){if((body.scene_id?existing.scene_id!==body.scene_id:existing.scene!==scene))fail('同编码版本场景不一致',409);if(existing.content_hash===digest)return clone(existing);if(existing.raw||!raw)fail('同编码版本已存在，不能覆盖；请登记新的修订版本',409);}
    return clone(storage.insert('service_skills',{code,version,scope:body.scope,scene,scene_id:body.scene_id||null,scene_snapshot:body.scene_snapshot||null,raw,source,snapshot_revision:(existing?.snapshot_revision||0)+1,content_hash:digest,runtime_verified:false,actor:requireText(body.actor,'登记人'),based_on_id:body.based_on_id||null}));
  }
  function verifyCandidate(c,cases) {
    const plan=entity('monitor_plans',c.plan_id);if(c.definition.executor_version!==JUDGE_VERSION||c.definition.executor_hash!==JUDGE_HASH)fail('检查执行版本已变更，请重新生成并复核候选',409);if(c.revision_id!==plan.current_revision_id)fail('候选不属于当前业务修订',409);
    if(!c.business_approved)fail('请先复核生成候选的业务含义',409);
    if(!cases.length)fail('请选择验证样本');
    for(const sample of cases){const rec=sample.record;if((c.definition.scene_id?(rec.scene_id||list('scene_assignments').find(a=>a.case_id===sample.id)?.scene_id)!==c.definition.scene_id:rec.scene!==c.definition.scene)||!c.definition.participants.includes(rec.scope))fail('样本场景或对象与候选不相容');}
  }
  function evaluateRecord(c,record) {
    const check=c.definition.checks[0];
    const result=check.supported?auditRecord(record):{check_id:check.id,verdict:'unjudged',evidence_refs:[],findings:[],unknown_reasons:['该自定义判据尚未接入可执行检查能力']};
    return {verdict:result.verdict,rating_grade:result.verdict==='conflict'?'L0':result.verdict==='unjudged'?'U':null,checks:[result],unknown_reasons:result.unknown_reasons,scope_note:'只评价登记的事实一致性检查点；通过不代表完整方案L3或实际问题已解决',root_cause_status:result.verdict!=='consistent'?'unresolved':'not_applicable'};
  }
  function evaluate(body) {
    const c=entity('monitor_candidates',body.candidate_id),samples=(body.case_ids||[]).map(id=>entity('monitor_cases',id));verifyCandidate(c,samples);
    const frozen=samples.map(sample=>({id:sample.id,content_hash:sample.content_hash,record:clone(sample.record)}));
    const results=frozen.map(s=>({case_id:s.id,record_hash:s.content_hash,report:evaluateRecord(c,s.record),expected:clone(s.record.expected),expected_match:s.record.expected?s.record.expected.verdict===evaluateRecord(c,s.record).verdict:null}));
    return clone(storage.insert('monitor_runs',{kind:'offline_evidence_audit',candidate_id:c.id,candidate_hash:c.content_hash,revision_id:c.revision_id,judge_version:JUDGE_VERSION,judge_hash:JUDGE_HASH,case_snapshots:frozen,results,executed:true,target_skill_executed:false,actor:requireText(body.actor,'验证人'),summary:{total:results.length,conflicts:results.filter(r=>r.report.verdict==='conflict').length,unjudged:results.filter(r=>r.report.verdict==='unjudged').length,expected_matched:results.filter(r=>r.expected_match===true).length,expected_total:results.filter(r=>r.expected_match!==null).length}}));
  }
  function compare(body) {
    const base=entity('monitor_runs',body.base_run_id);if(base.judge_version!==JUDGE_VERSION||base.judge_hash!==JUDGE_HASH)fail('裁判版本已变更，请用当前检查版本重新建立基线；旧报告保留',409);const sample=base.case_snapshots.find(s=>s.id===body.case_id);if(!sample)fail('原验证报告不含该样本');
    const c=entity('monitor_candidates',base.candidate_id);
    // 固定旧裁判和底单；原报告不变。只核验登记的新输出，不冒充生产执行。
    const corrected=clone(sample.record);corrected.ai_reply=requireText(body.ai_reply,'修改后的客服回复');
    const correctedRef=body.corrected_service_id?entity('service_skills',body.corrected_service_id):null;
    if(correctedRef&&(correctedRef.scene!==corrected.scene||correctedRef.scope!==corrected.scope))fail('修订业务版本与原样本不相容');
    const oldResult=base.results.find(r=>r.case_id===sample.id).report,newResult=evaluateRecord(c,corrected);
    return clone(storage.insert('monitor_runs',{kind:'uploaded_output_comparison',base_run_id:base.id,candidate_id:c.id,candidate_hash:c.content_hash,revision_id:c.revision_id,judge_version:base.judge_version,judge_hash:base.judge_hash,case_snapshots:clone(base.case_snapshots.filter(s=>s.id===sample.id)),case_id:sample.id,before:clone(oldResult),after:newResult,corrected_reply:corrected.ai_reply,corrected_service_ref:correctedRef?{id:correctedRef.id,code:correctedRef.code,version:correctedRef.version,content_hash:correctedRef.content_hash}:null,executed:true,target_skill_executed:false,output_origin:'user_registered_output',actor:requireText(body.actor,'复验人'),summary:{fact_conflict_resolved:oldResult.verdict==='conflict'&&newResult.verdict==='consistent',complete_skill_certified:false}}));
  }
  async function replay(body) {
    const base=entity('monitor_runs',body.base_run_id);if(base.judge_version!==JUDGE_VERSION||base.judge_hash!==JUDGE_HASH)fail('裁判版本已变更，请用当前检查版本重新建立基线；旧报告保留',409);const sample=base.case_snapshots.find(s=>s.id===body.case_id);if(!sample)fail('原报告不含该样本');
    const before=entity('service_skills',body.before_service_id),after=entity('service_skills',body.after_service_id);
    if(before.id===after.id)fail('请选择两个不同业务版本');
    for(const s of [before,after])if(!s.raw)fail('业务版本原文尚未取得，不能执行模型回放');
    for(const s of [before,after])if(s.scene!==sample.record.scene||s.scope!==sample.record.scope)fail('业务版本与样本对象/场景不相容');
    const config=getLlmConfig(body.model_selection);if(!config.base_url||!config.model||!config.api_key)fail('模型回放尚未配置',409);
    const candidate=entity('monitor_candidates',base.candidate_id);
    const fixed=clone(sample.record);
    const a=await modelReplay(clone(before),clone(fixed),config),b=await modelReplay(clone(after),clone(fixed),config);
    const beforeReport=evaluateRecord(candidate,{...fixed,ai_reply:a.reply}),afterReport=evaluateRecord(candidate,{...fixed,ai_reply:b.reply});
    return clone(storage.insert('monitor_runs',{kind:'isolated_model_replay',base_run_id:base.id,case_id:sample.id,candidate_id:candidate.id,candidate_hash:candidate.content_hash,revision_id:candidate.revision_id,judge_version:base.judge_version,judge_hash:base.judge_hash,case_snapshots:[clone(sample)],before:beforeReport,after:afterReport,before_reply:a.reply,corrected_reply:b.reply,target_versions:[{id:before.id,version:before.version,hash:before.content_hash},{id:after.id,version:after.version,hash:after.content_hash}],model:config.model,model_snapshot:require('./model-configs').snapshot(config),executed:true,target_skill_executed:true,production_execution_verified:false,output_origin:'isolated_model_replay',actor:requireText(body.actor,'回放人'),summary:{fact_conflict_resolved:beforeReport.verdict==='conflict'&&afterReport.verdict==='consistent',complete_skill_certified:false},limits:['使用业务Skill文本的隔离模型回放，不调用生产工具或执行业务动作','仅核验联系记录检查点，不能证明生产运行效果']}));
  }
  function task(body) { const run=entity('monitor_runs',body.run_id);if(run.kind!=='offline_evidence_audit'||!run.case_snapshots.some(s=>s.id===body.case_id))fail('请从原诊断报告选择具体样本创建任务');return clone(storage.insert('monitor_tasks',{run_id:run.id,case_id:body.case_id||null,description:requireText(body.description,'问题与修改说明'),owner:requireText(body.owner,'负责人'),status:'待修改',history:[{at:now(),action:'创建',actor:requireText(body.actor,'创建人')}]})); }
  function updateTask(id,body) { const t=entity('monitor_tasks',id);if(!['待修改','修改中','待复验','已复验'].includes(body.status))fail('任务状态无效');if(body.status==='已复验'){if(!body.replay_run_id)fail('标记已复验前，请选择对应的有效复验报告');const run=entity('monitor_runs',body.replay_run_id);if(run.judge_version!==JUDGE_VERSION||run.judge_hash!==JUDGE_HASH)fail('该复验报告的裁判版本已变更，请先重新复验',409);if(!['uploaded_output_comparison','isolated_model_replay'].includes(run.kind)||run.base_run_id!==t.run_id||!run.summary.fact_conflict_resolved||(t.case_id&&t.case_id!==run.case_id))fail('需要对应样本的有效前后复验报告，且事实矛盾已消除');}return clone(storage.update('monitor_tasks',id,{status:body.status,replay_run_id:body.replay_run_id||null,history:[...t.history,{at:now(),action:body.status,actor:requireText(body.actor,'操作人')}]})); }
  function bootstrap() {let config={};try{config=getLlmConfig();}catch{}return {current_judge:{version:JUDGE_VERSION,hash:JUDGE_HASH},plans:list('monitor_plans'),revisions:list('monitor_revisions'),candidates:list('monitor_candidates'),cases:list('monitor_cases'),runs:list('monitor_runs'),services:list('service_skills'),tasks:list('monitor_tasks'),workspace_mode:process.env.CSR_PREVIEW==='1'?'isolated_preview':'local_application',model_configured:!!(config.base_url&&config.api_key&&config.model),limits:['当前支持上传话单与回复的联系记录一致性检查','不执行退款、扣分或生产Skill发布','复验登记的新输出不代表生产Skill已运行']};}
  return {normalizeRecord,evaluateRecord,bootstrap,savePlan,confirm,generate,approve,addCase,importService,evaluate,compare,replay,task,updateTask};
}
module.exports={createMonitoring,auditContact,auditRecord,extractContactClaim,hash,JUDGE_HASH,JUDGE_VERSION};
