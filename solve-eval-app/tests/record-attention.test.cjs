'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Storage}=require('../storage'),{createRecordAttention}=require('../record-attention');
function setup(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'csr-record-attention-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const storage=new Storage(path.join(dir,'db.json'));
  storage.insert('monitor_batch_items',{id:'item',case_id:'case',record_hash:'hash',focus_marked:true,record_snapshot:{name:'合成工单'}});
  storage.insert('monitor_ratings',{id:'r1',item_id:'item',status:'completed',report:{grade:'L2'}});
  storage.insert('monitor_ratings',{id:'other',item_id:'other-item',status:'completed',report:{grade:'L3'}});
  storage.insert('monitor_rating_reviews',{rating_id:'r1',status:'已复核'});
  return {storage,file:path.join(dir,'db.json'),service:createRecordAttention({storage}),a:{id:'a',name:'甲'},b:{id:'b',name:'乙'}};
}
test('查看记录按账号和报告轮次隔离，幂等且重启后保留',t=>{
  const {storage,service,file,a,b}=setup(t),first=service.viewed('item',{rating_id:'r1',user_id:'伪造账号'},a);
  assert.equal(first.user_id,a.id);assert.equal(service.views(b.id).length,0);assert.deepEqual(service.viewed('item',{rating_id:'r1'},a),first);
  storage.insert('monitor_ratings',{id:'r2',item_id:'item',status:'completed',report:{grade:'L1'}});
  assert.equal(service.views(a.id).some(v=>v.revision_key==='rating:r2'),false);
  service.viewed('item',{rating_id:'r2'},a);service.viewed('item',{rating_id:'r1'},b);
  const restored=createRecordAttention({storage:new Storage(file)});assert.equal(restored.views(a.id).length,2);assert.equal(restored.views(b.id).length,1);
});
test('无评估时按材料版本查看，不能把其他工单或运行中的结果登记为已查看',t=>{
  const {storage,service,a}=setup(t);const first=service.viewed('item',{},a);assert.equal(first.revision_key,'record:hash');
  storage.update('monitor_batch_items','item',{current_route_id:'route2'});assert.equal(service.viewed('item',{},a).revision_key,'record:route2');
  assert.throws(()=>service.viewed('item',{rating_id:'other'},a),/不属于/);
  storage.insert('monitor_ratings',{id:'running',item_id:'item',status:'running'});assert.throws(()=>service.viewed('item',{rating_id:'running'},a),/尚未完成/);
});
test('两类问题可同时记录，保留原报告、旧复核和共享编辑历史',t=>{
  const {storage,service,a,b}=setup(t),before=JSON.stringify({ratings:storage.list('monitor_ratings'),reviews:storage.list('monitor_rating_reviews')});
  const marks=[{type:'evaluation',reason:'评估漏读已提供的处理依据',suggestion:'补充判据说明'},{type:'ai',reason:'责任结论使用未核实数据',suggestion:'标为待核实并提供查询步骤'}];
  const item=service.saveMarks('item',{base_version:0,rating_id:'r1',marks,actor:'伪造署名'},a);assert.equal(item.attention_marks.length,2);assert.equal(item.attention_marks[0].actor,'甲');assert.equal(item.attention_history[0].legacy_marked,true);
  assert.throws(()=>service.saveMarks('item',{base_version:0,rating_id:'r1',marks},b),/其他人更新/);
  const clear=service.saveMarks('item',{base_version:1,rating_id:'r1',marks:[]},b);assert.equal(clear.focus_marked,false);assert.equal(clear.attention_history.length,2);assert.equal(clear.attention_history[1].previous.length,2);
  assert.equal(JSON.stringify({ratings:storage.list('monitor_ratings'),reviews:storage.list('monitor_rating_reviews')}),before);
});
test('原因与AI改进方案必填，不接受重复或无效类型',t=>{
  const {service,a}=setup(t),save=marks=>service.saveMarks('item',{base_version:0,rating_id:'r1',marks},a);
  assert.throws(()=>save([{type:'evaluation',reason:' '}]),/原因/);
  assert.throws(()=>save([{type:'ai',reason:'未定位事实'}]),/改进方案/);
  assert.throws(()=>save([{type:'unknown',reason:'原因'}]),/类型/);
  assert.throws(()=>save([{type:'evaluation',reason:'原因'},{type:'evaluation',reason:'原因'}]),/重复/);
  assert.equal(save([{type:'evaluation',reason:'已有依据被漏读'}]).attention_marks[0].suggestion,'');
});
test('一键标记原子生成唯一待分析事项，来源固定且重复点击不覆盖草稿',t=>{
 const {storage,service,a,b,file}=setup(t);
 const first=service.mark('item',{rating_id:'r1',note:'先看看'},a);
 assert.equal(first.task.status,'待分析');assert.deepEqual(first.task.analysis_marks,[]);assert.equal(first.item.focus_marked,true);
 const again=service.mark('item',{},b);assert.equal(first.task.id,again.task.id);assert.equal(storage.list('monitor_tasks').length,1);assert.equal(again.task.rating_id,'r1');
 assert.equal(createRecordAttention({storage:new Storage(file)}).mark('item',{},a).task.id,first.task.id);
 assert.throws(()=>service.mark('item',{rating_id:'other'},a),/不属于/);
});
test('待分析可保存不完整草稿，推进前校验分类方案和负责人，关闭需说明并防并发覆盖',t=>{
 const {service,a,b,storage}=setup(t),task=service.mark('item',{rating_id:'r1'},a).task;
 const save=patch=>service.updateTask(task.id,{base_version:0,status:'待分析',marks:[],...patch},b);
 assert.throws(()=>save({status:'待修改'}),/至少一种/);
 assert.throws(()=>save({status:'无需改进'}),/分析备注/);
 const draft=save({marks:[{type:'ai',reason:'还在核实'}]});assert.equal(draft.task.status,'待分析');assert.equal(draft.task.analysis_marks[0].suggestion,'');
 assert.throws(()=>save({}),/其他人更新/);
 assert.throws(()=>service.updateTask(task.id,{base_version:1,status:'待修改',marks:[{type:'ai',reason:'明确问题'}]},a),/方案/);
 const ready=service.updateTask(task.id,{base_version:1,status:'待修改',marks:[{type:'evaluation',reason:'漏读依据',suggestion:'补充判据'},{type:'ai',reason:'错误输出',suggestion:'补充核实'}],owner:'维护人',goal:'原样本和正常样本验证'},a);
 assert.equal(ready.task.id,task.id);assert.equal(ready.item.attention_marks.length,2);assert.equal(ready.task.category,'完善评估标准 / 完善 AI 客服');assert.equal(storage.byId('monitor_ratings','r1').report.grade,'L2');
 const closed=service.updateTask(task.id,{base_version:2,status:'无需改进',marks:[],note:'核查后原判断合理'},b);assert.equal(closed.task.history.length,4);assert.equal(closed.task.status,'无需改进');
});
test('标记和待办同步写入失败时全部回滚',t=>{
 const {service,storage,a}=setup(t),update=storage.update.bind(storage);storage.update=()=>{throw Error('模拟保存失败');};
 assert.throws(()=>service.mark('item',{},a),/保存失败/);assert.equal(storage.list('monitor_tasks').length,0);assert.equal(storage.byId('monitor_batch_items','item').attention_task_id,undefined);storage.update=update;
});
test('无评估时标记也冻结原材料；旧标记接口不能绕过新待办分析',t=>{
 const {service,storage,a}=setup(t),result=service.mark('item',{},a);
 storage.update('monitor_batch_items','item',{record_snapshot:{name:'更新后的工单'}});
 assert.equal(result.task.record_snapshot.name,'合成工单');
 assert.throws(()=>service.saveMarks('item',{base_version:1,marks:[]},a),/关联改进待办/);
});
test('误点可直接取消标记并撤回待分析，原报告和已查看状态不变，重启后保留',t=>{
 const {service,storage,a,file}=setup(t),view=service.viewed('item',{rating_id:'r1'},a),first=service.mark('item',{rating_id:'r1'},a);
 const result=service.cancel('item',{base_version:first.item.attention_version,task_version:first.task.version},a);
 assert.equal(result.item.focus_marked,false);assert.deepEqual(result.item.attention_marks,[]);assert.equal(result.task.status,'已撤回');assert.equal(result.task.history.at(-1).actor,'甲');
 assert.equal(storage.byId('monitor_ratings','r1').report.grade,'L2');assert.deepEqual(service.views(a.id),[view]);
 const restored=new Storage(file);assert.equal(restored.byId('monitor_tasks',first.task.id).status,'已撤回');
 assert.throws(()=>service.updateTask(first.task.id,{base_version:result.task.version,status:'待分析',marks:[]},a),/已撤回/);
});
test('已推进事项需明确确认撤回，防止覆盖他人进度；重新标记复用待办并保存原分析历史',t=>{
 const {service,storage,a,b}=setup(t),first=service.mark('item',{rating_id:'r1'},a);
 const ready=service.updateTask(first.task.id,{base_version:0,status:'待修改',marks:[{type:'ai',reason:'错漏',suggestion:'修正'}],owner:'甲',goal:'验证案例'},a);
 assert.throws(()=>service.cancel('item',{base_version:first.item.attention_version,task_version:0},b),/标记已更新/);
 const cancelBody={base_version:ready.item.attention_version,task_version:ready.task.version};
 assert.throws(()=>service.cancel('item',cancelBody,b),/请确认/);assert.equal(storage.byId('monitor_tasks',first.task.id).status,'待修改');
 const canceled=service.cancel('item',{...cancelBody,confirm_withdraw:true,note:'核查确认合理'},b);
 assert.equal(canceled.task.history.at(-1).marks[0].reason,'错漏');assert.equal(canceled.task.history.at(-1).previous_status,'待修改');
 storage.insert('monitor_ratings',{id:'r2',item_id:'item',status:'completed',record_snapshot:{name:'新一轮材料'},report:{grade:'L3'}});
 const again=service.mark('item',{rating_id:'r2'},a);assert.equal(again.task.id,first.task.id);assert.equal(storage.list('monitor_tasks').length,1);assert.equal(again.task.status,'待分析');assert.equal(again.task.rating_id,'r2');assert.equal(again.task.record_snapshot.name,'新一轮材料');assert.deepEqual(again.task.analysis_marks,[]);assert.equal(again.task.history.at(-2).marks[0].reason,'错漏');assert.equal(again.item.focus_marked,true);
 assert.throws(()=>service.cancel('item',{...cancelBody,confirm_withdraw:true},b),/标记已更新/);
});
test('撤回写入失败时原标记与待办整体回滚',t=>{
 const {service,storage,a}=setup(t),first=service.mark('item',{},a),update=storage.update.bind(storage);
 storage.update=(name,...args)=>{if(name==='monitor_batch_items')throw Error('模拟写入失败');return update(name,...args);};
 assert.throws(()=>service.cancel('item',{base_version:first.item.attention_version,task_version:0},a),/写入失败/);
 assert.equal(storage.byId('monitor_tasks',first.task.id).status,'待分析');assert.equal(storage.byId('monitor_batch_items','item').focus_marked,true);
});
