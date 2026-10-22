'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const B=require('../public/business-import'),Field=require('../field-evaluation');
const {buildInput,validateOutput,SYSTEM,messagesFor}=require('../llm-rating');
const {helpReport,gradeBasis}=require('./helpers-rating.cjs');
function fixture(){
 const record=B.adaptRecord({'工单ID':'SYN-FIELD','traceId':'SYN-TRACE','租户id':'SYN','责任结论':'司机引导取消，维持判责。','关键信息提取':'司机车辆老旧并引导取消。','核心证据':'司机：车子老了。','行程对话':'司机：车子老了。'});
 const input=buildInput(record,{definition:{document:'辅助核对申诉材料，不从缺失材料反推AI未执行。'}},{fieldEvaluation:true});
 const ref=id=>input.reference_index.find(r=>r.source===id).id;
 const c=ref('ai_analysis_conclusion'),k=ref('ai_key_information'),e=ref('ai_core_evidence'),original=ref('journey_dialogue_text');
 const value={...helpReport(input),grade_basis:gradeBasis(input,'L2'),applicability:'applicable',grade:'L2',summary:'解决了什么：定位录音片段。\n\n没解决什么：取消认定缺乏支持，当前结论需复核。',dimensions:[{name:'责任依据',status:'gap',reason:'确定判断超出原话。',evidence_refs:[c,original]}],findings:[{finding_id:'F001',type:'事实判断',title:'将车辆老旧认定为取消引导',description:'信息提取和责任结论作出原话不能支持的确定判断。',evidence_reason:'原话只谈车辆老旧。',suggestion:'核听录音，修正确定表述。',suggestion_reason:'保留未核实边界。',problem_source_ids:['ai_analysis_conclusion','ai_key_information'],affects_primary_conclusion:true,impact:'若直接采用，会把未确认行为用于判责。',evidence_refs:[c,k,original],rule_refs:[],occurrences:[{source_id:'ai_analysis_conclusion',output_refs:[c],explanation:'责任结论把未经确认行为用于维持判责。',basis_type:'source_comparison',comparison_refs:[original]},{source_id:'ai_key_information',output_refs:[k],explanation:'提取将司机原话加入取消引导行为。',basis_type:'source_comparison',comparison_refs:[original]}]}],missing_materials:['完整录音—用于确认取消沟通。'],requires_review:true,
 output_assessments:input.field_evaluation.targets.map(t=>({source_id:t.source_id,task_relevance:t.available?'supporting':'not_required',status:!t.available?'not_applicable':t.source_id==='ai_core_evidence'?'no_issue_found':'issue',reason:t.source_id==='ai_core_evidence'?'准确摘录原话，不等于支持引导取消。':t.available?'存在与原话不符的确定断言。':'本次任务未要求单独输出该字段。',evidence_refs:t.available?[ref(t.source_id)]:[],finding_ids:t.available&&t.source_id!=='ai_core_evidence'?['F001']:[]})),
 material_limitations:[{material:'本次提供的录音语境不完整',status:'incomplete',limits:'无法核实是否实际引导乘客取消。',related_source_ids:['ai_analysis_conclusion','ai_key_information'],evidence_refs:[original],ai_handling:'overstated',finding_ids:['F001']}],
 conclusion_usability:{status:'not_usable',reason:'当前确定结论缺少引导取消的事实支持。',evidence_refs:[c]}};
 return {input,value,c,k,e,original};
}
test('逐字段草案仅显式启用，普通评估的输入、提示词和报告不受影响',()=>{
 const normal=buildInput({ai_reply:'需核对凭证。'},{definition:{document:'核对申诉。'}});assert.equal(normal.field_evaluation,undefined);assert.equal(messagesFor(normal,SYSTEM)[0].content,SYSTEM);
 const {input}=fixture(),messages=messagesFor(input,SYSTEM);assert.equal(input.field_evaluation.version,Field.VERSION);assert.match(messages[0].content,/摘录准确但不足以证明最终结论/);assert.deepEqual(JSON.parse(messages[2].content).field_evaluation,input.field_evaluation);
});
test('同一错误在两处出现各有原句和解释，正常核心证据不会被混入出错位置',()=>{
 const {input,value,c,k}=fixture(),report=validateOutput(value,input);
 assert.equal(report.findings.length,1);assert.equal(report.findings[0].occurrences.length,2);assert.equal(report.findings[0].occurrences[0].output_quotes[0].text,'司机引导取消，维持判责。');assert.equal(report.findings[0].occurrences[1].output_quotes[0].id,k);
 assert.equal(report.output_assessments.find(a=>a.source_id==='ai_core_evidence').status,'no_issue_found');assert.deepEqual(report.findings[0].problem_source_ids,['ai_analysis_conclusion','ai_key_information']);assert.equal(report.conclusion_usability.evidence_refs[0],c);
});
test('缺逐项评估、缺具体出现明细、错字段引文或漏关联问题均不能算完整报告',()=>{
 const {input,value,original}=fixture();
 const changes=[v=>delete v.output_assessments,v=>v.output_assessments.pop(),v=>v.findings[0].occurrences=[],v=>v.findings[0].occurrences[0].output_refs=[original],v=>v.findings[0].occurrences[0].explanation='',v=>v.findings[0].occurrences[0].comparison_refs=[],v=>v.findings[0].problem_source_ids=['ai_analysis_conclusion'],v=>v.output_assessments.find(a=>a.source_id==='ai_analysis_conclusion').status='no_issue_found',v=>v.output_assessments.push(v.output_assessments[0]),v=>v.findings[0].impact=''];
 for(const change of changes){const bad=structuredClone(value);change(bad);assert.throws(()=>validateOutput(bad,input),/逐字段评估|说明|影响/);}
});
test('已确认结论问题与可用性不能矛盾，核对材料不能作为出错输出',()=>{
 const {input,value,original}=fixture();assert.throws(()=>validateOutput({...value,conclusion_usability:{...value.conclusion_usability,status:'usable'}},input),/不能宣称结论可用/);
 const bad=structuredClone(value);bad.findings[0].occurrences[0].source_id='journey_dialogue_text';bad.findings[0].occurrences[0].output_refs=[original];assert.throws(()=>validateOutput(bad,input),/核对材料不能当作出错字段/);
});
test('材料不足但AI保留边界时可无具体错误；不能仅凭缺材料认定越界',()=>{
 const {input,value,c}=fixture();input.sources.find(s=>s.id==='ai_analysis_conclusion').text='现有材料不足，需核实后再判断责任。';input.sources.find(s=>s.id==='ai_key_information').text='司机提及车辆老旧，取消引导行为待核实。';input.reference_index=require('../rating-context').referenceIndex(input);value.material_limitations[0].evidence_refs.push(c);value.findings=[];value.output_assessments=value.output_assessments.map(a=>({...a,status:a.source_id==='ai_analysis_conclusion'?'unknown':a.status==='issue'?'no_issue_found':a.status,finding_ids:[],reason:a.source_id==='ai_analysis_conclusion'?'AI已明确表示核实后再判断。':a.available?'当前可见内容未发现问题。':a.reason}));value.material_limitations[0].ai_handling='qualified';value.material_limitations[0].finding_ids=[];value.conclusion_usability={status:'needs_verification',reason:'关键材料不足，AI已标明核实前不确定责任。',evidence_refs:[c]};
 const report=validateOutput(value,input);assert.equal(report.findings.length,0);assert.equal(report.material_limitations[0].ai_handling,'qualified');assert.equal(report.requires_review,true);
 value.material_limitations[0].ai_handling='overstated';assert.throws(()=>validateOutput(value,input),/不能仅凭材料缺失认错/);
});
test('未提供字段不能假称检查过；未提供结论时只能保留无法判断',()=>{
 const {input,value}=fixture(),missing=value.output_assessments.find(a=>!input.field_evaluation.targets.find(t=>t.source_id===a.source_id).available);missing.status='no_issue_found';assert.throws(()=>validateOutput(value,input),/未提供字段不能宣称已检查/);
});

test('逐项评估覆盖专项维度时允许无重复维度，但旧协议仍要求原维度',()=>{
 const {input,value}=fixture();value.dimensions=[];assert.equal(validateOutput(value,input).output_assessments.length,input.field_evaluation.targets.length);const noBasis=structuredClone(value);delete noBasis.grade_basis;assert.throws(()=>validateOutput(noBasis,input),/判级依据/);
 const legacy={...input};delete legacy.field_evaluation;assert.throws(()=>validateOutput(value,legacy),/检查维度/);
});

test('仅凭本次材料范围确认确定性越界时，必须关联材料限制而非一边判错一边称未知',()=>{
 const {input,value}=fixture();value.findings[0].occurrences[0].basis_type='provided_material_scope';value.material_limitations[0].ai_handling='not_assessable';value.material_limitations[0].finding_ids=[];
 assert.throws(()=>validateOutput(value,input),/越界须与材料限制关联/);
});

test('声称AI已保留核验边界时，必须出示AI的原句而不能只引用原始材料',()=>{
 const {input,value}=fixture();value.material_limitations[0].ai_handling='qualified';value.material_limitations[0].finding_ids=[];
 assert.throws(()=>validateOutput(value,input),/须引用其明确表述/);
});
