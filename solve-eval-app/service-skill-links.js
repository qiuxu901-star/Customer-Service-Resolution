'use strict';
const Links=require('./public/service-skill-link'),{selectSkill}=require('./skill-context');
const fail=(m,c=400)=>{throw Object.assign(Error(m),{statusCode:c});};
function createServiceSkillLinks({storage}){
 const services=()=>storage.list('service_skills');
 function recordFor(item){return storage.byId('monitor_item_routes',item.current_route_id)?.effective_record||item.record_snapshot;}
 function state(item){const record=recordFor(item);return record?Links.resolve(record,services(),item.skill_binding):{status:'missing',reason:'没有有效工单材料'};}
 function bind(body){
  if(!body.actor?.trim())fail('请填写维护人');
  if(!Array.isArray(body.item_ids)||!body.item_ids.length||body.item_ids.length>2000||new Set(body.item_ids).size!==body.item_ids.length)fail('请选择不重复的工单');
  const s=storage.byId('service_skills',body.selection?.id);if(!s||s.deleted_at)fail('客服业务 Skill 不存在或已删除',404);
  const selection=body.selection;if(selection.content_hash!==s.content_hash)fail('Skill 版本已变化，请刷新后选择',409);
  const parsed=selectSkill(s,selection);if(parsed.needs_confirmation)fail(parsed.reason);
  const items=body.item_ids.map(id=>storage.byId('monitor_batch_items',id)||fail('工单不存在',404));
  if(items.some(i=>!recordFor(i)||!Links.compatible(s,recordFor(i))))fail('只能关联同场景、同对象的客服业务 Skill');
  return storage.transaction(()=>({items:items.map(i=>{
   if(body.only_missing&&['ready','needs_version','needs_definition'].includes(state(i).status))return {id:i.id,skipped:true};
   const binding={code:s.code,service_id:s.id,content_hash:s.content_hash,modules:parsed.selected.map(m=>m.key),source:'manual',actor:body.actor,confirmed_at:new Date().toISOString()};
   storage.update('monitor_batch_items',i.id,{skill_binding:binding});return {id:i.id,skill_binding:binding};
  })}));
 }
 return {state,bind,recordFor,bootstrap:()=>storage.list('monitor_batch_items').filter(i=>i.record_snapshot).map(i=>({item_id:i.id,...state(i)}))};
}
module.exports={createServiceSkillLinks};
