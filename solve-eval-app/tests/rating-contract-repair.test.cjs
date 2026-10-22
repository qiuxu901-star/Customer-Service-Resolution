'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {buildInput,validateOutput,requestPerformanceRating,SYSTEM,messagesFor}=require('../llm-rating');
const {helpReport,gradeBasis}=require('./helpers-rating.cjs');
const config={base_url:'http://localhost:1/v1',api_key:'TEST',model:'fixture',rating_options:{pricing:{input_per_million:1,cached_input_per_million:0.1,output_per_million:2,currency:'USD'}}};
function fixture(){
 const input=buildInput({scope:'tier2',business_record:{kind:'tier2',fields:{ai_analysis_conclusion:'司机表示车辆故障，需核对维修记录。',transcript_text:'司机：车辆故障。'}}},{definition:{document:'核查本单故障说法并说明依据。'}},{evaluatorSkill:{version:'v1',decision_contract:1,document:'按具体帮助与剩余工作判断L1、L2、L3。'}});
 const ai=input.reference_index.find(r=>r.role==='ai_output').id;
 const finding={type:'表达问题',title:'建议没有说明具体核对项',description:'核查建议需进一步明确。',evidence_reason:'输出只说核对维修记录。',suggestion:'列出维修日期和订单时间的核对步骤。',suggestion_reason:'便于客服继续核对。',problem_source_ids:['ai_analysis_conclusion'],affects_primary_conclusion:true,impact:'客服需补充拆解核对步骤，判责方向尚无法确认。',evidence_refs:[ai],rule_refs:[]};
 const good={applicability:'applicable',grade:'L2',summary:'关键点是什么：已梳理争议。\n\n没解决什么：仍需核实维修事实。',...helpReport(input),grade_basis:gradeBasis(input),dimensions:[{name:'任务帮助',status:'gap',reason:'仍需核实',evidence_refs:[ai],rule_refs:['P001']}],findings:[finding],missing_materials:[],requires_review:false};
 return {input,good};
}
function provider(raws){const calls=[];return {calls,fetchImpl:async(_url,o)=>{calls.push(JSON.parse(o.body));return {ok:true,json:async()=>({choices:[{message:{content:raws[Math.min(calls.length-1,raws.length-1)]},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120,prompt_tokens_details:{cached_tokens:10}}})};}};}
for(const [name,damage,error]of [
 ['结论位置与影响标记矛盾',v=>{v.findings[0].affects_primary_conclusion=false;},/责任结论自身/],
 ['L1同时列出具体帮助',v=>{v.grade='L1';v.grade_basis.substantive_value={confirmed:false,reason:'尚未确认',evidence_refs:[]};},/已确认具体帮助/],
 ['具体帮助遗漏引用数组',v=>{delete v.helpful_contributions[0].evidence_refs;},/具体帮助证据编号/],
 ['具体帮助引用不存在编号',v=>{v.helpful_contributions[0].evidence_refs=['E999'];},/具体帮助证据编号/],
 ['具体帮助误用source编号',v=>{v.helpful_contributions[0].evidence_refs=['ai_analysis_conclusion'];},/具体帮助证据编号/],
 ['规则编号被缩写',v=>{v.dimensions[0].rule_refs=['P1'];},/规则引用/]
])test(name+'：仍拒绝错误报告，并反馈模型纠正一次',async()=>{
 const {input,good}=fixture(),bad=structuredClone(good);damage(bad);const original=JSON.stringify(bad);
 assert.throws(()=>validateOutput(bad,input),error);
 const p=provider([original,JSON.stringify(good)]),result=await requestPerformanceRating(input,config,p);
 assert.equal(p.calls.length,2);assert.deepEqual(result.value,good);assert.equal(JSON.stringify(bad),original);
 assert.match(JSON.parse(p.calls[1].messages.at(-1).content).validation_error,error);
 assert.equal(result.response_attempts[0].raw,original);assert.equal(result.response_attempts[1].status,'completed');
 assert.equal(result.usage.total_tokens,240);assert.equal(result.usage.cached_tokens,20);assert.ok(result.cost_estimate.amount>0);
});
test('JSON损坏反馈一次，返回完整报告；不通过本地拼补猜测内容',async()=>{
 const {input,good}=fixture(),raw=JSON.stringify(good).slice(0,-1),p=provider([raw,JSON.stringify(good)]);
 const result=await requestPerformanceRating(input,config,p);assert.deepEqual(result.value,good);assert.equal(result.response_attempts[0].raw,raw);assert.equal(p.calls.length,2);
});
test('纠错仍失败则保留两次原文、用量和错误，不产出报告或伪U',async()=>{
 const {input,good}=fixture(),bad=structuredClone(good);bad.helpful_contributions[0].evidence_refs=['E999'];const raw=JSON.stringify(bad),p=provider([raw]);
 await assert.rejects(()=>requestPerformanceRating(input,config,p),e=>e.raw_response===raw&&e.response_attempts.length===2&&e.usage.total_tokens===240&&/具体帮助证据编号/.test(e.message));assert.equal(p.calls.length,2);
});
test('有效结果只调用一次，HTTP及截断错误不自动重发',async()=>{
 const {input,good}=fixture(),p=provider([JSON.stringify(good)]);await requestPerformanceRating(input,config,p);assert.equal(p.calls.length,1);
 let calls=0;await assert.rejects(()=>requestPerformanceRating(input,config,{fetchImpl:async()=>{calls++;return {ok:false,status:429};}}),/HTTP 429/);assert.equal(calls,1);
 calls=0;await assert.rejects(()=>requestPerformanceRating(input,config,{fetchImpl:async()=>{calls++;return {ok:true,json:async()=>({choices:[{message:{content:'{'},finish_reason:'length'}]})};}}),/不完整/);assert.equal(calls,1);
});
test('纠错遵守输入预算，原始工单、规则及协议保持固定',async()=>{
 const {input,good}=fixture(),p=provider(['{']);const initial=messagesFor(input,SYSTEM);await assert.rejects(()=>requestPerformanceRating(input,{...config,rating_options:{max_input_chars:initial.reduce((n,m)=>n+m.content.length,0)+1}},p),/超过输入预算/);assert.equal(p.calls.length,1);
 const q=provider(['{',JSON.stringify(good)]);await requestPerformanceRating(input,config,q);assert.deepEqual(q.calls[1].messages.slice(0,3),q.calls[0].messages);assert.deepEqual(q.calls[0].messages,initial);
 const constraints=JSON.parse(initial.at(-1).content).output_constraints;assert.ok(constraints.rule_refs.includes('P001'));assert.ok(!constraints.rule_refs.includes('P1'));assert.deepEqual(constraints.problem_source_ids,['ai_analysis_conclusion']);assert.ok(constraints.ai_output_evidence_refs.every(id=>constraints.evidence_refs.includes(id)));
});
