'use strict';
const {hash,auditContact,auditRecord,extractContactClaim,JUDGE_HASH,JUDGE_VERSION}=require('./monitoring');
const RATING_VERSION='resolution-v2.1/record-v1';
const DIMENSIONS={facts:'事实充分性',cause:'原因分析',judgement:'业务判断',solution:'处理方案',executable:'可执行性',communication:'沟通交付',risk:'风险控制'};
const GRADE_DEFINITIONS={L0:'错误或不可用：已确认关键事实错误、违规建议、错误承诺或方向错误',L1:'仅信息相关：只有相关信息，主要分析与处理仍需人工完成',L2:'有效辅助：已有实质价值，但仍需补充查询、分析或完善方案',L3:'完整方案可交付：有事实及有效规则支撑，无需客服重新分析处理方案',U:'无法评价：缺少可读 AI 输出或基本任务材料，连分析质量与帮助程度也无法判断'};
const fail=(s,c=400)=>{const e=Error(s);e.statusCode=c;throw e;};
const text=(x,label)=>typeof x==='string'&&x.trim()?x.trim():fail('请填写'+label);
const clone=x=>structuredClone(x);
function gradeRecord(record,assessment){
  const fact=auditRecord(record);
  const result={grade:'U',reason:record.business_record?'业务导入原文已保存；AI处理记录尚未自动解析，缺少独立评估依据，不能由业务解决状态或人工意见生成AI等级':'尚无完整方案评估依据；单项检查一致不能代替完整评级',demands:[],fact_check:fact,method:assessment?'business_confirmed_assessment':'supported_fact_check',assessment_snapshot:assessment?clone(assessment):null};
  if(assessment){
    text(assessment.confirmed_by,'评估依据确认人');
    if(assessment.demand_inventory_confirmed!==true||!Array.isArray(assessment.demands)||!assessment.demands.length) return {...result,grade:fact.verdict==='conflict'?'L0':'U',reason:fact.verdict==='conflict'?'已确认关键事实矛盾；诉求清单尚未完整，其他维度保留未知':'诉求清单尚未确认完整，不能形成完整记录等级'};
    const ids=new Set();
    const refs=new Set((record.evidence||[]).filter(e=>e.status==='available'&&e.source_verified&&e.source&&e.context_id&&e.context_id===record.context_id).map(e=>e.id));
    for(const demand of assessment.demands){
      text(demand.id,'诉求编号');if(ids.has(demand.id))fail('诉求编号重复');ids.add(demand.id);text(demand.description,'诉求说明');
      const ds=demand.dimensions||{},unknown=[],errors=[];
      for(const [key,label]of Object.entries(DIMENSIONS)){
        const d=ds[key];if(!d||!['pass','gap','error','unknown'].includes(d.status)){unknown.push(label+'缺少结论');continue;}
        if(d.status==='unknown'){unknown.push(label+'：'+(d.reason||'待补证'));continue;}
        const backed=typeof d.reason==='string'&&d.reason.trim()&&Array.isArray(d.evidence_refs)&&d.evidence_refs.length&&d.evidence_refs.every(id=>refs.has(id));
        if(!backed){unknown.push(label+'缺少同订单已确认依据');continue;}
        if(d.status==='error'&&d.critical_error===true)errors.push(label+'：'+d.reason);
      }
      let grade='U',reason=unknown.join('；');
      if(errors.length){grade='L0';reason=errors.join('；');}
      else if(!unknown.length){
        if(!['substantive','related','none'].includes(demand.value))reason='未确认AI是否提供实质价值';
        else if(typeof demand.needs_reanalysis!=='boolean')reason='未确认是否需要人工重新分析';
        else if(demand.needs_reanalysis){grade=demand.value==='substantive'?'L2':'L1';reason=grade==='L2'?'有实质价值，仍需人工补充查询、分析或处理判断':'只有相关信息，主要处理分析仍需人工完成';}
        else if(Object.values(ds).length===7&&Object.keys(DIMENSIONS).every(k=>ds[k].status==='pass')&&demand.value==='substantive'&&demand.policy_verified===true&&Array.isArray(demand.policy_refs)&&demand.policy_refs.length&&demand.policy_refs.every(id=>refs.has(id)&&(record.evidence||[]).some(e=>e.id===id&&e.type==='policy'))){grade='L3';reason='七维有据、有效规则已确认，客服无需重新分析处理方案';}
        else reason='L3条件不完整：需七维通过、实质价值与可追溯的有效规则依据';
      }
      result.demands.push({id:demand.id,description:demand.description,grade,reason});
    }
    // 记录口径：关键错误优先，其次U，再取最低已确认等级；所有诉求L3才为记录L3。
    const grades=result.demands.map(d=>d.grade);result.grade=grades.includes('L0')?'L0':grades.includes('U')?'U':['L1','L2','L3'].find(g=>grades.includes(g));
    result.reason=result.demands.filter(d=>d.grade===result.grade).map(d=>d.description+'：'+d.reason).join('；');
  }
  if(fact.verdict==='conflict'){result.grade='L0';result.reason='已确认关键事实矛盾：回复陈述'+fact.claim.count+'次，同订单话单'+fact.actual_call_count+'次；其他维度仍保留原判断';}
  return result;
}
const RATING_HASH=hash({version:RATING_VERSION,algorithm:gradeRecord.toString(),fact:auditContact.toString(),business_input:auditRecord.toString(),extract:extractContactClaim.toString()});
function createBatchRating({storage,monitor,scenes,clock,getLlmConfig,callModel,evaluatorSkill,onCompleted}){
  evaluatorSkill=evaluatorSkill||require('./evaluator-skill').createEvaluatorSkill({storage});
  const get=(c,id)=>storage.byId(c,id)||fail('记录不存在',404);
  const ingestion=scenes?require('./ingestion').createIngestion({storage,monitor,scenes,clock}):null;
  function migrateLegacy(){
    const assigned=new Set(storage.list('monitor_batch_items').map(i=>i.case_id));const orphan=storage.list('monitor_cases').filter(c=>!assigned.has(c.id));if(!orphan.length)return;
    storage.transaction(()=>{let batch=storage.find('monitor_batches',b=>b.source_kind==='legacy_unknown');if(!batch)batch=storage.insert('monitor_batches',{name:'历史材料 · 原批次未知',source_kind:'legacy_unknown',source_name:'旧版材料迁移',source_system:'legacy',actor:'系统兼容迁移',status:'imported',schema_version:1,imported_count:0,duplicate_count:0,updated_count:0,error_count:0,origin_time_known:false});for(const c of orphan)storage.insert('monitor_batch_items',{batch_id:batch.id,case_id:c.id,record_snapshot:clone(c.record),record_hash:c.content_hash,source_record_id:c.source_record_id||null,logical_key:'legacy:'+c.id,ingestion_status:'legacy',assessment:null});storage.update('monitor_batches',batch.id,{imported_count:storage.list('monitor_batch_items').filter(i=>i.batch_id===batch.id).length});});
  }
  migrateLegacy();
  const llm=getLlmConfig?require('./llm-rating').createLlmRating({storage,assertConfirmed:id=>ingestion.assertConfirmed(id),getLlmConfig,callModel,clock,evaluatorSkill,onCompleted}):null;
  function importBatch(body){
    if(ingestion)return ingestion.importBatch(body);
    const binding=null,sceneData=null; // 无场景服务的旧兼容路径；正式入口使用逐条导入服务。
    const actor=text(body.actor,'导入人'),kind=body.source_kind||'file';if(!['file','sync','manual'].includes(kind))fail('来源类型无效');
    if(!Array.isArray(body.records)||!body.records.length||body.records.length>2000)fail('每批应包含1至2000条记录');
    const requestId=text(body.request_id,'导入请求编号');const fingerprint=hash({records:body.records,source_kind:kind,source_name:body.source_name,source_system:body.source_system,scene_id:body.scene_id,candidate_id:body.candidate_id});const old=storage.find('monitor_batches',b=>b.request_id===requestId);if(old){if(old.request_hash!==fingerprint)fail('同一请求编号内容不同',409);return clone(old);}
    return storage.transaction(()=>{
      const b=storage.insert('monitor_batches',{name:text(body.name,'批次名称'),source_kind:kind,source_name:text(body.source_name,'来源名称'),source_system:body.source_system||body.source_name,request_id:requestId,request_hash:fingerprint,actor,schema_version:2,scene_id:sceneData?.scene_id||null,scene_snapshot:sceneData?.scene_snapshot||null,monitor_binding:binding,origin_time_known:true,synced_at:kind==='sync'?new Date().toISOString():null,status:'imported',submitted_count:body.records.length,imported_count:0,duplicate_count:0,updated_count:0,error_count:0});
      const counters={imported_count:0,duplicate_count:0,updated_count:0,error_count:0};
      body.records.forEach((row,index)=>{
        try{
          const external=String(row.source_record_id||(kind==='manual'?requestId:index+1)),logical=hash({system:b.source_system,external,scope:row.scope});
          const previous=storage.list('monitor_batch_items').filter(i=>i.logical_key===logical&&i.case_id).at(-1);
          // 新内容创建新快照，旧批次继续引用旧样本；重复内容复用已有样本。
          const assigned=sceneData?{...row,scene:sceneData.scene,scene_id:sceneData.scene_id,scene_snapshot:sceneData.scene_snapshot}:row;const sample=monitor.addCase({...assigned,actor,source_record_id:'batch:'+logical+':'+hash({...row,assessment:undefined,source_record_id:undefined,actor:undefined,scene_id:sceneData?.scene_id||row.scene_id})});
          const status=previous?(previous.case_id===sample.id?'duplicate':'updated'):'new';
          storage.insert('monitor_batch_items',{batch_id:b.id,row_number:index+1,case_id:sample.id,record_snapshot:clone(sample.record),record_hash:sample.content_hash,logical_key:logical,source_record_id:external,ingestion_status:status,assessment:row.assessment?clone(row.assessment):null});counters.imported_count++;if(status==='duplicate')counters.duplicate_count++;if(status==='updated')counters.updated_count++;
        }catch(e){storage.insert('monitor_batch_items',{batch_id:b.id,row_number:index+1,case_id:null,logical_key:null,ingestion_status:'failed',error:e.message});counters.error_count++;}
      });return clone(storage.update('monitor_batches',b.id,{...counters,status:counters.error_count?'partial':'imported'}));
    });
  }
  function evaluate(id,body){
    if(llm)return llm.start(id,body);
    const b=get('monitor_batches',id),actor=text(body.actor,'评级人'),items=storage.list('monitor_batch_items').filter(i=>i.batch_id===id&&i.case_id);
    if(!items.length)fail('该批次没有可评级记录');
    const confirmation=ingestion?ingestion.assertConfirmed(id):null;
    const dedup=[...new Map(items.map(i=>[i.case_id,i])).values()];
    const overrides=body.assessments||{};for(const itemId of Object.keys(overrides))if(!dedup.some(i=>i.id===itemId))fail('评估依据不属于该批次记录');
    return storage.transaction(()=>{
      const routes=dedup.map(i=>i.current_route_id?get('monitor_item_routes',i.current_route_id):null);if(!dedup.some((i,n)=>!routes[n]||routes[n].status==='ready'))fail('本批尚无可检测记录，请先处理场景与方案匹配');
      const run=storage.insert('monitor_rating_runs',{batch_id:b.id,scene_id:b.scene_id||null,scene_snapshot:b.scene_snapshot||null,monitor_binding:b.monitor_binding||null,actor,rating_version:RATING_VERSION,rating_hash:RATING_HASH,kind:'record_rating',routing_confirmation_id:confirmation?.confirmation_id||null,routing_hash:confirmation?.route_hash||null,status:'completed',total:dedup.filter((i,n)=>!routes[n]||routes[n].status==='ready').length,skipped_routing:routes.filter(r=>r&&r.status!=='ready').length});
      for(const item of dedup){
        const routing=item.current_route_id?get('monitor_item_routes',item.current_route_id):null;if(routing&&routing.status!=='ready')continue;const effective=routing?.effective_record||item.record_snapshot,binding=routing?.monitor_binding||b.monitor_binding,recordHash=routing?.record_hash||item.record_hash;
        try{if(binding&&!['plan_document','basic_evaluation'].includes(binding.kind)&&binding.definition.executor_hash!==JUDGE_HASH)fail('本记录绑定的执行器版本已变化，请更正匹配后重新评级');const previous=storage.list('monitor_ratings').filter(r=>r.item_id===item.id&&r.status==='completed'&&(r.route_id||null)===(routing?.id||null)).at(-1);const assessment=overrides[item.id]?{...overrides[item.id],confirmed_by:actor}:previous?.report?.assessment_snapshot||(routing?.number>1?null:item.assessment);const report=['plan_document','basic_evaluation'].includes(binding?.kind)?{grade:'U',reason:'已绑定确认的监测方案文档；文档的 LLM 评级尚未接入，当前不能根据该文档自动给出等级',method:'plan_document_pending_llm',demands:[],assessment_snapshot:assessment?clone(assessment):null,fact_check:{verdict:'unjudged'}}:binding?.definition.checks?.[0]?.supported===false?{grade:'U',reason:'所选场景监测方案的自定义执行器尚未接通；不能套用其他场景的事实检查',method:'unsupported_scene_executor',demands:[],assessment_snapshot:assessment?clone(assessment):null,fact_check:{verdict:'unjudged'}}:gradeRecord(effective,assessment);const monitorReport=binding&&!['plan_document','basic_evaluation'].includes(binding.kind)?monitor.evaluateRecord({definition:binding.definition},effective):null;const auditRun=monitorReport?storage.insert('monitor_runs',{kind:'offline_evidence_audit',batch_id:b.id,item_id:item.id,route_id:routing?.id||null,candidate_id:binding.candidate_id,candidate_hash:binding.candidate_hash,revision_id:binding.revision_id,judge_version:JUDGE_VERSION,judge_hash:JUDGE_HASH,case_snapshots:[{id:item.case_id,content_hash:recordHash,record:clone(effective)}],results:[{case_id:item.case_id,record_hash:recordHash,report:monitorReport,expected:clone(effective.expected||null),expected_match:effective.expected?effective.expected.verdict===monitorReport.verdict:null}],executed:true,target_skill_executed:false,actor,summary:{total:1,conflicts:monitorReport.verdict==='conflict'?1:0,unjudged:monitorReport.verdict==='unjudged'?1:0}}):null;storage.insert('monitor_ratings',{run_id:run.id,batch_id:b.id,item_id:item.id,case_id:item.case_id,route_id:routing?.id||null,record_hash:recordHash,record_snapshot:clone(effective),rating_version:RATING_VERSION,rating_hash:RATING_HASH,assessment_hash:assessment?hash(assessment):null,status:'completed',scene_id:routing?.scene_id||b.scene_id||null,scene_snapshot:routing?.scene_snapshot||b.scene_snapshot||null,monitor_binding:binding||null,monitor_report:monitorReport,monitor_run_id:auditRun?.id||null,report,actor});}
        catch(e){storage.insert('monitor_ratings',{run_id:run.id,batch_id:b.id,item_id:item.id,case_id:item.case_id,route_id:routing?.id||null,record_hash:recordHash,status:'failed',error:e.message,rating_version:RATING_VERSION,rating_hash:RATING_HASH,actor});}
      }return clone(run);
    });
  }
  function bootstrap(){return {...(ingestion?.bootstrap()||{}),evaluator_skill:evaluatorSkill.bootstrap(),batches:storage.list('monitor_batches'),batch_items:storage.list('monitor_batch_items'),rating_runs:storage.list('monitor_rating_runs'),ratings:storage.list('monitor_ratings'),batch_routing_reviews:ingestion?storage.list('monitor_batches').map(b=>ingestion.review(b.id)):[],routing_confirmations:storage.list('monitor_batch_confirmations'),rating_contract:{version:llm?require('./llm-rating').VERSION:RATING_VERSION,hash:llm?require('./llm-rating').PROMPT_HASH:RATING_HASH,grades:GRADE_DEFINITIONS,dimensions:DIMENSIONS,aggregation:llm?'按全局评估员评级；有场景方案时执行专属检查，无方案时基础分析；失败及不适用不计入等级分布':'关键错误L0优先，其次U，其余取最低等级；全诉求L3才是记录L3',denominator:'记录等级占已评唯一记录（含U）；待评及失败单独列示',method:llm?'按已确认方案文档逐条调用 LLM；保存结构化评级与引用依据':'已确认业务评估依据 + 受限事实执行器；未配置通用模型评级',llm_enabled:!!llm,sync_connector_connected:false}};}
  return {importBatch,evaluate,bootstrap,startPlanTrial:body=>llm?llm.startPlanTrial(body):fail('请先配置分析模型',409),startEvaluatorTrial:body=>llm?llm.startTrial(body):fail('未配置 LLM 试评',409),getEvaluatorTrial:id=>llm.getTrial(id),getRatingRun:id=>llm?llm.getRun(id):clone(get('monitor_rating_runs',id)),waitForRating:id=>llm?.wait(id)||Promise.resolve(),preview:body=>ingestion.preview(body),resolveItem:(id,body)=>ingestion.resolveItem(id,body),routingReview:id=>ingestion.review(id),resolveGroup:(id,body)=>ingestion.resolveGroup(id,body),refreshRouting:(id,body)=>ingestion.refreshRoutes(id,body),confirmRouting:(id,body)=>ingestion.confirm(id,body)};
}
module.exports={createBatchRating,gradeRecord,RATING_VERSION,RATING_HASH,DIMENSIONS};
