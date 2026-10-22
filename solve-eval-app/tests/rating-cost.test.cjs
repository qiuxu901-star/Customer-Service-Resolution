'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Storage}=require('../storage'),{createMonitoring,hash}=require('../monitoring'),{createScenes}=require('../scenes'),{createBatchRating}=require('../batch-rating');
const {confirmBatch}=require('./helpers-routing.cjs');
const {selectSkill,planSkills}=require('../skill-context');
const {gradeBasis}=require('./helpers-rating.cjs');
const {buildInput,validateOutput,requestRating,messagesFor,SYSTEM,contextStats}=require('../llm-rating');
const {normalizeUsage,estimateCost,cacheCapability}=require('../llm-usage');
const raw=JSON.stringify({id:'PICKUP',type:'NON_AUDIO',rules:'核对话单\n不得推断已核实',exceptions:['无话单保留未知'],enabled:true})+',\n'+JSON.stringify({id:'CANCEL',type:'NON_AUDIO',rules:'不属于本场景的取消规则'})+',';
const skill={id:'SK',code:'PICKUP_NON_AUDIO',version:'1',scene_id:'S',scene:'接驾异常',scope:'tier2',raw,content_hash:hash({raw})};
const binding={plan_id:'P',revision_id:'R',definition:{name:'监测',scene_id:'S',scene:'接驾异常',scope:'tier2',document:'核对话单，缺失保留 U。\n不适用单列。',service_refs:['SK'],service_bindings:[{id:'SK',content_hash:skill.content_hash,modules:['module_1']}]}};
const record={name:'工单1',scope:'tier2',scene_id:'S',scene:'接驾异常',ai_reply:'已核对话单。\n下一行。',session_text:'请核实',evidence:[]};
const inputOf=(r=record,b=binding)=>buildInput(r,b,{getService:id=>id===skill.id?skill:null});
const valueOf=input=>{const evidence=input.reference_index.find(r=>r.role==='ai_output'),rule=input.reference_index.find(r=>r.role==='monitoring_plan'&&r.text.includes('核对话单'));return {applicability:'applicable',grade:'L1',...require('./helpers-rating.cjs').helpReport(input,'L1'),grade_basis:gradeBasis(input,'L1'),summary:'取证需要复核',dimensions:[{name:'取证',status:'gap',reason:'需补查',rule_refs:[rule.id],evidence_refs:[evidence.id]}],findings:[{type:'GAP',title:'话单情况需要核实',evidence_reason:'AI称已核对话单，本次未提供独立话单记录。',suggestion_reason:'补充话单可以核实AI陈述是否准确。',description:'需核实话单',rule_refs:[rule.id],evidence_refs:[evidence.id],suggestion:'补充话单'}],missing_materials:[],requires_review:false};};
function fixture(t,config={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'csr-cost-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const storage=new Storage(path.join(dir,'db.json')),monitor=createMonitoring({storage,getLlmConfig:()=>({})}),scenes=createScenes({storage});
  const scene=scenes.save({code:'S',name:record.scene,scopes:['tier2'],description:'合成',boundary:'合成',actor:'测试'});
  const service=monitor.importService(scenes.attach({...skill,scene_id:scene.id,source:'合成',actor:'测试'}));
  const draft=monitor.savePlan(scenes.attach({...binding.definition,scene_id:scene.id,service_refs:[service.id],service_bindings:[],actor:'测试'}));
  const calls=[];
  const batches=createBatchRating({storage,monitor,scenes,getLlmConfig:()=>({base_url:'http://mock/v1',api_key:'TEST',model:'test',...config}),callModel:async input=>{calls.push(input);return {value:{...valueOf(input),grade:'INVALID'},raw:'invalid grade',usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120,cached_tokens:70}};}});
  return {storage,monitor,scenes,scene,service,draft,batches,calls};
}
test('多定义和代码不匹配必须确认，两个 NON_AUDIO 不会按类型猜选',()=>{
  const unresolved=selectSkill(skill);assert.equal(unresolved.needs_confirmation,true);assert.equal(unresolved.selected.length,0);
  const selected=selectSkill(skill,binding.definition.service_bindings[0]);assert.equal(selected.selected[0].id,'PICKUP');assert.equal(selected.selected.length,1);assert.doesNotMatch(selected.selected[0].text,/取消规则/);
  const single={...skill,raw:JSON.stringify({id:'OTHER',rules:'完整规则'})};assert.equal(selectSkill(single).needs_confirmation,true);
  assert.equal(selectSkill({...single,code:'OTHER'}).selected.length,1);
});
test('未选择、错误选择、正文或子定义 hash 变化均阻止复用；解析不静默修复内容',()=>{
  assert.equal(selectSkill(skill,{modules:['module_9']}).needs_confirmation,true);
  assert.equal(selectSkill(skill,{modules:[null]}).needs_confirmation,true);
  assert.equal(selectSkill(skill,{modules:['module_1','module_1']}).needs_confirmation,true);
  assert.equal(selectSkill(skill,{modules:['module_1'],content_hash:'wrong'}).needs_confirmation,true);
  assert.equal(selectSkill(skill,{modules:[{key:'module_1',content_hash:'wrong'}]}).needs_confirmation,true);
  assert.equal(selectSkill({...skill,raw:'{"id":"X",broken}'}).needs_confirmation,true);
  const checked=selectSkill(skill,{modules:['module_1']});assert.match(checked.selected[0].text,/无话单保留未知/);
  checked.selected[0].text='caller mutation';assert.doesNotMatch(selectSkill(skill,{modules:['module_1']}).selected[0].text,/caller mutation/);
});
test('只发送选中定义，静态消息完全相同，工单在最后，正文不重复发送',()=>{
  const a=inputOf(),b=inputOf({...record,name:'不同工单',ai_reply:'另一条分析'}),ma=messagesFor(a,SYSTEM),mb=messagesFor(b,SYSTEM);
  assert.equal(ma.length,3);assert.deepEqual(ma.slice(0,2),mb.slice(0,2));assert.notEqual(ma[2].content,mb[2].content);
  assert.doesNotMatch(JSON.stringify(ma),/不属于本场景的取消规则/);
  const fixed=JSON.parse(ma[1].content),dynamic=JSON.parse(ma[2].content);
  assert.ok(fixed.rules.some(r=>r.role==='monitoring_plan'));assert.ok(fixed.rules.every(r=>r.role!=='service_skill'));assert.equal(contextStats(a,SYSTEM).skill_chars,0);
  assert.equal(fixed.monitoring_plan.document,undefined);assert.equal(dynamic.sources.filter(r=>r.role==='ai_output').flatMap(r=>r.segments.map(s=>s.text)).join(''),record.ai_reply);
  assert.equal(contextStats(a,SYSTEM).prefix_hash,contextStats(b,SYSTEM).prefix_hash);
  const changed=structuredClone(binding);changed.definition.document+='新例外';assert.notEqual(contextStats(a,SYSTEM).prefix_hash,contextStats(inputOf(record,changed),SYSTEM).prefix_hash);
});
test('编号输出后端回填原文与 JSON 路径；拒绝伪造编号、规则当行为证据、metadata 作证据',()=>{
  const input=inputOf(),value=valueOf(input),report=validateOutput(value,input);
  assert.equal(report.findings[0].quote,'已核对话单。\n');assert.equal(report.findings[0].quote_match,'server_reference');
  assert.equal(report.findings[0].quotes[0].start,0);assert.deepEqual(report.findings[0].rule_refs,value.findings[0].rule_refs);
  for(const refs of [['E999'],value.findings[0].rule_refs])assert.throws(()=>validateOutput({...value,findings:[{...value.findings[0],evidence_refs:refs}]},input),/证据编号/);
  assert.throws(()=>validateOutput({...value,findings:[{...value.findings[0],rule_refs:['E001']}]},input),/规则引用/);
  const jsonInput=inputOf({...record,ai_reply:JSON.stringify({logs:[{text:'核对\n下一步'}]})}),jsonReport=validateOutput(valueOf(jsonInput),jsonInput);
  assert.equal(jsonReport.findings[0].quotes[0].source_path,'/logs/0/text');assert.equal(jsonReport.findings[0].quote,'核对\n下一步');
  const business=inputOf({...record,business_record:{kind:'tier2',fields:{ticket_id:'T',ai_process_text:'日志'}}}),meta=business.reference_index.find(r=>r.role==='metadata');
  assert.throws(()=>validateOutput({...valueOf(business),findings:[{...valueOf(business).findings[0],evidence_refs:[meta.id]}]},business),/证据编号/);
});
test('DeepSeek、兼容字段、未知和矛盾用量分别处理；不重复计算推理和缓存',()=>{
  const usage=normalizeUsage({prompt_tokens:100,completion_tokens:30,total_tokens:130,prompt_cache_hit_tokens:70,prompt_cache_miss_tokens:30,completion_tokens_details:{reasoning_tokens:20}});
  assert.equal(usage.cached_tokens,70);assert.equal(usage.reasoning_tokens,20);assert.equal(usage.total_tokens,130);
  assert.equal(normalizeUsage({prompt_tokens:100,prompt_tokens_details:{cached_tokens:0}}).cached_tokens,0);
  assert.equal(normalizeUsage({prompt_tokens:100}).cached_tokens,null);
  assert.equal(normalizeUsage({prompt_tokens:100,prompt_cache_hit_tokens:101}).cached_tokens,null);
  assert.equal(normalizeUsage({prompt_tokens:100,prompt_cache_hit_tokens:70,prompt_cache_miss_tokens:40}).cache_metrics_valid,false);
  const pricing={currency:'CNY',input_per_million:2,cached_input_per_million:0.2,output_per_million:3};
  assert.ok(Math.abs(estimateCost(usage,pricing).amount-0.000164)<1e-10);
  assert.equal(estimateCost(normalizeUsage({prompt_tokens:100,completion_tokens:30}),pricing),null);
  assert.equal(estimateCost(normalizeUsage({prompt_tokens:100,completion_tokens:30,prompt_tokens_details:{cached_tokens:50,cache_write_tokens:20}}),pricing),null);
  assert.equal(cacheCapability('https://api.deepseek.com/v1').mode,'automatic_prefix');assert.equal(cacheCapability('https://api.deepseek.com.fake.test').mode,'unknown');
});
test('供应商请求不盲目添加缓存参数，输出预算传入，失败 JSON 与截断仍保留计费信息',async()=>{
  let sent;const input=inputOf(),config={base_url:'http://local/v1',api_key:'TEST',model:'M',rating_options:{max_output_tokens:1024}};
  const fetchImpl=async(_url,options)=>{sent=JSON.parse(options.body);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(valueOf(input))}}],usage:{prompt_tokens:100,completion_tokens:30,prompt_cache_hit_tokens:70,prompt_cache_miss_tokens:30}})};};
  const result=await requestRating(input,config,{fetchImpl});assert.equal(sent.max_tokens,1024);assert.equal(sent.prompt_cache_key,undefined);assert.equal(result.usage.cached_tokens,70);assert.deepEqual(sent.messages,messagesFor(input,SYSTEM));
  for(const [content,finish_reason]of [['not JSON','stop'],['{}','length']])await assert.rejects(()=>requestRating(input,config,{fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content},finish_reason}],usage:{prompt_tokens:100,completion_tokens:30,prompt_cache_hit_tokens:50}})})}),e=>e.usage.prompt_tokens===100&&e.usage.cached_tokens===50&&e.raw_response===content);
});
test('关联多定义尚未确认不阻止方案和整批确认，仅作为诊断时提示',t=>{
  const x=fixture(t);x.monitor.confirm(x.draft.plan_id,{revision_id:x.draft.id,actor:'测试'});
  const b=x.batches.importBatch({actor:'测试',request_id:'B',source_kind:'file',source_name:'合成',records:[{...record,scene_id:x.scene.id}]});
  const review=x.batches.routingReview(b.id);assert.equal(review.can_confirm,true);assert.equal(review.groups[0].service_skills[0].ready,false);confirmBatch(x.batches,b.id);assert.equal(x.batches.routingReview(b.id).confirmed,true);assert.equal(x.calls.length,0);
});
test('明确选择后冻结父子 hash，预算超限阻止整批且零调用，失败评级仍保存已知用量',async t=>{
  const x=fixture(t,{rating_options:{max_input_chars:1}});
  const revision=x.monitor.savePlan(x.scenes.attach({...x.draft.data,base_revision_id:x.draft.id,service_bindings:[{id:x.service.id,modules:['module_1']}],actor:'测试'}),x.draft.plan_id);
  x.monitor.confirm(revision.plan_id,{revision_id:revision.id,actor:'测试'});
  const selected=revision.data.service_bindings[0];assert.equal(selected.content_hash,x.service.content_hash);assert.equal(selected.modules[0].content_hash.length,64);
  const batch=x.batches.importBatch({actor:'测试',request_id:'B',source_kind:'file',source_name:'合成',records:[{...record,scene_id:x.scene.id}]});confirmBatch(x.batches,batch.id);
  assert.throws(()=>x.batches.evaluate(batch.id,{actor:'测试',request_id:'R'}),/输入字符预算/);assert.equal(x.calls.length,0);assert.equal(x.storage.list('monitor_rating_runs').length,0);
  const unrestricted=createBatchRating({storage:x.storage,monitor:x.monitor,scenes:x.scenes,getLlmConfig:()=>({base_url:'http://local',api_key:'TEST',model:'M'}),callModel:async input=>({value:{...valueOf(input),grade:'INVALID'},raw:'invalid',usage:{prompt_tokens:100,completion_tokens:30,cached_tokens:50}})});
  const run=unrestricted.evaluate(batch.id,{actor:'测试',request_id:'R2'});await unrestricted.waitForRating(run.id);const saved=x.storage.list('monitor_ratings')[0];assert.equal(saved.status,'failed');assert.equal(saved.usage.cached_tokens,50);assert.ok(saved.context_stats.prefix_hash);
  assert.doesNotMatch(JSON.stringify(saved),/api_key/);
  const original=structuredClone(saved.request_snapshot);x.storage.update('service_skills',x.service.id,{raw:'changed'});
  assert.equal(unrestricted.routingReview(batch.id).confirmed,true);assert.deepEqual(saved.request_snapshot,original);
});
