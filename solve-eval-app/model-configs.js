'use strict';
const {randomUUID}=require('node:crypto');
const {cacheCapability}=require('./llm-usage');
const fail=(message,statusCode=400)=>{throw Object.assign(Error(message),{statusCode});};
const text=(value,label)=>typeof value==='string'&&value.trim()?value.trim():fail('请填写'+label);
const publicProfile=profile=>{const {api_key,...safe}=profile;return {...safe,api_key_set:!!api_key,cache_capability:cacheCapability(profile.base_url)};};
const snapshot=config=>({profile_id:config.profile_id,profile_name:config.profile_name,profile_version:config.profile_version,base_url:config.base_url,model:config.model,...(config.rating_options?{rating_options:structuredClone(config.rating_options)}:{})});
function ratingOptions(value,models){
  if(!value||typeof value!=='object'||Array.isArray(value))fail('模型评级预算配置无效');
  const result={};
  for(const [model,options]of Object.entries(value)){
    if(!models.includes(model)||!options||typeof options!=='object'||Array.isArray(options))fail('评级预算必须对应当前可用模型');
    const out={};
    for(const key of ['max_input_chars','max_output_tokens'])if(options[key]!==undefined&&options[key]!==null&&options[key]!==''){if(!Number.isSafeInteger(options[key])||options[key]<1||options[key]>10000000)fail('评级预算应为有效正整数');out[key]=options[key];}
    if(options.pricing){const p=options.pricing;if(!['CNY','USD'].includes(p.currency)||['input_per_million','cached_input_per_million','output_per_million'].some(k=>!Number.isFinite(p[k])||p[k]<0))fail('费率需填写币种及三项非负数值');out.pricing={currency:p.currency,input_per_million:p.input_per_million,cached_input_per_million:p.cached_input_per_million,output_per_million:p.output_per_million};}
    result[model]=out;
  }
  return result;
}

function createModelConfigs({storage,fetchImpl=(...args)=>fetch(...args),timeoutMs=15000}){
  // Copy once; subsequent legacy settings remain independent of the new workspace.
  if(!storage.getSetting('model_profiles_migrated',false))storage.transaction(()=>{
    const base_url=storage.getSetting('llm_base_url',''),api_key=storage.getSetting('llm_api_key',''),model=storage.getSetting('llm_model','');
    if(base_url&&api_key&&model){const p=storage.insert('model_profiles',{id:randomUUID(),name:'旧版模型配置',base_url:base_url.replace(/\/+$/,''),api_key,models:[model],version:1});storage.setSetting('model_default',{profile_id:p.id,model});}
    storage.setSetting('model_profiles_migrated',true);
  });
  const get=id=>storage.byId('model_profiles',id)||fail('模型配置已删除或不存在，请重新选择',409);
  function resolve(selection){
    const chosen=selection??storage.getSetting('model_default',null);
    if(!chosen)return {};
    if(!chosen||typeof chosen!=='object'||Array.isArray(chosen))fail('模型选择无效');
    const p=get(chosen.profile_id);
    if(!p.models.includes(chosen.model))fail('所选模型已移除或不存在，请重新选择',409);
    if(!p.api_key)fail('模型服务尚未配置 API Key',409);
    return {base_url:p.base_url,api_key:p.api_key,model:chosen.model,profile_id:p.id,profile_name:p.name,profile_version:p.version,rating_options:structuredClone(p.rating_options?.[chosen.model]||{})};
  }
  function state(){const selection=storage.getSetting('model_default',null);let error=null,config={};try{config=resolve();}catch(e){error=e.message;}return {profiles:storage.list('model_profiles').map(publicProfile),default_selection:selection,configured:!!config.model,default_model:config.model?snapshot(config):null,warning:error||(!config.model?'尚未配置默认 LLM，请前往模型配置添加服务并设置默认模型':null)};}
  function save(body,id){
    const old=id?get(id):null;
    if(old&&body.version!==old.version)fail('配置已更新，请刷新后再保存',409);
    const name=text(body.name,'配置名称'),base_url=text(body.base_url,'Base URL').replace(/\/+$/,'');
    let url;try{url=new URL(base_url);}catch{fail('Base URL 格式无效');}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)fail('Base URL 需为不含账号、查询参数和片段的 HTTP(S) 地址');
    if(!Array.isArray(body.models)||!body.models.length||body.models.some(m=>typeof m!=='string'||!m.trim()))fail('请至少填写一个有效模型名称');
    const models=[...new Set(body.models.map(m=>m.trim()))],api_key=body.api_key===undefined||body.api_key===''?old?.api_key:text(body.api_key,'API Key');
    if(!api_key)fail('请填写 API Key');
    const current=storage.getSetting('model_default',null);
    if(old&&current?.profile_id===id&&!models.includes(current.model))fail('不能移除当前默认模型，请先更改或清除全局默认',409);
    const actor=text(body.actor,'维护人');
    const options=body.rating_options===undefined?Object.fromEntries(Object.entries(old?.rating_options||{}).filter(([model])=>models.includes(model))):body.rating_options;
    const value={name,base_url,api_key,models,rating_options:ratingOptions(options,models),version:(old?.version||0)+1,actor};
    return publicProfile(old?storage.update('model_profiles',id,value):storage.insert('model_profiles',{id:randomUUID(),...value}));
  }
  function setDefault(body){const actor=text(body.actor,'维护人'),selection=body.selection;if(selection!==null&&(!selection||!resolve(selection).model))fail('请选择默认模型');storage.setSetting('model_default',selection===null?null:{profile_id:selection.profile_id,model:selection.model,actor});return state();}
  function remove(id,body){text(body.actor,'维护人');const p=get(id);if(body.version!==p.version)fail('配置已更新，请刷新后再删除',409);return storage.transaction(()=>{storage.remove('model_profiles',id);if(storage.getSetting('model_default',null)?.profile_id===id)storage.setSetting('model_default',null);return state();});}
  async function call(config,path,body){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      const response=await fetchImpl(config.base_url+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+config.api_key,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:controller.signal,redirect:'error'});
      if(!response.ok){const reason=({401:'鉴权失败，请检查 API Key',403:'没有访问权限',404:'接口或模型不存在，请检查地址和模型',429:'请求受限，请稍后重试'})[response.status]||'模型服务请求失败';fail(reason+'（HTTP '+response.status+'）',502);}
      try{return await response.json();}catch{fail('模型服务未返回有效 JSON',502);}
    }catch(e){if(e.statusCode)throw e;fail(controller.signal.aborted?'模型连接超时，请检查服务地址':'无法连接模型服务，请检查地址和网络',502);}finally{clearTimeout(timer);}
  }
  async function test(body){const config=resolve(body.selection);if(!config.model)fail('尚未配置默认 LLM，请先配置或选择模型',409);const started=Date.now();const result=await call(config,'/chat/completions',{model:config.model,messages:[{role:'user',content:'Reply with OK.'}],max_tokens:8});if(typeof result.choices?.[0]?.message?.content!=='string'||!result.choices[0].message.content.trim())fail('模型未返回有效回复',502);return {ok:true,model_snapshot:snapshot(config),elapsed_ms:Date.now()-started};}
  async function discover(id){const p=get(id),result=await call(p,'/models');if(!Array.isArray(result.data))fail('服务未返回有效模型列表，请手动填写模型名称',502);return {models:[...new Set(result.data.filter(m=>typeof m.id==='string'&&m.id.trim()).map(m=>m.id))].sort()};}
  return {state,save,setDefault,remove,resolve,test,discover};
}
module.exports={createModelConfigs,snapshot};
