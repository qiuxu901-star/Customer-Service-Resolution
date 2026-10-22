'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict'),{spawn}=require('node:child_process'),{once}=require('node:events');
(async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'csr-model-http-')),calls=[];const fetch=require('./helpers-auth.cjs').authenticatedFetch(dir);let child;
  const mock=http.createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const body=text?JSON.parse(text):null;calls.push({url:req.url,body,key:req.headers.authorization});res.setHeader('Content-Type','application/json');if(req.url==='/v1/models')return res.end(JSON.stringify({data:[{id:'alpha'},{id:'beta'}]}));if(body.model==='broken'){res.writeHead(401);return res.end(JSON.stringify({error:'do not expose upstream error or secret'}));}res.end(JSON.stringify({choices:[{message:{content:body.messages[0].content==='Reply with OK.'?'OK':JSON.stringify({questions:[],checks:[{description:'合成检查建议'}],assumptions:[]})}}]}));});
  try{
    await new Promise(r=>mock.listen(0,'127.0.0.1',r));
    const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
    child=spawn(process.execPath,[path.join(__dirname,'../server.js')],{env:{...process.env,CSR_DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port)},stdio:'ignore'});
    async function api(method,url,body){const response=await fetch('http://127.0.0.1:'+port+url,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,value:await response.json()};}
    let ready=false;for(let n=0;n<80;n++){try{ready=(await api('GET','/api/monitor')).status===200;if(ready)break;}catch{}await new Promise(r=>setTimeout(r,30));}assert.ok(ready);
    assert.equal((await api('GET','/api/monitor')).value.model_configured,false);
    assert.equal((await api('POST','/api/monitor/model-test',{})).status,409);
    const body={name:'HTTP合成服务',base_url:'http://127.0.0.1:'+mock.address().port+'/v1',api_key:'synthetic-http-secret',models:['alpha','beta','broken'],actor:'HTTP验收'};
    const saved=await api('POST','/api/monitor/models',body);assert.equal(saved.status,200);assert.equal(saved.value.profile.api_key,undefined);const p=saved.value.profile,selection={profile_id:p.id,model:'alpha'};
    assert.equal((await api('POST','/api/monitor/model-default',{selection,actor:'HTTP验收'})).status,200);
    const bootstrap=(await api('GET','/api/monitor')).value;assert.equal(bootstrap.model_configured,true);assert.equal(JSON.stringify(bootstrap).includes(body.api_key),false);
    assert.deepEqual((await api('POST','/api/monitor/models/'+p.id+'/discover',{})).value.models,['alpha','beta']);
    const tested=await api('POST','/api/monitor/model-test',{selection:{...selection,model:'beta'}});assert.equal(tested.status,200);assert.equal(tested.value.model_snapshot.model,'beta');assert.equal(calls.at(-1).body.model,'beta');assert.equal(calls.at(-1).key,'Bearer '+body.api_key);
    const failure=await api('POST','/api/monitor/model-test',{selection:{...selection,model:'broken'}});assert.equal(failure.status,502);assert.match(failure.value.error,/鉴权失败/);assert.ok(!JSON.stringify(failure).includes('do not expose'));
    const scene=(await api('POST','/api/monitor/scenes',{code:'MODEL-HTTP',name:'合成场景',scopes:['frontline'],description:'模型路由测试',boundary:'仅合成',actor:'HTTP验收'})).value.scene;
    const revision=(await api('POST','/api/monitor/plans',{scene_id:scene.id,scope:'frontline',name:'合成方案',actor:'HTTP验收',...Object.fromEntries(['goal','trigger','prompt','materials','judgement','exceptions','output','reference'].map(k=>[k,'合成业务内容']))})).value.revision;
    await api('POST','/api/monitor/plans/'+revision.plan_id+'/confirm',{revision_id:revision.id,actor:'HTTP验收'});
    const run=await api('POST','/api/monitor/plans/'+revision.plan_id+'/generate',{revision_id:revision.id,mode:'model',model_selection:{...selection,model:'beta'},actor:'HTTP验收'});assert.equal(run.status,200);assert.equal(run.value.candidate.model_snapshot.model,'beta');assert.equal(calls.at(-1).body.model,'beta');assert.equal((await api('GET','/api/monitor/models')).value.default_model.model,'alpha');
    const defaultRun=await api('POST','/api/monitor/plans/'+revision.plan_id+'/generate',{revision_id:revision.id,mode:'model',actor:'HTTP验收'});assert.equal(defaultRun.value.candidate.model_snapshot.model,'alpha');assert.equal(calls.at(-1).body.model,'alpha');
    const edited=await api('PATCH','/api/monitor/models/'+p.id,{...body,api_key:'',name:'已更名',version:p.version});assert.equal(edited.status,200);assert.equal((await api('POST','/api/monitor/model-test',{})).status,200);
    assert.equal((await api('DELETE','/api/monitor/models/'+p.id,{version:edited.value.profile.version,actor:'HTTP验收'})).status,200);const state=(await api('GET','/api/monitor')).value;assert.equal(state.model_configured,false);assert.equal(state.candidates[0].model_snapshot.profile_name,'HTTP合成服务');assert.equal((await api('POST','/api/monitor/model-test',{selection})).status,409);
    console.log(JSON.stringify({http:true,multiple_models:true,default_and_override:true,real_local_mock_requests:calls.length,secrets_not_returned:true,history_snapshot:true,failures_explicit:true,external_model_called:false}));
  }finally{if(child&&child.exitCode===null){const ended=once(child,'exit');child.kill();await ended;}await new Promise(r=>mock.close(r));fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
