'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {buildInput,validateOutput,VERSION}=require('../llm-rating');
const {helpReport,gradeBasis}=require('./helpers-rating.cjs');
function fixture(grade='L2'){
 const input=buildInput({ai_reply:'已整理双方对支付的不同说法，需核对支付记录。',session_text:'司机说没有线下收取；乘客说已支付。'},{definition:{document:'核查收费争议。'}});
 const ai=input.reference_index.find(r=>r.role==='ai_output').id;
 const value={applicability:'applicable',grade,summary:'已整理争议，客服仍需核对支付记录。',...helpReport(input,grade),grade_basis:gradeBasis(input,grade),dimensions:[{name:'争议整理',status:'pass',reason:'保留不同说法。',evidence_refs:[ai]}],findings:[],missing_materials:['支付记录：用于确认是否重复收取。'],requires_review:true};
 return {input,value,ai};
}
test('新版强制保存任务、具体成果、帮助解释与剩余工作；不能用形式完整替代这些内容',()=>{
 const {input,value}=fixture(),report=validateOutput(value,input);
 assert.equal(input.contract_version,VERSION);assert.deepEqual(report.helpful_contributions,value.helpful_contributions);assert.deepEqual(report.remaining_work,value.remaining_work);assert.equal(report.task_summary,value.task_summary);
 for(const key of ['task_summary','helpful_contributions','remaining_work']){const bad=structuredClone(value);delete bad[key];assert.throws(()=>validateOutput(bad,input),/本次任务|具体帮助与剩余工作/);}
 const bad=structuredClone(value);bad.helpful_contributions[0].benefit='';assert.throws(()=>validateOutput(bad,input),/减少的客服工作/);
});
test('具体帮助必须引用AI成果，不能引用规则、索引、人工意见或伪造材料代替；剩余工作须解释并取证',()=>{
 const {input,value}=fixture();
 for(const refs of [[],['P001'],['E999'],[input.reference_index.find(r=>r.role==='context').id]]){const bad=structuredClone(value);bad.helpful_contributions[0].evidence_refs=refs;assert.throws(()=>validateOutput(bad,input),/具体帮助/);}
 for(const patch of [{kind:'unknown'},{reason:''},{evidence_refs:[]}]){const bad=structuredClone(value);Object.assign(bad.remaining_work[0],patch);assert.throws(()=>validateOutput(bad,input),/剩余工作/);}
});
test('等级与具体帮助和剩余工作一致；旧冻结报告仍能读取，不伪造新版内容',()=>{
 const {input,value}=fixture();
 assert.throws(()=>validateOutput({...value,helpful_contributions:[]},input),/L2\/L3/);
 assert.throws(()=>validateOutput({...value,remaining_work:[]},input),/L1\/L2/);
 assert.throws(()=>validateOutput({...value,grade:'L1'},input),/具体帮助.*L1/);
 assert.throws(()=>validateOutput({...value,grade:'L3'},input),/L3本次任务/);
 const {task_summary,helpful_contributions,remaining_work,...legacy}=value;
 const old=validateOutput(legacy,{...input,contract_version:'resolution-llm/v5.3'});assert.equal(old.task_summary,undefined);assert.equal(old.grade,'L2');
 const u=fixture('U');u.value.remaining_work=[];u.value.helpful_contributions=[];assert.equal(validateOutput(u.value,u.input).grade,'U');
 const l3=fixture('L3');assert.equal(validateOutput(l3.value,l3.input).grade,'L3');
});
function uiContext(){
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const context=vm.createContext({AnalysisSummary:require('../public/analysis-summary'),esc,names:{},renderHome:()=>'',render:()=>'',ratingDetail:()=>'',document:{addEventListener(){}},window:{addEventListener(){}},planDocumentMarkup:esc,data:{rating_runs:[],revisions:[]}});
 for(const file of ['finding-presentation.js','llm-rating-workbench.js','evaluator-workbench.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../public',file),'utf8'),context,{filename:file});
 return context;
}
test('报告按五项展示，原文可展开且转义；历史报告不填造新结论，详细规则折叠',()=>{
 const c=uiContext(),{input,value}=fixture();c.rating={report:value,request_snapshot:input};
 const html=vm.runInContext('llmReportHtml(rating)',c);
 const headings=['评估结论','关键点是什么','没解决什么'];let previous=-1;for(const title of headings){const at=html.indexOf('>'+title+'<');assert.ok(at>previous,title);previous=at;}assert.match(html,/本次任务：/);assert.ok(html.indexOf('aria-label="AI 输出可读性"')<html.indexOf('aria-label="具体问题与依据"'));assert.doesNotMatch(html,/查看表达与可读性评估/);assert.match(html,/<details class="assistance-detail"><summary>查看具体帮助、剩余工作与依据/);
 assert.match(html,/<details class="assistance-detail"><summary>查看详细检查/);assert.match(html,/帮客服减少的工作/);assert.match(html,/查看原文依据/);
 c.report={...value,task_summary:'<script>alert(1)</script>'};assert.doesNotMatch(vm.runInContext('assistanceReportHtml(report)',c),/<script>/);
 c.rating={report:{...value,task_summary:undefined},request_snapshot:input};assert.match(vm.runInContext('llmReportHtml(rating)',c),/历史报告，未记录新版/);
});
test('公共标准阅读视图展示真实等级表格与列表，并转义正文内容',()=>{
 const c=uiContext();c.documentText=require('../evaluator-skill').DEFAULT_DOCUMENT;
 const html=vm.runInContext('publicStandardMarkup(documentText)',c);assert.match(html,/<table/);assert.match(html,/<th>等级<\/th>/);assert.match(html,/<td>L2：有明确帮助/);assert.match(html,/<ul>/);assert.doesNotMatch(html,/\| --- \|/);
});

test('结论按两段短句展示，支持模型分段和已有结构化成果，长段落可展开而不改写原结论',()=>{
 const c=uiContext();
 c.report={summary:'解决了什么：定位了停车费争议。\n\n没解决什么：费用是否真实发生仍需核对凭证。'};
 let html=vm.runInContext('evaluationConclusionHtml(report)',c);assert.match(html,/<h4>关键点是什么<\/h4><p>历史成果摘要：定位了停车费争议。/);assert.match(html,/<h4>没解决什么<\/h4><p>费用是否真实发生仍需核对凭证。/);assert.match(html,/查看原结论/);
 c.report={summary:'旧版一整段结论',task_summary:'核查费用',helpful_contributions:[{result:'已定位费用项目'}],remaining_work:[{work:'仍需核对支付记录'}]};html=vm.runInContext('evaluationConclusionHtml(report)',c);assert.match(html,/旧版一整段结论/);assert.match(html,/仍需核对支付记录/);
 c.report={summary:'无法确认最终责任',grade:'U',missing_materials:['缺少支付记录']};html=vm.runInContext('evaluationConclusionHtml(report)',c);assert.match(html,/无法确认最终责任/);assert.match(html,/查看原结论/);assert.equal(c.report.summary,'无法确认最终责任');
 c.report={summary:'解决了什么：'+('已确认事实。'.repeat(30))+'\n\n没解决什么：仍需核查。'};html=vm.runInContext('evaluationConclusionHtml(report)',c);assert.match(html,/展开完整说明/);assert.match(html,/…/);
});

test('问题位置独立于核对引用，拒绝把原始会话、人工意见或编号伪造成出错输出',()=>{
 const {input,value,ai}=fixture();
 const finding={type:'依据边界',title:'结论越界',description:'AI将单方陈述作为确定事实。',evidence_reason:'原话未支持确定结论。',suggestion:'核对原话。',suggestion_reason:'保留待核实边界。',evidence_refs:[ai],rule_refs:[],problem_source_ids:['ai_reply'],affects_primary_conclusion:true,impact:'客服需核实后才能采用。'};
 value.findings=[finding];const saved=validateOutput(value,input).findings[0];assert.deepEqual(saved.problem_source_ids,['ai_reply']);assert.equal(saved.impact,finding.impact);
 for(const ids of [['session_text'],['E999'],[],['missing']])assert.throws(()=>validateOutput({...value,findings:[{...finding,problem_source_ids:ids}]},input),/问题位置/);
 assert.throws(()=>validateOutput({...value,findings:[{...finding,impact:''}]},input),/问题影响/);
 const legacy={...finding};for(const key of ['problem_source_ids','affects_primary_conclusion','impact'])delete legacy[key];assert.equal(validateOutput({...value,findings:[legacy]},input).findings[0].problem_source_ids,undefined);
});

test('新版结论解释判级原因，列表和详情复用且转义，不再展示解决了什么标题',()=>{
 const c=uiContext(),report={grade:'L2',summary:'关键点是什么：已准确整理双方说法，但支付状态未核实，因此仍需补齐。\n\n没解决什么：核对支付记录后完成重复收费判断。',task_summary:'核查重复收费',output_readability:{status:'clear',reason:'已知和待核实事项分明'}};
 c.report=report;const html=vm.runInContext('evaluationConclusionHtml(report)',c);
 assert.match(html,/<h4>关键点是什么<\/h4><p>已准确整理双方说法/);assert.doesNotMatch(html,/解决了什么|查看原结论/);
 const parts=require('../public/analysis-summary').record({status:'L2',rating:{report}});assert.ok(html.includes(parts.key_points));assert.ok(html.includes(parts.unresolved));
 c.report={summary:'关键点是什么：<script>bad</script>。\n\n没解决什么：核对记录。'};assert.doesNotMatch(vm.runInContext('evaluationConclusionHtml(report)',c),/<script>/);
});
