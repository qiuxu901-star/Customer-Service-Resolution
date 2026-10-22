'use strict';
const State=require('./public/service-skill-state'),{hash}=require('./monitoring');
const fail=(message,statusCode=400)=>{throw Object.assign(Error(message),{statusCode});};
const text=(value,label)=>typeof value==='string'&&value.trim()?value.trim():fail('请填写'+label);
function createServiceSkills({storage,monitor}){
 const all=()=>storage.list('service_skills');
 const get=id=>all().find(s=>s.id===id&&!s.deleted_at)||fail('客服业务 Skill 不存在或已删除',404);
 const publicOne=s=>State.decorate(all()).find(x=>x.id===s.id);
 function guard(s,b){text(b.actor,'维护人');if(b.base_content_hash!==s.content_hash||b.base_maintenance_revision!==(s.maintenance_revision||0)||(b.base_updated_at||null)!==(s.updated_at||null))fail('业务 Skill 已变更，请刷新后重试',409);}
 function setCurrent(s,actor){for(const x of all().filter(x=>State.available(x)&&State.family(x)===State.family(s)))storage.update('service_skills',x.id,{default_for_diagnosis:x.id===s.id,status_actor:actor,maintenance_revision:(x.maintenance_revision||0)+1});}
 function create(b){text(b.actor,'维护人');return storage.transaction(()=>{const before=State.decorate(all()),s=monitor.importService(b),group=before.filter(x=>State.family(x)===State.family(s)),current=group.find(x=>x.default_for_diagnosis);if(b.use_as_current===true||!group.length&&b.use_as_current!==false)setCurrent(s,text(b.actor,'维护人'));else if(!before.some(x=>x.id===s.id)){storage.update('service_skills',s.id,{default_for_diagnosis:false});if(current)setCurrent(current,b.actor);}return publicOne(s);});}
 function edit(id,b){const old=get(id);guard(old,b);if(b.code!==old.code||b.scope!==old.scope||(b.scene_id||null)!==(old.scene_id||null))fail('编辑时不可更换编码、场景或对象，请新增 Skill');
  const version=text(b.version,'版本'),source=text(b.source,'来源'),raw=typeof b.raw==='string'?b.raw:'';
  if(version!==old.version&&all().some(s=>State.available(s)&&s.id!==id&&State.family(s)===State.family(old)&&s.version===version&&s.content_hash!==hash({raw})))fail('该版本号已存在，请使用新版本号',409);
  return storage.transaction(()=>{const wasCurrent=State.current(all(),old),s=storage.insert('service_skills',{code:old.code,scope:old.scope,scene:old.scene,scene_id:old.scene_id||null,scene_snapshot:old.scene_snapshot||null,version,source,raw,content_hash:hash({raw}),snapshot_revision:Math.max(...all().filter(x=>State.family(x)===State.family(old)).map(x=>x.snapshot_revision||1))+1,based_on_id:old.id,runtime_verified:false,actor:text(b.actor,'维护人'),default_for_diagnosis:false});
   if(b.use_as_current===true||wasCurrent&&b.use_as_current!==false)setCurrent(s,b.actor);else if(wasCurrent)setCurrent(old,b.actor);return publicOne(s);});
 }
 function activate(id,b){const s=get(id);guard(s,b);return storage.transaction(()=>{setCurrent(s,b.actor);return publicOne(s);});}
 function remove(id,b){const s=get(id);guard(s,b);return storage.transaction(()=>{const wasCurrent=State.current(all(),s);if(wasCurrent)for(const x of all().filter(x=>State.available(x)&&State.family(x)===State.family(s)))storage.update('service_skills',x.id,{default_for_diagnosis:false,maintenance_revision:(x.maintenance_revision||0)+1});storage.update('service_skills',id,{deleted_at:new Date().toISOString(),deleted_by:b.actor,default_for_diagnosis:false,maintenance_revision:(s.maintenance_revision||0)+1});return {id,deleted:true,needs_current_selection:wasCurrent&&all().some(x=>State.available(x)&&State.family(x)===State.family(s))};});}
 return {create,edit,activate,remove,list:()=>State.decorate(all())};
}
module.exports={createServiceSkills};
