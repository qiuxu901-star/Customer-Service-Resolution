'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Storage}=require('../storage'),{createMonitoring,hash}=require('../monitoring'),{createScenes}=require('../scenes'),{createBatchRating}=require('../batch-rating');
const {createSkillDiagnosis,validateDiagnosis,SYSTEM}=require('../skill-diagnosis'),{requestRating,messagesFor}=require('../llm-rating'),{createCallLimiter}=require('../model-call-limit');
const {confirmBatch}=require('./helpers-routing.cjs'),{gradeBasis}=require('./helpers-rating.cjs');
const config={base_url:'http://mock/v1',api_key:'SECRET_TEST_KEY',model:'test',profile_id:'P',profile_name:'合成模型',profile_version:1};
function diagnosticOutput(input,action='modify_skill'){
 const e=input.reference_index.find(r=>r.role==='ai_output').id,p=input.reference_index.find(r=>r.role==='monitoring_plan').id,s=input.reference_index.find(r=>r.role==='service_skill').id;
 return {summary:'缺少异常情况核验分支，建议补充条件与证据边界。',findings:input.selected_findings.map(f=>({finding_index:f.finding_index,validity:'supported',issue_types:['逻辑缺失'],coverage:'missing',location:'完整适用定义：阈值判断之前',explanation:'定义仅按时间判断，缺少对已提供道路异常陈述的核验分支；实际执行版本待查。',evidence_refs:[e],skill_refs:[s],requirement_refs:[p],cause_status:'direct_basis',action,suggestion:'增加道路异常陈述的核验分支，不直接据此免责。',revision:action==='modify_skill'?{anchor_ref:s,proposed_text:'若有道路异常陈述，应分析其影响并列出待核实材料，不直接推定免责。',reason:'落实场景要求，避免忽略影响结论的条件。'}:null,verification_cases:[{name:'原问题',input:'道路封闭陈述',expected:'核验其影响，不能直接据此免责'},{name:'正常',input:'未提供异常',expected:'按已有条件分析'},{name:'边界',input:'仅单方陈述',expected:'保留待核实'}],missing_materials:['实际运行版本与调用记录']}))};
}
async function fixture(t,{callModel,resolve=()=>config,raw='接驾判断：提取时间，达到阈值则建议驳回。',limiter}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'csr-diagnosis-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const storage=new Storage(path.join(dir,'db.json')),monitor=createMonitoring({storage,getLlmConfig:()=>({})}),scenes=createScenes({storage}),scene=scenes.save({code:'S',name:'接驾异常',scopes:['tier2'],description:'合成',boundary:'合成',actor:'测试'}),skill=monitor.importService(scenes.attach({code:'PICKUP',version:'1',scene_id:scene.id,scope:'tier2',raw,source:'合成',actor:'测试'})),plan=monitor.savePlan(scenes.attach({name:'接驾检查',scene_id:scene.id,scope:'tier2',document:'检查 AI 是否分析道路异常与协商更改接驾点；说法不等于事实，不得编造政策。',service_refs:[skill.id],actor:'测试'}));
 monitor.confirm(plan.plan_id,{revision_id:plan.id,actor:'测试'});
 const initialCalls=[],batches=createBatchRating({storage,monitor,scenes,limiter,getLlmConfig:()=>config,callModel:async input=>{initialCalls.push(structuredClone(input));const e=input.reference_index.find(r=>r.role==='ai_output').id,p=input.reference_index.find(r=>r.role==='monitoring_plan').id;const value={applicability:'applicable',grade:'L1',...require('./helpers-rating.cjs').helpReport(input,'L1'),grade_basis:gradeBasis(input,'L1'),summary:'未分析异常陈述',dimensions:[{name:'材料分析',status:'gap',reason:'未回应陈述',rule_refs:[p],evidence_refs:[e]}],findings:[{type:'语境遗漏',title:'没有回应道路封闭的说法',evidence_reason:'会话提到道路封闭，完整可见回复只给出超时结论。',suggestion_reason:'核实道路情况能补齐影响接驾的条件。',description:'未分析道路封闭陈述',suggestion:'补充道路异常分析',rule_refs:[p],evidence_refs:[e]}],missing_materials:[],requires_review:false};return {value,raw:JSON.stringify(value)};}});
 const batch=batches.importBatch({actor:'测试',request_id:'IMPORT',source_kind:'file',source_name:'合成',records:[{name:'工单一',scene:'接驾异常',scope:'tier2',session_text:'司机：道路封闭。乘客：改到 B 口。',ai_reply:'接驾超时，建议驳回。',evidence:[]}]});confirmBatch(batches,batch.id);const run=batches.evaluate(batch.id,{actor:'测试',request_id:'RATE'});await batches.waitForRating(run.id);const rating=storage.list('monitor_ratings')[0];assert.equal(rating.status,'completed');
 const calls=[],service=createSkillDiagnosis({storage,limiter,getLlmConfig:resolve,callModel:async(input,c)=>{calls.push(structuredClone(input));return callModel?callModel(input,c):{value:diagnosticOutput(input),raw:'{}',usage:{prompt_tokens:200,completion_tokens:70,cached_tokens:80}};}}),body={finding_indices:[0],skill_selections:[{id:skill.id,content_hash:skill.content_hash,modules:raw.startsWith('[')?['module_1']:['whole']}],model_selection:{profile_id:'P',model:'test'},notes:'先核对条件',actor:'测试',request_id:'DIAG'};
 return {storage,monitor,scenes,scene,skill,plan,batches,batch,rating,service,body,calls,initialCalls};
}
function start(x,body=x.body){const preview=x.service.preview(x.rating.id,body);return x.service.start(x.rating.id,{...body,preparation_hash:preview.preparation_hash});}
test('预览零调用，初评不含 Skill；显式诊断冻结完整 S/G/P/E，编号重新建立，使用独立提示词',async t=>{
 let sent;const x=await fixture(t,{callModel:(input,c)=>requestRating(input,c,{system:SYSTEM,fetchImpl:async(_url,options)=>{sent=JSON.parse(options.body);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(diagnosticOutput(input))}}],usage:{prompt_tokens:200,completion_tokens:70,prompt_tokens_details:{cached_tokens:80}}})};}})});
 assert.equal(x.initialCalls[0].sources.some(s=>s.role==='service_skill'),false);const preview=x.service.preview(x.rating.id,x.body);assert.equal(x.calls.length,0);assert.equal(x.storage.list('service_skill_diagnoses').length,0);assert.equal(preview.additional_calls,1);assert.ok(preview.context_stats.skill_chars>0);
 const run=x.service.start(x.rating.id,{...x.body,preparation_hash:preview.preparation_hash});await x.service.wait(run.id);const saved=x.service.get(run.id);assert.equal(saved.status,'completed');assert.equal(sent.messages[0].content,SYSTEM);assert.match(sent.messages[2].content,/selected_findings/);assert.deepEqual(sent.messages,messagesFor(saved.request_snapshot,SYSTEM));assert.equal(saved.report.findings[0].revision.before,x.skill.raw);assert.equal(saved.report.changes_official_grade,false);assert.equal(saved.request_snapshot.selected_findings[0].original_quotes,undefined);assert.ok(saved.request_snapshot.selected_findings[0].evidence_refs.every(id=>id.startsWith('E')));assert.equal(x.rating.report.grade,'L1');assert.equal(x.storage.list('monitor_ratings').length,1);assert.doesNotMatch(JSON.stringify(saved),/SECRET_TEST_KEY|api_key/);
});
test('重复启动幂等，改变相同请求内容被拒绝；启动后正文修改不改写快照及报告',async t=>{
 let release;const wait=new Promise(r=>release=r),x=await fixture(t,{callModel:async input=>{await wait;return {value:diagnosticOutput(input),raw:'{}'};}}),preview=x.service.preview(x.rating.id,x.body),body={...x.body,preparation_hash:preview.preparation_hash},d=x.service.start(x.rating.id,body);
 assert.equal(x.service.start(x.rating.id,body).id,d.id);assert.throws(()=>x.service.start(x.rating.id,{...body,notes:'changed'}),/编号内容不同/);x.storage.update('service_skills',x.skill.id,{raw:'CHANGED',content_hash:hash({raw:'CHANGED'})});release();await x.service.wait(d.id);assert.equal(x.calls.length,1);assert.equal(x.service.get(d.id).request_snapshot.sources.find(s=>s.role==='service_skill').text,x.skill.raw);assert.equal(x.service.get(d.id).status,'completed');
});
test('版本、输入或模型变化须重新预览，失效配置与超预算均零诊断调用',async t=>{
 const x=await fixture(t),p=x.service.preview(x.rating.id,x.body);assert.throws(()=>x.service.preview(x.rating.id,{...x.body,skill_selections:[{...x.body.skill_selections[0],modules:[]}]}),/完整内部定义/);assert.throws(()=>x.service.start(x.rating.id,{...x.body,preparation_hash:'wrong'}),/重新预览/);assert.throws(()=>x.service.start(x.rating.id,{...x.body,notes:'新意见',preparation_hash:p.preparation_hash}),/重新预览/);
 x.storage.update('service_skills',x.skill.id,{raw:'CHANGED',content_hash:hash({raw:'CHANGED'})});assert.throws(()=>x.service.preview(x.rating.id,x.body),/摘要/);assert.equal(x.calls.length,0);
 const budget=createSkillDiagnosis({storage:x.storage,getLlmConfig:()=>({...config,rating_options:{max_input_chars:1}})});const valid={...x.body,skill_selections:[{id:x.skill.id,content_hash:hash({raw:'CHANGED'}),modules:['whole']}]};assert.throws(()=>budget.preview(x.rating.id,valid),/超过/);
 const stale=createSkillDiagnosis({storage:x.storage,getLlmConfig:()=>{throw Object.assign(Error('原模型已删除，请重新选择'),{statusCode:409});}});assert.throws(()=>stale.preview(x.rating.id,valid),/重新选择/);assert.equal(x.storage.list('service_skill_diagnoses').length,0);
});
test('多定义未选、缺正文、跨场景、伪造摘要阻止诊断，初评与整批确认不受影响',async t=>{
 const raw=JSON.stringify([{id:'PICKUP',rules:'先提取时间'},{id:'OTHER',rules:'其他定义，不应发送'}]),x=await fixture(t,{raw});assert.equal(x.batches.routingReview(x.batch.id).confirmed,true);assert.equal(x.initialCalls.length,1);
 const invalid={...x.body,skill_selections:[{id:x.skill.id,content_hash:x.skill.content_hash,modules:[]}]};assert.throws(()=>x.service.preview(x.rating.id,invalid),/完整内部定义/);const d=start(x);await x.service.wait(d.id);assert.doesNotMatch(JSON.stringify(x.calls),/其他定义，不应发送/);
 x.storage.update('service_skills',x.skill.id,{scope:'frontline'});assert.throws(()=>x.service.preview(x.rating.id,x.body),/不相容/);assert.equal(x.rating.report.grade,'L1');
});
test('历史联合评估重建索引并丢弃旧 S；关联不证明实际版本，原报告不可被覆盖',async t=>{
 const x=await fixture(t);const old=structuredClone(x.rating.request_snapshot);old.sources.push({id:'old_skill',role:'service_skill',label:'旧版本',text:'OLD SECRET RULE'});old.service_skills=[{id:'old',version:'0'}];x.storage.update('monitor_ratings',x.rating.id,{request_snapshot:old,rating_version:'resolution-llm/v4.3'});const d=start(x);await x.service.wait(d.id);const saved=x.service.get(d.id);assert.doesNotMatch(JSON.stringify(saved.request_snapshot),/OLD SECRET RULE/);assert.equal(saved.source_rating_version,'resolution-llm/v4.3');assert.equal(saved.request_snapshot.service_skills[0].record_usage_verified,false);assert.match(x.storage.byId('monitor_ratings',x.rating.id).request_snapshot.sources.at(-1).text,/OLD SECRET RULE/);
});
test('诊断验证拒绝伪造引用、规则作为行为证据、缺依据修订、遗漏所选问题与不一致动作',async t=>{
 const x=await fixture(t),d=start(x);await x.service.wait(d.id);const input=x.calls[0],valid=diagnosticOutput(input);assert.equal(validateDiagnosis(valid,input).findings.length,1);
 for(const patch of [{evidence_refs:['S001']},{skill_refs:['S999']},{requirement_refs:[]},{validity:'not_established'},{revision:null},{verification_cases:[]},{coverage:'unknown'}])assert.throws(()=>validateDiagnosis({...valid,findings:[{...valid.findings[0],...patch}]},input),/诊断结果无效/);
 assert.throws(()=>validateDiagnosis({...valid,findings:[]},input),/数量/);
 const notIssue={...valid,findings:[{...valid.findings[0],validity:'not_established',action:'review',revision:null}]};assert.equal(validateDiagnosis(notIssue,input).findings[0].action,'review');
});
test('失败仍保留实际用量，重启不自动重发；缺具体问题或来源已更新不得诊断',async t=>{
 const x=await fixture(t,{callModel:async()=>{throw Object.assign(Error('模型 JSON 无效'),{statusCode:502,usage:{prompt_tokens:100,cached_tokens:50},raw_response:'not json'});}}),d=start(x);await x.service.wait(d.id);assert.equal(x.service.get(d.id).status,'failed');assert.equal(x.service.get(d.id).usage.cached_tokens,50);assert.equal(x.rating.report.grade,'L1');
 x.storage.insert('service_skill_diagnoses',{id:'interrupted',status:'pending'});createSkillDiagnosis({storage:x.storage,getLlmConfig:()=>config});assert.equal(x.storage.byId('service_skill_diagnoses','interrupted').status,'failed');assert.equal(x.calls.length,1);
 x.storage.update('monitor_batch_items',x.rating.item_id,{current_route_id:'new'});assert.throws(()=>x.service.preview(x.rating.id,x.body),/匹配已变化/);
});
test('诊断待办按动作保存，含版本原文修订与验证，人工可编辑且幂等；不会修改等级或发布 Skill',async t=>{
 const x=await fixture(t),d=start(x);await x.service.wait(d.id);const body={request_id:'TASK',actor:'测试',finding_index:0,suggestion:'人工调整：先核查异常再下结论',owner:'维护人'},task=x.service.createTask(d.id,body);assert.equal(task.category,'AI 客服 Skill');assert.equal(task.diagnosis_id,d.id);assert.equal(task.skill_change.suggestion,body.suggestion);assert.equal(task.skill_change.diagnosis_finding.verification_cases.length,3);assert.equal(task.diagnosis_snapshot.target_skills[0].content_hash,x.skill.content_hash);assert.equal(x.service.createTask(d.id,body).id,task.id);assert.throws(()=>x.service.createTask(d.id,{...body,owner:'另一人'}),/同一保存请求/);assert.equal(x.storage.list('service_skills').length,1);assert.equal(x.rating.report.grade,'L1');
 const other=await fixture(t,{callModel:async input=>({value:diagnosticOutput(input,'check_execution'),raw:'{}'})}),e=start(other);await other.service.wait(e.id);assert.equal(other.service.createTask(e.id,{request_id:'T',actor:'测试',finding_index:0}).category,'原客服 AI 能力');
});
test('评级与诊断共用调用限流器，排队释放后继续，失败也释放名额',async()=>{
 const limit=createCallLimiter(2),resolvers=[];let active=0,max=0;
 const jobs=Array.from({length:5},(_,i)=>limit(async()=>{active++;max=Math.max(max,active);await new Promise(r=>resolvers.push(r));active--;if(i===1)throw Error('模拟失败');return i;}));
 const all=Promise.allSettled(jobs);await Promise.resolve();assert.equal(resolvers.length,2);while(resolvers.length){resolvers.shift()();await new Promise(r=>setImmediate(r));}const results=await all;assert.equal(max,2);assert.equal(results.filter(r=>r.status==='rejected').length,1);
});

test('兼容报告顶层共用材料，不将共用材料擅自分配或重复到各问题；仍支持问题内材料',async t=>{
 const x=await fixture(t),d=start(x);await x.service.wait(d.id);const input=x.calls[0],value=diagnosticOutput(input),materials=value.findings[0].missing_materials;
 value.missing_materials=['运行版本与发布记录','本次共用的工具原始返回'];delete value.findings[0].missing_materials;
 const report=validateDiagnosis(value,input);assert.deepEqual(report.missing_materials,value.missing_materials);assert.deepEqual(report.findings[0].missing_materials,[]);
 value.findings[0].missing_materials=materials;const mixed=validateDiagnosis(value,input);assert.deepEqual(mixed.findings[0].missing_materials,materials);assert.deepEqual(mixed.missing_materials,value.missing_materials);
 delete value.missing_materials;assert.deepEqual(validateDiagnosis(value,input).missing_materials,[]);
 delete value.findings[0].missing_materials;assert.throws(()=>validateDiagnosis(value,input),/第1个问题的待补材料应为字符串数组/);
 for(const invalid of [null,'运行记录',{items:[]},[null],[''],Array(51).fill('材料')])assert.throws(()=>validateDiagnosis({...value,missing_materials:invalid},input),/模型诊断结果无效/);
});
test('重新解析已保存失败结果不调用模型，保留原始返回、用量和历史错误，不修改等级',async t=>{
 const x=await fixture(t),d=start(x);await x.service.wait(d.id);const value=diagnosticOutput(x.calls[0]);value.missing_materials=['共用待补材料'];delete value.findings[0].missing_materials;const raw=JSON.stringify(value),error='模型诊断结果无效：待补材料格式无效';x.storage.update('service_skill_diagnoses',d.id,{status:'failed',report:null,raw_response:raw,error});
 const before=x.service.get(d.id),calls=x.calls.length,restored=x.service.reparse(d.id,{actor:'维护人'});assert.equal(restored.status,'completed');assert.equal(restored.error,null);assert.deepEqual(restored.report.missing_materials,['共用待补材料']);assert.equal(restored.raw_response,raw);assert.deepEqual(restored.usage,before.usage);assert.equal(restored.recovery_history[0].previous_error,error);assert.equal(x.service.reparse(d.id,{actor:'维护人'}).recovery_history.length,1);assert.equal(x.calls.length,calls);assert.equal(x.rating.report.grade,'L1');
 const task=x.service.createTask(d.id,{request_id:'RESTORED-TASK',actor:'维护人',finding_index:0});assert.deepEqual(task.diagnosis_snapshot.report.missing_materials,['共用待补材料']);
});
test('保存结果仍有无效引用时重新解析继续拒绝，不把失败伪装成功或补造内容',async t=>{
 const x=await fixture(t),d=start(x);await x.service.wait(d.id);const value=diagnosticOutput(x.calls[0]);value.missing_materials=['共用材料'];delete value.findings[0].missing_materials;value.findings[0].evidence_refs=['E999'];x.storage.update('service_skill_diagnoses',d.id,{status:'failed',report:null,raw_response:JSON.stringify(value),error:'模型诊断结果无效：待补材料格式无效'});
 assert.throws(()=>x.service.reparse(d.id,{actor:'维护人'}),/工单引用不存在/);assert.equal(x.service.get(d.id).status,'failed');assert.equal(x.service.get(d.id).recovery_history,undefined);assert.equal(x.calls.length,1);
});

test('已有报告重新诊断必须说明原因，新调用保留旧报告并关联次数与版本',async t=>{
 const x=await fixture(t),first=start(x);await x.service.wait(first.id);const before=x.service.get(first.id);assert.equal(before.attempt_number,1);assert.throws(()=>x.service.preview(x.rating.id,{...x.body,request_id:'AGAIN'}),/重新诊断的原因/);assert.throws(()=>x.service.preview(x.rating.id,{...x.body,repeat_reason:'随便'}),/重新诊断的原因/);assert.equal(x.calls.length,1);
 const second=start(x,{...x.body,request_id:'AGAIN',repeat_reason:'model_changed'});await x.service.wait(second.id);const saved=x.service.get(second.id);assert.equal(saved.attempt_number,2);assert.equal(saved.repeat_reason,'model_changed');assert.deepEqual(saved.repeat_of,[first.id]);assert.deepEqual(saved.request_snapshot.diagnosis_context.repeat_of,[first.id]);assert.equal(x.calls.length,2);assert.deepEqual(x.service.get(first.id),before);assert.equal(x.rating.report.grade,'L1');
});
test('仅诊断此前未覆盖的新问题不要求重跑原因；进度查询不触发新调用或返回完整冻结正文',async t=>{
 let release;const gate=new Promise(resolve=>release=resolve),x=await fixture(t,{callModel:async input=>{await gate;return {value:diagnosticOutput(input),raw:'RAW-MODEL-REPLY'};}}),d=start(x);assert.equal(d.phase,'queued');const initial=x.service.statuses({ids:[d.id]}).diagnoses[0];assert.equal(initial.status,'pending');assert.equal(initial.request_snapshot,undefined);assert.equal(initial.system_prompt,undefined);assert.equal(initial.raw_response,undefined);
 await new Promise(r=>setImmediate(r));const running=x.service.statuses({ids:[d.id]}).diagnoses[0];assert.equal(running.status,'running');assert.equal(running.phase,'analysing');assert.ok(running.started_at);assert.equal(x.calls.length,1);release();await x.service.wait(d.id);const done=x.service.statuses({ids:[d.id]}).diagnoses[0];assert.equal(done.phase,'completed');assert.ok(done.report);assert.equal(done.raw_response,undefined);assert.equal(x.calls.length,1);
 x.storage.update('monitor_ratings',x.rating.id,{report:{...x.rating.report,findings:[...x.rating.report.findings,{...x.rating.report.findings[0],description:'新增问题'}]}});assert.ok(x.service.preview(x.rating.id,{...x.body,request_id:'NEW-ISSUE',finding_indices:[1]}).preparation_hash);
 for(const ids of [[],[d.id,d.id],[null],Array(101).fill(d.id)])assert.throws(()=>x.service.statuses({ids}),/诊断任务/);
});
