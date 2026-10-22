'use strict';
const {hash}=require('./monitoring');
const {basicBinding}=require('./basic-evaluation');
const {planSkills}=require('./skill-context');
const {evaluationRecord}=require('./public/business-import');
const Capability=require('./evaluation-capability');
const clone=x=>structuredClone(x);
const fail=(message,statusCode=409)=>{throw Object.assign(Error(message),{statusCode});};

// Recognition and business confirmation are separate. Confirmation always covers
// all imported valid rows, including duplicates and rows hidden by UI filters.
function createBatchConfirmation({storage,scenes,plans,route,resolveItem,evaluatorSkill,clock=()=>new Date()}){
  const get=(collection,id)=>storage.byId(collection,id)||fail('记录不存在',404);
  const batchItems=id=>storage.list('monitor_batch_items').filter(i=>i.batch_id===id&&i.case_id);
  function routeHash(items){return hash(items.map(item=>({id:item.id,case_id:item.case_id,record_hash:item.record_hash,route:item.current_route_id?get('monitor_item_routes',item.current_route_id):null})));}
  function review(id){
    const batch=get('monitor_batches',id),items=batchItems(id),route_hash=routeHash(items);
    const previous=batch.routing_confirmation_id?storage.byId('monitor_batch_confirmations',batch.routing_confirmation_id):null;
    const capability_hash=Capability.hash(evaluatorSkill?.configuration()||Capability.DEFAULT_CONFIGURATION);
    const confirmed=!!items.length&&previous?.route_hash===route_hash&&(previous.capability_hash===capability_hash||!previous.capability_hash&&capability_hash===Capability.hash(Capability.DEFAULT_CONFIGURATION));
    const groups=new Map();
    for(const item of items){
      const r=item.current_route_id?get('monitor_item_routes',item.current_route_id):null,record=r?.effective_record||item.record_snapshot;
      const declared=r?.declared_scene??record.business_record?.fields.intent_scene??record.scene??'';
      const scene_id=r?.scene_id||record.scene_id||null,scope=record.scope,key=hash({scene_id,declared_scene:scene_id?null:declared,scope});
      let status=r?.status||'missing_scene',reason=r?.reason||'历史记录尚未确认场景与监测方案';
      const skills=r?.monitor_binding?planSkills(r.monitor_binding.definition,id=>storage.byId('service_skills',id),scope):[];
      if(!confirmed&&status==='ready'){
        try{const scene=storage.byId('business_scenes',scene_id);if(!scene||scene.status!=='active'||!scene.scopes.includes(scope))fail('场景已变更或停用，请重新匹配');const current=r.monitor_binding.kind==='basic_evaluation'?basicBinding(scene,scope):scenes.binding(r.monitor_binding.selection_id||r.monitor_binding.candidate_id,scene_id,[scope]);if((current.document_hash||current.candidate_hash)!==(r.monitor_binding.document_hash||r.monitor_binding.candidate_hash)||hash(current.definition)!==hash(r.monitor_binding.definition))fail('监测方案版本已变化，请重新匹配');}
        catch(e){status='invalid_plan';reason=e.message;}
      }
      if(!groups.has(key))groups.set(key,{key,scene_id,scope,scene_name:r?.scene_snapshot?.name||record.scene_snapshot?.name||declared||'场景未填写',declared_scene:declared,item_ids:[],count:0,choices:scene_id?plans(scene_id,scope).map(b=>({candidate_id:b.selection_id||b.candidate_id,plan_id:b.plan_id,name:b.definition.name,revision_id:b.revision_id})):[],bindings:[],pending_count:0,reasons:[],service_skills:skills});
      const group=groups.get(key);group.count++;
      if(status==='ready'&&r?.monitor_binding&&evaluatorSkill){try{group.evaluation_flow=evaluatorSkill.resolve(record,r.monitor_binding);}catch(e){status='invalid_plan';reason=e.message;}}group.item_ids.push(item.id);
      if(status!=='ready'||!r?.monitor_binding){group.pending_count++;if(!group.reasons.includes(reason))group.reasons.push(reason);}
      if(r?.monitor_binding&&!group.bindings.some(b=>(b.selection_id||b.candidate_id)===(r.monitor_binding.selection_id||r.monitor_binding.candidate_id)))group.bindings.push(clone(r.monitor_binding));
    }
    const rows=[...groups.values()].map(group=>{const selected=group.bindings.length===1?group.bindings[0]:null;return {...group,selected_candidate_id:selected?.selection_id||selected?.candidate_id||null,selected_binding:selected,ready:group.pending_count===0&&group.bindings.length===1,reason:group.pending_count?group.reasons.join('；'):group.bindings.length>1?'同一场景与对象存在不同方案，请统一选择本组方案':'已识别方案，等待整批确认'};});
    const all=storage.list('monitor_batch_items').filter(i=>i.batch_id===id),pending=rows.filter(g=>!g.ready);
    return {batch_id:id,route_hash,capability_hash,review_hash:hash({route_hash,groups:rows}),confirmed:confirmed&&!pending.length,can_confirm:!!items.length&&!pending.length,valid_count:items.length,import_failed_count:all.length-items.length,group_count:rows.length,pending_group_count:pending.length,groups:rows,confirmation_id:confirmed&&!pending.length?previous.id:null,confirmed_by:confirmed?previous.actor:null,confirmed_at:confirmed?previous.created_at:null};
  }
  function checkReview(id,body){const state=review(id);if(!body.actor?.trim())fail('请填写确认人',400);if(!body.review_hash||body.review_hash!==state.review_hash)fail('本批场景或方案已变化，请刷新后重新核对');return state;}
  function resolveGroup(id,body){
    const state=checkReview(id,body),group=state.groups.find(g=>g.key===body.group_key);if(!group)fail('确认分组已变化，请刷新');
    if(!body.scene_id||!body.candidate_id)fail('请选择明确的场景和监测方案',400);
    return storage.transaction(()=>{for(const itemId of group.item_ids){const item=get('monitor_batch_items',itemId);resolveItem(itemId,{base_route_id:item.current_route_id||null,scene_id:body.scene_id,candidate_id:body.candidate_id,actor:body.actor});}return review(id);});
  }
  function refreshRoutes(id,body){
    checkReview(id,body);
    return storage.transaction(()=>{
      for(const item of batchItems(id)){
        const old=item.current_route_id?get('monitor_item_routes',item.current_route_id):null;
        const next=route(item.raw_record||item.record_snapshot,{scene_id:old?.scene_id||undefined,candidate_id:old?.monitor_binding?.selection_id||old?.monitor_binding?.candidate_id||undefined});
        if(old)next.source=old.source;
        const effective={...clone(item.record_snapshot),scene:next.scene_snapshot?.name||item.record_snapshot.scene,scene_id:next.scene_id,scene_snapshot:next.scene_snapshot};
        const value={...next,effective_record:effective,record_hash:hash(evaluationRecord(effective))};
        const comparable=old?Object.fromEntries(Object.keys(value).map(k=>[k,old[k]])):null;
        if(hash(comparable)===hash(value))continue;
        const r=storage.insert('monitor_item_routes',{item_id:item.id,case_id:item.case_id,number:(old?.number||0)+1,...value,actor:body.actor});
        storage.update('monitor_batch_items',item.id,{current_route_id:r.id});
        storage.update('monitor_batches',id,{routing_confirmation_id:null});
      }
      const state=review(id);storage.update('monitor_batches',id,{pending_routing_count:state.groups.reduce((n,g)=>n+g.pending_count,0)});return state;
    });
  }
  function confirm(id,body){
    const state=checkReview(id,body);
    if(body.confirmed!==true)fail('请明确确认已核对本批全部场景与监测方案',400);
    if(!state.can_confirm)fail('本批仍有场景或监测方案待处理，全部确认后才能开始评级');
    const keys=body.group_keys;
    if(!Array.isArray(keys)||keys.length!==state.groups.length||new Set(keys).size!==keys.length||state.groups.some(g=>!keys.includes(g.key)))fail('必须核对并确认本批全部分组，不能只确认筛选后的部分');
    if(state.confirmed)return clone(get('monitor_batch_confirmations',state.confirmation_id));
    return storage.transaction(()=>{const confirmation=storage.insert('monitor_batch_confirmations',{batch_id:id,route_hash:state.route_hash,capability_hash:state.capability_hash,review_hash:state.review_hash,actor:body.actor.trim(),created_at:clock().toISOString(),valid_count:state.valid_count,groups:clone(state.groups),item_routes:batchItems(id).map(i=>({item_id:i.id,route_id:i.current_route_id,record_hash:get('monitor_item_routes',i.current_route_id).record_hash}))});storage.update('monitor_batches',id,{routing_confirmation_id:confirmation.id});return clone(confirmation);});
  }
  function assertConfirmed(id){const state=review(id);if(!state.confirmed)fail('本批监测方案尚未整批确认，请先处理全部场景与方案并确认后再开始评级');return state;}
  return {review,resolveGroup,refreshRoutes,confirm,assertConfirmed};
}
module.exports={createBatchConfirmation};
