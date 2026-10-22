'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {collect,metrics,businessDay,trend,comparisons}=require('../public/analytics-data');
function fixture(){return {batches:[{id:'one',source_system:'crm'},{id:'two',source_system:'crm'}],batch_items:[],ratings:[],runs:[]};}
function add(d,id,batch,ticket,grade,day='2026-10-01',extra={}){
  const item={id,case_id:'case-'+id,batch_id:batch,record_snapshot:{scope:'tier2',scene:'合成场景',analytics_scene_id:'scene',business_record:{fields:{ticket_id:ticket,created_time:day}}},...extra};d.batch_items.push(item);
  if(grade)d.ratings.push({id:'rating-'+id,item_id:id,status:'completed',created_at:'2026-10-01T01:00:00Z',report:{grade}});return item;
}
test('默认统计所有批次，既保留原始导入数量也按业务ID去重，编号相同但来源不同分别计数',()=>{
  const d=fixture();add(d,'a','one','001','L0');add(d,'b','two','001','L3');add(d,'c','two','002','L2');d.batch_items.push({id:'invalid',batch_id:'one'});
  const all=collect(d);assert.equal(all.rawCount,4);assert.equal(all.rawValid,3);assert.equal(all.batchCount,2);assert.equal(all.unique.length,2);assert.equal(all.duplicates,1);assert.equal(metrics(all.rows).counts.import_failed,1);assert.equal(all.unique.find(r=>r.item.record_snapshot.business_record.fields.ticket_id==='001').status,'L3');
  d.batches[1].source_system='other';assert.equal(collect(d).unique.length,3);
});
test('较新导入未完成时使用已有最新有效评级，失败、待匹配不当作U且不跨路由使用旧评级',()=>{
  const d=fixture();add(d,'a','one','001','L2');add(d,'b','two','001',null);d.ratings.push({id:'failed',item_id:'b',status:'failed',created_at:'2026-10-02T00:00:00Z'});
  const all=collect(d);assert.equal(all.unique[0].item.id,'a');assert.equal(all.olderEffective,1);assert.equal(metrics(all.rows).counts.U,0);assert.equal(all.operations[0].status,'failed');assert.equal(all.operations[0].item.id,'b');
  d.batch_items[0].current_route_id='new';d.item_routes=[{id:'new',status:'ready'}];d.ratings[0].route_id='old';assert.equal(collect(d).unique[0].status,'failed');
});
test('同一次记录重试失败不抹掉此前有效结果，最新成功结果按完成时间选择',()=>{
  const d=fixture();add(d,'a','one','001','L2');d.ratings.push({id:'retry',item_id:'a',status:'failed',created_at:'2026-10-03T00:00:00Z'});assert.equal(collect(d).unique[0].status,'L2');
  d.ratings.push({id:'success',item_id:'a',status:'completed',created_at:'2026-10-04T00:00:00Z',report:{grade:'L3'}});assert.equal(collect(d).unique[0].status,'L3');
});
test('六项指标使用明确分母，U和失败不混入可评价记录，分母为零保留未知',()=>{
  const d=fixture();for(const [i,g]of ['L0','L1','L2','L3','U',null].entries())add(d,String(i),'one',String(i),g);
  const m=metrics(collect(d).rows);assert.equal(m.valid,6);assert.equal(m.done,5);assert.equal(m.evaluable,4);assert.equal(m.coverage,5/6);assert.equal(m.delivery,.25);assert.equal(m.assisted,.5);assert.equal(m.error,.25);assert.equal(m.unknown,.2);assert.equal(metrics([]).delivery,null);
});
test('日期筛选与趋势只采用业务时间，缺失时间不回退到导入或评级时间',()=>{
  const d=fixture();add(d,'a','one','001','L3','2026-10-01');add(d,'b','two','002','L0','2026-10-05');add(d,'c','two','003','U','');
  d.batch_items[2].created_at='2026-10-05T00:00:00Z';const all=collect(d);assert.equal(all.undated,1);assert.deepEqual(trend(all.rows).map(x=>x.day),['2026-10-01','2026-10-05']);
  assert.deepEqual(collect(d,{from:'2026-10-03',to:'2026-10-08'}).unique.map(r=>r.item.id),['b']);assert.equal(businessDay({business_record:{fields:{created_time:'2026-02-30'}}}),null);assert.equal(businessDay({business_record:{fields:{created_time:'2026-10-01T20:00:00Z'}}}),'2026-10-02');
});
test('范围筛选不复活同记录的旧场景与旧日期，未知编号的历史行不跨批次合并',()=>{
  const d=fixture();add(d,'a','one','001','L0');add(d,'b','two','001','L3','2026-10-05');d.batch_items[1].record_snapshot.analytics_scene_id='new-scene';assert.equal(collect(d,{scene:'scene'}).unique.length,0);
  assert.equal(collect(d,{batch:'one'}).unique.length,1);
  for(const id of ['a','b']){const item=d.batch_items.find(i=>i.id===id);item.record_snapshot.business_record=null;item.logical_key='old-row-1';item.identity_quality='batch_row_only';}
  assert.equal(collect(d).unique.length,2);
});
test('固定底单复验跨导入版本关联，但普通评级轮次和别的记录不会混入改善证明',()=>{
  const d=fixture();add(d,'a','one','001','L0');add(d,'b','two','001','L3');add(d,'c','two','002','L0');
  d.runs=[{id:'before',kind:'offline_evidence_audit'},{id:'compare',kind:'uploaded_output_comparison',executed:true,base_run_id:'before',case_id:'case-a',before:{verdict:'conflict'},after:{verdict:'consistent'},case_snapshots:[{id:'case-a',record:d.batch_items[0].record_snapshot}]}];
  const selected=collect(d).unique.filter(r=>r.item.id==='b');assert.equal(comparisons(d,selected).length,1);assert.equal(comparisons(d,selected,{from:'2026-10-05'}).length,0);
});

test('租户精确筛选覆盖累计去重、原始数量、失败行、趋势及复验，不混入其他租户',()=>{
 const d=fixture(),a=add(d,'ta','one','same','L0'),b=add(d,'tb','two','same','L3'),c=add(d,'tc','one','same','L2');
 a.record_snapshot.business_record.fields.tenant_id='800029';b.record_snapshot.business_record.fields.tenant_id='800029';c.record_snapshot.business_record.fields.tenant_id='8000290';
 d.batch_items.push({id:'bad-a',batch_id:'one',raw_record:{'租户id':'800029'}},{id:'bad-b',batch_id:'one',raw_record:{tenant_id:'8000290'}},{id:'unknown',batch_id:'one'});
 const selected=collect(d,{tenant:'800029'});
 assert.equal(collect(d).unique.length,2);assert.equal(selected.unique.length,1);assert.equal(selected.unique[0].item.id,'tb');assert.equal(selected.rawCount,3);assert.equal(selected.rawValid,2);assert.equal(selected.duplicates,1);assert.equal(selected.batchCount,2);assert.deepEqual(selected.rows.map(r=>r.item.id),['tb','bad-a']);assert.equal(metrics(selected.rows).delivery,1);assert.equal(trend(selected.rows)[0].valid,1);
 d.runs=[a,c].map((item,i)=>({id:'compare-'+i,kind:'uploaded_output_comparison',executed:true,case_id:item.case_id,base_run_id:'before',before:{},after:{}}));
 assert.deepEqual(comparisons(d,selected.rows).map(r=>r.id),['compare-0']);assert.equal(collect(d,{tenant:'does-not-exist'}).rows.length,0);
});

test('租户 ID 保留前导零并兼容数字、原始列名和案例快照，未知租户仅在全部中显示',()=>{
 const B=require('../public/business-import');
 assert.equal(B.tenantId({business_record:{fields:{tenant_id:' 00800029 '}}}),'00800029');assert.equal(B.matchesTenant({tenant_id:800029},'800029'),true);assert.equal(B.matchesTenant({'租户ID':'00800029'},'800029'),false);assert.equal(B.tenantId({record_snapshot:{business_record:{fields:{tenant_id:'800029'}}}}),'800029');assert.equal(B.matchesTenant({},'800029'),false);assert.equal(B.matchesTenant({},'all'),true);
});
