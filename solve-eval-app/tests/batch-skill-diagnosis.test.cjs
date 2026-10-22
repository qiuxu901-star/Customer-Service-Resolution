'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Storage}=require('../storage'),{createMonitoring}=require('../monitoring'),{createScenes}=require('../scenes'),{createIngestion}=require('../ingestion'),{buildInput}=require('../llm-rating'),{createSkillDiagnosis}=require('../skill-diagnosis'),{createServiceSkillLinks}=require('../service-skill-links'),{createBatchSkillDiagnosis,validateBatch}=require('../batch-skill-diagnosis'),Links=require('../public/service-skill-link');
const config={base_url:'http://mock/v1',api_key:'synthetic-secret',model:'mock',profile_id:'profile',profile_name:'合成模型',profile_version:1};
function legacyOutput(input){
 const refs=(f,prefix)=>input.reference_index.filter(r=>r.id[0]===prefix&&(prefix==='S'||input.reference_owners[r.id]==='shared'||input.reference_owners[r.id]===f.rating_id||Array.isArray(input.reference_owners[r.id])&&input.reference_owners[r.id].includes(f.rating_id))),first=input.selected_findings;
 return {summary:'两条工单重复出现证据核验缺口，应完善判断条件；第三条只需核查执行。',missing_materials:['真实运行版本仍需核实'],findings:first.map((f,i)=>({finding_index:f.finding_index,validity:'supported',issue_types:[i<2?'条件遗漏':'执行待查'],coverage:'covered',location:'VERBAL_CONFLICT v1 · 证据核验',explanation:'对照本工单原文，判断条件需进一步核查。',evidence_refs:[refs(f,'E').find(r=>r.role==='ai_output').id],skill_refs:[refs(f,'S')[0].id],requirement_refs:[(refs(f,'P')[0]||refs(f,'G')[0]).id],cause_status:i<2?'direct_basis':'hypothesis',action:i<2?'modify_skill':'check_execution',suggestion:'先核对原文，再判断是否达到条件。',revision:i<2?{anchor_ref:refs(f,'S')[0].id,proposed_text:'核对双方原文并注明证据不足的情形。',reason:'落实场景要求'}:null,verification_cases:[{name:'原问题',input:'有陈述',expected:'核对原文'},{name:'正常',input:'条件完整',expected:'按证据分析'},{name:'边界',input:'陈述不完整',expected:'保留待核实'}],missing_materials:[]})),groups:[{title:'多条工单未充分核验言语证据',finding_indices:first.slice(0,2).map(f=>f.finding_index),explanation:'相同判断条件下重复出现证据核验不足，需要完善定义。',location:'证据核验分支',suggestion:'完善双方原文核验条件。'},...(first.length>2?[{title:'个别工单的执行仍需核查',finding_indices:first.slice(2).map(f=>f.finding_index),explanation:'仅此单出现执行疑点，不能确认定义缺陷。',location:'执行记录',suggestion:'补充调用记录。'}]:[])]};
}
function output(input){
 const old=legacyOutput(input);
 return {...old,findings:old.findings.map(f=>({finding_index:f.finding_index,validity:f.validity,explanation:f.explanation,evidence_refs:f.evidence_refs})),groups:old.groups.map(g=>{const first=old.findings.find(f=>f.finding_index===g.finding_indices[0]);return {...first,...g,missing_materials:[]};})};
}
function fixture(t,options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'csr-joint-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'db.json'),storage=new Storage(file),monitor=createMonitoring({storage,getLlmConfig:()=>config}),scenes=createScenes({storage}),scene=scenes.save({code:'LOCAL-VERBAL',name:'言语冲突类',scopes:['tier2'],actor:'测试',description:'测试',boundary:'测试'}),skill=monitor.importService(scenes.attach({code:'VERBAL_CONFLICT',version:'v1',scene_id:scene.id,scope:'tier2',raw:'先核对双方原文，再判断言语冲突及适用条件。',source:'合成',actor:'测试'}));
 const ingestion=createIngestion({storage,monitor,scenes}),rows=Array.from({length:3},(_,i)=>({'工单ID':'T'+i,'租户id':'tenant',traceId:'TRACE'+i,'命中场景':i===2?'言语冲突类':'语言骚扰辱骂乘客',msg:i===2?'':'返回违规场景意图 314 语言骚扰辱骂乘客 VERBAL_CONFLICT','责任结论':'工单'+i+'：司机有责。','录音对话':'工单'+i+'：双方陈述不同，需要核对。'}));
 const imported=ingestion.importBatch({records:rows,actor:'测试',request_id:'IMPORT',source_name:'合成.xlsx'}),items=storage.list('monitor_batch_items');
 const ratings=items.map((item,i)=>{const route=storage.byId('monitor_item_routes',item.current_route_id),input=buildInput(item.record_snapshot,route.monitor_binding);return storage.insert('monitor_ratings',{id:'R'+i,item_id:item.id,batch_id:imported.id,route_id:item.current_route_id,status:'completed',rating_version:'test',record_snapshot:item.record_snapshot,monitor_binding:route.monitor_binding,request_snapshot:input,model_snapshot:{profile_id:'profile',model:'mock'},report:{grade:'L1',findings:[{type:'证据遗漏',description:'没有核对双方言语原文',suggestion:'核对证据',quotes:[{source:'ai_analysis_conclusion',quote:'工单'+i+'：司机有责。'}]}]}});});
 const links=createServiceSkillLinks({storage}),diagnosis=createSkillDiagnosis({storage,getLlmConfig:()=>options.config||config}),calls=[],service=createBatchSkillDiagnosis({storage,diagnosis,links,getLlmConfig:()=>options.config||config,callModel:async input=>{calls.push(input);return options.callModel?options.callModel(input):{value:output(input),raw:JSON.stringify(output(input)),usage:{prompt_tokens:100,completion_tokens:50}};}}),body={records:ratings.map(r=>({rating_id:r.id,finding_indices:[0]})),skill_selections:[{id:skill.id,content_hash:skill.content_hash,modules:['whole']}],model_selection:{profile_id:'profile',model:'mock'},actor:'测试',request_id:'JOINT'};
 return {dir,file,storage,monitor,scenes,scene,skill,ingestion,items,ratings,links,diagnosis,service,calls,body};
}
test('msg 对照维护编码自动匹配言语冲突类；原始意图名称不创建场景，缺 msg 待手动选择',t=>{
 const x=fixture(t);assert.equal(x.items[0].record_snapshot.scene,'言语冲突类');assert.equal(x.items[0].raw_record['命中场景'],'语言骚扰辱骂乘客');assert.equal(x.storage.list('business_scenes').length,1);assert.equal(x.links.state(x.items[0]).selection.id,x.skill.id);assert.equal(x.links.state(x.items[2]).status,'missing');
 const saved=x.links.bind({item_ids:[x.items[2].id],selection:x.body.skill_selections[0],actor:'测试'});assert.equal(saved.items[0].skill_binding.code,'VERBAL_CONFLICT');assert.equal(createServiceSkillLinks({storage:new Storage(x.file)}).state(x.storage.byId('monitor_batch_items',x.items[2].id)).status,'ready');
 const custom=x.monitor.importService(x.scenes.attach({...x.skill,code:'NEW_CUSTOM_CODE',actor:'测试'}));const msgOnly=x.ingestion.preview({records:[{'工单ID':'MSG-ONLY','租户id':'tenant',traceId:'MSG-ONLY',msg:'返回意图 NEW_CUSTOM_CODE','命中场景':'','责任结论':'待核对'}],actor:'测试',request_id:'MSGONLY',source_name:'合成'});assert.equal(msgOnly.rows[0].status,'ready');assert.equal(msgOnly.rows[0].scene_id,x.scene.id);assert.equal(msgOnly.rows[0].skill_link.service_id,custom.id);
 const s={...x.skill,code:'NEW_CUSTOM_CODE'};assert.equal(Links.detect({...x.items[0].record_snapshot,business_record:{fields:{msg:'返回意图 NEW_CUSTOM_CODE'}}},[s]).code,'NEW_CUSTOM_CODE');
 assert.equal(Links.detect({...x.items[0].record_snapshot,business_record:{fields:{msg:'返回意图 UNKNOWN_CODE'}}},[s]).status,'unmatched');
});
test('同编码多版本仅确认一次；保存版本不可用或正文变化须重新确认，不自动改用最新版',t=>{
 const x=fixture(t),record=x.items[0].record_snapshot,second=x.monitor.importService(x.scenes.attach({...x.skill,version:'v2',raw:'新定义',actor:'测试'}));
 assert.equal(Links.resolve(record,[x.skill,second]).status,'needs_version');const link=x.links.state(x.items[0]);assert.equal(link.selection.id,x.skill.id);
 assert.equal(Links.resolve(record,[second],x.items[0].skill_binding).status,'conflict');assert.equal(Links.resolve(record,[{...x.skill,content_hash:'changed'}],x.items[0].skill_binding).status,'needs_version');
});
test('联合预览零调用，三条工单一次模型调用，形成共性与个例并保留独立引用及关联',async t=>{
 const x=fixture(t),preview=x.service.preview(x.body);assert.equal(x.calls.length,0);assert.equal(preview.case_count,3);assert.equal(preview.finding_count,3);assert.equal(preview.additional_calls,1);assert.equal(x.links.state(x.items[2]).status,'missing');
 const body={...x.body,preparation_hash:preview.preparation_hash},row=x.service.start(body);assert.equal(x.service.start(body).id,row.id);await x.service.wait(row.id);const saved=x.service.get(row.id);
 assert.equal(saved.status,'completed',saved.error);assert.equal(x.calls.length,1);assert.equal(saved.report.groups[0].kind,'common');assert.equal(saved.report.groups[0].case_count,2);assert.equal(saved.report.groups[1].kind,'individual');assert.equal(saved.report.groups[1].case_count,1);assert.equal(x.links.state(x.items[2]).selection.id,x.skill.id);
 assert.deepEqual(saved.request_snapshot.selected_findings.map(f=>f.original_finding_index),[0,0,0]);assert.equal(new Set(saved.request_snapshot.reference_index.map(r=>r.id)).size,saved.request_snapshot.reference_index.length);assert.equal(saved.request_snapshot.service_skills[0].record_usage_verified,false);assert.deepEqual(x.storage.list('monitor_ratings').map(r=>r.report.grade),['L1','L1','L1']);assert.doesNotMatch(JSON.stringify(saved),/synthetic-secret/);
 const task=x.service.createTask(row.id,{group_id:'group_1',actor:'测试',request_id:'TASK'});assert.equal(task.rating_refs.length,2);assert.equal(task.skill_change.source_findings.length,2);assert.equal(x.service.createTask(row.id,{group_id:'group_1',actor:'测试',request_id:'TASK'}).id,task.id);
 assert.throws(()=>x.service.preview({...x.body,request_id:'AGAIN'}),/重新诊断.*原因/);assert.ok(x.service.preview({...x.body,repeat_reason:'scope_changed'}).preparation_hash);
});
test('拒绝跨工单原文或要求串用、汇总遗漏和重复问题、混合证据状态',async t=>{
 const x=fixture(t),p=x.service.preview(x.body),row=x.service.start({...x.body,preparation_hash:p.preparation_hash});await x.service.wait(row.id);const input=x.calls[0],valid=output(input);
 assert.equal(validateBatch(valid,input).groups.length,2);
 const wrong=structuredClone(valid);wrong.findings[0].evidence_refs=wrong.findings[1].evidence_refs;assert.throws(()=>validateBatch(wrong,input),/其他工单的原文/);
 const rule=structuredClone(valid),other=structuredClone(input);other.reference_index.push({id:'P999',source:'other',role:'monitoring_plan',text:'另一工单要求'});other.reference_owners.P999=input.selected_findings[2].rating_id;rule.groups[0].requirement_refs=['P999'];assert.throws(()=>validateBatch(rule,other),/不适用工单的评估要求/);
 const missing=structuredClone(valid);missing.groups.pop();assert.throws(()=>validateBatch(missing,input),/遗漏/);
 const duplicate=structuredClone(valid);duplicate.groups[0].finding_indices.push(0);assert.throws(()=>validateBatch(duplicate,input),/重复/);
 const mixed=structuredClone(valid);mixed.findings[2].validity='insufficient';mixed.groups=[{...mixed.groups[0],finding_indices:[0,1,2]}];assert.throws(()=>validateBatch(mixed,input),/不同证据状态|后续动作不一致/);
});
test('预览后的报告与 Skill 变化、跨 Skill、跨场景、过预算及并发任务均在调用前阻止',async t=>{
 const x=fixture(t),preview=x.service.preview(x.body);x.storage.update('monitor_ratings',x.ratings[0].id,{report:{...x.ratings[0].report,grade:'L2'}});assert.throws(()=>x.service.start({...x.body,preparation_hash:preview.preparation_hash}),/重新核对/);assert.equal(x.calls.length,0);
 x.monitor.importService(x.scenes.attach({...x.skill,code:'OTHER_CODE',actor:'测试'}));x.storage.update('monitor_batch_items',x.items[0].id,{skill_binding:{code:'OTHER_CODE',source:'manual'}});assert.throws(()=>x.service.preview(x.body),/其他客服业务 Skill/);x.storage.update('monitor_batch_items',x.items[0].id,{skill_binding:null});
 const row=x.service.start({...x.body,preparation_hash:x.service.preview(x.body).preparation_hash});assert.throws(()=>x.service.preview(x.body),/已有诊断执行中/);assert.throws(()=>x.diagnosis.start(x.ratings[0].id,{...x.body,finding_indices:[0],preparation_hash:x.diagnosis.preview(x.ratings[0].id,{...x.body,finding_indices:[0]}).preparation_hash}),/正在诊断/);await x.service.wait(row.id);
 const y=fixture(t,{config:{...config,rating_options:{max_input_chars:1}}});assert.throws(()=>y.service.preview(y.body),/超过预算/);assert.equal(y.calls.length,0);
 const z=fixture(t);z.storage.update('monitor_ratings',z.ratings[0].id,{request_snapshot:{...z.ratings[0].request_snapshot,record:{...z.ratings[0].request_snapshot.record,scene_id:'other',scene:'其他场景'}}});assert.throws(()=>z.service.preview(z.body),/同批次、同场景/);
});
test('失败保留用量与原始返回，重新解析恢复汇总不会再调用模型，重启不重发',async t=>{
 const x=fixture(t,{callModel:async input=>{const value=output(input);delete value.groups;return {value,raw:JSON.stringify(output(input)),usage:{prompt_tokens:10}};}}),row=x.service.start({...x.body,preparation_hash:x.service.preview(x.body).preparation_hash});await x.service.wait(row.id);assert.equal(x.service.get(row.id).status,'failed');assert.equal(x.service.get(row.id).usage.prompt_tokens,10);const restored=x.service.reparse(row.id,{actor:'测试'});assert.equal(restored.status,'completed');assert.equal(restored.report.groups.length,2);assert.equal(x.calls.length,1);
 x.storage.insert('service_skill_batch_diagnoses',{id:'interrupted',status:'running'});createBatchSkillDiagnosis({storage:x.storage,diagnosis:x.diagnosis,links:x.links,getLlmConfig:()=>config});assert.equal(x.service.get('interrupted').status,'failed');
});

test('导入预览可一次手动补选 Skill，带出维护场景并保存版本；冲突编码仍需确认',t=>{
 const x=fixture(t),records=[0,1].map(i=>({'工单ID':'MANUAL'+i,'租户id':'tenant',traceId:'M'+i,'命中场景':'语言骚扰辱骂乘客',msg:'','责任结论':'待核对'})),body={records,request_id:'MANUAL',source_name:'无msg.xlsx',actor:'测试',routing_overrides:{1:{skill_id:x.skill.id},2:{skill_id:x.skill.id}}};
 const preview=x.ingestion.preview(body);assert.ok(preview.rows.every(r=>r.status==='ready'&&r.scene_id===x.scene.id&&r.skill_link.source==='manual'));
 const batch=x.ingestion.importBatch({...body,preview_hash:preview.routing_hash}),items=x.storage.list('monitor_batch_items').filter(i=>i.batch_id===batch.id);assert.ok(items.every(i=>x.links.state(i).selection.id===x.skill.id));assert.ok(items.every(i=>i.record_snapshot.scene==='言语冲突类'));
 const conflict=x.ingestion.preview({records:[{...records[0],msg:'返回意图 VERBAL_CONFLICT','二级场景':'ORDER_CANCELLATION'}],request_id:'CONFLICT',source_name:'冲突.xlsx',actor:'测试'});assert.equal(conflict.rows[0].status,'scene_conflict');
});

test('汇总兼容规范数字字符串，归一化后保留全局序号与审计，不改模型原始结果',async t=>{
 const x=fixture(t),row=x.service.start({...x.body,preparation_hash:x.service.preview(x.body).preparation_hash});await x.service.wait(row.id);const input=x.calls[0],value=output(input);
 value.groups.forEach(g=>g.finding_indices=g.finding_indices.map(String));const original=JSON.stringify(value),report=validateBatch(value,input);
 assert.deepEqual(report.groups.map(g=>g.finding_indices),[[0,1],[2]]);assert.equal(report.format_normalizations.length,3);assert.deepEqual(report.format_normalizations[0],{path:'/groups/0/finding_indices/0',from:'0',to:0});assert.equal(JSON.stringify(value),original);assert.equal(report.groups[0].case_count,2);
 for(const invalid of [true,false,null,'',' 0','00','0.0','1e0','-1','9007199254740993',99]){const bad=structuredClone(value);bad.groups[0].finding_indices[0]=invalid;assert.throws(()=>validateBatch(bad,input),/无效问题序号/);}
 for(const ids of [[0,'0'],['0','1','0']]){const duplicate=structuredClone(value);duplicate.groups[0].finding_indices=ids;assert.throws(()=>validateBatch(duplicate,input),/问题序号重复/);}
 const across=structuredClone(value);across.groups[1].finding_indices=['0'];assert.throws(()=>validateBatch(across,input),/问题序号重复/);
});
test('已保存的字符串序号失败报告可零调用恢复，原始返回、费用、输入与评级保留',async t=>{
 const x=fixture(t),row=x.service.start({...x.body,preparation_hash:x.service.preview(x.body).preparation_hash});await x.service.wait(row.id);const legacyInput=structuredClone(x.calls[0]);delete legacyInput.output_mode;const value=legacyOutput(legacyInput);value.groups.forEach(g=>g.finding_indices=g.finding_indices.map(String));const raw=JSON.stringify(value);
 x.storage.update('service_skill_batch_diagnoses',row.id,{status:'failed',request_snapshot:legacyInput,report:null,error:'模型诊断结果无效：汇总问题序号重复或无效',raw_response:raw,prompt_version:'service-skill-batch-diagnosis/v1.0'});
 const before=x.service.get(row.id),restored=x.service.reparse(row.id,{actor:'本地修复'});
 assert.equal(restored.status,'completed');assert.equal(restored.validation_version,'service-skill-batch-diagnosis/v2.0');assert.equal(restored.prompt_version,before.prompt_version);assert.equal(restored.raw_response,raw);assert.equal(restored.input_hash,before.input_hash);assert.deepEqual(restored.usage,before.usage);assert.deepEqual(restored.request_snapshot,before.request_snapshot);assert.equal(restored.recovery_history[0].previous_error,before.error);assert.equal(x.calls.length,1);assert.ok(x.ratings.every(r=>r.report.grade==='L1'));
 assert.equal(x.service.reparse(row.id,{actor:'本地修复'}).recovery_history.length,1);assert.equal(x.calls.length,1);
});

test('新版实际请求共享规则与Skill一次发送，原文完整且不携带评级流程或归属索引',async t=>{
 const {SYSTEM}=require('../joint-diagnosis-protocol'),{messagesFor}=require('../rating-context'),x=fixture(t),preview=x.service.preview(x.body),wire=preview.request_messages,actual=wire.map(m=>m.content).join('');
 assert.equal(preview.prompt_version,'service-skill-batch-diagnosis/v2.0');assert.equal(wire[0].content,SYSTEM);assert.equal((SYSTEM.match(/输出结构：/g)||[]).length,1);
 const fixed=JSON.parse(wire[1].content),dynamic=JSON.parse(wire[2].content);assert.equal(fixed.rules.filter(r=>r.role==='service_skill').length,1);assert.equal(fixed.rules.filter(r=>r.role==='evaluator_skill').length,1);assert.equal(fixed.rules.some(r=>r.role==='monitoring_plan'),false);assert.equal(dynamic.cases.length,3);assert.equal(dynamic.selected_findings.length,3);
 assert.doesNotMatch(actual,/reference_owners|rating_id|route_id|完整评估流程|全局等级与判定顺序/);
 const materials=dynamic.cases.flatMap(c=>c.materials).flatMap(m=>m.segments.map(s=>s.text));for(const r of x.ratings)for(const s of r.request_snapshot.sources)assert.ok(materials.includes(s.text),s.label);
 const d=x.service.start({...x.body,preparation_hash:preview.preparation_hash});await x.service.wait(d.id);const saved=x.service.get(d.id);assert.deepEqual(saved.request_messages,messagesFor(saved.request_snapshot,SYSTEM));assert.equal(saved.context_stats.total_chars,saved.request_messages.reduce((n,m)=>n+m.content.length,0));assert.ok(saved.request_snapshot.source_rating_provenance.every(p=>p.input_hash));assert.equal(saved.report.report_layout,'group_first');
 const raw=JSON.parse(saved.raw_response);assert.deepEqual(Object.keys(raw.findings[0]).sort(),['evidence_refs','explanation','finding_index','validity']);assert.ok(raw.groups[0].revision);assert.equal(raw.groups[0].verification_cases.length,3);assert.equal(saved.report.groups[0].verification_cases.length,3);
});
test('相同场景要求按正文共享，差异要求独立保存并明确适用工单',t=>{
 const {buildJointInput}=require('../joint-diagnosis-protocol'),x=fixture(t),prepared=x.ratings.map(r=>x.diagnosis.prepare(r.id,{...x.body,finding_indices:[0]}));
 prepared.forEach((p,i)=>{p.input.monitoring_plan={...p.input.monitoring_plan,evaluation_mode:'scene',document:i<2?'核验原文与条件。':'额外核验第三单的场景要求。'};});
 const input=buildJointInput(prepared),rules=input.reference_index.filter(r=>r.role==='monitoring_plan');assert.equal(new Set(rules.map(r=>r.source)).size,2);
 const shared=rules.find(r=>r.text==='核验原文与条件。'),different=rules.find(r=>r.text==='额外核验第三单的场景要求。');assert.deepEqual(input.reference_owners[shared.id],['R0','R1']);assert.deepEqual(input.reference_owners[different.id],['R2']);assert.ok(input.record.records[0].requirement_refs.includes(shared.id));assert.ok(!input.record.records[2].requirement_refs.includes(shared.id));
});
test('联合诊断按最终实际请求检查预算，历史完整评级规则保留来源但不误计入诊断请求',t=>{
 const x=fixture(t,{config:{...config,rating_options:{max_input_chars:12000}}});
 for(const r of x.ratings)x.storage.update('monitor_ratings',r.id,{request_snapshot:{...r.request_snapshot,evaluator_skill:{version:'历史版本',document:'历史完整评级流程与等级定义。'.repeat(3000)}}});
 assert.throws(()=>x.diagnosis.preview(x.ratings[0].id,{...x.body,finding_indices:[0]}),/超过/);const preview=x.service.preview(x.body);assert.ok(preview.context_stats.total_chars<12000);assert.doesNotMatch(JSON.stringify(preview.request_messages),/历史完整评级流程与等级定义/);assert.ok(x.storage.byId('monitor_ratings',x.ratings[0].id).request_snapshot.evaluator_skill.document.length>30000);
});
