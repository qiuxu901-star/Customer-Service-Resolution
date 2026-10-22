'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict'),{spawn}=require('node:child_process'),{once}=require('node:events');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'csr-workspace-http-')),calls=[];const fetch=require('./helpers-auth.cjs').authenticatedFetch(dir);let child;
 const provider=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);calls.push(body);res.setHeader('Content-Type','application/json');if(body.model==='broken'){res.writeHead(401);return res.end('{"error":"PRIVATE-HTTP-KEY"}');}const last=body.messages.at(-1);let message;if(last.role==='tool')message={content:'统计已读取：'+last.content};else if(last.content.includes('数据'))message={tool_calls:[{id:'query',type:'function',function:{name:'get_workspace_summary',arguments:'{}'}}]};else message={content:'收到 '+body.messages.filter(m=>m.role==='user').length+' 轮消息'};res.end(JSON.stringify({choices:[{message:{role:'assistant',...message}}]}));});
 try{
  await new Promise(r=>provider.listen(0,'127.0.0.1',r));const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
  const base='http://127.0.0.1:'+port;
  async function api(method,url,body){const response=await fetch(base+url,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,value:await response.json()};}
  async function start(){child=spawn(process.execPath,[path.join(__dirname,'../server.js')],{env:{...process.env,CSR_DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port)},stdio:'ignore'});for(let i=0;i<80;i++){try{if((await api('GET','/api/monitor')).status===200)return;}catch{}await new Promise(r=>setTimeout(r,30));}throw Error('服务未启动');}
  await start();
  const missing=await api('POST','/api/monitor/not-a-real-endpoint',{});assert.equal(missing.status,404);assert.match(missing.value.error,/接口不存在/);
  for(const asset of ['/workspace.js','/workspace.css','/workspace-polish.js','/workspace-polish.css','/workspace-reply.js','/workspace-reply.css'])assert.equal((await fetch(base+asset)).status,200);
  const profile=(await api('POST','/api/monitor/models',{name:'HTTP合成模型',base_url:'http://127.0.0.1:'+provider.address().port+'/v1',api_key:'PRIVATE-HTTP-KEY',models:['chat','broken'],actor:'合成验收'})).value.profile;
  await api('POST','/api/monitor/model-default',{actor:'合成验收',selection:{profile_id:profile.id,model:'chat'}});
  const c=(await api('POST','/api/monitor/conversations',{})).value.conversation;
  const first=await api('POST','/api/monitor/conversations/'+c.id+'/messages',{content:'你好',request_id:'one'});assert.equal(first.status,200);assert.equal(first.value.conversation.messages.at(-1).content,'收到 1 轮消息');
  const second=await api('POST','/api/monitor/conversations/'+c.id+'/messages',{content:'继续',request_id:'two'});assert.equal(second.value.conversation.messages.at(-1).content,'收到 2 轮消息');
  const imported=await api('POST','/api/monitor/batches',{actor:'合成验收',request_id:'import-one',source_kind:'file',source_name:'合成任务.json',records:[{name:'合成记录',scope:'frontline',scene:'',ai_reply:'合成回复',evidence:[]}]});assert.equal(imported.status,200);
  const b=imported.value.batch;
  const markBefore=(await api('GET','/api/monitor')).value,markedItem=markBefore.batch_items.find(i=>i.batch_id===b.id),markUrl='/api/monitor/batch-items/'+markedItem.id+'/mark';
  assert.equal((await api('PATCH',markUrl,{marked:'true'})).status,400);
  assert.equal((await api('PATCH','/api/monitor/batch-items/missing/mark',{marked:true})).status,404);
  const mark=await api('PATCH',markUrl,{marked:true,actor:'不能覆盖登录身份'});assert.equal(mark.status,200);assert.equal(mark.value.item.focus_marked,true);assert.notEqual(mark.value.item.focus_marked_by,'不能覆盖登录身份');
  assert.deepEqual((await api('PATCH',markUrl,{marked:true})).value.item,mark.value.item);
  const markAfter=(await api('GET','/api/monitor')).value;
  for(const key of ['ratings','rating_reviews','tasks','item_routes'])assert.deepEqual(markAfter[key],markBefore[key],key+' must not change when marking');
  assert.deepEqual(markAfter.batch_items.find(i=>i.id===markedItem.id).record_snapshot,markedItem.record_snapshot);
  const sourceView=await api('POST','/api/monitor/batch-items/'+markedItem.id+'/view',{user_id:'伪造账号'});assert.equal(sourceView.status,200);assert.notEqual(sourceView.value.view.user_id,'伪造账号');
  assert.deepEqual((await api('POST','/api/monitor/batch-items/'+markedItem.id+'/view',{})).value.view,sourceView.value.view);
  assert.equal((await api('POST','/api/monitor/batch-items/'+markedItem.id+'/view',{rating_id:'not-existing'})).status,400);

assert.equal((await api('POST','/api/monitor/conversations/'+c.id+'/batches',{batch_id:b.id})).status,200);
  const summary=await api('POST','/api/monitor/conversations/'+c.id+'/messages',{content:'查看数据',request_id:'three',context:{scope:'all',scene_id:'all',batch_id:b.id}});assert.equal(summary.status,200);const assistant=summary.value.conversation.messages.at(-1);assert.equal(assistant.actions[0].type,'analytics');assert.match(assistant.content,/"routing_pending":1/);assert.doesNotMatch(JSON.stringify(summary.value),/PRIVATE-HTTP-KEY/);
  assert.equal(assistant.presentation.version,1);assert.equal(assistant.presentation.blocks[0].type,'metrics');assert.equal(assistant.presentation.blocks[0].data.counts.routing_pending,1);
  const failure=await api('POST','/api/monitor/conversations/'+c.id+'/messages',{content:'失败测试',request_id:'four',model_selection:{profile_id:profile.id,model:'broken'}});assert.equal(failure.status,502);assert.doesNotMatch(JSON.stringify(failure.value),/PRIVATE-HTTP-KEY/);
  const before=(await api('GET','/api/monitor/conversations/'+c.id)).value.conversation;assert.equal(before.messages.at(-1).status,'failed');
  const exited=once(child,'exit');child.kill();await exited;
  const {Storage}=require('../storage'),storage=new Storage(path.join(dir,'db.json')),item=storage.list('monitor_batch_items').find(i=>i.batch_id===b.id);
  storage.insert('monitor_ratings',{id:'http-rating',item_id:item.id,route_id:item.current_route_id,status:'completed',report:{grade:'U',summary:'合成接口测试依据'}});
  await start();
  const persistedMark=(await api('GET','/api/monitor')).value.batch_items.find(i=>i.id===markedItem.id);assert.equal(persistedMark.focus_marked,true);assert.equal(persistedMark.focus_marked_at,mark.value.item.focus_marked_at);
  const unmark=await api('PATCH',markUrl,{marked:false});assert.equal(unmark.status,200);assert.equal(unmark.value.item.focus_marked,false);assert.equal(unmark.value.item.focus_marked_by,null);
  assert.equal((await api('GET','/api/monitor')).value.batch_items.find(i=>i.id===markedItem.id).focus_marked,false);

  const attentionUrl='/api/monitor/batch-items/'+markedItem.id+'/attention';
  assert.equal((await api('GET','/api/monitor')).value.record_views.length,1);
  const ratedView=await api('POST','/api/monitor/batch-items/'+markedItem.id+'/view',{rating_id:'http-rating'});assert.equal(ratedView.status,200);assert.equal((await api('GET','/api/monitor')).value.record_views.length,2);
  assert.equal((await api('PATCH',attentionUrl,{base_version:0,rating_id:'http-rating',marks:[{type:'ai',reason:'缺少核查'}]})).status,400);
  const bothMarks=await api('PATCH',attentionUrl,{base_version:0,rating_id:'http-rating',marks:[{type:'evaluation',reason:'评估漏读依据',suggestion:'完善判断边界'},{type:'ai',reason:'缺少核查',suggestion:'补充核查步骤'}]});assert.equal(bothMarks.status,200);assert.equal(bothMarks.value.item.attention_marks.length,2);
  assert.equal((await api('PATCH',attentionUrl,{base_version:0,marks:[]})).status,409);
  const review=await api('POST','/api/monitor/ratings/http-rating/review',{decision:'needs_info',reason:'合成测试缺少依据',actor:'合成验收'});assert.equal(review.status,200);assert.equal(review.value.review.status,'待补充');
  const task=await api('POST','/api/monitor/ratings/http-rating/tasks',{title:'合成待办',description:'缺少依据',goal:'补齐有效依据',owner:'测试',category:'业务依据或证据',priority:'中',actor:'合成验收'});assert.equal(task.status,200);assert.equal(task.value.task.rating_refs[0].item_id,item.id);
  const progress=await api('PATCH','/api/monitor/rating-tasks/'+task.value.task.id,{status:'修改中',note:'正在补充合成依据',actor:'合成验收'});assert.equal(progress.status,200);assert.equal(progress.value.task.status,'修改中');
  assert.equal((await api('PATCH','/api/monitor/rating-tasks/'+task.value.task.id,{status:'已复验',note:'不能凭声明完成',actor:'合成验收'})).status,400);
  const initial=await api('POST',attentionUrl,{rating_id:'http-rating'});assert.equal(initial.status,200);assert.equal(initial.value.task.status,'待分析');
  assert.equal((await api('POST',attentionUrl,{})).value.task.id,initial.value.task.id);
  const draft=await api('PATCH','/api/monitor/attention-tasks/'+initial.value.task.id,{base_version:0,status:'待分析',marks:[],note:'先核实'});assert.equal(draft.status,200);
  assert.equal((await api('PATCH','/api/monitor/attention-tasks/'+initial.value.task.id,{base_version:0,status:'待分析',marks:[]})).status,409);
  const ready=await api('PATCH','/api/monitor/attention-tasks/'+initial.value.task.id,{base_version:1,status:'待修改',marks:[{type:'ai',reason:'原文遗漏',suggestion:'补充引用核实'}],owner:'维护人',goal:'验证遗漏内容'});assert.equal(ready.status,200);assert.equal(ready.value.item.attention_marks[0].type,'ai');
  const cancelUrl=attentionUrl+'/cancel',cancelBody={base_version:ready.value.item.attention_version,task_version:ready.value.task.version};
  assert.equal((await api('POST',cancelUrl,cancelBody)).status,409);
  const withdrawn=await api('POST',cancelUrl,{...cancelBody,confirm_withdraw:true,note:'核查后无问题'});assert.equal(withdrawn.status,200);assert.equal(withdrawn.value.item.focus_marked,false);assert.equal(withdrawn.value.task.status,'已撤回');
  const reopened=await api('POST',attentionUrl,{rating_id:'http-rating'});assert.equal(reopened.status,200);assert.equal(reopened.value.task.id,initial.value.task.id);assert.equal(reopened.value.task.status,'待分析');
  assert.equal((await api('POST',cancelUrl,{...cancelBody,confirm_withdraw:true})).status,409);
  const restored=(await api('GET','/api/monitor/conversations/'+c.id)).value.conversation;assert.equal(restored.messages.length,before.messages.length);assert.equal(restored.batch_ids[0],b.id);assert.equal((await api('GET','/api/monitor/conversations')).value.conversations.length,1);
  assert.deepEqual(restored.messages.find(m=>m.id===assistant.id).presentation,assistant.presentation);
  console.log(JSON.stringify({http:true,free_chat:true,multi_turn:true,read_only_tools:true,task_link:true,reply_snapshots:true,personal_view_versions:true,typed_problem_marks:true,ticket_mark_persistence:true,mark_independent_of_review:true,review_and_improvement_routes:true,verification_guard:true,restart_persistence:true,upstream_error_explicit:true,private_keys_hidden:true,local_provider_calls:calls.length,external_model_called:false,production_data_touched:false}));
 }finally{if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}await new Promise(r=>provider.close(r));fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
