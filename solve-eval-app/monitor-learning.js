'use strict';
const {hash}=require('./monitoring');
const {proposalsFor}=require('./learning-proposals');
const {matches}=require('./public/rating-identity');
const clone=x=>structuredClone(x),fail=(m,c=400)=>{throw Object.assign(Error(m),{statusCode:c});};
const text=x=>String(x||'').trim();
function createMonitorLearning({storage,monitor,scenes,startTrial,clock=()=>new Date()}){
 const get=(c,id)=>storage.byId(c,id)||fail('记录不存在',404),actor=b=>text(b.actor)||fail('请先在右上角填写姓名');
 function currentRatings(){const found=new Map();for(const r of storage.list('monitor_ratings')){const item=storage.byId('monitor_batch_items',r.item_id);if(!item)continue;const route=storage.byId('monitor_item_routes',item.current_route_id);if(!matches(r,route))continue;found.set(r.item_id,r);}return [...found.values()].filter(r=>r.status==='completed'&&r.request_snapshot&&r.scene_id);}
 function collect(){
  const added=[];storage.transaction(()=>{for(const r of currentRatings()){
   const review=storage.list('monitor_rating_reviews').filter(v=>v.rating_id===r.id).at(-1),record=r.record_snapshot||{},findings=r.report.findings||[];
   const suggestions=findings.map(f=>({kind:'finding',title:text(f.type)||'分析检查',description:text(f.description),suggestion:text(f.suggestion),rule_refs:f.rule_refs||[],evidence_refs:f.evidence_refs||[],quotes:f.quotes||[],review_id:review?.id||null}));
   if(review&&review.decision!=='confirm')suggestions.push({kind:'review',title:review.decision==='change'?'人工纠正评级':'人工要求补证',description:review.reason,suggestion:'对照人工复核理由及所附依据，补充或修正检查；人工结论仍需结合证据核验。',rule_refs:[],evidence_refs:[],quotes:[],review_id:review.id,review:clone(review)});
   for(const f of suggestions){if(!f.description)continue;const key=hash({rating:r.id,kind:f.kind,description:f.description,review:f.review_id});if(storage.find('monitor_learning_signals',x=>x.source_key===key))continue;
    const rule_texts=f.rule_refs.map(id=>r.request_snapshot.reference_index?.find(x=>x.id===id)?.text).filter(Boolean);
    added.push(storage.insert('monitor_learning_signals',{source_key:key,scene_id:r.scene_id,scope:record.scope||r.request_snapshot.record.scope,rating_id:r.id,item_id:r.item_id,case_id:r.case_id,batch_id:r.batch_id,record_name:record.name||r.request_snapshot.record.name,grade:r.report.grade,record_hash:r.record_hash,criterion_key:hash({kind:f.kind,title:f.title,rules:rule_texts,...(!rule_texts.length?{description:f.description}:{})}),...clone(f),rule_texts,consumed_by:null}));
   }
  }});return added;
 }
 function groups(){const eligible=new Set(currentRatings().map(r=>r.id)),out=new Map();for(const s of storage.list('monitor_learning_signals')){
  if(s.consumed_by||!eligible.has(s.rating_id))continue;const latest=storage.list('monitor_rating_reviews').filter(r=>r.rating_id===s.rating_id).at(-1);if((latest?.id||null)!==(s.review_id||null))continue;
  const key=s.scene_id+':'+s.scope;if(!out.has(key))out.set(key,{key,scene_id:s.scene_id,scene_name:storage.byId('business_scenes',s.scene_id)?.name||'场景',scope:s.scope,signals:[]});out.get(key).signals.push(clone(s));
 }return [...out.values()].map(g=>({...g,record_count:new Set(g.signals.map(s=>s.case_id)).size,batch_count:new Set(g.signals.map(s=>s.batch_id)).size,review_count:g.signals.filter(s=>s.kind==='review').length}));}
 function batchGroups(){return groups().flatMap(g=>[...new Set(g.signals.map(s=>s.batch_id))].map(batch_id=>{const signals=g.signals.filter(s=>s.batch_id===batch_id),batch=storage.byId('monitor_batches',batch_id);const group={...g,key:batch_id+':'+g.key,batch_id,batch_name:batch?.name||batch?.source_name||'当前批次',signals,record_count:new Set(signals.map(s=>s.case_id)).size,batch_count:1};return {...group,proposals:proposalsFor(group)};}));}
 function bootstrap(){return {version:'scenario-learning/v2',groups:groups(),batch_groups:batchGroups(),drafts:clone(storage.list('monitor_learning_drafts')),trials:clone(storage.list('monitor_plan_trials'))};}
 const modern=d=>{if(d.workflow_version!==2)fail('这是旧版历史汇总草稿，仅供查看。请回到具体批次，重新选择本批检查建议',409);return d;};
 function draft(body){
  const owner=actor(body);if(!text(body.request_id))fail('请重试保存检查建议');
  const requestHash=hash({batch:body.batch_id,scene:body.scene_id,scope:body.scope,plan:body.plan_id||null,ids:body.proposal_ids,actor:owner});const previous=storage.find('monitor_learning_drafts',d=>d.request_id===body.request_id);if(previous){if(previous.request_hash!==requestHash)fail('同一请求内容不同，请重新保存',409);return clone(previous);}
  const group=batchGroups().find(g=>g.batch_id===body.batch_id&&g.scene_id===body.scene_id&&g.scope===body.scope);if(!group)fail('请从已完成分析的批次选择检查建议',409);
  const ids=body.proposal_ids;if(!Array.isArray(ids)||!ids.length||ids.length>3||new Set(ids).size!==ids.length||ids.some(id=>!group.proposals.some(p=>p.id===id)))fail('请选择本批 1 至 3 项有用的检查建议；内容变化后请刷新重选',409);
  const changes=group.proposals.filter(p=>ids.includes(p.id)).map(p=>({...clone(p),key:p.category,action:'新增'})),selected=group.signals.filter(s=>changes.some(p=>p.source_ids.includes(s.id)));
  const base=body.plan_id?get('monitor_plans',body.plan_id):null;if(base&&(base.scene_id!==body.scene_id||base.scope!==body.scope))fail('方案不属于当前场景或对象');
  const revision=base?get('monitor_revisions',base.current_revision_id):null,scene=get('business_scenes',body.scene_id);if(scene.status!=='active'||!scene.scopes.includes(body.scope))fail('场景已停用或不适用于此对象',409);
  const source=get('monitor_ratings',selected[0].rating_id),sourceDefinition=source.monitor_binding?.definition||{};
  const skillSignature=definition=>hash({refs:definition.service_refs||[],bindings:definition.service_bindings||[]});if(selected.some(s=>skillSignature(get('monitor_ratings',s.rating_id).monitor_binding?.definition||{})!==skillSignature(sourceDefinition)))fail('所选建议的来源关联了不同业务 Skill，请分开选择，避免混合检查条件',409);
  if(revision&&hash({refs:revision.data.service_refs||[],bindings:revision.data.service_bindings||[]})!==hash({refs:sourceDefinition.service_refs||[],bindings:sourceDefinition.service_bindings||[]}))fail('已有方案关联的业务 Skill 与本批不同，请选择新建独立草稿，保持试用条件一致',409);
  const baseData=clone(revision?.data||{service_refs:sourceDefinition.service_refs||[],service_bindings:sourceDefinition.service_bindings||[]});
  let document=revision?.data.document||'# '+scene.name+' · 场景检查方案\n\n用于评估 AI 客服分析质量；全局评级标准与证据边界服从评估员 Skill。候选检查不构成新增业务政策，不预设责任或等级。\n';
  for(const c of changes){const marker='<!-- check:'+c.key+' -->',block=marker+'\n### '+c.title+'\n'+c.check+'\n<!-- /check -->',start=document.indexOf(marker);if(start>=0){const end=document.indexOf('<!-- /check -->',start);if(end<0)fail('已有方案检查块不完整，请先修复',409);document=document.slice(0,start)+block+document.slice(end+15);c.action='更新';}else document+='\n\n'+block;}
  const samples=[],seen=new Set(),add=r=>{if(r&&!seen.has(r.case_id)&&samples.length<3){seen.add(r.case_id);samples.push(r.id);}};
  selected.map(s=>get('monitor_ratings',s.rating_id)).forEach(add);
  const sameBatch=currentRatings().filter(r=>r.batch_id===group.batch_id&&r.scene_id===scene.id&&(r.record_snapshot?.scope||r.request_snapshot.record.scope)===body.scope);
  sameBatch.filter(r=>['L2','L3'].includes(r.report.grade)&&!r.report.findings?.length).forEach(add);sameBatch.forEach(add);
  if(document.length>100000)fail('方案过长，请减少检查内容');
  return clone(storage.insert('monitor_learning_drafts',{workflow_version:2,source_batch_id:group.batch_id,source_batch_name:group.batch_name,scene_id:scene.id,scene_name:scene.name,scope:body.scope,name:base?.name||scene.name+'检查方案',plan_id:base?.id||null,base_revision_id:revision?.id||null,base_document:revision?.data.document||null,base_data:baseData,document,content_hash:hash(document),trial_rating_ids:samples,changes,source_signals:clone(selected),status:'draft',actor:owner,request_id:body.request_id,request_hash:requestHash}));
 }
 function saveDraft(id,body){const d=modern(get('monitor_learning_drafts',id));if(d.status==='active')fail('已启用版本不可覆盖，请生成下一版',409);actor(body);if(body.base_hash!==d.content_hash)fail('草稿已有更新，请刷新后核对',409);const document=text(body.document);if(!document||document.length>100000)fail('请填写 1 至 100000 字符的方案');return clone(storage.update('monitor_learning_drafts',id,{document,content_hash:hash(document),status:'draft',actor:body.actor}));}
 function trial(id,body){const d=modern(get('monitor_learning_drafts',id));actor(body);if(d.status==='active')fail('此方案已启用，请从新批次选择建议继续完善',409);for(const id of d.trial_rating_ids){if(get('monitor_ratings',id).batch_id!==d.source_batch_id)fail('试用记录必须来自当前批次',409);}return startTrial({...body,draft_id:d.id,draft_hash:d.content_hash,document:d.document,scene_id:d.scene_id,scope:d.scope,source_batch_id:d.source_batch_id,source_batch_name:d.source_batch_name,rating_ids:d.trial_rating_ids});}
 function activate(id,body){const owner=actor(body),d=modern(get('monitor_learning_drafts',id));if(d.status==='active')return clone(d);if(body.reviewed!==true)fail('请先查看试用对比，再勾选确认');const t=get('monitor_plan_trials',body.trial_id);if(t.draft_id!==id||t.draft_hash!==d.content_hash||t.status!=='completed')fail('请先用当前草稿完成试用，失败或修改过的草稿不能启用',409);
  const base=d.plan_id?get('monitor_plans',d.plan_id):null;if(base&&base.current_revision_id!==d.base_revision_id)fail('原方案已有新版本，请重新选择建议，避免覆盖他人修改',409);
  return storage.transaction(()=>{const data=scenes.attach({...d.base_data,name:d.name,scene_id:d.scene_id,scope:d.scope,document:d.document,base_revision_id:d.base_revision_id,actor:owner});const r=monitor.savePlan(data,d.plan_id||undefined);monitor.confirm(r.plan_id,{revision_id:r.id,actor:owner});const value=storage.update('monitor_learning_drafts',id,{status:'active',activated_revision_id:r.id,activated_plan_id:r.plan_id,trial_id:t.id,confirmed_by:owner,confirmed_at:clock().toISOString()});for(const s of d.source_signals)storage.update('monitor_learning_signals',s.id,{consumed_by:id});return clone(value);});
 }

 collect();
 return {collect,bootstrap,draft,saveDraft,trial,activate};
}
module.exports={createMonitorLearning};
