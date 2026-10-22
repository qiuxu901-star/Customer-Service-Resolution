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
 const issue=aggregate([a,b]).issues[0];assert.equal(issue.sources.length,2);assert.equal(issue.sources[0].finding_index,0);assert.equal(issue.sources[0].quotes[0].quote,'摘录原文');assert.equal(issue.sources[1].suggestion,'另一条具体建议');assert.equal(improvement(issue).target,'表现问题／原因待诊断');assert.equal(improvement(aggregate([row('u','U',[],{missing_materials:['话单']})]).issues[0]).target,'业务依据或证据');
});

test('同场景的基础分析按评估对象分开归并，避免一份改进混入不同客服对象',()=>{const a=row('a','L1',[finding]),b=row('b','L1',[finding]);a.item.record_snapshot.scope='frontline';b.item.record_snapshot.scope='tier2';assert.equal(aggregate([a,b]).issues.length,2);});

test('白话标题用于阅读，归并仍按类型；每个案例的依据、建议和理由成套保留',()=>{
 const a=row('a','L1',[{...finding,title:'没有核对联系结果',suggestion:'',evidence_reason:'案例甲依据',suggestion_reason:'案例甲理由',quote:'旧版引用',source:'ai'}]);a.rating.id='ra';a.rating.request_snapshot={sources:[{id:'ai',label:'实际回复'}]};
 const b=row('b','L1',[{...finding,title:'另一白话标题',suggestion:'案例乙建议',evidence_reason:'案例乙依据',suggestion_reason:'案例乙理由'}]);b.rating.id='rb';
 const issue=aggregate([a,b]).issues[0];assert.equal(issue.count,2);assert.equal(issue.title,'没有核对联系结果');assert.equal(issue.sources[0].suggestion,'');assert.equal(issue.sources[0].suggestion_reason,'案例甲理由');assert.equal(issue.sources[1].suggestion,'案例乙建议');assert.equal(issue.sources[1].evidence_reason,'案例乙依据');assert.equal(issue.sources[0].quotes[0].label,'实际回复');
 assert.equal(a.rating.report.findings[0].quotes,undefined);
});

test('固定类别跨同义类型和规则编号归并，所有发现保留；分类版本、待处理状态分别展示',()=>{
 const a=row('a','L1',[finding]),b=row('b','L1',[{...finding,type:'另一说法',rule_refs:['G2','P2']}]);a.rating.id='ra';b.rating.id='rb';
 const category={id:'C01',name:'用户诉求理解或回应不到位',definition:'主要请求没有回应'};
 const assignment={finding_index:0,status:'classified',category,classification:{taxonomy_revision_id:'taxonomy-v1',category_id:'C01'},taxonomy_version:'v1'};
 a.classifications=[assignment];b.classifications=[assignment];const s=aggregate([a,b]);assert.equal(s.issues.length,1);assert.equal(s.issues[0].count,2);assert.equal(s.issues[0].sources.length,2);assert.equal(s.issues[0].category.definition,category.definition);
 b.classifications=[{...assignment,classification:{...assignment.classification,taxonomy_revision_id:'taxonomy-v2'},taxonomy_version:'v2'}];assert.equal(aggregate([a,b]).issues.length,2);
 b.classifications=[];assert.equal(aggregate([b]).issues[0].title,'尚未归类');b.classifications=[{finding_index:0,status:'unclassified'}];assert.equal(aggregate([b]).issues[0].title,'未分类');b.classifications=[{finding_index:0,status:'outdated'}];assert.equal(aggregate([b]).issues[0].title,'需重新归类');
});

test('新旧报告共用摘要提取，旧报告不伪造评价原因和可读性，U不假定无缺口',()=>{
 const {conclusionParts}=require('../public/analysis-summary');
 const report={grade:'L2',summary:'关键点是什么：已有事实整理，但关键条件未确认。\n\n没解决什么：核对记录。',output_readability:{status:'needs_improvement',reason:'依据对应不清。'}};
 const p=conclusionParts(report);assert.equal(p.key_points,'已有事实整理，但关键条件未确认。');assert.equal(p.unresolved,'核对记录。');assert.equal(p.readability_status,'需要改进');assert.equal(p.legacy,false);
 const old={summary:'解决了什么：提取事实。\n\n没解决什么：核对记录。'},before=structuredClone(old);const historic=conclusionParts(old);assert.match(historic.key_points,/历史成果摘要/);assert.equal(historic.readability_status,'未评估');assert.equal(historic.legacy,true);assert.deepEqual(old,before);
 assert.match(conclusionParts({grade:'U',summary:'缺材料，无法评价。'}).unresolved,/暂不能确认/);
 const stale=record({status:'failed',rating:{report},item:{}});assert.doesNotMatch(stale.key_points,/已有事实整理/);assert.equal(stale.readability_status,'未评估');
 const basis=conclusionParts({...old,grade_basis:{critical_error:{confirmed:true,reason:'关键说话人颠倒，影响核心判断。'}}});assert.equal(basis.key_points,'关键说话人颠倒，影响核心判断。');
});
