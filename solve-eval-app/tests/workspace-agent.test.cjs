'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Storage}=require('../storage'),{createModelConfigs}=require('../model-configs'),{createWorkspaceAgent}=require('../workspace-agent');
const response=message=>({ok:true,json:async()=>({choices:[{message}]})});
const tool=name=>({role:'assistant',content:null,tool_calls:[{id:'call-1',type:'function',function:{name,arguments:'{}'}}]});
function setup(t,options={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'csr-workspace-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'db.json'),storage=new Storage(file),modelConfigs=createModelConfigs({storage});const profile=modelConfigs.save({name:'合成测试模型',base_url:'https://models.example.test/v1',api_key:'PRIVATE-TEST-KEY',models:['test-chat'],actor:'测试'});modelConfigs.setDefault({actor:'测试',selection:{profile_id:profile.id,model:'test-chat'}});const requests=[];const agent=createWorkspaceAgent({storage,modelConfigs,fetchImpl:async(url,options)=>{requests.push({url,...options});return response({role:'assistant',content:'测试模型的真实接口响应'});},...options});return {storage,file,modelConfigs,profile,requests,agent};}
function seed(storage){storage.insert('business_scenes',{id:'scene-a',name:'测试场景'});storage.insert('monitor_batches',{id:'batch-a',name:'批次A',imported_count:2,error_count:0});for(const [id,scope,grade]of [['a','frontline','U'],['b','tier2','L3']]){storage.insert('monitor_batch_items',{id,case_id:'case-'+id,batch_id:'batch-a',logical_key:'key-'+id,current_route_id:'route-'+id,record_snapshot:{name:'记录'+id,scope,scene_id:'scene-a',session_text:'原始合成内容',ai_reply:'合成输出'}});storage.insert('monitor_item_routes',{id:'route-'+id,status:'ready',scene_id:'scene-a',effective_record:{name:'记录'+id,scope,scene_id:'scene-a',session_text:'原始合成内容',ai_reply:'合成输出'}});storage.insert('monitor_ratings',{id:'rating-'+id,item_id:id,route_id:'route-'+id,status:'completed',report:{grade,summary:'合成依据'}});}}
test('自由对话真正调用所选模型，多轮上下文与会话跨重启保存；重试幂等',async t=>{const x=setup(t),c=x.agent.create();const first=await x.agent.send(c.id,{content:'你好，帮我梳理业务问题',request_id:'one'});assert.equal(first.messages.length,2);assert.equal(x.requests[0].url,'https://models.example.test/v1/chat/completions');assert.equal(x.requests[0].headers.Authorization,'Bearer PRIVATE-TEST-KEY');assert.equal(JSON.parse(x.requests[0].body).model,'test-chat');await x.agent.send(c.id,{content:'你好，帮我梳理业务问题',request_id:'one'});assert.equal(x.requests.length,1);await assert.rejects(x.agent.send(c.id,{content:'不同内容',request_id:'one'}),/不一致/);await x.agent.send(c.id,{content:'继续讨论',request_id:'two'});const sent=JSON.parse(x.requests[1].body).messages;assert.equal(sent[1].content,'你好，帮我梳理业务问题');assert.equal(sent[2].role,'assistant');const restored=createWorkspaceAgent({storage:new Storage(x.file),modelConfigs:x.modelConfigs});assert.equal(restored.read(c.id).messages.length,4);assert.equal(JSON.stringify(restored.read(c.id)).includes('PRIVATE-TEST-KEY'),false);assert.equal(restored.list()[0].title,'你好，帮我梳理业务问题');});
test('统计工具固定使用服务端数据和用户范围，U不算可评价，旧route评级不混入',async t=>{let calls=0,summary;const x=setup(t,{fetchImpl:async(url,options)=>{const input=JSON.parse(options.body);if(!calls++)return response(tool('get_workspace_summary'));summary=JSON.parse(input.messages.at(-1).content);return response({role:'assistant',content:'当前一线1条记录，为U，缺少依据。'});}});seed(x.storage);x.storage.insert('monitor_ratings',{item_id:'a',route_id:'old-route',status:'completed',report:{grade:'L3'}});const c=x.agent.create(),r=await x.agent.send(c.id,{content:'总结当前数据',request_id:'stats',context:{scope:'frontline',scene_id:'scene-a',batch_id:'batch-a'}});assert.equal(summary.valid,1);assert.equal(summary.counts.U,1);assert.equal(summary.evaluable,0);assert.equal(summary.l3_delivery_rate,null);assert.equal(summary.counts.L3,0);assert.equal(r.messages.at(-1).actions[0].type,'analytics');assert.equal(x.storage.list('monitor_ratings').length,3);});
test('批量分析工具仅返回入口；关联已入库任务幂等保存，不伪造任务或执行',async t=>{let count=0;const x=setup(t,{fetchImpl:async()=>response(count++?{role:'assistant',content:'请打开批量分析入口。'}:tool('open_batch_import'))});const c=x.agent.create(),r=await x.agent.send(c.id,{content:'批量分析',request_id:'batch'});assert.equal(r.messages.at(-1).actions[0].type,'import');assert.equal(x.storage.list('monitor_batches').length,0);seed(x.storage);x.agent.attachBatch(c.id,{batch_id:'batch-a'});x.agent.attachBatch(c.id,{batch_id:'batch-a'});assert.equal(x.agent.read(c.id).messages.filter(m=>m.kind==='task').length,1);assert.equal(x.storage.list('monitor_rating_runs').length,0);});
test('未配置、上游错误、空回复和未知工具明确失败，不生成助手成功消息或泄漏Key',async t=>{const no=setup(t);no.modelConfigs.setDefault({actor:'测试',selection:null});const c=no.agent.create();await assert.rejects(no.agent.send(c.id,{content:'你好',request_id:'x'}),/未配置默认/);assert.equal(no.agent.read(c.id).messages.length,0);for(const fetchImpl of [async()=>({ok:false,status:401}),async()=>response({content:''}),async()=>response(tool('delete_all_records')),async()=>{throw Error('PRIVATE-TEST-KEY');}]){const x=setup(t,{fetchImpl}),c=x.agent.create();await assert.rejects(x.agent.send(c.id,{content:'你好',request_id:'failed'}),e=>!e.message.includes('PRIVATE-TEST-KEY'));assert.equal(x.agent.read(c.id).messages.length,1);assert.equal(x.agent.read(c.id).messages[0].status,'failed');}});
test('同对话并发被拒绝；重启将未完成消息标记失败，允许继续对话',async t=>{let resolve;const x=setup(t,{fetchImpl:()=>new Promise(r=>resolve=r)}),c=x.agent.create();const pending=x.agent.send(c.id,{content:'第一条',request_id:'one'});await assert.rejects(x.agent.send(c.id,{content:'第二条',request_id:'two'}),/正在回复/);resolve(response({role:'assistant',content:'完成'}));await pending;x.storage.insert('workspace_messages',{conversation_id:c.id,role:'user',content:'重启前请求',status:'pending'});const restored=createWorkspaceAgent({storage:new Storage(x.file),modelConfigs:x.modelConfigs});assert.equal(restored.read(c.id).messages.at(-1).status,'failed');assert.match(restored.read(c.id).messages.at(-1).error,/重启/);});
test('证据工具不能越过用户所选范围，原文和报告可追溯',async t=>{let n=0,result;const x=setup(t,{fetchImpl:async(url,options)=>{if(!n++){const reply=tool('read_record_evidence');reply.tool_calls[0].function.arguments=JSON.stringify({record_id:'b'});return response(reply);}result=JSON.parse(JSON.parse(options.body).messages.at(-1).content);return response({role:'assistant',content:'该记录不在当前范围'});}});seed(x.storage);await x.agent.send(x.agent.create().id,{content:'看记录b',request_id:'evidence',context:{scope:'frontline'}});assert.match(result.error,/不在当前范围/);assert.equal(result.report,undefined);});
test('人工复核独立保存，改判需依据，旧评级或旧匹配拒绝复核',t=>{const x=setup(t);seed(x.storage);assert.throws(()=>x.agent.reviewRating('rating-a',{decision:'change',grade:'L3',reason:'测试',actor:'复核人'}),/证据/);const review=x.agent.reviewRating('rating-a',{decision:'change',grade:'L2',reason:'有辅助仍需补查',evidence:'原回复与合成事实',actor:'复核人'});assert.equal(review.grade,'L2');assert.equal(x.storage.byId('monitor_ratings','rating-a').report.grade,'U');assert.equal(x.storage.list('monitor_rating_reviews').length,1);x.storage.insert('monitor_ratings',{id:'new-rating',item_id:'a',route_id:'route-a',status:'completed',report:{grade:'L3'}});assert.throws(()=>x.agent.reviewRating('rating-a',{decision:'confirm',reason:'复核',actor:'复核人'}),/更新评级/);x.storage.update('monitor_batch_items','a',{current_route_id:'changed-route'});assert.throws(()=>x.agent.reviewRating('new-rating',{decision:'confirm',reason:'复核',actor:'复核人'}),/匹配版本/);});

test('评级待办保留证据来源，必填项校验，关联去重且不覆盖原事项',t=>{
  const x=setup(t);seed(x.storage);
  const body={actor:'复核人',title:'补齐联系凭证',description:'原回复缺少依据',goal:'给出有效话单及对应回复',owner:'测试负责人',category:'业务依据或证据',priority:'高'};
  assert.throws(()=>x.agent.createRatingTask('rating-a',{...body,goal:''}),/验收目标/);
  const task=x.agent.createRatingTask('rating-a',body);
  assert.equal(task.status,'待修改');assert.equal(task.case_id,'case-a');assert.equal(task.rating_refs[0].route_id,'route-a');assert.equal(task.rating_refs[0].grade,'U');
  const linked=x.agent.createRatingTask('rating-b',{task_id:task.id,actor:'复核人'});
  assert.equal(linked.rating_refs.length,2);assert.equal(linked.title,body.title);assert.equal(linked.owner,body.owner);
  x.agent.createRatingTask('rating-b',{task_id:task.id,actor:'复核人'});
  assert.equal(x.storage.byId('monitor_tasks',task.id).rating_refs.length,2);assert.equal(x.storage.list('monitor_tasks').length,1);
  assert.equal(x.storage.byId('monitor_ratings','rating-a').report.grade,'U');
});
test('待办进度需留痕，不能绕过有效复验；过期评级不能创建新问题',t=>{
  const x=setup(t);seed(x.storage);const body={actor:'复核人',title:'补充依据',description:'合成问题',goal:'证据核验',owner:'测试负责人',category:'监测方案',priority:'中'};
  const task=x.agent.createRatingTask('rating-a',body);
  assert.throws(()=>x.agent.updateRatingTask(task.id,{status:'修改中',actor:'复核人',note:''}),/进度说明/);
  const changed=x.agent.updateRatingTask(task.id,{status:'待复验',actor:'复核人',note:'已补充合成依据，等待核验'});
  assert.equal(changed.status,'待复验');assert.equal(changed.history.at(-1).actor,'复核人');
  assert.throws(()=>x.agent.updateRatingTask(task.id,{status:'已复验',actor:'复核人',note:'已完成'}),/有效复验报告/);
  assert.equal(x.storage.byId('monitor_tasks',task.id).status,'待复验');
  x.storage.insert('monitor_ratings',{id:'rating-new',item_id:'a',route_id:'route-a',status:'completed',report:{grade:'L2'}});
  assert.throws(()=>x.agent.createRatingTask('rating-a',body),/更新评级/);
  x.storage.update('monitor_batch_items','a',{current_route_id:'route-new'});
  assert.throws(()=>x.agent.createRatingTask('rating-new',body),/匹配版本/);
});
test('助手按关联记录查询跨范围待办；尚未评级不返回零完成率',async t=>{
  let outputs=[];const x=setup(t,{fetchImpl:async(url,options)=>{const input=JSON.parse(options.body);if(input.messages.at(-1).role==='tool'){outputs.push(JSON.parse(input.messages.at(-1).content));return response({content:'已读取合成数据'});}return response(tool(input.messages.at(-1).content.includes('待办')?'list_improvement_tasks':'get_workspace_summary'));}});seed(x.storage);
  const task=x.agent.createRatingTask('rating-a',{actor:'测试',title:'跨对象问题',description:'合成问题',goal:'合成核验',owner:'测试',category:'监测方案',priority:'中'});x.agent.createRatingTask('rating-b',{task_id:task.id,actor:'测试'});
  await x.agent.send(x.agent.create().id,{content:'查询待办',request_id:'tasks',context:{scope:'tier2'}});assert.equal(outputs.at(-1).total,1);
  x.storage.update('monitor_batch_items','a',{current_route_id:'new-route'});x.storage.insert('monitor_item_routes',{id:'new-route',status:'ready',scene_id:'scene-a',effective_record:{scope:'frontline',scene_id:'scene-a'}});
  await x.agent.send(x.agent.create().id,{content:'查看数据',request_id:'unrated',context:{scope:'frontline'}});assert.equal(outputs.at(-1).evaluated,0);assert.equal(outputs.at(-1).full_l3_coverage,null);
});

test('回复规范传给模型；卡片来自实际工具、去重并随对话冻结保存', async t=>{
  let call=0,policy;
  const x=setup(t,{fetchImpl:async(url,options)=>{
    policy=JSON.parse(options.body).messages[0].content;
    if(!call++)return response({tool_calls:[
      ...['get_workspace_summary','get_workspace_summary','list_analysis_tasks'].map((name,i)=>({id:'query-'+i,type:'function',function:{name,arguments:'{}'}})),
      {id:'evidence',type:'function',function:{name:'read_record_evidence',arguments:JSON.stringify({record_id:'a'})}},
    ]});
    return response({content:'**先补齐记录a的依据。**\n\n### 优先建议\n1. 核对原文。'});
  }});
  seed(x.storage);const c=x.agent.create();
  const result=await x.agent.send(c.id,{content:'分析数据和任务，解释记录a',request_id:'rich-reply',context:{scope:'frontline'}});
  const reply=result.messages.at(-1),blocks=reply.presentation.blocks;
  assert.match(policy,/先回答用户当前问题/);assert.match(policy,/不要输出一级、二级标题/);assert.match(policy,/不猜测数字/);
  assert.equal(blocks.length,3);assert.deepEqual(blocks.map(b=>b.type),['metrics','analysis_tasks','evidence']);
  assert.equal(blocks[0].data.valid,1);assert.equal(blocks[0].data.evaluable,0);assert.equal(blocks[0].data.counts.U,1);
  assert.equal(blocks[1].tasks[0].id,'batch-a');assert.equal(blocks[2].excerpts[0].text,'原始合成内容');
  assert.equal(blocks[0].context.scope,'frontline');assert.ok(Date.parse(blocks[0].captured_at));
  x.storage.update('monitor_ratings','rating-a',{report:{grade:'L3'}});
  const restored=createWorkspaceAgent({storage:new Storage(x.file),modelConfigs:x.modelConfigs}).read(c.id).messages.at(-1);
  assert.equal(restored.presentation.blocks[0].data.counts.U,1);
  assert.equal(restored.presentation.blocks[0].data.counts.L3,0);
  assert.equal(reply.content.startsWith('**先补齐'),true);
});

function skillBody(){return {actor:'维护人',request_id:'skill-request',rating_ids:['rating-a','rating-b'],finding_refs:[{rating_id:'rating-a',finding_index:0},{rating_id:'rating-b',finding_index:0}],title:'客服 Skill 改进',description:'核对后的问题',suggestion:'修改分析步骤',reason:'避免遗漏关键陈述',goal:'新输出回应关键陈述',owner:'维护人',category:'AI 客服 Skill',priority:'高'};}
function skillSeed(storage){seed(storage);storage.update('monitor_batch_items','b',{record_snapshot:{name:'记录b',scope:'frontline',scene_id:'scene-a'}});for(const id of ['rating-a','rating-b'])storage.update('monitor_ratings',id,{report:{grade:'L1',findings:[{type:'语境遗漏',description:'遗漏关键陈述',suggestion:'结合陈述分析',quotes:[{quote:'原始证据'}]}]}});}
test('一次整理同类问题为客服 Skill 改进，来源冻结、保存幂等，既有评级及业务 Skill 不变',t=>{
 const x=setup(t);skillSeed(x.storage);const ratings=structuredClone(x.storage.list('monitor_ratings')),body=skillBody(),task=x.agent.createRatingTask('rating-a',body);assert.equal(task.category,'AI 客服 Skill');assert.equal(task.skill_change.status,'candidate');assert.equal(task.rating_refs.length,2);assert.equal(task.skill_change.source_findings[1].description,'遗漏关键陈述');assert.equal(x.agent.createRatingTask('rating-a',body).id,task.id);assert.equal(x.storage.list('monitor_tasks').length,1);assert.deepEqual(x.storage.list('monitor_ratings'),ratings);assert.equal(x.storage.list('service_skills').length,0);assert.throws(()=>x.agent.createRatingTask('rating-a',{...body,suggestion:'另一次修改'}),/同一保存请求/);x.storage.update('monitor_ratings','rating-a',{report:{grade:'L2',findings:[]}});assert.equal(task.skill_change.source_findings[0].description,'遗漏关键陈述');
});
test('来源全部校验后才保存，缺陷不存在、跨批和旧评级不能留下部分待办',t=>{
 const x=setup(t);skillSeed(x.storage);const body=skillBody();assert.throws(()=>x.agent.createRatingTask('rating-a',{...body,finding_refs:[{rating_id:'rating-a',finding_index:8}]}),/来源问题/);assert.equal(x.storage.list('monitor_tasks').length,0);x.storage.update('monitor_batch_items','b',{batch_id:'another'});assert.throws(()=>x.agent.createRatingTask('rating-a',body),/同一批次/);x.storage.update('monitor_batch_items','b',{batch_id:'batch-a'});x.storage.insert('monitor_ratings',{id:'new-rating',item_id:'b',route_id:'route-b',status:'failed'});assert.throws(()=>x.agent.createRatingTask('rating-a',body),/更新评级/);assert.equal(x.storage.list('monitor_tasks').length,0);
});
test('相同内容重新匹配后可整理与复核，真正改材料后拒绝；后续失败不能复用旧成功',t=>{
 const x=setup(t);skillSeed(x.storage);const old=x.storage.byId('monitor_item_routes','route-a');x.storage.update('monitor_ratings','rating-a',{record_hash:'same',scene_id:'scene-a',monitor_binding:{kind:'basic',definition:{document:'规则'}}});const route=x.storage.insert('monitor_item_routes',{...old,id:'route-again',record_hash:'same',monitor_binding:{definition:{document:'规则'},kind:'basic'}});x.storage.update('monitor_batch_items','a',{current_route_id:route.id});const task=x.agent.createRatingTask('rating-a',skillBody());assert.equal(task.skill_change.source_findings.length,2);assert.equal(x.agent.reviewRating('rating-a',{actor:'测试',decision:'confirm',reason:'原文可核对'}).grade,'L1');x.storage.update('monitor_item_routes',route.id,{record_hash:'changed'});assert.throws(()=>x.agent.createRatingTask('rating-a',{...skillBody(),request_id:'another'}),/匹配版本/);
});

test('助手按租户精确查询统计和证据，历史范围兼容全部租户且保存查询条件',async t=>{
 let output,requested='get_workspace_summary';const x=setup(t,{fetchImpl:async(url,options)=>{
  const input=JSON.parse(options.body);if(input.messages.at(-1).role==='tool'){output=JSON.parse(input.messages.at(-1).content);return response({content:'已按租户查询'});}
  const reply=tool(requested);if(requested==='read_record_evidence')reply.tool_calls[0].function.arguments=JSON.stringify({record_id:'b'});return response(reply);
 }});seed(x.storage);
 for(const id of ['a','b']){const route=x.storage.byId('monitor_item_routes','route-'+id);x.storage.update('monitor_item_routes',route.id,{effective_record:{...route.effective_record,tenant_id:id==='a'?'800029':'8000290'}});}
 const c=x.agent.create(),context={tenant_id:'800029'};
 await x.agent.send(c.id,{content:'查看数据',request_id:'tenant-summary',context});assert.equal(output.valid,1);assert.equal(output.counts.U,1);assert.equal(output.counts.L3,0);assert.equal(x.agent.read(c.id).context.tenant_id,'800029');
 requested='read_record_evidence';await x.agent.send(c.id,{content:'查看记录b',request_id:'tenant-evidence',context});assert.match(output.error,/不在当前范围/);assert.equal(output.report,undefined);
 requested='get_workspace_summary';await x.agent.send(c.id,{content:'全部数据',request_id:'tenant-all',context:{}});assert.equal(output.valid,2);
});
