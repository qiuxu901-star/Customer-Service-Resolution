'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function workspace(){
  const nodes=new Map(),listeners=new Map();
  const node=id=>{if(!nodes.has(id))nodes.set(id,{id,value:'',innerHTML:'',textContent:'',hidden:false,scrollTop:0,dataset:{},style:{setProperty(){}},classList:{add(){},remove(){},toggle(){}},setAttribute(){},removeAttribute(){},focus(){},querySelector(){return null;},querySelectorAll(){return [];},insertAdjacentHTML(){}});return nodes.get(id);};
  const context=vm.createContext({document:{getElementById:node,querySelector:node,querySelectorAll:()=>[],addEventListener:(name,fn,capture=false)=>{if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push({fn,capture});},body:{classList:{add(){},remove(){},toggle(){},contains(){return false;}},style:{setProperty(){}}}},window:{addEventListener(){},scrollTo(){}},localStorage:{getItem:()=>'',setItem(){},removeItem(){}},fetch:async()=>{throw Error('Unexpected request');},setTimeout:()=>1,clearTimeout(){},structuredClone,crypto:require('node:crypto').webcrypto,XLSX:{}});
  const dir=path.join(__dirname,'../public'),html=fs.readFileSync(path.join(dir,'workbench.html'),'utf8');for(const m of html.matchAll(/<script src="\/([^"]+)"/g)){if(!m[1].startsWith('vendor/'))vm.runInContext(fs.readFileSync(path.join(dir,m[1]),'utf8'),context,{filename:m[1]});}
  const run=code=>vm.runInContext(code,context);run(`data={plans:[],revisions:[],candidates:[],cases:[],runs:[],services:[],tasks:[],scenes:[],scene_assignments:[],unmapped_scenes:[],examples:[],batches:[],batch_items:[],ratings:[],rating_reviews:[],rating_runs:[],item_routes:[],batch_routing_reviews:[],routing_confirmations:[],model_config:{profiles:[],configured:false}};workspaceConversations=[];scope='all';sceneFilter='all';`);
  function click(dataset){const b={dataset,disabled:false,hasAttribute(name){return Object.hasOwn(dataset,name.replace(/^data-/, '').replace(/-([a-z])/g,(_,x)=>x.toUpperCase()));}};const event={target:{closest:()=>b}};for(const {fn}of [...listeners.get('click')].sort((a,b)=>Number(b.capture)-Number(a.capture)))fn(event);}
  return {run,node,click,dispatch(name,event){for(const {fn}of [...(listeners.get(name)||[])].sort((a,b)=>Number(b.capture)-Number(a.capture)))fn(event);}};
}
test('人工复核状态与模型等级、执行状态独立筛选，待补充不会归为已复核',()=>{
  const x=workspace();x.run(`data.rating_reviews=[{rating_id:'a',status:'待补充'},{rating_id:'b',status:'已复核'}];var testRows=[{item:{id:'1'},rating:{id:'a'},status:'U'},{item:{id:'2'},rating:{id:'b'},status:'L2'},{item:{id:'3'},rating:{id:'c'},status:'L2'},{item:{id:'4'},status:'failed'}];workspaceReviewTab='pending';`);
  assert.equal(x.run('filteredWorkspaceRows(testRows).map(r=>r.item.id).join()'),'3');
  x.run(`workspaceReviewTab='needs_info'`);assert.equal(x.run('filteredWorkspaceRows(testRows).map(r=>r.item.id).join()'),'1');
  x.run(`workspaceReviewTab='reviewed';workspaceRecordStatus='L2'`);assert.equal(x.run('filteredWorkspaceRows(testRows).map(r=>r.item.id).join()'),'2');
  x.run(`workspaceReviewTab='all';workspaceRecordStatus='all';workspaceExecutionFilter='failed'`);assert.equal(x.run('filteredWorkspaceRows(testRows).map(r=>r.item.id).join()'),'4');
});
test('数据分析下钻保留待处理和待复核条件，不被导航重置覆盖',()=>{
  const x=workspace();x.run(`view='analytics';batchId='all';workspaceReviewTab='needs_info';workspaceExecutionFilter='failed'`);x.click({analyticsRecords:'actionable'});
  assert.equal(x.run('view'),'records');assert.equal(x.run('workspaceExecutionFilter'),'actionable');assert.equal(x.run('workspaceReviewTab'),'all');
  x.run(`view='analytics'`);x.click({analyticsRecords:'review'});assert.equal(x.run('workspaceReviewTab'),'pending');assert.equal(x.run('workspaceExecutionFilter'),'all');
});
test('配置页与数据页分别记忆对象范围；无评级时清楚提示而非零绩效',()=>{
  const x=workspace();x.run(`view='analytics';scope='all';show('plans',{restore:true});`);assert.equal(x.run('scope'),'frontline');x.run(`scope='tier2';show('analytics',{restore:true})`);assert.equal(x.run('scope'),'all');x.run(`show('plans',{restore:true})`);assert.equal(x.run('scope'),'tier2');
  x.run(`show('analytics',{restore:true})`);assert.match(x.node('view').innerHTML,/尚未形成评级/);
});
test('同一证据弹窗并列原文与复核表单，连续处理遵循当前队列',()=>{
  const x=workspace();x.run(`data.batches=[{id:'batch',name:'合成批次'}];data.batch_items=['a','b'].map(id=>({id,case_id:'case-'+id,batch_id:'batch',record_snapshot:{name:'记录'+id,scope:'frontline',session_text:'可核对原文',ai_reply:'测试回复'}}));data.ratings=['a','b'].map(id=>({id:'rating-'+id,item_id:id,status:'completed',report:{grade:'L2',summary:'合成结论'}}));view='records';workspaceRecordsBatch='all';workspaceReviewDrafts.set('rating-a',{decision:'change',grade:'L1',reason:'保留的复核理由',evidence:'原文依据'});openWorkspaceEvidence('a',true);`);
  assert.match(x.node('modalBody').innerHTML,/可核对原文/);assert.match(x.node('modalBody').innerHTML,/保留的复核理由/);assert.match(x.node('modalBody').innerHTML,/保存并下一条/);assert.equal(x.run('workspaceEvidenceQueue.join()'),'a,b');
});

test('确认页优先展开异常分组，正常分组折叠仍保留全部选择和整批确认要求',()=>{
  const x=workspace();x.run(`data.batches=[{id:'batch'}];data.batch_routing_reviews=[{batch_id:'batch',confirmed:false,valid_count:2,group_count:2,pending_group_count:1,can_confirm:false,groups:[{key:'ready',scope:'frontline',scene_name:'已匹配',ready:true,count:1,scene_id:'scene',choices:[],item_ids:[]},{key:'exception',scope:'tier2',scene_name:'缺失场景',ready:false,count:1,choices:[],reason:'请补充场景',item_ids:[]}]}];`);
  const html=x.run(`routingConfirmationPanel(data.batches[0])`);
  assert.ok(html.indexOf('data-routing-group="exception"')<html.indexOf('data-routing-group="ready"'));
  assert.match(html,/<details class="routing-group" open data-routing-group="exception"/);assert.match(html,/<details class="routing-group" data-routing-group="ready"/);
  assert.match(html,/data-routing-candidate="ready"/);assert.match(html,/data-learning-start disabled/);assert.match(html,/当前筛选条件不缩小确认范围/);
});

test('用户输入保留原样，助手正文渲染层级；旧对话兼容且卡片入口不重复',()=>{
  const x=workspace();
  const user=x.run(`workspaceMessageHtml({role:'user',content:'**用户原文**\\n<script>测试</script>'})`);
  assert.match(user,/\*\*用户原文\*\*/);assert.doesNotMatch(user,/<strong>用户原文|<script>/);
  const old=x.run(`workspaceMessageHtml({role:'assistant',content:'**先看重点**\\n\\n### 原因\\n- 缺少依据'})`);
  assert.match(old,/<strong>先看重点<\/strong>/);assert.match(old,/<h3>原因<\/h3>/);
  const rich=x.run(`workspaceMessageHtml({role:'assistant',content:'先核对依据。',presentation:{version:1,blocks:[{type:'metrics',context:{scope:'all',scene_id:'all',batch_id:'all'},data:{valid:1,evaluated:1,evaluable:0,counts:{U:1,L3:0},l3_delivery_rate:null}}]},actions:[{type:'analytics',label:'查看数据分析',context:{scope:'all',scene_id:'all',batch_id:'all'}}]})`);
  assert.equal((rich.match(/data-workspace-action="analytics"/g)||[]).length,1);
  assert.match(rich,/全部对象 · 全部场景 · 全部任务/);
});

test('评估员维护页显示全局生效版本与独立草稿，不受场景范围影响且正文安全转义',()=>{
  const x=workspace();x.run(`data.evaluator_skill={active_revision_id:'v1',head_revision_id:'v2',revisions:[{id:'v1',number:1,name:'评估员',document:'全局规则',confirmed_by:'测试',confirmed_at:'2026-10-16T00:00:00Z'},{id:'v2',number:2,name:'评估员',document:'草稿<script>不能执行</script>',note:'边界修订'}],trials:[]};show('evaluator');`);
  const html=x.node('view').innerHTML;assert.match(html,/当前生效 v1/);assert.match(html,/最新草稿 v2/);assert.match(html,/确认生效 v2/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.equal(x.node('crumb').textContent,'评估员 Skill');
});
test('编辑缓冲保留未保存内容；服务器出现新版本时拒绝覆盖并提示核对',()=>{
  const x=workspace();x.run(`data.evaluator_skill={active_revision_id:'v1',head_revision_id:'v1',revisions:[{id:'v1',number:1,name:'评估员',document:'原文',confirmed_by:'测试',confirmed_at:'2026-10-16T00:00:00Z'}],trials:[]};show('evaluator');evaluatorBuffer.document='用户未保存的改动';evaluatorBuffer.dirty=true;data.evaluator_skill.revisions.push({id:'v2',number:2,name:'评估员',document:'其他维护人的改动'});data.evaluator_skill.head_revision_id='v2';render();`);
  assert.match(x.node('view').innerHTML,/用户未保存的改动/);assert.match(x.node('view').innerHTML,/服务器已有新版本/);assert.match(x.node('view').innerHTML,/data-evaluator-save disabled/);assert.equal(x.run('evaluatorBuffer.base_revision_id'),'v1');
});
test('版本差异安全显示增加与删除；旧报告不伪造评估员版本，生效后默认比较前一版本',()=>{
  const x=workspace(),html=x.run(`evaluatorDiffLines('原规则\\n删除项','原规则\\n<script>新增项</script>')`);assert.match(html,/diff-remove/);assert.match(html,/diff-add/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(x.run(`evaluatorRatingVersions({request_snapshot:{service_skills:[]}})`),/历史版本未独立记录/);assert.equal(x.run(`evaluatorBaselineId({active_revision_id:'v2',head_revision_id:'v2',revisions:[{id:'v1'},{id:'v2'}]})`),'v1');
});

function insightWorkspace(){
  const x=workspace();x.run(`
    data.batches=[{id:'batch',name:'合成批次',imported_count:3}];
    data.batch_items=['a','b','c'].map(id=>({id,case_id:'case-'+id,batch_id:'batch',record_snapshot:{name:'记录'+id,scope:'frontline',scene:'合成场景',session_text:'原文完整内容',ai_reply:'回复'}}));
    data.ratings=['a','b','c'].map(id=>({id:'rating-'+id,item_id:id,status:'completed',monitor_binding:{revision_id:'plan'},report:{grade:id==='c'?'L3':'L0',summary:'简短结论',findings:id==='c'?[]:[{type:'事实核验',description:'具体事实矛盾',suggestion:'核对原始话单',rule_refs:['P1']}],dimensions:[],missing_materials:[]}}));
    batchId='batch';view='analytics';
  `);return x;
}
test('总结下钻只显示相关记录，连续查看遵循问题队列，返回保留原分析范围',()=>{
  const x=insightWorkspace();x.click({insightIssue:'0'});
  assert.equal(x.run('view'),'records');assert.equal(x.run('workspaceRecordsBatch'),'batch');
  assert.equal(x.run('filteredWorkspaceRows(workspaceRows({batch:workspaceRecordsBatch})).map(r=>r.item.id).join()'),'a,b');
  x.click({workspaceEvidence:'a'});assert.equal(x.run('workspaceEvidenceQueue.join()'),'a,b');
  assert.match(x.node('modalBody').innerHTML,/<section class="evidence-source"><h3>导入数据<\/h3>/);assert.doesNotMatch(x.node('modalBody').innerHTML,/id="workspaceReviewReason"/);
  x.click({insightReturn:''});assert.equal(x.run('view'),'analytics');assert.equal(x.run('batchId'),'batch');assert.equal(x.run('insightSelection'),null);
});
test('直接导航全部记录时清除问题范围，清除问题筛选保留当前批次',()=>{
  const x=insightWorkspace();x.click({insightIssue:'0'});x.click({insightClear:''});
  assert.equal(x.run('workspaceRecordsBatch'),'batch');assert.equal(x.run('filteredWorkspaceRows(workspaceRows({batch:workspaceRecordsBatch})).length'),3);
  x.run(`view='analytics'`);x.click({insightIssue:'0'});x.click({view:'records'});
  assert.equal(x.run('insightSelection'),null);assert.equal(x.run('workspaceRecordsBatch'),'all');
});
test('已完成批次默认展示总结，记录和任务设置各在独立隐藏面板',()=>{
 const x=insightWorkspace();x.run(`analysisTaskId='batch';view='batches';data.batch_routing_reviews=[{batch_id:'batch',confirmed:true,groups:[]}];`);
 const html=x.run('renderAnalysisTasks()');assert.match(html,/aria-label="批次工作区"/);assert.match(html,/id="batchTab-summary" role="tab" aria-selected="true"/);assert.match(html,/id="batchPanel-records"[^>]*hidden/);assert.match(html,/id="batchPanel-settings"[^>]*hidden/);assert.match(html,/role="tablist" aria-label="本批问题" aria-orientation="vertical"/);assert.equal((html.match(/class="batch-issue-detail"/g)||[]).length,1);assert.doesNotMatch(html,/展开其余|class="task-sticky-actions"/);
 x.click({batchTab:'settings'});assert.equal(x.run(`batchWorkspaceState('batch').tab`),'settings');assert.doesNotMatch(x.node('view').innerHTML,/id="batchPanel-settings"[^>]*hidden/);
});
test('列表打开精简结论，明确点击复核后才展示表单且保留返回入口',()=>{
  const x=insightWorkspace(),html=x.run('workspaceRecordsPanel(workspaceRows())');
  assert.match(html,/data-workspace-evidence="a"/);assert.doesNotMatch(html,/data-workspace-review=/);
  x.click({workspaceEvidence:'a'});assert.match(x.node('modalBody').innerHTML,/<section class="evidence-source">[\s\S]*原文完整内容[\s\S]*<\/section><section class="evidence-result insight-record-body">/);assert.match(x.node('modalBody').innerHTML,/主要问题/);assert.match(x.node('modalBody').innerHTML,/核对原始话单/);
  x.click({workspaceReview:'rating-a'});assert.match(x.node('modalBody').innerHTML,/id="workspaceReviewReason"/);assert.match(x.node('modalBody').innerHTML,/返回结论/);
});
test('从结论创建待办时带入主要问题与具体建议，用户可继续补充验收标准',()=>{
  const x=insightWorkspace();x.click({ratingTask:'rating-a'});
  assert.match(x.node('modalBody').innerHTML,/id="ratingTaskDescription"[^>]*>具体事实矛盾/);
  assert.match(x.node('modalBody').innerHTML,/id="ratingTaskGoal"[^>]*>核对原始话单/);
});
test('分析进度固定显示，未确认批次的设置面板保留唯一确认入口',()=>{
 const x=insightWorkspace();x.run(`analysisTaskId='batch';view='batches';data.batch_routing_reviews=[{batch_id:'batch',confirmed:true,groups:[]}];data.rating_runs=[{id:'run',batch_id:'batch',status:'running',processed_count:1,total:3}];`);
 assert.match(x.run('renderAnalysisTasks()'),/已处理 1 \/ 3 条/);assert.match(x.run('renderAnalysisTasks()'),/class="batch-run-status" role="status"/);
 x.run(`data.rating_runs=[];data.batch_routing_reviews=[{batch_id:'batch',confirmed:false,groups:[],can_confirm:true}];`);const html=x.run('renderAnalysisTasks()');assert.equal((html.match(/data-learning-start/g)||[]).length,1);assert.doesNotMatch(html,/id="confirmBatchRouting"/);assert.match(html,/没有专属方案也没关系/);
});
test('数据分析默认统计全部批次，进入过单批任务不污染全量，指标先于问题和效果',()=>{
  const x=insightWorkspace();x.run(`data.batches.push({id:'second',name:'第二批'});data.batch_items.push({id:'d',case_id:'case-d',batch_id:'second',record_snapshot:{name:'第二批记录',scope:'frontline'}});openWorkspaceBatch('batch');`);
  x.click({view:'analytics'});assert.equal(x.run('analyticsBatch'),'all');assert.equal(x.run('analyticsSnapshot().unique.length'),4);
  const html=x.node('view').innerHTML;assert.ok(html.indexOf('整体能力')<html.indexOf('主要问题'));assert.ok(html.indexOf('主要问题')<html.indexOf('改进效果'));assert.match(html,/累计导入 4 行/);assert.match(html,/全部导入数据 · 去重统计/);assert.equal((html.match(/class="dashboard-metric[ "]/g)||[]).length,6);
});
test('最新有效评级位于早期批次时指标下钻仍能打开正确记录，返回保持日期范围',()=>{
  const x=insightWorkspace();x.run(`data.batches[0].source_system='crm';data.batches.push({id:'newer',source_system:'crm'});data.batch_items[0].record_snapshot.business_record={kind:'frontline',fields:{session_id:'same',session_time:'2026-10-01'}};data.batch_items.push({id:'new-a',case_id:'new-case-a',batch_id:'newer',record_snapshot:{name:'新导入',scope:'frontline',business_record:{fields:{session_id:'same',session_time:'2026-10-01'}}}});analyticsFrom='2026-10-01';analyticsTo='2026-10-02';render();`);
  assert.equal(x.run('analyticsSnapshot().olderEffective'),1);x.click({dashboardDrill:'0'});
  assert.equal(x.run('filteredWorkspaceRows(workspaceRows({batch:workspaceRecordsBatch})).map(r=>r.item.id).join()'),'a');
  x.click({workspaceEvidence:'a'});assert.match(x.node('modalBody').innerHTML,/主要问题/);assert.equal(x.run('workspaceEvidenceQueue.join()'),'a');
  x.click({insightReturn:''});assert.equal(x.run('analyticsFrom'),'2026-10-01');assert.equal(x.run('analyticsTo'),'2026-10-02');assert.equal(x.run('analyticsSnapshot().unique.length'),1);
});

test('本批总结呈现问题、建议、原因和验证，主操作面向客服 Skill，监测入口折叠',()=>{
 const x=insightWorkspace();x.run(`analysisTaskId='batch';view='batches';`);
 const panel=x.run(`insightSummaryHtml(workspaceRows({batch:'batch',target:'all',scene:'all'}),'batch','本批分析总结')`);
 for(const label of ['问题','改进建议','为什么要改','改后怎么看效果','查看来源和各条记录的建议','整理为 AI 客服 Skill 改进待办'])assert.ok(panel.includes(label));
 assert.match(panel,/具体事实矛盾/);assert.match(panel,/核对原始话单/);assert.doesNotMatch(panel,/data-learning-generate/);
 const secondary=x.run(`learningPanel('batch')`);assert.match(secondary,/<details[^>]+learning-secondary/);assert.match(secondary,/评估有遗漏或判断不对/);assert.doesNotMatch(secondary,/data-learning-generate|查看本批建议并选择/);
 x.click({insightImprove:'0'});const html=x.node('modalBody').innerHTML;assert.match(html,/整理 AI 客服 Skill 改进待办/);assert.match(html,/id="skillChangeProblem"[^>]*>具体事实矛盾/);assert.match(html,/id="skillChangeSuggestion"[^>]*>核对原始话单/);assert.match(html,/暂不指定，先保存改进说明/);assert.match(html,/不会自动修改或发布 Skill/);
});
test('改进说明可交付给 Skill 维护人，含原始来源和验证边界',()=>{
 const x=workspace();const doc=x.run(`skillChangeDocument({title:'核查事实',owner:'维护人',description:'来源不清',goal:'输出交代来源',skill_change:{suggestion:'增加核实步骤',reason:'避免直接断言',target_skill:{code:'客服',version:'1'},source_findings:[{record_name:'案例一',rating_id:'r',description:'具体发现',suggestion:'具体建议',quotes:[{quote:'原文摘录'}]}]}})`);
 for(const text of ['建议怎么改','为什么要改','改后如何验证','来源案例','原文摘录','不是已发布 Skill','不从个案阈值'])assert.ok(doc.includes(text));
});
test('新草稿只用本批记录试用，失败不能启用，旧版汇总草稿只读',()=>{
 const x=workspace();x.run(`data.monitor_learning={batch_groups:[],drafts:[{id:'d',workflow_version:2,source_batch_id:'batch',source_batch_name:'本批名称',scene_id:'s',scene_name:'接驾',scope:'tier2',status:'draft',document:'规则',content_hash:'h',changes:[],trial_rating_ids:['r'],source_signals:[{case_id:'c',batch_id:'batch'}]}],trials:[]};learningOpen('d');`);
 let html=x.node('modalBody').innerHTML;assert.match(html,/本批名称/);assert.match(html,/用本批记录试一试/);assert.match(html,/本次共 2 次调用/);assert.doesNotMatch(html,/data-learning-activate/);
 x.run(`data.monitor_learning.trials=[{id:'t',draft_id:'d',draft_hash:'h',status:'completed_with_errors',cases:[{record_name:'记录',baseline_mode:'basic',sides:{baseline:{status:'failed',error:'调用失败'},candidate:{status:'completed',report:{grade:'L1',summary:'分析不足',findings:[],missing_materials:[]}}}}]}];learningOpen('d');`);
 html=x.node('modalBody').innerHTML;assert.match(html,/本次试用未完成/);assert.match(html,/本批原来的基础分析/);assert.doesNotMatch(html,/data-learning-activate/);x.run(`delete data.monitor_learning.drafts[0].workflow_version;learningOpen('d');`);html=x.node('modalBody').innerHTML;assert.match(html,/旧版历史汇总草稿/);assert.doesNotMatch(html,/data-learning-trial|data-learning-activate/);
});

test('保存后的客服 Skill 待办先给出修改建议和下载，进度作为次要操作',()=>{
 const x=workspace();x.run(`data.tasks=[{id:'t',source:'record_rating',title:'客服改进',description:'<script>问题</script>',owner:'维护人',status:'待修改',goal:'新输出可核验',skill_change:{suggestion:'补上分析步骤',reason:'避免遗漏',target_skill:null,source_findings:[]}}];taskEditor(null,null,'t');`);const html=x.node('modalBody').innerHTML;assert.match(html,/补上分析步骤/);assert.match(html,/为什么要改/);assert.match(html,/data-skill-change-download="t"/);assert.ok(html.indexOf('下载改进说明')<html.indexOf('登记处理进度'));assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
});

test('问题与依据分别切换，每个问题保留阅读位置，目录选择在记录页返回后保持',()=>{
 const x=insightWorkspace();x.run(`view='batches';analysisTaskId='batch';data.ratings[1].report.findings=[{type:'语境遗漏',description:'漏了关键陈述',suggestion:'结合原文分析'}];render();`);
 x.node('batchIssueScroll').scrollTop=137;x.click({batchIssue:'1'});assert.equal(x.run(`batchWorkspaceState('batch').issueKey`),x.run(`AnalysisSummary.aggregate(insightRows()).issues[1].key`));
 x.node('batchIssueScroll').scrollTop=84;x.click({batchDetailTab:'sources'});assert.match(x.node('view').innerHTML,/id="batchDetail-sources" role="tab" aria-selected="true"/);assert.equal(x.node('batchIssueScroll').scrollTop,0);
 x.node('batchIssueScroll').scrollTop=52;x.click({batchDetailTab:'advice'});assert.equal(x.node('batchIssueScroll').scrollTop,84);
 x.click({batchIssue:'0'});assert.equal(x.node('batchIssueScroll').scrollTop,137);x.click({batchTab:'records'});x.node('batchRecordsScroll').scrollTop=160;x.click({batchTab:'summary'});assert.equal(x.node('batchIssueScroll').scrollTop,137);x.click({batchTab:'records'});assert.equal(x.node('batchRecordsScroll').scrollTop,160);
});
test('问题搜索可到达原本折叠的问题，空结果安全显示，清空后恢复可选目录',()=>{
 const x=insightWorkspace();x.run(`view='batches';analysisTaskId='batch';data.ratings[1].report.findings=[{type:'语境遗漏',description:'漏了关键陈述',suggestion:'结合原文分析'}];render();`);
 x.dispatch('input',{target:{id:'batchIssueSearch',value:'语境',dataset:{}}});assert.match(x.node('view').innerHTML,/找到 1 类问题/);assert.match(x.node('view').innerHTML,/id="batchIssueDetail"[\s\S]*?<h2>语境遗漏<\/h2>/);
 x.dispatch('input',{target:{id:'batchIssueSearch',value:'<script>',dataset:{}}});assert.match(x.node('view').innerHTML,/没有匹配的问题/);assert.match(x.node('view').innerHTML,/value="&lt;script&gt;"/);assert.doesNotMatch(x.node('view').innerHTML,/<script>/);
 x.dispatch('input',{target:{id:'batchIssueSearch',value:'',dataset:{}}});assert.match(x.node('view').innerHTML,/data-batch-issue="0"/);assert.match(x.node('view').innerHTML,/data-batch-issue="1"/);
});
test('问题内下钻留在批次记录页签，复核队列只包含涉及记录，返回保持问题',()=>{
 const x=insightWorkspace();x.run(`view='batches';analysisTaskId='batch';render();`);const selected=x.run(`batchWorkspaceState('batch').issueKey`);x.click({batchRelated:'0'});assert.equal(x.run('view'),'batches');assert.equal(x.run(`batchWorkspaceState('batch').tab`),'records');assert.equal(x.run('filteredWorkspaceRows(insightRows()).map(r=>r.item.id).join()'),'a,b');x.click({workspaceEvidence:'a'});assert.equal(x.run('workspaceEvidenceQueue.join()'),'a,b');x.click({batchTab:'summary'});assert.equal(x.run(`batchWorkspaceState('batch').issueKey`),selected);x.click({batchClearRelated:''});assert.equal(x.run('filteredWorkspaceRows(insightRows()).length'),3);
});
test('每个批次分别保留页签、问题及记录筛选，新批次未分析时默认任务设置',()=>{
 const x=insightWorkspace();x.run(`view='batches';analysisTaskId='batch';render();`);x.click({batchTab:'records'});x.run(`workspaceRecordStatus='L0';workspaceReviewTab='pending';render();data.batches.push({id:'second',name:'第二批',imported_count:0});`);x.click({workspaceBatch:'second'});assert.equal(x.run(`batchWorkspaceState('second').tab`),'settings');x.click({workspaceBatch:'batch'});assert.equal(x.run(`batchWorkspaceState('batch').tab`),'records');assert.equal(x.run('workspaceRecordStatus'),'L0');assert.equal(x.run('workspaceReviewTab'),'pending');
});
