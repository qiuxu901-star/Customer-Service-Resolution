(function(root){
 'use strict';
 // Shared by the browser and server: business exports remain one row per interaction.
 const schemas={
  frontline:{name:'一线会话',id:'session_id',fields:[
   ['session_id','会话ID'],['session_time','会话时间'],['intent_scene','意图场景'],['skill_name','skill名称'],
   ['conversation_text','会话记录'],['ai_process_text','AI处理记录'],['ai_suggested_reply','AI建议回复'],['session_category','会话分类'],
   ['resolution_status','解决状态'],['session_summary','会话小记'],['related_tickets','关联工单']
  ]},
  tier2:{name:'二线工单',id:'ticket_id',fields:[
   ['ticket_id','工单ID'],['created_time','创建时间'],['intent_scene','意图场景'],['skill_name','skill名称'],
   ['transcript_text','录音转录文本'],['ai_process_text','AI处理记录'],['ai_analysis_conclusion','AI分析结论'],
   ['ticket_category','工单分类'],['ticket_status','工单状态'],['feedback_text','反馈内容'],['handling_opinion','处理意见']
  ]}
 };
 const rnd={name:'二线研发导出',id:'ticket_id',fields:[
  ['trace_id','traceId'],['intent_scene','命中场景'],['source_scene_message','msg'],['source_scene_code','二级场景'],
  ['ticket_id','工单ID'],['tenant_id','租户id'],['created_time','工单创建时间'],['source_created_date','工单创建日期'],
  ['processing_started_at','开始处理时间'],['processing_completed_at','处理完成时间'],['ticket_status','工单状态 2为完成'],
  ['processing_duration_minutes','处理时长(分钟)'],['order_id','订单号'],['ticket_category','工单分类'],
  ['feedback_text','反馈内容'],['handling_opinion','处理意见'],['handler_name','处理人'],['ai_key_information','关键信息提取'],
  ['ai_responsible_party','责任方'],['ai_analysis_conclusion','责任结论'],['ai_cited_policy','判责依据条款'],
  ['ai_core_evidence','核心证据'],['journey_dialogue_text','行程对话'],['transcript_text','录音对话'],
  ['source_usefulness','有用/无用'],['source_useless_reason','无用原因']
 ]};
 const profiles={tier2_rnd_v1:rnd};
 const sceneNames={PICKUP_SERVICE_EXCEPTION:['未接乘客/接驾异常类','接驾异常','未接乘客'],ORDER_CANCELLATION:['订单取消类','订单取消'],ADDITIONAL_FEE_DISPUTE:['附加费类','附加费争议'],ROUTE_DEVIATION:['绕路/路线异常类','绕路/路线异常'],VERBAL_CONFLICT:['言语冲突类','言语冲突'],DRIVER_ILLEGAL_CHARGE:['费用行为类','费用行为']};
 const excluded=new Set(['source_usefulness','source_useless_reason','handler_name','processing_started_at','processing_completed_at','processing_duration_minutes','ticket_status','source_created_date']);
 const meaningful=value=>value!==undefined&&value!==null&&String(value).trim()!==''&&!/^null$/i.test(String(value).trim());
 // Tenant IDs are text identifiers; keep leading zeroes and match the entire ID.
 function tenantId(value){
  const record=value?.record_snapshot||value?.record||value;
  const candidates=[record?.business_record?.fields,record,value?.raw_record?.business_record?.fields,value?.raw_record];
  for(const source of candidates)for(const key of ['tenant_id','租户id','租户ID','tenantId'])if(meaningful(source?.[key]))return String(source[key]).trim();
  return '';
 }
 function matchesTenant(value,tenant='all'){return tenant==='all'||tenantId(value)===String(tenant).trim();}
 function isRnd(record){return record?.business_record?.import_profile==='tier2_rnd_v1'||record?.import_profile==='tier2_rnd_v1';}
 function schemaFor(record){return isRnd(record)?rnd:schemas[record?.business_record?.kind||record?.scope];}
 function templateSchema(kind,profile){if(profile&&profile!=='standard'){if(kind!=='tier2'||!profiles[profile])throw Error('导入格式与对象不一致');return profiles[profile];}return schemas[kind];}
 function logicalIdentity(record,system){const b=record.business_record,f=b?.fields||{},key={system,external:String(record.source_record_id||f.ticket_id||f.session_id||''),scope:record.scope};return isRnd(record)?{...key,tenant:f.tenant_id,trace:f.trace_id}:key;}
 function evaluationRecord(record){if(!isRnd(record))return record;const fields={...record.business_record.fields};for(const key of excluded)fields[key]='';return {...record,business_record:{...record.business_record,fields}};}
 function modelFields(record){const schema=schemaFor(record);if(!schema)return [];
  return schema.fields.map(([key,label])=>{let role=['ai_process_text','ai_suggested_reply','ai_analysis_conclusion','ai_key_information','ai_responsible_party','ai_cited_policy','ai_core_evidence'].includes(key)?'ai_output':['conversation_text','transcript_text','journey_dialogue_text'].includes(key)?'context':['session_summary','resolution_status','ticket_status','feedback_text','handling_opinion'].includes(key)?'human_context':'metadata';
   if(isRnd(record)){if(!['ai_output','context'].includes(role)&&!['feedback_text','handling_opinion'].includes(key))return null;if(key==='transcript_text')label='电话录音转录（AI当时可读）';if(key==='journey_dialogue_text')label='车内录音转录（AI当时可读）';}
   return {key,label,role,...((record.business_record?.kind||record.scope)==='tier2'&&role==='ai_output'?{presentation:key==='ai_analysis_conclusion'?'primary':'details'}:{})};}).filter(Boolean);
 }
 const has=(x,k)=>Object.prototype.hasOwnProperty.call(x,k);
 function kindOf(row){
  if(!row||typeof row!=='object'||Array.isArray(row))return null;
  const session=has(row,'会话ID')||has(row,'session_id'),ticket=has(row,'工单ID')||has(row,'ticket_id');
  if(session&&ticket)throw Error('同一行不能同时包含会话ID和工单ID，请分别使用一线或二线模板');
  const declared=row.record_template||row.business_record?.kind;
  if(declared&&!schemas[declared])throw Error('业务导入模板仅支持一线会话或二线工单');
  const detected=session?'frontline':ticket?'tier2':null;
  if(declared&&detected&&declared!==detected)throw Error('所选模板与文件中的会话ID / 工单ID不一致');
  return declared||detected;
 }
 function asText(value,label){
  if(value===undefined||value===null)return '';
  if(typeof value==='string')return value;
  if(typeof value==='number'&&Number.isFinite(value))return String(value);
  throw Error(label+'应为文本；完整日志请原样导出为文本');
 }
 function adaptRecord(row){
  const kind=kindOf(row);if(!kind)return row;
  const schema=schemas[kind];if(row.scope&&row.scope!==kind)throw Error('评估对象与所用业务模板不一致');
  const input=row.business_record?.fields||row,fields={};
  const profile=row.business_record?.import_profile||row.import_profile||(kind==='tier2'&&['traceId','trace_id','命中场景','责任结论','租户id'].some(k=>has(input,k))?'tier2_rnd_v1':null);
  if(profile&&(!profiles[profile]||kind!=='tier2'))throw Error('导入格式与评估对象不一致');
  const definitions=profile?[...schema.fields,...rnd.fields]:schema.fields;
  for(const [key,label]of definitions){
   let value=input[key]??input[label];
   const aliases=definitions.filter(([k])=>k===key).map(([,name])=>name);
   const supplied=[key,...new Set(aliases)].filter(k=>meaningful(input[k])).map(k=>asText(input[k],label));
   if(new Set(supplied.map(v=>v.trim())).size>1)throw Error(label+'存在冲突的同义列，请核对');
   if(supplied.length)value=supplied[0];
   if(profile&&['ticket_id','tenant_id','trace_id','order_id'].includes(key)&&[key,...aliases].some(k=>typeof input[k]==='number'&&!Number.isSafeInteger(input[k])))throw Error(label+'超出安全整数范围，请由来源系统按文本导出编号');
   if(key==='skill_name')value=value??input['Skill名称'];
   if(key==='transcript_text')value=value??input['录音转文本']??input['录音文本'];
   fields[key]=asText(value,label);
  }
  const id=fields[schema.id].trim();if(!id)throw Error('请填写'+schema.fields[0][1]);fields[schema.id]=id;
  if(profile)for(const [key,label]of [['trace_id','traceId'],['tenant_id','租户id']])if(!meaningful(fields[key]))throw Error('二线研发导出请提供'+label+'，用于区分调用和租户');
  let hints={};if(profile){const codes=Object.keys(sceneNames).filter(code=>new RegExp('\\b'+code+'\\b').test(fields.source_scene_message));const explicit=meaningful(fields.source_scene_code)?fields.source_scene_code.trim():'';const code=explicit||codes[0]||Object.keys(sceneNames).find(c=>sceneNames[c].includes(fields.intent_scene.trim()))||'';
   hints={source_scene_code:code,source_scene_conflict:codes.length>1||!!explicit&&codes.some(c=>c!==explicit)||!!sceneNames[code]&&meaningful(fields.intent_scene)&&!sceneNames[code].includes(fields.intent_scene.trim())};}
  return {...row,scope:kind,source_record_id:id,name:schema.name+' '+id+(profile?' · '+fields.trace_id:''),scene:meaningful(fields.intent_scene)?fields.intent_scene:'',
   context_id:profile?fields.order_id:id,session_text:fields.conversation_text||fields.transcript_text||'',ai_reply:'',
   evidence:Array.isArray(row.evidence)?row.evidence:[],
   business_record:{schema_version:profile?2:1,kind,...(profile?{import_profile:profile,...hints}:{}),fields}};
 }
 function quality(record){
  const b=record?.business_record;if(!b)return null;
  const schema=schemaFor(record),required=isRnd(record)?new Set(['created_time','intent_scene','order_id','feedback_text','handling_opinion','ai_key_information','ai_responsible_party','ai_analysis_conclusion','ai_cited_policy','ai_core_evidence','journey_dialogue_text','transcript_text']):null,missing=schema.fields.filter(([key])=>(!required||required.has(key))&&!meaningful(b.fields[key])).map(([,label])=>label);
  const optional=new Set(['关联工单']);
  return {kind:b.kind,name:schema.name,missing_fields:missing.filter(x=>!optional.has(x)),
   note:'仅检查字段是否提供；自动评级由模型按确认方案读取原文，不代表材料充分或AI表现合格'};
 }
 function csvTemplate(kind,profile){const schema=templateSchema(kind,profile);if(!schema)throw Error('模板不存在');return '\uFEFF'+schema.fields.map(([,label])=>'"'+label+'"').join(',')+'\r\n';}
 function jsonTemplate(kind,profile){const schema=templateSchema(kind,profile);if(!schema)throw Error('模板不存在');return Object.fromEntries(schema.fields.map(([,label])=>[label,'']));}
 const api={tenantId,matchesTenant,schemas,profiles,sceneNames,isRnd,schemaFor,templateSchema,logicalIdentity,evaluationRecord,modelFields,meaningful,kindOf,adaptRecord,quality,csvTemplate,jsonTemplate};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.BusinessImport=api;
})(typeof globalThis!=='undefined'?globalThis:this);
