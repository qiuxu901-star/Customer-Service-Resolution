'use strict';
const {createHash}=require('node:crypto');
const Capability=require('./evaluation-capability');
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(message,statusCode=400)=>{throw Object.assign(Error(message),{statusCode});};
const BUILTIN_VERSION='2026-10-22.3';
const DEFAULT_DOCUMENT=require('node:fs').readFileSync(require('node:path').join(__dirname,'skills/customer-performance-evaluation/public-standard.md'),'utf8').trim();

function createEvaluatorSkill({storage}){
  const state=()=>storage.getSetting('evaluator_skill_state',null);
  if(!state())storage.transaction(()=>{
    const r=storage.insert('evaluator_skill_revisions',{name:'客服 AI 评估员',number:1,document:DEFAULT_DOCUMENT,content_hash:hash({document:DEFAULT_DOCUMENT}),note:'按具体帮助、证据及人工剩余工作初始化公共评估标准',actor:'系统初始化',confirmed_at:new Date().toISOString(),confirmed_by:'系统初始化'});
    storage.setSetting('evaluator_skill_state',{active_revision_id:r.id,head_revision_id:r.id});
  });
  const get=id=>storage.byId('evaluator_skill_revisions',id)||fail('评估员 Skill 版本不存在',404);
  const actor=body=>{if(typeof body.actor!=='string'||!body.actor.trim())fail('请填写业务维护人');return body.actor.trim();};
  function configuration(id=state().active_revision_id){const r=get(id),value=Capability.configurationOf(r);if(r.capability_hash&&Capability.hash(value)!==r.capability_hash)fail('评估流程配置摘要不一致',409);return value;}
  function resolve(record,binding,id=state().active_revision_id){return Capability.resolveFlow(configuration(id),{scene_id:record.scene_id,scope:record.scope,binding},snapshot(id));}
  function snapshot(id=state().active_revision_id){const r=get(id);if(hash({document:r.document})!==r.content_hash)fail('评估员 Skill 正文摘要不一致',409);return structuredClone({id:r.id,name:r.name,number:r.number,version:'v'+r.number,document:r.document,content_hash:r.content_hash,decision_contract:1});}
  function save(body){
    const owner=actor(body),s=state();if(body.base_revision_id!==s.head_revision_id)fail('评估员 Skill 已有新版本，请刷新后核对再保存',409);
    if(typeof body.document!=='string'||!body.document.trim())fail('请填写评估员 Skill 正文');
    if(body.document.length>100000)fail('正文不能超过 100000 字符');
    if(typeof body.note!=='string'||!body.note.trim()||body.note.length>500)fail('请填写 1 至 500 字的修改说明');
    const document=body.document,capability=Capability.normalizeConfiguration(body.capability===undefined?configuration(s.head_revision_id):body.capability,{storage});
    return storage.transaction(()=>{const r=storage.insert('evaluator_skill_revisions',{name:'客服 AI 评估员',number:Math.max(...storage.list('evaluator_skill_revisions').map(r=>r.number))+1,document,capability,capability_hash:Capability.hash(capability),content_hash:hash({document}),note:body.note.trim(),actor:owner,parent_revision_id:s.head_revision_id,restored_from:body.restored_from?(get(body.restored_from).id):null});storage.setSetting('evaluator_skill_state',{...s,head_revision_id:r.id});return structuredClone(r);});
  }
  function activate(id,body){
    const owner=actor(body),s=state(),r=get(id);
    if(id!==s.head_revision_id||body.expected_active_revision_id!==s.active_revision_id)fail('版本状态已变化，请刷新后重新核对生效范围',409);
    Capability.normalizeConfiguration(configuration(id),{storage});
    if(s.active_revision_id===id)return structuredClone(r);
    return storage.transaction(()=>{storage.update('evaluator_skill_revisions',id,{confirmed_at:new Date().toISOString(),confirmed_by:owner});storage.setSetting('evaluator_skill_state',{...s,active_revision_id:id});return structuredClone(get(id));});
  }
  function bootstrap(){const s=state();return {...s,capability_defaults:Capability.configurationOf(),capability_catalog:Capability.catalog(storage),built_in:{name:'客服 AI 评估员 Skill（系统内置完整版）',version:BUILTIN_VERSION,document:DEFAULT_DOCUMENT,content_hash:hash({document:DEFAULT_DOCUMENT})},revisions:structuredClone(storage.list('evaluator_skill_revisions')).map(r=>({...r,capability:configuration(r.id),capability_hash:Capability.hash(configuration(r.id)),status:r.id===s.active_revision_id?'active':r.confirmed_at?'historical':'draft'})),trials:structuredClone(storage.list('evaluator_skill_trials'))};}
  return {snapshot,configuration,resolve,save,activate,bootstrap};
}
module.exports={createEvaluatorSkill,DEFAULT_DOCUMENT,BUILTIN_VERSION};
