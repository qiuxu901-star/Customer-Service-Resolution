'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict'),{spawn}=require('node:child_process'),{once}=require('node:events');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'csr-workspace-http-')),calls=[];let child;
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
  const b=imported.value.batch;assert.equal((await api('POST','/api/monitor/conversations/'+c.id+'/batches',{batch_id:b.id})).status,200);
  const summary=await api('POST','/api/monitor/conversations/'+c.id+'/messages',{content:'查看数据',request_id:'three',context:{scope:'all',scene_id:'all',batch_id:b.id}});assert.equal(summary.status,200);const assistant=summary.value.conversation.messages.at(-1);assert.equal(assistant.actions[0].type,'analytics');assert.match(assistant.content,/"routing_pending":1/);assert.doesNotMatch(JSON.stringify(summary.value),/PRIVATE-HTTP-KEY/);
  assert.equal(assistant.presentation.version,1);assert.equal(assistant.presentation.blocks[0].type,'metrics');assert.equal(assistant.presentation.blocks[0].data.counts.routing_pending,1);
  const failure=await api('POST','/api/monitor/conversations/'+c.id+'/messages',{content:'失败测试',request_id:'four',model_selection:{profile_id:profile.id,model:'broken'}});assert.equal(failure.status,502);assert.doesNotMatch(JSON.stringify(failure.value),/PRIVATE-HTTP-KEY/);
  const before=(await api('GET','/api/monitor/conversations/'+c.id)).value.conversation;assert.equal(before.messages.at(-1).status,'failed');
  const exited=once(child,'exit');child.kill();await exited;
  const {Storage}=require('../storage'),storage=new Storage(path.join(dir,'db.json')),item=storage.list('monitor_batch_items').find(i=>i.batch_id===b.id);
  storage.insert('monitor_ratings',{id:'http-rating',item_id:item.id,route_id:item.current_route_id,status:'completed',report:{grade:'U',summary:'合成接口测试依据'}});
  await start();
  const review=await api('POST','/api/monitor/ratings/http-rating/review',{decision:'needs_info',reason:'合成测试缺少依据',actor:'合成验收'});assert.equal(review.status,200);assert.equal(review.value.review.status,'待补充');
  const task=await api('POST','/api/monitor/ratings/http-rating/tasks',{title:'合成待办',description:'缺少依据',goal:'补齐有效依据',owner:'测试',category:'业务依据或证据',priority:'中',actor:'合成验收'});assert.equal(task.status,200);assert.equal(task.value.task.rating_refs[0].item_id,item.id);
  const progress=await api('PATCH','/api/monitor/rating-tasks/'+task.value.task.id,{status:'修改中',note:'正在补充合成依据',actor:'合成验收'});assert.equal(progress.status,200);assert.equal(progress.value.task.status,'修改中');
  assert.equal((await api('PATCH','/api/monitor/rating-tasks/'+task.value.task.id,{status:'已复验',note:'不能凭声明完成',actor:'合成验收'})).status,400);
  const restored=(await api('GET','/api/monitor/conversations/'+c.id)).value.conversation;assert.equal(restored.messages.length,before.messages.length);assert.equal(restored.batch_ids[0],b.id);assert.equal((await api('GET','/api/monitor/conversations')).value.conversations.length,1);
  assert.deepEqual(restored.messages.find(m=>m.id===assistant.id).presentation,assistant.presentation);
  console.log(JSON.stringify({http:true,free_chat:true,multi_turn:true,read_only_tools:true,task_link:true,reply_snapshots:true,review_and_improvement_routes:true,verification_guard:true,restart_persistence:true,upstream_error_explicit:true,private_keys_hidden:true,local_provider_calls:calls.length,external_model_called:false,production_data_touched:false}));
 }finally{if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}await new Promise(r=>provider.close(r));fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
