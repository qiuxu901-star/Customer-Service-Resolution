'use strict';
const {createHash}=require('node:crypto');
const Definitions=require('./public/skill-definitions');
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const cache=new Map();
function selectSkill(skill,binding){
  const content_hash=digest({raw:skill?.raw||''});
  const key=digest({content_hash,binding,code:skill?.code});
  if(cache.has(key))return structuredClone(cache.get(key));
  const result=Definitions.selection(skill,binding);
  if(binding?.content_hash&&binding.content_hash!==content_hash){result.needs_confirmation=true;result.reason='Skill 正文版本已变化，请重新确认定义';result.selected=[];}
  if(!result.needs_confirmation&&binding?.modules?.some(p=>typeof p==='object'&&p.content_hash&&p.content_hash!==digest({text:result.selected.find(m=>m.key===p.key)?.text}))){result.needs_confirmation=true;result.reason='Skill 定义摘要不一致，请重新确认';result.selected=[];}
  const value={...result,content_hash,selected:result.selected.map(m=>({...m,content_hash:digest({text:m.text})}))};
  if(cache.size>=128)cache.delete(cache.keys().next().value);
  cache.set(key,value);return structuredClone(value);
}
function planSkills(definition,getService,scope){
  return [...new Set((definition.service_refs||[]).map(ref=>typeof ref==='string'?ref:ref?.id).filter(Boolean))].flatMap(id=>{
    const skill=getService(id);
    if(skill&&definition.scope==='linked'&&scope&&skill.scope!==scope)return [];
    const binding=(definition.service_bindings||[]).find(b=>b.id===id),result=selectSkill(skill,binding);
    const compatible=skill&&(!scope||skill.scope===scope)&&(definition.scene_id&&skill.scene_id?definition.scene_id===skill.scene_id:!definition.scene||definition.scene===skill.scene);
    const expected=(definition.service_refs||[]).find(ref=>typeof ref==='object'&&ref.id===id)?.content_hash;
    const issue=!skill?'关联 Skill 版本不存在':!compatible?'Skill 场景或评估对象不相容':skill.content_hash&&skill.content_hash!==result.content_hash||expected&&expected!==result.content_hash?'Skill 正文摘要不一致':result.needs_confirmation?result.reason:null;
    return [{id,code:skill?.code||id,version:skill?.version||null,scope:skill?.scope||null,content_hash:result.content_hash,ready:!issue,reason:issue,modules:result.selected.map(m=>({key:m.key,id:m.id,type:m.type,content_hash:m.content_hash,chars:m.text.length}))}];
  });
}
module.exports={selectSkill,planSkills};
