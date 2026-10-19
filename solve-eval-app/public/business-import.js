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
  for(const [key,label]of schema.fields){
   let value=input[key]??input[label];
   if(key==='skill_name')value=value??input['Skill名称'];
   if(key==='transcript_text')value=value??input['录音转文本']??input['录音文本'];
   fields[key]=asText(value,label);
  }
  const id=fields[schema.id].trim();if(!id)throw Error('请填写'+schema.fields[0][1]);fields[schema.id]=id;
  return {...row,scope:kind,source_record_id:id,name:schema.name+' '+id,scene:fields.intent_scene,
   context_id:id,session_text:fields.conversation_text||fields.transcript_text||'',ai_reply:'',
   evidence:Array.isArray(row.evidence)?row.evidence:[],
   business_record:{schema_version:1,kind,fields}};
 }
 function quality(record){
  const b=record?.business_record;if(!b)return null;
  const schema=schemas[b.kind],missing=schema.fields.filter(([key])=>!String(b.fields[key]||'').trim()).map(([,label])=>label);
  const optional=new Set(['关联工单']);
  return {kind:b.kind,name:schema.name,missing_fields:missing.filter(x=>!optional.has(x)),
   note:'仅检查字段是否提供；自动评级由模型按确认方案读取原文，不代表材料充分或AI表现合格'};
 }
 function csvTemplate(kind){const schema=schemas[kind];if(!schema)throw Error('模板不存在');return '\uFEFF'+schema.fields.map(([,label])=>'"'+label+'"').join(',')+'\r\n';}
 function jsonTemplate(kind){const schema=schemas[kind];if(!schema)throw Error('模板不存在');return Object.fromEntries(schema.fields.map(([,label])=>[label,'']));}
 const api={schemas,kindOf,adaptRecord,quality,csvTemplate,jsonTemplate};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.BusinessImport=api;
})(typeof globalThis!=='undefined'?globalThis:this);
