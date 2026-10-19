'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {aggregate,record}=require('../public/analysis-summary');
function row(id,status,findings=[],extra={}){return {item:{id,case_id:'case-'+id,record_snapshot:{scene:'取消费'}},status,rating:{report:{summary:'本条结论',findings,...extra},monitor_binding:{revision_id:'plan-1'}}};}
const finding={type:'事实核验',description:'已有外呼却判断未联系',suggestion:'核对外呼结果后回复',rule_refs:['P1']};
test('问题条数按记录去重，归并相同方案与类型且保留全部下钻记录',()=>{
  const s=aggregate([row('a','L0',[finding,finding]),row('b','L2',[finding]),row('c','L3')]);
  assert.equal(s.issues.length,1);assert.equal(s.issues[0].count,2);assert.deepEqual(s.issues[0].ids,['a','b']);assert.equal(s.affected,2);assert.match(s.conclusion,/事实核验.*2 条/);
});
test('局部规则编号相同的不同方案不会混为同一问题',()=>{
  const a=row('a','L0',[finding]),b=row('b','L2',[finding]);b.rating.monitor_binding.revision_id='plan-2';assert.equal(aggregate([a,b]).issues.length,2);
});
test('执行失败与待匹配保留待处理状态，不复用旧报告或记为能力错误',()=>{
  const s=aggregate([row('a','failed',[finding]),row('b','routing_pending',[finding]),row('c','U',[],{missing_materials:['有效政策']})]);
  assert.equal(s.assessed,1);assert.equal(s.remaining,2);assert.equal(s.issues.length,1);assert.equal(s.issues[0].kind,'missing');assert.equal(s.counts.L0,0);assert.match(s.conclusion,/补齐材料/);assert.equal(record(row('a','failed',[finding])).findings.length,0);
});
test('无问题、无法判断与尚未评级分别给出明确结论，不补造缺陷',()=>{
  assert.equal(aggregate([]).assessed,0);assert.match(aggregate([]).conclusion,/尚未形成评级/);
  assert.match(aggregate([row('a','L3')]).conclusion,/未列出明确问题/);
  assert.match(record(row('b','U',[],{missing_materials:['话单']})).advice,/补充话单/);
  assert.equal(aggregate([row('a','L0')]).issues[0].kind,'review');
});
test('先呈现关键错误，再按影响记录数排列，代表建议始终来自源记录',()=>{
  const s=aggregate([row('a','L0',[finding]),row('b','L2',[{...finding,type:'政策适用'}]),row('c','L2',[{...finding,type:'政策适用'}])]);
  assert.equal(s.issues[0].title,'事实核验');assert.equal(s.issues[1].count,2);assert.equal(s.issues[0].suggestions[0],finding.suggestion);
});

test('改进卡的来源保留具体发现位置和原文；同类建议不丢失，材料不足不默认改客服 Skill',()=>{
 const {improvement}=require('../public/analysis-summary');const a=row('a','L1',[{...finding,quotes:[{quote:'摘录原文'}]}]),b=row('b','L2',[{...finding,suggestion:'另一条具体建议'}]);a.rating.id='r-a';b.rating.id='r-b';a.item.batch_id=b.item.batch_id='batch';
 const issue=aggregate([a,b]).issues[0];assert.equal(issue.sources.length,2);assert.equal(issue.sources[0].finding_index,0);assert.equal(issue.sources[0].quotes[0].quote,'摘录原文');assert.equal(issue.sources[1].suggestion,'另一条具体建议');assert.equal(improvement(issue).target,'AI 客服 Skill');assert.equal(improvement(aggregate([row('u','U',[],{missing_materials:['话单']})]).issues[0]).target,'业务依据或证据');
});

test('同场景的基础分析按评估对象分开归并，避免一份改进混入不同客服对象',()=>{const a=row('a','L1',[finding]),b=row('b','L1',[finding]);a.item.record_snapshot.scope='frontline';b.item.record_snapshot.scope='tier2';assert.equal(aggregate([a,b]).issues.length,2);});
