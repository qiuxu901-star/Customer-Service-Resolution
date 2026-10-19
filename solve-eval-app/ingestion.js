'use strict';
const {hash}=require('./monitoring');
const {BASIC_ID,basicBinding}=require('./basic-evaluation');
const {adaptRecord,quality}=require('./public/business-import');
const clone=x=>structuredClone(x),fail=(s,c=400)=>{const e=Error(s);e.statusCode=c;throw e;};
const ROUTE_LABELS={ready:'已识别方案，待确认',missing_scene:'场景未填写',unknown_scene:'场景未匹配',ambiguous_scene:'场景名称有歧义',scene_conflict:'场景字段不一致',scene_archived:'场景已停用',scope_incompatible:'场景与对象不相容',no_plan:'未配置可用方案',multiple_plans:'待选择监测方案',invalid_plan:'所选方案不可用',invalid_record:'数据格式错误'};
function createIngestion({storage,monitor,scenes,clock=()=>new Date()}){
 const get=(c,id)=>storage.byId(c,id)||fail('记录不存在',404);
 function plans(sceneId,scope){const found=new Map();for(const p of storage.list('monitor_plans')){try{const binding=scenes.binding(p.current_revision_id,sceneId,[scope]);found.set(p.id,binding);}catch{}}return [...found.values()];}
 function route(row,override={}){
  const result={status:'missing_scene',reason:'导入文件没有填写场景，请补充',scope:row?.scope||null,scene_id:null,scene_snapshot:null,monitor_binding:null,choices:[],source:override.scene_id?'manual_selection':'import_field'};
  if(!row||typeof row!=='object'||Array.isArray(row))return {...result,status:'invalid_record',reason:'记录必须是对象'};
  try{row=adaptRecord(row);monitor.normalizeRecord({...row,scene:row.scene||'待确认场景'});Object.assign(result,{scope:row.scope,name:row.name,declared_scene:row.scene||row.scene_code||'',material_quality:quality(row)});}catch(e){return {...result,status:'invalid_record',reason:e.message};}
  const sid=override.scene_id||row.scene_id,code=String(row.scene_code||'').trim(),name=String(row.scene||'').trim();
  let matches=sid?storage.list('business_scenes').filter(s=>s.id===sid):code?storage.list('business_scenes').filter(s=>s.code===code):name?storage.list('business_scenes').filter(s=>s.name===name):[];
  if(!sid&&!code&&!name)return result;
  if(!matches.length)return {...result,status:'unknown_scene',reason:'填写的场景未在业务场景中找到，请选择或先维护场景'};
  if(matches.length>1)return {...result,status:'ambiguous_scene',reason:'存在同名场景，请填写稳定编码或人工选择'};
  const scene=matches[0];Object.assign(result,{scene_id:scene.id,scene_snapshot:{id:scene.id,code:scene.code,name:scene.name,version:scene.version}});
  if(!override.scene_id&&((code&&code!==scene.code)||(name&&name!==scene.name)))return {...result,status:'scene_conflict',reason:'场景编码、ID与名称不一致，请核对'};
  if(scene.status!=='active')return {...result,status:'scene_archived',reason:'该场景已停用，需业务确认其他归属'};
  if(!scene.scopes.includes(row.scope))return {...result,status:'scope_incompatible',reason:'该场景不适用于此评估对象'};
  const available=plans(scene.id,row.scope);result.choices=available.map(b=>({candidate_id:b.selection_id||b.candidate_id,plan_id:b.plan_id,name:b.definition.name,revision_id:b.revision_id}));
  const selected=override.candidate_id||row.candidate_id;
  if(selected===BASIC_ID||(!selected&&!available.length))return {...result,status:'ready',reason:'暂无专属方案，先做基础分析；分析后可生成场景检查方案',evaluation_mode:'basic',monitor_binding:basicBinding(scene,row.scope)};
  let binding;if(selected){try{binding=scenes.binding(selected,scene.id,[row.scope]);}catch(e){return {...result,status:'invalid_plan',reason:e.message};}}
  else if(available.length===1)binding=available[0];
  else return {...result,status:available.length?'multiple_plans':'no_plan',reason:available.length?'同场景存在多套可用方案，请明确选择':'当前场景与对象尚无已确认文档，请补充方案或确认当前文档版本'};
  return {...result,status:'ready',reason:'已识别监测方案，等待整批确认',monitor_binding:binding};
 }
 function validateBody(body){if(!Array.isArray(body.records)||!body.records.length||body.records.length>2000)fail('每批应包含1至2000条记录');if(!body.actor?.trim())fail('请填写导入人');if(!['file','sync','manual'].includes(body.source_kind||'file'))fail('来源类型无效');if(!body.source_name?.trim())fail('请填写来源名称');}
 function overrideAt(body,index){const explicit=body.routing_overrides?.[index+1];if(explicit)return explicit;return {scene_id:body.scene_id||undefined,candidate_id:body.candidate_id||undefined};}
 function preview(body){validateBody(body);const rows=body.records.map((row,index)=>({row_number:index+1,name:row?.name||'第'+(index+1)+'条',declared_scene:row?.scene||row?.scene_code||'',...route(row,overrideAt(body,index))}));const counts={total:rows.length,ready:rows.filter(r=>r.status==='ready').length,invalid:rows.filter(r=>r.status==='invalid_record').length,pending:rows.filter(r=>!['ready','invalid_record'].includes(r.status)).length};return {rows,counts,routing_hash:hash(rows),labels:ROUTE_LABELS};}
 function allocateName(actor,actorKey){const d=clock(),parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d).map(p=>[p.type,p.value]));const day=parts.year+'-'+parts.month+'-'+parts.day,key=hash({actor:actorKey||actor,day});const c=storage.byId('monitor_import_counters',key);const sequence=(c?.last_sequence||0)+1;if(c)storage.update('monitor_import_counters',key,{last_sequence:sequence});else storage.insert('monitor_import_counters',{id:key,actor_key:actorKey||actor,day,last_sequence:sequence});return {name:actor+parts.month+parts.day+String(sequence).padStart(3,'0'),import_day:day,day_sequence:sequence,naming_version:1};}
 function importBatch(body){validateBody(body);if(!body.request_id?.trim())fail('请填写导入请求编号');const fingerprint=hash({records:body.records,source_kind:body.source_kind||'file',source_name:body.source_name,source_system:body.source_system,scene_id:body.scene_id,candidate_id:body.candidate_id,routing_overrides:body.routing_overrides,actor:body.actor});const old=storage.find('monitor_batches',b=>b.request_id===body.request_id);if(old){if(old.request_hash!==fingerprint)fail('同一请求编号内容不同',409);return clone(old);}
  const checked=preview(body);if(body.preview_hash&&body.preview_hash!==checked.routing_hash)fail('预览后场景或方案已变化，请重新预览后导入',409);
  return storage.transaction(()=>{
   const b=storage.insert('monitor_batches',{...allocateName(body.actor,body.actor_key),schema_version:3,source_kind:body.source_kind||'file',source_name:body.source_name,source_system:body.source_system||body.source_name,note:String(body.note||''),actor:body.actor,request_id:body.request_id,request_hash:fingerprint,scene_id:null,scene_snapshot:null,monitor_binding:null,origin_time_known:true,synced_at:body.source_kind==='sync'?clock().toISOString():null,status:'imported',submitted_count:body.records.length,imported_count:0,duplicate_count:0,updated_count:0,error_count:0,pending_routing_count:checked.counts.pending});
   const counters={imported_count:0,duplicate_count:0,updated_count:0,error_count:0};
   for(const [index,raw]of body.records.entries()){
    const r=checked.rows[index];if(r.status==='invalid_record'){storage.insert('monitor_batch_items',{batch_id:b.id,row_number:index+1,case_id:null,raw_record:clone(raw),ingestion_status:'failed',error:r.reason});counters.error_count++;continue;}
    const row=adaptRecord(raw);
    const external=String(row.source_record_id||body.request_id+':'+(index+1)),logical=hash({system:b.source_system,external,scope:row.scope});
    const input={...row,scene:r.scene_snapshot?.name||row.scene||'待确认场景',scene_id:r.scene_id,scene_snapshot:r.scene_snapshot};
    const previous=storage.list('monitor_batch_items').filter(i=>i.logical_key===logical&&i.case_id).at(-1);const normalized=monitor.normalizeRecord(input),digest=hash(normalized);const sample=previous?.record_hash===digest?get('monitor_cases',previous.case_id):monitor.addCase({...input,actor:body.actor,source_record_id:'multi:'+logical+':'+digest});
    const state=previous?(previous.case_id===sample.id?'duplicate':'updated'):'new';
    const item=storage.insert('monitor_batch_items',{batch_id:b.id,row_number:index+1,case_id:sample.id,logical_key:logical,source_record_id:external,identity_quality:row.source_record_id?'source_id':'batch_row_only',raw_record:clone(raw),record_snapshot:clone(sample.record),record_hash:sample.content_hash,assessment:row.assessment?clone(row.assessment):null,ingestion_status:state});
    const routing=storage.insert('monitor_item_routes',{item_id:item.id,case_id:sample.id,number:1,...r,effective_record:clone(sample.record),record_hash:sample.content_hash,actor:body.actor});storage.update('monitor_batch_items',item.id,{current_route_id:routing.id});counters.imported_count++;if(state==='duplicate')counters.duplicate_count++;if(state==='updated')counters.updated_count++;
   }
   return clone(storage.update('monitor_batches',b.id,{...counters,status:counters.error_count?'partial':'imported'}));
  });
 }
 function resolveItem(id,body){const item=get('monitor_batch_items',id);if(!item.case_id)fail('此行为导入失败，请修正源文件后重新导入');if(!body.actor?.trim())fail('请填写确认人');const previous=item.current_route_id?get('monitor_item_routes',item.current_route_id):null;if((body.base_route_id||null)!==(previous?.id||null))fail('该记录的场景或方案已更新，请刷新',409);const r=route(item.raw_record||item.record_snapshot,body);if(r.status!=='ready')fail(r.reason);return storage.transaction(()=>{const effective={...clone(item.record_snapshot),scene:r.scene_snapshot.name,scene_id:r.scene_id,scene_snapshot:r.scene_snapshot};const value=storage.insert('monitor_item_routes',{item_id:id,case_id:item.case_id,number:(previous?.number||0)+1,...r,effective_record:effective,record_hash:hash(effective),actor:body.actor});storage.update('monitor_batch_items',id,{current_route_id:value.id});const items=storage.list('monitor_batch_items').filter(i=>i.batch_id===item.batch_id&&i.current_route_id);const pending=items.filter(i=>storage.byId('monitor_item_routes',i.current_route_id)?.status!=='ready').length;storage.update('monitor_batches',item.batch_id,{pending_routing_count:pending,routing_confirmation_id:null});return clone(value);});}
 const confirmation=require('./batch-confirmation').createBatchConfirmation({storage,scenes,plans,route,resolveItem,clock});
 return {preview,importBatch,resolveItem,...confirmation,bootstrap:()=>({item_routes:storage.list('monitor_item_routes'),routing_labels:ROUTE_LABELS})};
}
module.exports={createIngestion,ROUTE_LABELS};
