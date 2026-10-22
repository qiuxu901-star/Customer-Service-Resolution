(function(root){
 'use strict';
 const Definitions=typeof module!=='undefined'&&module.exports?require('./skill-definitions'):root.SkillDefinitions;
 const State=typeof module!=='undefined'&&module.exports?require('./service-skill-state'):root.ServiceSkillState;
 const compatible=(s,r)=>s.scope===r.scope&&(s.scene_id&&r.scene_id?s.scene_id===r.scene_id:s.scene===r.scene);
 function detect(record,services){
  services=services.filter(State.available);
  const fields=record?.business_record?.fields||record||{},message=String(fields.source_scene_message??fields.msg??record?.msg??'').trim();
  if(!message)return {status:'missing',code:null,source:'manual',reason:'未提供 msg，请选择客服业务 Skill'};
  const tokens=[...new Set(message.match(/[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+/g)||[])];
  // Maintenance codes are authoritative; do not keep a second hardcoded catalogue.
  const known=[...new Set(services.filter(s=>s.scope===record.scope&&new RegExp('(^|[^A-Za-z0-9_])'+s.code.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?=$|[^A-Za-z0-9_])').test(message)).map(s=>s.code))];
  const codes=[...new Set([...known,...tokens])];
  if(codes.length!==1)return {status:'unresolved',code:null,source:'msg',reason:codes.length?'msg 包含多个编码，请确认客服业务 Skill':'msg 未识别出业务 Skill 编码，请手动选择'};
  const code=codes[0],matches=services.filter(s=>s.scope===record.scope&&s.code===code),scenes=[...new Set(matches.map(s=>s.scene_id||s.scene))];
  return {status:!matches.length?'unmatched':scenes.length>1?'conflict':'matched',code,source:'msg',scene_id:scenes.length===1?matches[0].scene_id:null,scene:scenes.length===1?matches[0].scene:null,reason:!matches.length?'编码 '+code+' 尚未登记客服业务 Skill':scenes.length>1?'同编码对应多个业务场景，请确认':''};
 }
 function resolve(record,services,saved){
  services=State.decorate(services);
  const found=saved?.code?{...saved}:detect(record,services),matches=services.filter(s=>s.code===found.code&&compatible(s,record));
  if(!found.code)return found;
  if(!matches.length)return {...found,status:'conflict',reason:'关联的客服业务 Skill 不存在或与当前场景、对象不一致',selection:null};
  let service=saved?.service_id?matches.find(s=>s.id===saved.service_id):null;
  if(saved?.service_id&&!service)return {...found,status:'conflict',reason:'已保存的 Skill 版本不可用，请重新选择',selection:null};
  if(!service){const defaults=matches.filter(s=>s.default_for_diagnosis===true);service=defaults.length===1?defaults[0]:null;}
  if(!service)return {...found,status:'needs_version',reason:'已匹配 '+found.code+'，请选择一次诊断版本',selection:null};
  const binding=saved?.service_id===service.id?saved:null,parsed=Definitions.selection(service,binding);
  if(binding?.content_hash&&binding.content_hash!==service.content_hash)return {...found,status:'needs_version',reason:'已保存版本正文发生变化，请重新确认',selection:null};
  return {...found,status:parsed.needs_confirmation?'needs_definition':'ready',reason:parsed.needs_confirmation?'请确认适用的完整内部定义':'',service_id:service.id,version:service.version,content_hash:service.content_hash,selection:parsed.needs_confirmation?null:{id:service.id,content_hash:service.content_hash,modules:parsed.selected.map(m=>m.key)}};
 }
 const api={detect,resolve,compatible};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.ServiceSkillLink=api;
})(typeof globalThis!=='undefined'?globalThis:this);
