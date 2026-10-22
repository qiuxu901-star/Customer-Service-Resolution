(function(root){
 'use strict';
 const available=s=>!s.deleted_at;
 const family=s=>JSON.stringify([s.scene_id||s.scene,s.scope,s.code]);
 function current(list,s){
  const group=list.filter(x=>available(x)&&family(x)===family(s));
  const defaults=group.filter(x=>x.default_for_diagnosis===true);
  if(defaults.length===1)return defaults[0].id===s.id;
  // Legacy single versions were already selected automatically. Ambiguous groups stay unselected.
  return defaults.length===0&&group.length===1&&group[0].default_for_diagnosis!==false&&group[0].id===s.id;
 }
 function decorate(list){return list.filter(available).map(s=>({...s,default_for_diagnosis:current(list,s),maintenance_status:current(list,s)?'current':'standby'}));}
 const api={available,family,current,decorate};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.ServiceSkillState=api;
})(typeof globalThis!=='undefined'?globalThis:this);
