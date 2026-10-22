'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const B=require('../public/business-import'),E=require('../public/excel-import'),XLSX=require('../public/vendor/xlsx.full.min'),{parseCSV}=require('../public/csv');
const {Storage}=require('../storage'),{createMonitoring}=require('../monitoring'),{createScenes}=require('../scenes'),{createBatchRating}=require('../batch-rating');
const {buildInput}=require('../llm-rating'),Analytics=require('../public/analytics-data'),{confirmBatch}=require('./helpers-routing.cjs');
const fixture=()=>Object.assign(B.jsonTemplate('tier2','tier2_rnd_v1'),{
 traceId:'SYN-TRACE-001','命中场景':'订单取消类',msg:'返回违规场景意图 309 无故取消订单 ORDER_CANCELLATION','二级场景':'ORDER_CANCELLATION','工单ID':'000T1','租户id':'000A',
 '工单创建时间':'2026-10-14 10:00:00','工单状态 2为完成':'2','处理时长(分钟)':'12.5','订单号':'2610108531232167416','工单分类':'合成申诉','反馈内容':'合成：乘客要求取消，司机申请核查','处理意见':'合成：人工已核查','处理人':'合成人工',
 '关键信息提取':'乘客主动提出取消。','责任方':'乘客','责任结论':'建议核查主动取消原因。','判责依据条款':'适用主动取消条款（AI引用）','核心证据':'00:00:03 乘客：我不用车了。',
 '行程对话':'00:00:01 司机：已到达。\n00:00:03 乘客：我不用车了。','录音对话':'通话1:\n00:00:03 乘客：我不用车了。','有用/无用':'有用','无用原因':''
});
function setup(t,options={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'csr-rnd-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const storage=new Storage(path.join(dir,'db.json')),monitor=createMonitoring({storage,getLlmConfig:()=>({})}),scenes=createScenes({storage}),batches=createBatchRating({storage,monitor,scenes,...options});const scene=scenes.save({code:'LOCAL-CANCEL',name:'订单取消',scopes:['tier2'],description:'合成验收',boundary:'仅测试',actor:'验收'});return {dir,storage,monitor,scenes,batches,scene};}
const body=rows=>({records:rows,actor:'合成验收',source_name:'合成研发.xlsx',source_system:'SYN-SYSTEM',request_id:crypto.randomUUID()});
test('研发26列在JSON、CSV和Excel中映射一致，保留19位订单和双来源转录',()=>{
 const row=fixture(),b=XLSX.utils.book_new();XLSX.utils.book_append_sheet(b,XLSX.utils.aoa_to_sheet([Object.keys(row),Object.values(row)]),'研发');
 const excel=E.readRows(E.open(XLSX.write(b,{type:'buffer',bookType:'xlsx'})))[0];
 const csv=Object.keys(row).map(x=>JSON.stringify(x)).join(',')+'\r\n'+Object.values(row).map(x=>'"'+x.replace(/"/g,'""')+'"').join(',');
 assert.deepEqual(B.adaptRecord(excel),B.adaptRecord(row));assert.deepEqual(B.adaptRecord(parseCSV(csv)[0]),B.adaptRecord(row));
 const r=B.adaptRecord(row);assert.equal(r.business_record.schema_version,2);assert.equal(r.context_id,row['订单号']);assert.equal(r.business_record.fields.transcript_text,row['录音对话']);assert.equal(r.business_record.fields.journey_dialogue_text,row['行程对话']);assert.equal(r.business_record.source_scene_code,'ORDER_CANCELLATION');assert.deepEqual(B.adaptRecord(r),r);
});
test('研发必填身份、冲突同义列和场景冲突均明确显示，不静默覆盖',t=>{
 const x=setup(t);for(const key of ['traceId','租户id','工单ID'])assert.throws(()=>B.adaptRecord({...fixture(),[key]:''}),/请提供|请填写/);
 assert.throws(()=>B.adaptRecord({...fixture(),'创建时间':'另一时间'}),/冲突/);
 assert.throws(()=>B.adaptRecord({...fixture(),'订单号':2610108531232167416}),/安全整数/);
 const unsafe=XLSX.utils.book_new();XLSX.utils.book_append_sheet(unsafe,XLSX.utils.aoa_to_sheet([['工单ID','订单号'],['SYN',2610108531232167416]]),'数字编号');assert.throws(()=>E.readRows(E.open(XLSX.write(unsafe,{type:'buffer',bookType:'xlsx'}))),/丢失精度/);
 assert.equal(x.batches.preview(body([{...fixture(),'二级场景':'VERBAL_CONFLICT'}])).rows[0].status,'scene_conflict');
 const p=x.batches.preview(body([fixture()]));assert.equal(p.rows[0].status,'ready');assert.equal(p.rows[0].scene_id,x.scene.id);
 const nameOnly=fixture();delete nameOnly.msg;delete nameOnly['二级场景'];assert.equal(x.batches.preview(body([nameOnly])).rows[0].status,'ready');
});
test('新调用、多租户和同订单多工单分开；同调用重导去重，人工评价更新不产生新材料版本',t=>{
 const x=setup(t),row=fixture();const rows=[row,{...row,traceId:'SYN-TRACE-002'},{...row,'租户id':'000B'},{...row,'工单ID':'000T2'}];
 const first=x.batches.importBatch(body(rows));assert.equal(first.imported_count,4);assert.equal(new Set(x.storage.list('monitor_batch_items').map(i=>i.logical_key)).size,4);
 const firstItem=x.storage.list('monitor_batch_items')[0],dup=x.batches.importBatch({...body([row]),source_name:'重命名.xlsx'});assert.equal(dup.duplicate_count,1);
 const annotation=x.batches.importBatch(body([{...row,'有用/无用':'无用','无用原因':'人工补注','处理时长(分钟)':'30'}]));assert.equal(annotation.duplicate_count,1);
 const changed=x.storage.list('monitor_batch_items').at(-1);assert.equal(changed.case_id,firstItem.case_id);assert.equal(changed.record_hash,firstItem.record_hash);assert.equal(changed.record_snapshot.business_record.fields.source_usefulness,'无用');assert.equal(changed.raw_record['无用原因'],'人工补注');assert.equal(firstItem.raw_record['有用/无用'],'有用');
 const update=x.batches.importBatch(body([{...row,'责任结论':'更新后的AI结论'}]));assert.equal(update.updated_count,1);assert.notEqual(x.storage.list('monitor_batch_items').at(-1).case_id,firstItem.case_id);
 const restored=new Storage(path.join(x.dir,'db.json'));assert.equal(restored.list('monitor_batch_items').at(-2).record_snapshot.business_record.fields.source_useless_reason,'人工补注');
 const snapshot=Analytics.collect({...x.batches.bootstrap(),runs:[]});assert.equal(snapshot.rndCallCount,4);assert.equal(snapshot.rndTicketCount,3);assert.equal(snapshot.unique.length,4);
});
test('五类AI结果与两类转录真实进入初评；人工标签、时长和null条款不进入',t=>{
 const x=setup(t),row=fixture(),b=x.batches.importBatch(body([row]));confirmBatch(x.batches,b.id);const route=x.storage.list('monitor_item_routes')[0],input=buildInput(route.effective_record,route.monitor_binding);
 assert.deepEqual(input.sources.filter(s=>s.role==='ai_output').map(s=>s.id).sort(),['ai_key_information','ai_responsible_party','ai_analysis_conclusion','ai_cited_policy','ai_core_evidence'].sort());
 assert.equal(input.sources.filter(s=>s.role==='context').length,2);assert.match(input.sources.find(s=>s.id==='journey_dialogue_text').label,/车内/);assert.match(input.sources.find(s=>s.id==='transcript_text').label,/电话/);
 assert.equal(input.record.trace_id,row.traceId);assert.equal(input.record.context_id,row['订单号']);
 for(const key of ['source_usefulness','source_useless_reason','processing_duration_minutes','handler_name','ticket_status','source_scene_message'])assert.ok(!input.sources.some(s=>s.id===key),key);
 const missing=B.adaptRecord({...row,'判责依据条款':'null'});assert.equal(missing.business_record.fields.ai_cited_policy,'null');assert.ok(B.quality(missing).missing_fields.includes('判责依据条款'));assert.ok(!buildInput(missing,route.monitor_binding).sources.some(s=>s.id==='ai_cited_policy'));
 assert.ok(input.reference_index.some(r=>r.source==='ai_core_evidence'&&r.role==='ai_output'));assert.ok(input.reference_index.some(r=>r.source==='transcript_text'&&r.role==='context'));
});
test('刷新和人工更正路由使用同一评估摘要，人工标签不改变评级身份',t=>{
 const x=setup(t),batch=x.batches.importBatch(body([fixture()])),before=x.storage.list('monitor_item_routes')[0];const review=x.batches.routingReview(batch.id);x.batches.refreshRouting(batch.id,{actor:'验收',review_hash:review.review_hash});assert.equal(x.storage.list('monitor_item_routes').at(-1).record_hash,before.record_hash);
 const item=x.storage.list('monitor_batch_items')[0],updated=x.batches.resolveItem(item.id,{actor:'验收',base_route_id:item.current_route_id,scene_id:x.scene.id,candidate_id:require('../basic-evaluation').BASIC_ID});assert.equal(updated.record_hash,before.record_hash);
});
test('研发Excel/CSV/JSON下载模板为26列，旧11列下载仍独立兼容',()=>{
 const expected=Object.keys(B.jsonTemplate('tier2','tier2_rnd_v1'));assert.equal(expected.length,26);assert.deepEqual(Object.keys(parseCSV(B.csvTemplate('tier2','tier2_rnd_v1')+'\n'+Array(26).fill('x').join(','))[0]),expected);
 const b=E.open(E.template('tier2','tier2_rnd_v1'));assert.deepEqual(XLSX.utils.sheet_to_json(b.Sheets[b.SheetNames[0]],{header:1})[0],expected);assert.throws(()=>E.readRows(b),/没有可导入记录/);assert.equal(Object.keys(B.jsonTemplate('tier2')).length,11);assert.equal(Object.keys(B.jsonTemplate('frontline')).length,11);
});
test('同工单两次调用分别完成模型评估，同次重复行只执行一次并保存引用快照',async t=>{
 const calls=[],x=setup(t,{getLlmConfig:()=>({base_url:'http://127.0.0.1:1/v1',api_key:'SYNTHETIC',model:'local-stub'}),callModel:async input=>{
  calls.push(input);const value={applicability:'applicable',grade:'L2',summary:'合成验收：有帮助，仍需人工核查。',...require('./helpers-rating.cjs').helpReport(input,'L2'),grade_basis:require('./helpers-rating.cjs').gradeBasis(input,'L2'),dimensions:[{name:'分析质量',status:'gap',reason:'合成验收需补查',evidence_refs:['ai_analysis_conclusion']}],findings:[],missing_materials:[],requires_review:false};return {value,raw:JSON.stringify(value)};
 }}),row=fixture(),batch=x.batches.importBatch(body([row,row,{...row,traceId:'SYN-TRACE-002'}]));
 confirmBatch(x.batches,batch.id);const run=x.batches.evaluate(batch.id,{actor:'验收',request_id:crypto.randomUUID()});await x.batches.waitForRating(run.id);
 assert.equal(run.total,2);assert.equal(calls.length,2);assert.equal(new Set(calls.map(i=>i.record.trace_id)).size,2);assert.equal(x.batches.getRatingRun(run.id).failed_count,0);
 for(const saved of x.storage.list('monitor_ratings')){assert.equal(saved.status,'completed');assert.equal(saved.report.grade,'L2');assert.ok(saved.request_snapshot.reference_index.some(r=>r.source==='ai_analysis_conclusion'));assert.ok(!saved.request_snapshot.sources.some(s=>s.id==='source_usefulness'));}
});
module.exports={fixture};
