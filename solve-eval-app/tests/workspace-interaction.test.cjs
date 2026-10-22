'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function workspace(){
  const nodes=new Map(),listeners=new Map();
  const node=id=>{if(!nodes.has(id))nodes.set(id,{id,value:'',innerHTML:'',textContent:'',hidden:false,scrollTop:0,dataset:{},style:{setProperty(){}},classList:{add(){},remove(){},toggle(){},contains(){return false;}},setAttribute(){},removeAttribute(){},focus(){},querySelector(){return null;},querySelectorAll(){return [];},insertAdjacentHTML(){}});return nodes.get(id);};
  const context=vm.createContext({document:{getElementById:node,querySelector:node,querySelectorAll:()=>[],addEventListener:(name,fn,capture=false)=>{if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push({fn,capture});},body:{classList:{add(){},remove(){},toggle(){},contains(){return false;}},style:{setProperty(){}}}},window:{addEventListener(){},scrollTo(){}},localStorage:{getItem:()=>'',setItem(){},removeItem(){}},fetch:async()=>{throw Error('Unexpected request');},setTimeout:()=>1,clearTimeout(){},structuredClone,crypto:require('node:crypto').webcrypto,XLSX:{}});
  context.window.fetch=context.fetch;
  const dir=path.join(__dirname,'../public'),html=fs.readFileSync(path.join(dir,'workbench.html'),'utf8');for(const m of html.matchAll(/<script src="\/([^"]+)"/g)){if(!m[1].startsWith('vendor/'))vm.runInContext(fs.readFileSync(path.join(dir,m[1]),'utf8'),context,{filename:m[1]});}
  const run=code=>vm.runInContext(code,context);run(`data={plans:[],revisions:[],candidates:[],cases:[],runs:[],services:[],tasks:[],scenes:[],scene_assignments:[],unmapped_scenes:[],examples:[],batches:[],batch_items:[],ratings:[],rating_reviews:[],rating_runs:[],item_routes:[],batch_routing_reviews:[],routing_confirmations:[],model_config:{profiles:[],configured:false}};workspaceConversations=[];scope='all';sceneFilter='all';`);
  function click(dataset){const b={dataset,disabled:false,hasAttribute(name){return Object.hasOwn(dataset,name.replace(/^data-/, '').replace(/-([a-z])/g,(_,x)=>x.toUpperCase()));}};const event={target:{closest:()=>b}};for(const {fn}of [...listeners.get('click')].sort((a,b)=>Number(b.capture)-Number(a.capture)))fn(event);}
  return {run,node,click,dispatch(name,event){for(const {fn}of [...(listeners.get(name)||[])].sort((a,b)=>Number(b.capture)-Number(a.capture)))fn(event);}};
}
function capabilityWorkspace(){const x=workspace(),cap=require('../evaluation-capability'),definition=JSON.stringify(cap.DEFAULT_CONFIGURATION),catalog=JSON.stringify({step_types:cap.STEP_TYPES,source_keys:cap.SOURCE_KEYS,plans:[{scene_id:'scene',scene_name:'接驾异常',scope:'tier2',selection_id:'plan-r1',plan_id:'plan',revision_number:1,name:'接驾检查'}]});x.run(`data.scenes=[{id:'scene',name:'接驾异常',status:'active',scopes:['tier2']}];data.evaluator_skill={active_revision_id:'v5',head_revision_id:'v5',revisions:[{id:'v5',number:5,document:'规则',confirmed_by:'测试',confirmed_at:'2026-10-20T00:00:00Z',capability:${definition}}],capability_defaults:${definition},capability_catalog:${catalog},trials:[],executions:[]};show('evaluator');`);return x;}
test('流程只呈现四个主步骤及用途，复制流程不会改变原流程',()=>{const x=capabilityWorkspace();x.run(`evaluatorTab='branches';render();`);assert.match(x.node('view').innerHTML,/公共标准＋场景专项检查/);assert.match(x.node('view').innerHTML,/接驾检查/);x.run(`evaluatorTab='flows';render();`);const html=x.node('view').innerHTML;assert.equal((html.match(/class="cap-step"/g)||[]).length,4);for(const text of ['准备评估资料','模型评估','检查评估结果','保存报告','读取本条工单','校验失败时显示原因'])assert.ok(html.includes(text),text);assert.doesNotMatch(html,/添加检查步骤|检查材料提供情况|证据摘录初筛|data-cap-add-step|data-cap-condition|data-cap-source/);x.click({capCopyFlow:''});assert.equal(x.run('capabilityDraft().flows.length'),2);assert.equal(x.run('capabilityDraft().default_flow_id'),'standard');x.dispatch('input',{target:{id:'capFlowName',value:'副本名称',dataset:{}}});assert.equal(x.run('capabilityFlow().name'),'副本名称');assert.equal(x.run('capabilityDraft().flows[0].name'),'标准表现评估');assert.equal(x.run('capabilityFlow().steps.length'),4);assert.equal(x.run('evaluatorBuffer.dirty'),true);});
test('历史附加步骤保留原数据且不可新增编辑，复制后的新流程只含四步',()=>{const x=capabilityWorkspace();x.run(`var legacyFlow=capabilityDraft().flows[0];legacyFlow.steps.splice(1,0,{id:'materials',type:'material_check',condition:'always',options:{source_ids:['ai_core_evidence']}},{id:'quotes',type:'evidence_quote_check',condition:'has_context',options:{}});evaluatorTab='flows';render();`);const html=x.node('view').innerHTML;assert.equal((html.match(/class="cap-step"/g)||[]).length,4);assert.match(html,/历史配置兼容信息/);assert.doesNotMatch(html,/data-cap-add-step|data-cap-remove-step|data-cap-move|data-cap-condition|data-cap-source/);x.click({capAddStep:'',capAddType:'material_check'});assert.equal(x.run('capabilityFlow().steps.length'),6);x.click({capCopyFlow:''});assert.equal(x.run('capabilityFlow().steps.length'),4);assert.equal(x.run('capabilityDraft().flows[0].steps.length'),6);x.run(`data.evaluator_skill.executions=[{id:'legacy',name:'历史工单',status:'completed',step_runs:[{type:'material_check',name:'检查材料提供情况',status:'completed',result:{missing_source_ids:[]}}]}];`);x.click({capExecution:'legacy'});assert.match(x.node('modalBody').innerHTML,/检查材料提供情况/);assert.match(x.node('modalBody').innerHTML,/missing_source_ids/);});
test('默认场景明确转为分支草稿；已停用和当前绑定不会因页面切换丢失',()=>{const x=capabilityWorkspace();x.run(`evaluatorTab='branches';render();`);x.click({capMaterialize:''});assert.equal(x.run('capabilityDraft().branches.length'),1);assert.equal(x.run('capabilityDraft().branches[0].selection_id'),'plan-r1');x.dispatch('change',{target:{id:'capBranchEnabled',checked:false,dataset:{}}});assert.equal(x.run('capabilityDraft().branches[0].enabled'),false);x.run(`evaluatorTab='flows';render();evaluatorTab='branches';render();`);assert.match(x.node('view').innerHTML,/已停用/);assert.match(x.node('view').innerHTML,/data-settings-toggle/);});
test('执行记录展示真实阶段与错误，历史记录不补造步骤',()=>{const x=capabilityWorkspace();x.run(`data.evaluator_skill.executions=[{id:'old',name:'旧记录',status:'completed',created_at:'2026-10-20T00:00:00Z'},{id:'new',name:'新记录',status:'failed',created_at:'2026-10-20T00:00:00Z',error:'评分格式无效',step_runs:[{id:'validate',type:'validate',status:'failed',error:'评分格式无效'},{id:'save',type:'save',status:'pending'}]}];evaluatorTab='executions';render();`);assert.match(x.node('view').innerHTML,/历史未记录场景分支/);x.click({capExecution:'new'});assert.match(x.node('modalBody').innerHTML,/检查评估结果/);assert.match(x.node('modalBody').innerHTML,/评分格式无效/);assert.match(x.node('modalBody').innerHTML,/未执行/);x.click({capExecution:'old'});assert.match(x.node('modalBody').innerHTML,/未保存步骤明细/);});
test('评估配置列出缺方案场景，正文直接可读且不常驻绑定下拉框',()=>{
  const x=capabilityWorkspace();x.run(`data.scenes.push({id:'missing',name:'待补场景',status:'active',scopes:['frontline','tier2']});data.plans=[{id:'plan',name:'接驾检查',scene_id:'scene',scope:'tier2',current_revision_id:'plan-r1'}];data.revisions=[{id:'plan-r1',plan_id:'plan',number:1,confirmed:true,data:{name:'接驾检查',scene_id:'scene',scope:'tier2',document:'## 核验依据\\n直接展示完整判据'}}];render();`);
  const html=x.node('view').innerHTML;assert.match(html,/待补场景/);assert.match(html,/公共标准评估/);assert.match(html,/直接展示完整判据/);assert.doesNotMatch(html,/id="capBranchPlan"|id="capBranchFlow"/);assert.equal(x.run('capabilityBranches().length'),2);
  x.run(`show('plans');`);assert.equal(x.run('view'),'evaluator');assert.equal(x.node('crumb').textContent,'评估配置');
});
test('未配置或只有草稿时显示公共标准；已有专项、主动选公共和失效绑定分别呈现',()=>{
 const x=capabilityWorkspace();x.run(`data.evaluator_skill.capability_catalog.plans=[];render();`);assert.equal(x.run('settingsAssessmentMode(capabilityBranch()).kind'),'public');assert.match(x.node('view').innerHTML,/仅使用公共评估标准/);assert.match(x.node('view').innerHTML,/可正常评级/);assert.doesNotMatch(x.node('view').innerHTML,/待补充方案|在导入确认时选择方案/);
 x.run(`data.plans=[{id:'p',scene_id:'scene',scope:'tier2',current_revision_id:'draft'}];data.revisions=[{id:'draft',plan_id:'p',number:1,confirmed:false,data:{name:'待确认方案',scene_id:'scene',scope:'tier2',document:'专项判据'}}];render();`);assert.equal(x.run('settingsAssessmentMode(capabilityBranch()).kind'),'public');assert.match(x.node('view').innerHTML,/当前仍按公共评估标准评级/);
 x.run(`capabilityDraft().branches=[{id:'public',name:'仅公共',scene_id:'scene',scope:'tier2',selection_id:'__basic__',flow_id:'standard',enabled:true}];capabilitySelection='public';render();`);assert.equal(x.run('settingsAssessmentMode(capabilityBranch()).kind'),'public');
 x.run(`capabilityDraft().branches[0].selection_id='obsolete';render();`);assert.equal(x.run('settingsAssessmentMode(capabilityBranch()).kind'),'invalid');assert.match(x.node('view').innerHTML,/绑定的方案需要更新/);x.run(`capabilityDraft().branches[0].enabled=false;render();`);assert.equal(x.run('settingsAssessmentMode(capabilityBranch()).kind'),'blocked');assert.match(x.node('view').innerHTML,/暂停评估/);
});
test('无方案导入组显示公共标准，不误报已识别多套方案，也不要求先补场景文档',()=>{
 const x=capabilityWorkspace();x.run(`data.batches=[{id:'batch'}];data.batch_routing_reviews=[{batch_id:'batch',confirmed:false,valid_count:1,group_count:1,pending_group_count:0,can_confirm:true,groups:[{key:'g',scene_id:'scene',scene_name:'接驾异常',scope:'tier2',ready:true,count:1,choices:[],item_ids:[],selected_binding:{kind:'basic_evaluation',definition:{name:'基础分析检查'}}}]}];`);const html=x.run('routingConfirmationPanel(data.batches[0])');assert.match(html,/仅使用公共评估标准/);assert.match(html,/未配置场景专属方案，已使用公共评估标准/);assert.doesNotMatch(html,/已识别多套可用方案|去补充监测方案/);assert.match(html,/data-learning-start >确认并开始分析/);
});
test('方案未保存内容跨场景和页签保留，新建方案不会覆盖现有方案',()=>{
  const x=capabilityWorkspace();x.run(`data.plans=[{id:'plan',name:'接驾检查',scene_id:'scene',scope:'tier2',current_revision_id:'plan-r1'}];data.revisions=[{id:'plan-r1',plan_id:'plan',number:1,confirmed:true,data:{name:'接驾检查',scene_id:'scene',scope:'tier2',document:'原文',service_refs:['skill'],service_bindings:[{id:'skill',modules:['a']}]}}];render();`);
  x.click({settingsEdit:''});x.dispatch('input',{target:{id:'settingsPlanDocument',value:'未保存的新判据',dataset:{}}});x.click({settingsCloseEditor:''});assert.match(x.node('view').innerHTML,/有未保存内容/);x.run(`evaluatorTab='flows';render();evaluatorTab='branches';render();`);x.click({settingsEdit:''});assert.match(x.node('view').innerHTML,/未保存的新判据/);assert.equal(x.run('settingsDocumentDraft(capabilityBranch()).definition.service_bindings[0].modules[0]'),'a');
  x.click({settingsNewPlan:''});assert.match(x.node('view').innerHTML,/切换查看 · 1 套/);assert.equal(x.run('settingsDocumentDraft(capabilityBranch()).plan_id'),undefined);assert.equal(x.run('data.revisions[0].data.document'),'原文');assert.equal(x.run("settingsDocumentDrafts.get('plan:plan').document"),'未保存的新判据');
});
test('编辑联动方案时保留原执行对象与参与范围，不因查看二线分支而改写',()=>{
 const x=capabilityWorkspace();x.run(`data.plans=[{id:'linked',scene_id:'scene',scope:'linked',current_revision_id:'linked-r1'}];data.revisions=[{id:'linked-r1',plan_id:'linked',number:1,confirmed:true,data:{name:'联动方案',scene_id:'scene',scope:'linked',participants:['frontline','tier2'],document:'联动判据'}}];render();`);assert.equal(x.run('settingsPlan(capabilityBranch()).id'),'linked');assert.equal(x.run('settingsDocumentDraft(capabilityBranch()).scope'),'linked');assert.equal(x.run('settingsDocumentDraft(capabilityBranch()).definition.participants.join()'),'frontline,tier2');
});
test('场景列表仅呈现一次，共用配置默认打开，新增差异和恢复继承保留原方案文档',()=>{
  const x=capabilityWorkspace();x.run(`data.scenes[0].scopes=['frontline','tier2'];data.evaluator_skill.capability_catalog.plans=[];capabilitySelection=null;render();`);
  let html=x.node('view').innerHTML;assert.equal((html.match(/data-settings-scene="scene"/g)||[]).length,1);assert.equal(x.run('capabilityBranch().scope'),'shared');assert.match(html,/共用配置/);assert.doesNotMatch(html,/class="settings-common-standard"|class="settings-context"|class="settings-chain"|class="panel evaluator-live"/);
  assert.ok(html.indexOf('data-evaluator-tab="branches"')<html.indexOf('data-evaluator-tab="editor"'));
  x.click({settingsAddTarget:''});x.click({settingsTarget:'tier2'});assert.equal(x.run('capabilityBranch().scope'),'tier2');assert.equal(x.run('capabilityDraft().branches.length'),1);assert.equal(x.run('capabilityDraft().branches[0].selection_id'),'__basic__');
  x.click({settingsInherit:''});assert.equal(x.run('capabilityBranch().scope'),'shared');assert.equal(x.run('capabilityDraft().branches.length'),1);assert.equal(x.run('capabilityDraft().branches[0].scope'),'shared');assert.equal(x.run('evaluatorDraft().dirty'),true);
});
test('已有一二线差异保持单独配置，修改共用配置不覆盖差异，单独编辑共用文档时复制为新方案',()=>{
  const x=capabilityWorkspace();x.run(`data.scenes[0].scopes=['frontline','tier2'];data.plans=[{id:'shared-plan',scene_id:'scene',scope:'linked',current_revision_id:'shared-r'}];data.revisions=[{id:'shared-r',plan_id:'shared-plan',number:1,confirmed:true,data:{name:'共用接驾方案',scene_id:'scene',scope:'linked',participants:['frontline','tier2'],document:'共用判据原文'}}];data.evaluator_skill.capability_catalog.plans=[{scope:'frontline',scene_id:'scene',selection_id:'shared-r',name:'共用接驾方案',revision_number:1},{scope:'tier2',scene_id:'scene',selection_id:'shared-r',name:'共用接驾方案',revision_number:1},{scope:'tier2',scene_id:'scene',selection_id:'legacy-r',name:'旧二线方案',revision_number:1}];capabilitySelection=null;render();`);
  assert.equal(x.run('capabilityBranch().scope'),'shared');assert.match(x.node('view').innerHTML,/二线助手 · 单独配置/);
  x.click({settingsBinding:''});x.node('settingsBindingPlan').value='shared-r';x.node('settingsBindingName').value='接驾共用';x.node('settingsBindingFlow').value='standard';x.node('settingsBindingCommit').onclick();
  assert.equal(x.run(`capabilityDraft().branches.find(b=>b.scope==='tier2').selection_id`),'legacy-r');assert.equal(x.run(`capabilityDraft().branches.find(b=>b.scope==='shared').selection_id`),'shared-r');
  x.run(`capabilityDraft().branches=capabilityDraft().branches.filter(b=>b.scope==='shared');capabilitySelection=capabilityDraft().branches[0].id;render();`);x.click({settingsAddTarget:''});x.click({settingsTarget:'frontline'});x.click({settingsEdit:''});
  assert.equal(x.run('settingsDocumentDraft(capabilityBranch()).plan_id'),undefined);assert.equal(x.run('settingsDocumentDraft(capabilityBranch()).scope'),'frontline');assert.equal(x.run('settingsDocumentDraft(capabilityBranch()).document'),'共用判据原文');assert.equal(x.run('data.revisions[0].data.document'),'共用判据原文');
});
test('查看状态与问题类型、模型等级和执行状态独立，旧复核不当作已查看',()=>{
 const x=workspace();x.run(`data.rating_reviews=[{rating_id:'a',status:'已复核'}];data.record_views=[{item_id:'2',revision_key:'rating:b'}];var testRows=[{item:{id:'1'},rating:{id:'a'},status:'U'},{item:{id:'2',attention_marks:[{type:'ai'}]},rating:{id:'b'},status:'L2'},{item:{id:'3',attention_marks:[{type:'evaluation'}]},rating:{id:'c'},status:'L2'},{item:{id:'4'},status:'failed'}];workspaceViewTab='unviewed';`);
 assert.equal(x.run('filteredWorkspaceRows(testRows).map(r=>r.item.id).join()'),'1,3,4');
 x.run(`workspaceViewTab='viewed';workspaceMarkType='ai';workspaceRecordStatus='L2'`);assert.equal(x.run('filteredWorkspaceRows(testRows).map(r=>r.item.id).join()'),'2');
 x.run(`workspaceViewTab='unviewed';workspaceMarkType='evaluation'`);assert.equal(x.run('filteredWorkspaceRows(testRows).map(r=>r.item.id).join()'),'3');
 x.run(`workspaceViewTab='all';workspaceMarkType='all';workspaceRecordStatus='all';workspaceExecutionFilter='failed'`);assert.equal(x.run('filteredWorkspaceRows(testRows).map(r=>r.item.id).join()'),'4');
});
test('数据分析下钻保留待处理条件，旧复核入口转为未查看',()=>{
 const x=workspace();x.run(`view='analytics';batchId='all';workspaceViewTab='viewed';workspaceExecutionFilter='failed'`);x.click({analyticsRecords:'actionable'});
 assert.equal(x.run('view'),'records');assert.equal(x.run('workspaceExecutionFilter'),'actionable');assert.equal(x.run('workspaceViewTab'),'all');
 x.run(`view='analytics'`);x.click({analyticsRecords:'review'});assert.equal(x.run('workspaceViewTab'),'unviewed');assert.equal(x.run('workspaceExecutionFilter'),'all');
});
test('业务 Skills 默认展示全部对象，数据页独立记忆范围且无评级时清楚提示',()=>{
  const x=workspace();x.run(`view='analytics';scope='all';show('services',{restore:true});`);assert.equal(x.run('scope'),'all');x.run(`scope='tier2';show('analytics',{restore:true})`);assert.equal(x.run('scope'),'all');x.run(`show('services',{restore:true})`);assert.equal(x.run('scope'),'all');
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
  const x=workspace();x.run(`data.evaluator_skill={active_revision_id:'v1',head_revision_id:'v2',revisions:[{id:'v1',number:1,name:'评估员',document:'全局规则',confirmed_by:'测试',confirmed_at:'2026-10-16T00:00:00Z'},{id:'v2',number:2,name:'评估员',document:'草稿<script>不能执行</script>',note:'边界修订'}],trials:[]};evaluatorTab='editor';show('evaluator');`);
  const html=x.node('view').innerHTML;assert.match(html,/公共评估标准 v1/);assert.match(html,/最新草稿 v2/);assert.match(html,/确认生效 v2/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.equal(x.node('crumb').textContent,'评估配置');
});
test('编辑缓冲保留未保存内容；服务器出现新版本时拒绝覆盖并提示核对',()=>{
  const x=workspace();x.run(`data.evaluator_skill={active_revision_id:'v1',head_revision_id:'v1',revisions:[{id:'v1',number:1,name:'评估员',document:'原文',confirmed_by:'测试',confirmed_at:'2026-10-16T00:00:00Z'}],trials:[]};evaluatorTab='editor';show('evaluator');evaluatorBuffer.document='用户未保存的改动';evaluatorBuffer.dirty=true;data.evaluator_skill.revisions.push({id:'v2',number:2,name:'评估员',document:'其他维护人的改动'});data.evaluator_skill.head_revision_id='v2';render();`);
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
  assert.match(x.node('modalBody').innerHTML,/<section class="evidence-source"><h3 class="review-source-title">工单关键信息<\/h3>/);assert.doesNotMatch(x.node('modalBody').innerHTML,/id="workspaceReviewReason"/);
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
  x.click({workspaceEvidence:'a'});assert.match(x.node('modalBody').innerHTML,/<section class="evidence-source">[\s\S]*原文完整内容[\s\S]*<\/section><section class="evidence-result insight-record-body">/);assert.match(x.node('modalBody').innerHTML,/哪里有问题/);assert.match(x.node('modalBody').innerHTML,/核对原始话单/);
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
 x.run(`data.rating_runs=[];data.batch_routing_reviews=[{batch_id:'batch',confirmed:false,groups:[],can_confirm:true}];`);const html=x.run('renderAnalysisTasks()');assert.equal((html.match(/data-learning-start/g)||[]).length,1);assert.doesNotMatch(html,/id="confirmBatchRouting"/);assert.match(html,/按公共评估标准正常评级/);
});
test('数据分析默认统计全部批次，进入过单批任务不污染全量，指标先于问题和效果',()=>{
  const x=insightWorkspace();x.run(`data.batches.push({id:'second',name:'第二批'});data.batch_items.push({id:'d',case_id:'case-d',batch_id:'second',record_snapshot:{name:'第二批记录',scope:'frontline'}});openWorkspaceBatch('batch');`);
  x.click({view:'analytics'});assert.equal(x.run('analyticsBatch'),'all');assert.equal(x.run('analyticsSnapshot().unique.length'),4);
  const html=x.node('view').innerHTML;assert.ok(html.indexOf('整体能力')<html.indexOf('主要问题'));assert.ok(html.indexOf('主要问题')<html.indexOf('改进效果'));assert.match(html,/累计导入 4 行/);assert.match(html,/全部导入数据 · 去重统计/);assert.equal((html.match(/class="dashboard-metric[ "]/g)||[]).length,6);
});
test('场景列表共用表头与列宽，其他场景在原表展开并保留查看记录入口',()=>{
  const x=insightWorkspace();x.run(`data.batch_items=Array.from({length:6},(_,i)=>({id:'scene-item-'+i,case_id:'scene-case-'+i,batch_id:'batch',record_snapshot:{name:'记录'+i,scope:'frontline',scene:'场景'+(i+1)}}));show('analytics');`);
  let html=x.node('view').innerHTML;
  assert.equal((html.match(/dashboard-scene-table/g)||[]).length,1);assert.equal((html.match(/有效辅助覆盖率<\/th>/g)||[]).length,1);
  assert.match(html,/<tbody id="dashboardOtherScenes" hidden>/);assert.match(html,/aria-expanded="false">展开其他场景（1）/);
  x.click({dashboardScenesToggle:''});html=x.node('view').innerHTML;
  assert.match(html,/<tbody id="dashboardOtherScenes">/);assert.match(html,/aria-expanded="true">收起其他场景（1）/);
  assert.equal((html.match(/dashboard-scene-table/g)||[]).length,1);assert.equal((html.match(/有效辅助覆盖率<\/th>/g)||[]).length,1);
  x.run('render()');assert.match(x.node('view').innerHTML,/aria-expanded="true">收起其他场景/);
  const drill=x.run(`dashboardDrills.findIndex(d=>d.label==='场景6')`);assert.ok(drill>=0);x.click({dashboardDrill:String(drill)});assert.equal(x.run('view'),'records');assert.equal(x.run('insightSelection.rows[0].item.id'),'scene-item-5');
});
test('数据分析合并范围与日期筛选，统一查询、校验和重置，修改选项不会提前刷新',()=>{
  const x=insightWorkspace();
  x.run(`workspaceSceneFilter=()=>{throw Error('数据分析不应再插入第二条筛选栏');};show('analytics');`);
  const html=x.node('view').innerHTML;
  for(const id of ['analyticsScopeFilter','analyticsSceneFilter','analyticsBatchFilter','analyticsFrom','analyticsTo'])assert.match(html,new RegExp('id="'+id+'"'));
  assert.equal((html.match(/id="analyticsRangeForm"/g)||[]).length,1);
  x.node('analyticsScopeFilter').value='frontline';x.node('analyticsSceneFilter').value='unmapped';x.node('analyticsBatchFilter').value='batch';
  x.node('analyticsFrom').value='2026-10-02';x.node('analyticsTo').value='2026-10-01';
  x.dispatch('change',{target:{id:'analyticsBatchFilter',value:'batch',dataset:{}}});assert.equal(x.run('analyticsBatch'),'all');
  const submit=()=>x.dispatch('submit',{target:{id:'analyticsRangeForm'},preventDefault(){}});
  submit();assert.equal(x.node('analyticsRangeError').textContent,'开始日期不能晚于结束日期');assert.equal(x.run('analyticsBatch'),'all');assert.equal(x.run('scope'),'all');
  x.node('analyticsFrom').value='2026-10-01';submit();
  assert.equal(x.run('analyticsBatch'),'batch');assert.equal(x.run('scope'),'frontline');assert.equal(x.run('sceneFilter'),'unmapped');assert.equal(x.run('analyticsFrom'),'2026-10-01');assert.equal(x.run('analyticsTo'),'2026-10-01');
  x.click({dashboardReset:''});assert.equal(x.run('analyticsBatch'),'all');assert.equal(x.run('scope'),'all');assert.equal(x.run('sceneFilter'),'all');assert.equal(x.run('analyticsFrom'),'');assert.equal(x.run('analyticsTo'),'');
});
test('最新有效评级位于早期批次时指标下钻仍能打开正确记录，返回保持日期范围',()=>{
  const x=insightWorkspace();x.run(`data.batches[0].source_system='crm';data.batches.push({id:'newer',source_system:'crm'});data.batch_items[0].record_snapshot.business_record={kind:'frontline',fields:{session_id:'same',session_time:'2026-10-01'}};data.batch_items.push({id:'new-a',case_id:'new-case-a',batch_id:'newer',record_snapshot:{name:'新导入',scope:'frontline',business_record:{fields:{session_id:'same',session_time:'2026-10-01'}}}});analyticsFrom='2026-10-01';analyticsTo='2026-10-02';render();`);
  assert.equal(x.run('analyticsSnapshot().olderEffective'),1);x.click({dashboardDrill:'0'});
  assert.equal(x.run('filteredWorkspaceRows(workspaceRows({batch:workspaceRecordsBatch})).map(r=>r.item.id).join()'),'a');
  x.click({workspaceEvidence:'a'});assert.match(x.node('modalBody').innerHTML,/哪里有问题/);assert.equal(x.run('workspaceEvidenceQueue.join()'),'a');
  x.click({insightReturn:''});assert.equal(x.run('analyticsFrom'),'2026-10-01');assert.equal(x.run('analyticsTo'),'2026-10-02');assert.equal(x.run('analyticsSnapshot().unique.length'),1);
});

test('本批总结只展示问题与依据，修改建议留在关联原问题的诊断阶段',()=>{
 const x=insightWorkspace();x.run(`analysisTaskId='batch';view='batches';`);
 const panel=x.run(`insightSummaryHtml(workspaceRows({batch:'batch',target:'all',scene:'all'}),'batch','本批分析总结')`);
 for(const label of ['哪里有问题','问题位置','对处理的影响','查看问题与依据','诊断业务 Skill'])assert.ok(panel.includes(label));
 assert.doesNotMatch(panel,/为什么要改|改后怎么看效果/);
 assert.match(panel,/具体事实矛盾/);assert.doesNotMatch(panel,/建议怎么改|为什么这样改|核对原始话单/);assert.doesNotMatch(panel,/data-learning-generate/);
 const secondary=x.run(`learningPanel('batch')`);assert.match(secondary,/<details[^>]+learning-secondary/);assert.match(secondary,/评估有遗漏或判断不对/);assert.doesNotMatch(secondary,/data-learning-generate|查看本批建议并选择/);
 x.run(`data.ratings.forEach(r=>{r.batch_id='batch';r.request_snapshot={record:data.batch_items.find(i=>i.id===r.item_id).record_snapshot};});`);x.click({diagnoseIssue:'0'});const html=x.node('modalBody').innerHTML;assert.match(html,/诊断客服业务 Skill/);assert.match(html,/同场景.*多工单联合诊断/);assert.match(html,/未识别到 msg/);assert.match(html,/确定 Skill 后显示可诊断问题/);assert.match(html,/id="batchDiagnosisService"/);assert.doesNotMatch(panel,/建议让 Skill|应让 Skill|整理为 AI 客服 Skill/);
});
test('分析总结按业务场景区分，未映射记录单独可查；头部统计与记录面板保持全批',()=>{
 const x=insightWorkspace();
 x.run(`data.scenes=[{id:'scene-a',name:'接驾异常',status:'active',scopes:['frontline']},{id:'scene-b',name:'附加费争议',status:'active',scopes:['frontline']}];data.batch_items[0].record_snapshot.scene_id='scene-a';data.batch_items[1].record_snapshot.scene_id='scene-a';data.batch_items[2].record_snapshot.scene_id='scene-b';data.ratings[2].report={grade:'L1',summary:'另一场景结论',findings:[{type:'费用争议',description:'附加费未说明',suggestion:'补充计费说明'}],dimensions:[],missing_materials:[]};analysisTaskId='batch';view='batches';data.batch_routing_reviews=[{batch_id:'batch',confirmed:true,groups:[]}];`);
 const all=x.run('renderAnalysisTasks()');
 assert.match(all,/id="batchSummaryScene"/);assert.match(all,/具体事实矛盾/);assert.match(all,/费用争议/);
 assert.equal(x.run(`batchWorkspaceState('batch').scene`),'all');
 x.dispatch('change',{target:{id:'batchSummaryScene',value:'scene-a',dataset:{}}});
 let html=x.node('view').innerHTML;
 assert.match(html,/具体事实矛盾/);assert.doesNotMatch(html,/附加费未说明|费用争议/);assert.match(html,/当前范围 <b>2<\/b> 工单/);
 assert.match(html,/共 <b>3<\/b> 条/);assert.match(html,/本批记录 <span class="badge">3 条/);
 assert.equal(x.run(`batchWorkspaceState('batch').scene`),'scene-a');
 x.dispatch('change',{target:{id:'batchSummaryScene',value:'unmapped',dataset:{}}});
 assert.match(x.node('view').innerHTML,/当前筛选没有匹配工单/);
 x.dispatch('change',{target:{id:'batchSummaryScene',value:'scene-b',dataset:{}}});
 html=x.node('view').innerHTML;
 assert.match(html,/附加费未说明/);assert.doesNotMatch(html,/具体事实矛盾/);
});
test('改进说明可交付给 Skill 维护人，含原始来源和验证边界',()=>{
 const x=workspace();const doc=x.run(`skillChangeDocument({title:'核查事实',owner:'维护人',description:'来源不清',goal:'输出交代来源',skill_change:{suggestion:'增加核实步骤',reason:'避免直接断言',target_skill:{code:'客服',version:'1'},source_findings:[{record_name:'案例一',rating_id:'r',description:'具体发现',suggestion:'具体建议',quotes:[{quote:'原文摘录'}]}]}})`);
 for(const text of ['建议怎么改','为什么要改','改后如何验证','来源案例','原文摘录','不是已发布 Skill','不从个案阈值'])assert.ok(doc.includes(text));
});
test('新草稿只用本批记录试用，失败不能启用，旧版汇总草稿只读',()=>{
 const x=workspace();x.run(`data.monitor_learning={batch_groups:[],drafts:[{id:'d',workflow_version:2,source_batch_id:'batch',source_batch_name:'本批名称',scene_id:'s',scene_name:'接驾',scope:'tier2',status:'draft',document:'规则',content_hash:'h',changes:[],trial_rating_ids:['r'],source_signals:[{case_id:'c',batch_id:'batch'}]}],trials:[]};learningOpen('d');`);
 let html=x.node('modalBody').innerHTML;assert.match(html,/本批名称/);assert.match(html,/用本批记录试一试/);assert.match(html,/本次共 2 次调用/);assert.doesNotMatch(html,/data-learning-activate/);
 x.run(`data.monitor_learning.trials=[{id:'t',draft_id:'d',draft_hash:'h',status:'completed_with_errors',cases:[{record_name:'记录',baseline_mode:'basic',sides:{baseline:{status:'failed',error:'调用失败'},candidate:{status:'completed',report:{grade:'L1',summary:'分析不足',findings:[],missing_materials:[]}}}}]}];learningOpen('d');`);
 html=x.node('modalBody').innerHTML;assert.match(html,/本次试用未完成/);assert.match(html,/本批原来的公共标准评估/);assert.doesNotMatch(html,/data-learning-activate/);x.run(`delete data.monitor_learning.drafts[0].workflow_version;learningOpen('d');`);html=x.node('modalBody').innerHTML;assert.match(html,/旧版历史汇总草稿/);assert.doesNotMatch(html,/data-learning-trial|data-learning-activate/);
});

test('保存后的客服 Skill 待办先给出修改建议和下载，进度作为次要操作',()=>{
 const x=workspace();x.run(`data.tasks=[{id:'t',source:'record_rating',title:'客服改进',description:'<script>问题</script>',owner:'维护人',status:'待修改',goal:'新输出可核验',skill_change:{suggestion:'补上分析步骤',reason:'避免遗漏',target_skill:null,source_findings:[]}}];taskEditor(null,null,'t');`);const html=x.node('modalBody').innerHTML;assert.match(html,/补上分析步骤/);assert.match(html,/为什么要改/);assert.match(html,/data-skill-change-download="t"/);assert.ok(html.indexOf('下载改进说明')<html.indexOf('登记处理进度'));assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
});

test('合并问题依据页签，旧依据入口兼容且诊断与各类别分别保留阅读位置',()=>{
 const x=insightWorkspace();x.run(`view='batches';analysisTaskId='batch';data.ratings[1].report.findings=[{type:'语境遗漏',description:'漏了关键陈述',suggestion:'结合原文分析'}];render();`);
 x.node('batchIssueScroll').scrollTop=137;x.click({batchIssue:'1'});assert.equal(x.run(`batchWorkspaceState('batch').issueKey`),x.run(`AnalysisSummary.aggregate(insightRows()).issues[1].key`));
 x.node('batchIssueScroll').scrollTop=84;x.click({batchDetailTab:'sources'});assert.match(x.node('view').innerHTML,/id="batchDetail-advice" role="tab" aria-selected="true"/);assert.doesNotMatch(x.node('view').innerHTML,/id="batchDetail-sources"|依据与案例/);assert.equal(x.node('batchIssueScroll').scrollTop,84);x.click({batchDetailTab:'diagnosis'});assert.equal(x.node('batchIssueScroll').scrollTop,0);
 x.node('batchIssueScroll').scrollTop=52;x.click({batchDetailTab:'advice'});assert.equal(x.node('batchIssueScroll').scrollTop,84);
 x.click({batchIssue:'0'});assert.equal(x.node('batchIssueScroll').scrollTop,137);x.click({batchTab:'records'});x.node('batchRecordsScroll').scrollTop=160;x.click({batchTab:'summary'});assert.equal(x.node('batchIssueScroll').scrollTop,137);x.click({batchTab:'records'});assert.equal(x.node('batchRecordsScroll').scrollTop,160);
});
test('问题搜索可到达原本折叠的问题，空结果安全显示，清空后恢复可选目录',()=>{
 const x=insightWorkspace();x.run(`view='batches';analysisTaskId='batch';data.ratings[1].report.findings=[{type:'语境遗漏',description:'漏了关键陈述',suggestion:'结合原文分析'}];render();`);
 x.dispatch('input',{target:{id:'batchIssueSearch',value:'语境',dataset:{}}});assert.match(x.node('view').innerHTML,/找到 1 组问题/);assert.match(x.node('view').innerHTML,/id="batchIssueDetail"[\s\S]*?<h2>语境遗漏<\/h2>/);
 x.dispatch('input',{target:{id:'batchIssueSearch',value:'<script>',dataset:{}}});assert.match(x.node('view').innerHTML,/没有匹配的问题/);assert.match(x.node('view').innerHTML,/value="&lt;script&gt;"/);assert.doesNotMatch(x.node('view').innerHTML,/<script>/);
 x.dispatch('input',{target:{id:'batchIssueSearch',value:'',dataset:{}}});assert.match(x.node('view').innerHTML,/data-batch-issue="0"/);assert.match(x.node('view').innerHTML,/data-batch-issue="1"/);
});
test('问题内下钻留在批次记录页签，复核队列只包含涉及记录，返回保持问题',()=>{
 const x=insightWorkspace();x.run(`view='batches';analysisTaskId='batch';render();`);const selected=x.run(`batchWorkspaceState('batch').issueKey`);x.click({batchRelated:'0'});assert.equal(x.run('view'),'batches');assert.equal(x.run(`batchWorkspaceState('batch').tab`),'records');assert.equal(x.run('filteredWorkspaceRows(insightRows()).map(r=>r.item.id).join()'),'a,b');x.click({workspaceEvidence:'a'});assert.equal(x.run('workspaceEvidenceQueue.join()'),'a,b');x.click({batchTab:'summary'});assert.equal(x.run(`batchWorkspaceState('batch').issueKey`),selected);x.click({batchClearRelated:''});assert.equal(x.run('filteredWorkspaceRows(insightRows()).length'),3);
});
test('每个批次分别保留页签、问题及记录筛选，新批次未分析时默认任务设置',()=>{
 const x=insightWorkspace();x.run(`view='batches';analysisTaskId='batch';render();`);x.click({batchTab:'records'});x.run(`workspaceRecordStatus='L0';workspaceViewTab='unviewed';render();data.batches.push({id:'second',name:'第二批',imported_count:0});`);x.click({workspaceBatch:'second'});assert.equal(x.run(`batchWorkspaceState('second').tab`),'settings');x.click({workspaceBatch:'batch'});assert.equal(x.run(`batchWorkspaceState('batch').tab`),'records');assert.equal(x.run('workspaceRecordStatus'),'L0');assert.equal(x.run('workspaceViewTab'),'unviewed');
});

test('诊断确认面板先选择问题、版本与定义，展示额外调用，取消不调用模型',()=>{
 const x=insightWorkspace();x.run(`data.ratings[0].request_snapshot={record:{scope:'frontline',scene:'合成场景'},sources:[]};data.ratings[0].model_snapshot={profile_id:'p',model:'m'};data.services=[{id:'s',code:'S',version:'1',scope:'frontline',scene:'合成场景',raw:'完整业务定义',content_hash:'hash'}];data.model_config.profiles=[{id:'p',name:'服务',models:['m']}];openSkillDiagnosis('rating-a',[0]);`);
 const html=x.node('modalBody').innerHTML;for(const text of ['选择本次诊断的原问题','业务 Skill 版本与完整内部定义','使用模型','预览不调用模型','开始诊断','name="diagnosisModule"'])assert.ok(html.includes(text),text);assert.match(html,/id="diagnosisStart" disabled/);assert.match(html,/不改变原等级/);x.node('diagnosisCancel').onclick();assert.equal(x.run('diagnosisDraft'),null);
});
test('诊断报告按结论提供排查动作，原文和修订安全展示，导出保留验证与来源',()=>{
 const x=insightWorkspace();x.run(`var diagnosticFixture={id:'diag',rating_id:'rating-a',item_id:'a',prompt_version:'diagnosis/v1',input_hash:'hash',status:'completed',request_snapshot:{service_skills:[{code:'S',version:'1'}]},model_snapshot:{model:'m'},report:{summary:'执行需核查',findings:[{finding_index:0,validity:'supported',coverage:'covered',cause_status:'hypothesis',issue_types:['执行待核查'],location:'条款一',explanation:'输出未体现不证明未执行',suggestion:'核对实际版本和执行日志',evidence_quotes:[{id:'E1',label:'AI输出',text:'<script>原文</script>'}],skill_quotes:[{id:'S1',label:'业务定义',text:'要求核对'}],requirement_quotes:[],revision:null,verification_cases:[{name:'原问题',input:'原案例',expected:'查看执行记录'}],missing_materials:['运行日志'],action:'check_execution'}]}};openDiagnosisReport(diagnosticFixture);`);
 const html=x.node('modalBody').innerHTML;assert.match(html,/创建执行／工具排查待办/);assert.doesNotMatch(html,/创建 Skill 改进待办|<script>/);assert.match(html,/&lt;script&gt;/);assert.match(html,/不改变原等级/);assert.match(html,/待验证推测/);const doc=x.run('diagnosisReportDocument(diagnosticFixture)');for(const text of ['来源评级：rating-a','运行日志','查看执行记录','业务定义'])assert.ok(doc.includes(text));
});

test('报告顶层共用待补材料单独呈现并进入导出；失败可零调用重新解析',()=>{
 const x=insightWorkspace();x.run(`var sharedMaterialsFixture={id:'diag',rating_id:'rating-a',item_id:'a',status:'completed',request_snapshot:{service_skills:[]},model_snapshot:{model:'m'},report:{summary:'建议核查',findings:[],missing_materials:['共享材料<script>一</script>']},recovery_history:[{previous_error:'模型诊断结果无效：待补材料格式无效'}]};openDiagnosisReport(sharedMaterialsFixture);`);
 let html=x.node('modalBody').innerHTML;assert.match(html,/报告共用待补材料/);assert.match(html,/共享材料&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(html,/没有再次调用模型/);assert.match(x.run('diagnosisReportDocument(sharedMaterialsFixture)'),/报告共用待补材料[\s\S]*共享材料/);
 x.run(`sharedMaterialsFixture.status='failed';sharedMaterialsFixture.error='模型诊断结果无效：待补材料格式无效';sharedMaterialsFixture.raw_response='{}';sharedMaterialsFixture.report=null;openDiagnosisReport(sharedMaterialsFixture);`);html=x.node('modalBody').innerHTML;assert.match(html,/重新解析已保存结果（不调用模型）/);assert.match(html,/data-diagnosis-reparse="diag"/);
});

function addDiagnosisForUi(x,{id='diag',rating='rating-a',status='completed',index=0,summary='诊断发现条件不清'}={}){
 x.run(`data.skill_diagnoses||=[];data.skill_diagnoses.push(${JSON.stringify({id,rating_id:rating,item_id:rating.replace('rating-',''),status,phase:status==='running'?'analysing':status==='pending'?'queued':status,created_at:'2026-10-20T06:00:00Z',started_at:status==='running'?'2026-10-20T06:00:10Z':null,model_snapshot:{profile_id:'p',model:'m'},request_snapshot:{record:{scope:'frontline',scene:'合成场景'},service_skills:[{id:'s',code:'S',version:'1',content_hash:'hash',modules:[{key:'whole'}]}],selected_findings:[{finding_index:index}],user_notes:'上次诊断说明'},...(status==='completed'?{report:{summary,findings:[{finding_index:index,validity:'supported',coverage:'covered',cause_status:'hypothesis',issue_types:['执行待核查'],location:'章节一',explanation:'具体诊断说明',suggestion:'核查实际版本',evidence_quotes:[],skill_quotes:[],requirement_quotes:[],revision:null,verification_cases:[],missing_materials:[],action:'check_execution'}],missing_materials:[]}}:{})})});`);
}
test('业务 Skill 诊断与问题建议同级，直接呈现已存报告，切换后保留页签与位置',()=>{
 const x=insightWorkspace();addDiagnosisForUi(x);x.run(`view='batches';analysisTaskId='batch';render();`);let html=x.node('view').innerHTML;assert.match(html,/id="batchDetail-diagnosis" role="tab"/);assert.match(html,/查看诊断报告/);x.click({batchDetailTab:'diagnosis'});html=x.node('view').innerHTML;assert.match(html,/aria-selected="true"[^>]+data-batch-detail-tab="diagnosis"/);assert.match(html,/诊断发现条件不清/);assert.match(html,/1 \/ 1 个问题已有报告/);assert.match(html,/记录b/);assert.match(html,/尚未诊断/);
 x.node('batchIssueScroll').scrollTop=92;x.click({batchDetailTab:'advice'});x.click({batchDetailTab:'diagnosis'});assert.equal(x.node('batchIssueScroll').scrollTop,92);
});
test('记录详情默认表现评估，诊断同级且操作集中到底部；旧报告保留，重诊说明原因与调用',()=>{
 const x=insightWorkspace();x.run(`data.ratings[0].request_snapshot={record:{scope:'frontline',scene:'合成场景'},sources:[],reference_index:[],monitoring_plan:{document:'方案'}};data.ratings[0].model_snapshot={profile_id:'p',model:'m'};data.ratings[0].evaluator_skill_snapshot=null;data.rating_runs=[];data.ratings[0].context_stats=null;`);addDiagnosisForUi(x);
 x.run(`openWorkspaceEvidence('a');`);const html=x.node('modalBody').innerHTML,body=html.split('<footer class="evidence-footer">')[0],footer=html.split('<footer class="evidence-footer">')[1];
 assert.match(html,/id="recordDetailTab-performance" role="tab" aria-selected="true"/);assert.match(html,/id="recordDetailPanel-diagnosis"[^>]*hidden/);assert.ok(html.indexOf('<h3>表现评估</h3>')<html.indexOf('诊断发现条件不清'));assert.equal((html.match(/data-record-diagnosis-root=/g)||[]).length,1);assert.match(html,/已诊断 1 \/ 1 个问题/);assert.doesNotMatch(body,/data-diagnose-rating=|diagnosis-section-actions/);for(const text of ['查看诊断报告','重新诊断…','标记'])assert.ok(footer.includes(text),text);
 x.click({recordDetailTab:'diagnosis'});assert.equal(x.node('recordDetailPanel-performance').hidden,true);assert.equal(x.node('recordDetailPanel-diagnosis').hidden,false);x.node('recordDetailPanel-diagnosis').scrollTop=92;
 x.dispatch('keydown',{target:{dataset:{recordDetailTab:'diagnosis'}},key:'ArrowLeft',preventDefault(){}});assert.equal(x.node('recordDetailPanel-performance').hidden,false);assert.equal(x.node('recordDetailTab-performance').tabIndex,0);assert.equal(x.node('recordDetailTab-diagnosis').tabIndex,-1);
 x.click({recordDetailTab:'diagnosis'});assert.equal(x.node('recordDetailPanel-diagnosis').scrollTop,92);
 x.run(`data.services=[{id:'s',code:'S',version:'1',scope:'frontline',scene:'合成场景',raw:'完整业务定义',content_hash:'hash'}];data.model_config.profiles=[{id:'p',name:'服务',models:['m']}];openSkillDiagnosis('rating-a',[0]);`);const modalHtml=x.node('modalBody').innerHTML;assert.match(modalHtml,/重新诊断原因/);assert.match(modalHtml,/沿用上次配置/);assert.match(modalHtml,/旧报告不会被覆盖/);assert.match(modalHtml,/上次诊断说明/);assert.match(modalHtml,/id="diagnosisStart" disabled/);
});
test('工单诊断入口区分未诊断、部分覆盖、运行中和失败，无问题时不发起调用',()=>{
 const x=insightWorkspace();x.run(`openWorkspaceEvidence('a');`);let html=x.node('modalBody').innerHTML;assert.match(html,/尚未诊断/);assert.equal((html.match(/data-diagnose-rating=/g)||[]).length,1);assert.match(html,/>诊断业务 Skill<\/button>/);
 x.run(`data.ratings[0].report.findings.push({...data.ratings[0].report.findings[0],description:'第二个问题'});`);addDiagnosisForUi(x);x.run(`openWorkspaceEvidence('a');`);html=x.node('modalBody').innerHTML;assert.match(html,/已诊断 1 \/ 2 个问题/);assert.match(html,/data-diagnose-indices="\[1\]"[^>]*>诊断剩余问题（1）/);assert.match(html,/查看诊断报告/);
 addDiagnosisForUi(x,{id:'active',status:'running',index:1});x.run(`openWorkspaceEvidence('a');`);html=x.node('modalBody').innerHTML;assert.match(html,/诊断中 · 已诊断 1 \/ 2 个问题/);assert.match(html,/查看诊断进度/);assert.doesNotMatch(html,/data-diagnose-rating=/);
 x.run(`data.skill_diagnoses[1].status='failed';data.skill_diagnoses[1].error='模型请求超时';openWorkspaceEvidence('a');`);html=x.node('modalBody').innerHTML;const body=html.split('<footer class="evidence-footer">')[0];assert.match(html,/最新诊断失败 · 已诊断 1 \/ 2 个问题/);assert.match(html,/模型请求超时/);assert.match(html,/诊断发现条件不清/);assert.match(html,/查看失败原因/);assert.match(html,/调整后重试/);assert.doesNotMatch(body,/data-diagnose-rating=/);
 x.run(`openWorkspaceEvidence('c');`);html=x.node('modalBody').innerHTML;assert.match(html,/无待诊断问题/);assert.doesNotMatch(html,/data-diagnose-rating=/);
});
test('后台诊断完成后同步报告、页签状态和底部入口，保留正在阅读的页签',async()=>{
 const x=insightWorkspace();addDiagnosisForUi(x,{status:'running'});x.run(`openWorkspaceEvidence('a');`);x.click({recordDetailTab:'diagnosis'});x.node('recordDetailPanel-diagnosis').scrollTop=64;
 x.run(`var recordRoot={dataset:{recordDiagnosisRoot:'rating-a',diagnosisIndices:'null',diagnosisFooterActions:'true'},innerHTML:''},recordLabel={dataset:{recordDiagnosisLabel:'rating-a'},textContent:''},recordActions={dataset:{recordDiagnosisActions:'rating-a'},innerHTML:''};document.querySelectorAll=selector=>selector==='[data-record-diagnosis-root]'?[recordRoot]:selector==='[data-record-diagnosis-label]'?[recordLabel]:selector==='[data-record-diagnosis-actions]'?[recordActions]:[];request=async()=>({diagnoses:[{id:'diag',status:'completed',phase:'completed',report:{summary:'异步完成的报告',findings:[{finding_index:0,action:'no_change'}]}}]});`);
 await x.run('diagnosisPollBackground()');assert.match(x.run('recordRoot.innerHTML'),/异步完成的报告/);assert.doesNotMatch(x.run('recordRoot.innerHTML'),/data-diagnose-rating=/);assert.match(x.run('recordLabel.textContent'),/已诊断 1 \/ 1 个问题/);assert.match(x.run('recordActions.innerHTML'),/查看诊断报告/);assert.doesNotMatch(x.run('recordActions.innerHTML'),/查看诊断进度/);assert.equal(x.node('recordDetailPanel-diagnosis').hidden,false);assert.equal(x.node('recordDetailPanel-diagnosis').scrollTop,64);
});
test('退出弹窗后仍有进度入口，排队分析阶段与已用时间清楚；已有任务不会再次打开新建表单',()=>{
 const x=insightWorkspace();addDiagnosisForUi(x,{status:'running'});x.run(`diagnosisTrackRows();`);const html=x.run('diagnosisActivityHtml()');assert.match(html,/业务 Skill 诊断中 · 1 项/);assert.match(html,/模型分析中/);assert.match(html,/已用/);assert.match(html,/查看诊断进度/);assert.doesNotMatch(html,/%|progress max/);
 x.run(`openSkillDiagnosis('rating-a',[0]);`);assert.match(x.node('modalBody').innerHTML,/关闭弹窗不影响执行/);assert.doesNotMatch(x.node('modalBody').innerHTML,/id="diagnosisStart"/);
 x.run(`data.skill_diagnoses[0].status='completed';data.skill_diagnoses[0].phase='completed';diagnosisTrackRows();`);assert.match(x.run('diagnosisActivityHtml()'),/诊断已完成/);assert.equal(x.run(`diagnosisNotifications.has('diag')`),true);
});
test('问题页签只展示本问题的诊断项，不把同次报告的其他问题混进来',()=>{
 const x=insightWorkspace();addDiagnosisForUi(x);x.run(`data.skill_diagnoses[0].report.findings.push({...data.skill_diagnoses[0].report.findings[0],finding_index:1,suggestion:'另一个问题专属建议'});data.skill_diagnoses[0].request_snapshot.selected_findings.push({finding_index:1});`);const html=x.run(`diagnosisIssueHtml(AnalysisSummary.aggregate(insightRows()).issues[0])`);assert.match(html,/当前范围采用的 1 项/);assert.doesNotMatch(html,/另一个问题专属建议/);
});

test('最近一轮失败时明确提示失败并保留上次成功报告，问题目录与诊断页签同步显示状态',()=>{
 const x=insightWorkspace();addDiagnosisForUi(x,{id:'old',summary:'此前有效诊断结论'});addDiagnosisForUi(x,{id:'failed',status:'failed'});x.run(`data.skill_diagnoses[1].error='模型请求超时';`);
 const html=x.run(`diagnosisHistoryHtml(data.ratings[0])`);assert.match(html,/本次诊断未完成/);assert.match(html,/模型请求超时/);assert.match(html,/此前有效诊断结论/);assert.match(html,/下面保留上次完成的结果/);
 x.run(`view='batches';analysisTaskId='batch';render();`);assert.match(x.node('view').innerHTML,/业务 Skill 诊断（1） · 1 失败/);assert.match(x.node('view').innerHTML,/最新诊断失败/);
});

test('只重新诊断部分问题时采用各问题最新报告，不重复展示已被更新的旧建议',()=>{
 const x=insightWorkspace();addDiagnosisForUi(x,{id:'old'});x.run(`data.ratings[0].report.findings.push({...data.ratings[0].report.findings[0],description:'第二个具体问题'});data.skill_diagnoses[0].report.findings[0].suggestion='旧问题零建议不应重复';data.skill_diagnoses[0].report.findings.push({...data.skill_diagnoses[0].report.findings[0],finding_index:1,suggestion:'第二个问题仍适用的旧结论'});data.skill_diagnoses[0].request_snapshot.selected_findings.push({finding_index:1});`);addDiagnosisForUi(x,{id:'new'});x.run(`data.skill_diagnoses[1].report.findings[0].suggestion='问题零采用新结论';`);
 const html=x.run(`diagnosisHistoryHtml(data.ratings[0])`);assert.match(html,/2 \/ 2 个问题已有报告/);assert.match(html,/问题零采用新结论/);assert.match(html,/第二个问题仍适用的旧结论/);assert.doesNotMatch(html,/旧问题零建议不应重复/);
});

test('问题与依据同时覆盖全部来源，逐条引用与上下文准确且不展示初评修改建议',()=>{
 const x=insightWorkspace();x.run(`
  Object.assign(data.ratings[0].report.findings[0],{title:'未核对联系结果',evidence_reason:'甲依据<script>危险</script>',suggestion_reason:'甲建议理由应隐藏',quotes:[{id:'E001',source:'ai_a',label:'实际AI回复',quote:'甲原文<script>危险</script>'}]});
  Object.assign(data.ratings[1].report.findings[0],{suggestion:'乙建议应隐藏',evidence_reason:'乙依据',suggestion_reason:'乙建议理由应隐藏',quotes:[{id:'E002',label:'用户反馈',quote:'乙工单原文'}]});
  data.ratings[0].request_snapshot={sources:[{id:'ai_a',role:'ai_output',label:'甲AI输出',text:'甲的完整上下文'},{id:'skill',role:'skill',text:'不应混入事实依据的Skill正文'}]};
  analysisTaskId='batch';view='batches';render();
 `);
 const html=x.node('view').innerHTML;
 for(const label of ['哪里有问题','问题位置','对处理的影响','记录a','记录b','查看问题与依据','问题与依据'])assert.ok(html.includes(label),label);
 assert.doesNotMatch(html,/<script>|甲原文|乙工单原文|建议怎么改|为什么这样改|建议理由应隐藏|乙建议应隐藏|依据与案例|原评估未提供建议/);
 x.click({issueEvidence:JSON.stringify(['rating-a',0])});const context=x.node('modalBody').innerHTML;assert.match(context,/甲原文&lt;script&gt;/);assert.match(context,/甲的完整上下文/);assert.doesNotMatch(context,/<script>|乙工单原文|不应混入事实依据的Skill正文/);
 const legacy=x.run(`insightFindingHtml({description:'旧问题',suggestion:'旧建议'})`);assert.match(legacy,/未保存可展示的原文引用/);assert.doesNotMatch(legacy,/旧建议|原评估未提供建议|建议怎么改/);
 const detailed=x.run(`insightFindingHtml({description:'长引用',quotes:[{quote:'甲'.repeat(400)},{quote:'乙'},{quote:'丙'}]})`);assert.doesNotMatch(detailed,/甲…/);assert.match(detailed,/其他引用（1）/);assert.ok(detailed.includes('甲'.repeat(400)));assert.equal((detailed.match(/class="finding-section /g)||[]).length,2);
});

test('一个工单的多个问题按原问题编号分行，跨类别汇总与诊断沿用同一批问题',()=>{
 const x=insightWorkspace();x.run(`
  var firstFinding=data.ratings[0].report.findings[0];firstFinding.quotes=[{id:'E1',quote:'甲问题一的证据'}];
  data.ratings[0].report.findings.push({...firstFinding,description:'甲工单第二个不同问题',type:'诉求遗漏',quotes:[{id:'E2',quote:'甲问题二的证据'}]});
  data.ratings[1].report.findings[0].quotes=[{id:'E3',quote:'乙工单证据'}];
  analysisTaskId='batch';view='batches';render();
  var originalRatings=JSON.stringify(data.ratings);
 `);
 x.click({batchIssue:'-1'});let html=x.node('view').innerHTML;assert.match(html,/全部具体问题/);assert.match(html,/rowspan="2"/);assert.match(html,/本工单 2 个问题/);assert.doesNotMatch(html,/甲问题一的证据|甲问题二的证据|乙工单证据/);assert.equal((html.match(/data-finding-open=/g)||[]).length,3);assert.equal((html.match(/data-finding-key=/g)||[]).length,3);
 x.click({batchDetailTab:'diagnosis'});html=x.node('view').innerHTML;assert.match(html,/data-diagnose-rating="rating-a"/);assert.match(html,/data-diagnose-indices="\[0,1\]"/);assert.equal(x.run('JSON.stringify(data.ratings)===originalRatings'),true);
 x.click({batchDetailTab:'advice'});x.click({issueEvidence:JSON.stringify(['rating-a',1])});html=x.node('modalBody').innerHTML;assert.match(html,/甲问题二的证据/);assert.doesNotMatch(html,/甲问题一的证据|乙工单证据/);
});

test('固定分类目录、待分类队列和分版本展示可渲染，筛选不调用模型，类别汇总不受原始标签影响',()=>{
 const x=insightWorkspace(),categories=require('../issue-taxonomy-seed.json').categories;x.run(`
  var cats=${JSON.stringify(categories)};
  data.issue_taxonomy={active_revision_id:'tax1',head_revision_id:'tax1',active:{id:'tax1',number:1,version:'v1',categories:cats},revisions:[{id:'tax1',number:1,status:'active',categories:cats,confirmed_by:'测试'}]};
  data.issue_classifications=data.ratings.slice(0,2).map((r,i)=>({key:JSON.stringify([r.id,0]),rating_id:r.id,finding_index:0,item_id:r.item_id,batch_id:'batch',scene:'合成场景',description:r.report.findings[0].description,raw_type:i?'不同叫法':'核心诉求遗漏',status:i?'unclassified':'classified',classification:i?{category_id:null,reason:'边界不清',unclassified_reason:'ambiguous_boundary'}:{taxonomy_revision_id:'tax1',category_id:'C01'},category:i?null:cats[0],taxonomy_version:'v1'}));
  analysisTaskId='batch';view='batches';render();
 `);assert.match(x.node('view').innerHTML,/用户诉求理解或回应不到位/);assert.match(x.node('view').innerHTML,/未分类/);
 x.run(`issueTaxonomyTab='definitions'`);let html=x.run('issueTaxonomyHtml()');assert.match(html,/分类定义 v1/);assert.match(html,/正例/);assert.match(html,/管理员/);
 x.run(`issueTaxonomyTab='queue'`);html=x.run('issueTaxonomyHtml()');assert.match(html,/边界不清/);assert.match(html,/AI整理所选问题/);assert.doesNotMatch(html,/已选 1 个问题/);
 x.click({issueSelectPage:''});assert.equal(x.run('issueSelected.size'),1);x.click({issueClear:''});assert.equal(x.run('issueSelected.size'),0);
 x.dispatch('change',{target:{dataset:{issueFilter:'status'},value:'classified'}});assert.equal(x.run('issueRows().length'),1);assert.equal(x.run('issueRows()[0].status'),'classified');
});

test('同类超过十个问题时分页覆盖所有来源，不丢失末页记录',()=>{const x=insightWorkspace();x.run(`var pagedIssue={key:'page-test',count:11,title:'同类',category:{definition:'固定定义'},sources:Array.from({length:11},(_,i)=>({rating_id:'r'+i,finding_index:0,item_id:'i'+i,record_name:'工单'+i,description:'问题'+i,suggestion:'建议'+i,suggestion_reason:'理由'+i}))};`);const first=x.run('insightIssueExplanation(pagedIssue)');assert.match(first,/工单9/);assert.doesNotMatch(first,/工单10/);x.run(`insightIssuePages.set('page-test',1)`);const last=x.run('insightIssueExplanation(pagedIssue)');assert.match(last,/工单10/);assert.match(last,/11–11 \/ 11/);});

test('工单评级标识来自同次原评估；顶部场景与评级筛选同步归并、证据及诊断范围',()=>{
 const x=insightWorkspace();x.run(`
  data.scenes=[{id:'s1',name:'接驾',status:'active',scopes:['frontline']},{id:'s2',name:'费用',status:'active',scopes:['frontline']}];
  data.batch_items[0].record_snapshot.scene_id='s1';data.batch_items[1].record_snapshot.scene_id='s1';data.batch_items[2].record_snapshot.scene_id='s2';
  data.ratings[1].report.grade='L1';data.rating_reviews=[{rating_id:'rating-a',decision:'change',grade:'L3',reason:'复核另有意见'}];
  analysisTaskId='batch';view='batches';render();var ratingsBeforeFilter=JSON.stringify(data.ratings);
 `);
 let html=x.node('view').innerHTML;assert.match(html,/aria-label="工单评级 L0"/);assert.match(html,/aria-label="工单评级 L1"/);assert.doesNotMatch(html,/aria-label="工单评级 L3"/);
 assert.equal((html.match(/id="batchSummaryScene"/g)||[]).length,1);assert.equal((html.match(/id="batchSummaryGrade"/g)||[]).length,1);assert.ok(html.indexOf('aria-label="分析总结筛选"')<html.indexOf('<aside class="batch-issue-rail">'));
 x.run(`insightIssuePages.set('stale-page',4);batchWorkspaceState('batch').positions['stale|advice']=90;`);
 x.dispatch('change',{target:{id:'batchSummaryGrade',value:'L1',dataset:{}}});assert.equal(x.run('insightRows().map(r=>r.item.id).join()'),'b');assert.equal(x.run('insightIssuePages.size'),0);
 html=x.node('view').innerHTML;assert.match(html,/当前范围 <b>1<\/b> 工单/);assert.match(html,/aria-label="工单评级 L1"/);assert.doesNotMatch(html,/aria-label="工单评级 L0"/);assert.match(html,/共 <b>3<\/b> 条/);
 x.click({batchDetailTab:'diagnosis'});html=x.node('view').innerHTML;assert.match(html,/data-diagnose-rating="rating-b"/);assert.doesNotMatch(html,/data-diagnose-rating="rating-a"/);
 x.dispatch('change',{target:{id:'batchSummaryScene',value:'s2',dataset:{}}});assert.equal(x.run('insightRows().length'),0);assert.match(x.node('view').innerHTML,/当前筛选没有匹配工单/);
 x.dispatch('change',{target:{id:'batchSummaryGrade',value:'L3',dataset:{}}});assert.equal(x.run('insightRows().length'),1);html=x.node('view').innerHTML;assert.match(html,/当前范围未列出具体问题/);assert.match(html,/当前筛选有 1 条工单/);assert.doesNotMatch(html,/当前筛选没有匹配工单/);
 x.click({summaryRecords:''});assert.equal(x.run(`batchWorkspaceState('batch').related.ids.join()`),'c');assert.equal(x.run(`filteredWorkspaceRows(workspaceRows({batch:'batch',target:'all',scene:'all'})).map(r=>r.item.id).join()`),'c');
 x.click({batchTab:'summary'});x.click({summaryReset:''});assert.equal(x.run(`batchWorkspaceState('batch').grade`),'all');assert.equal(x.run(`batchWorkspaceState('batch').scene`),'all');assert.equal(x.run('insightRows().length'),3);assert.equal(x.run(`batchWorkspaceState('different-batch').grade`),'all');assert.equal(x.run('JSON.stringify(data.ratings)===ratingsBeforeFilter'),true);
});

test('评级U保留材料缺口，执行失败不当作U或原评级，筛选清空后恢复全批',()=>{
 const x=insightWorkspace();x.run(`
  data.ratings[2].report={grade:'U',summary:'缺少底单',findings:[],missing_materials:['订单底单'],dimensions:[]};
  data.batch_items.push({id:'d',case_id:'case-d',batch_id:'batch',record_snapshot:{name:'失败工单',scope:'frontline',scene:'合成场景'}});
  data.ratings.push({id:'rating-d',item_id:'d',status:'failed',error:'调用失败'});
  analysisTaskId='batch';view='batches';render();
 `);
 x.dispatch('change',{target:{id:'batchSummaryGrade',value:'U',dataset:{}}});assert.equal(x.run('insightRows().map(r=>r.item.id).join()'),'c');const html=x.node('view').innerHTML;assert.match(html,/判断依据不足/);assert.match(html,/订单底单/);assert.match(html,/aria-label="工单评级 U"/);assert.doesNotMatch(html.split('id="batchPanel-records"')[0],/失败工单/);
 x.click({summaryReset:''});assert.equal(x.run('insightRows().length'),4);
});

test('同场景联合诊断先带入 msg 匹配 Skill，问题区可同时选择多工单，其他 Skill 工单排除',()=>{
 const x=insightWorkspace();x.run(`
  data.ratings.forEach(r=>{r.batch_id='batch';r.request_snapshot={record:data.batch_items.find(i=>i.id===r.item_id).record_snapshot};});
  data.services=[{id:'verbal',code:'VERBAL_CONFLICT',version:'v1',scope:'frontline',scene:'合成场景',raw:'完整定义',content_hash:'hash'}];
  data.service_skill_links=[{item_id:'a',code:'VERBAL_CONFLICT',source:'msg',status:'ready',selection:{id:'verbal',content_hash:'hash',modules:['whole']}},{item_id:'b',code:'VERBAL_CONFLICT',source:'msg',status:'ready',selection:{id:'verbal',content_hash:'hash',modules:['whole']}}];
  analysisTaskId='batch';view='batches';openBatchSkillDiagnosis(AnalysisSummary.aggregate(insightRows()).issues[0]);
 `);let html=x.node('modalBody').innerHTML;
 for(const text of ['msg 自动匹配','VERBAL_CONFLICT @ v1','选择本场景的问题与工单','记录a','记录b','全选当前 Skill 的问题','name="batchDiagnosisRecord"','name="batchDiagnosisFinding"'])assert.ok(html.includes(text),text);
 assert.equal((html.match(/name="batchDiagnosisRecord"/g)||[]).length,2);assert.match(html,/id="batchDiagnosisStart" disabled/);
 x.run(`data.service_skill_links[1].code='OTHER_SKILL';openBatchSkillDiagnosis(AnalysisSummary.aggregate(insightRows()).issues[0]);batchDiagnosisDraft.serviceId='verbal';batchDiagnosisForm();`);html=x.node('modalBody').innerHTML;assert.match(html,/已排除关联其他 Skill 的 1 条工单/);assert.doesNotMatch(html,/name="batchDiagnosisRecord" value="rating-b"/);
});
test('无 msg 不自动猜 Skill；手动选择后展示问题，已有选择可再次直接带入',()=>{
 const x=insightWorkspace();x.run(`data.ratings.forEach(r=>{r.batch_id='batch';r.request_snapshot={record:data.batch_items.find(i=>i.id===r.item_id).record_snapshot};});data.services=[{id:'verbal',code:'VERBAL_CONFLICT',version:'v1',scope:'frontline',scene:'合成场景',raw:'完整定义',content_hash:'hash'}];analysisTaskId='batch';view='batches';openBatchSkillDiagnosis(AnalysisSummary.aggregate(insightRows()).issues[0]);`);
 assert.equal(x.run('batchDiagnosisDraft.serviceId'),'');assert.match(x.node('modalBody').innerHTML,/未识别到 msg/);assert.doesNotMatch(x.node('modalBody').innerHTML,/name="batchDiagnosisFinding"/);
 x.run(`data.service_skill_links=[{item_id:'a',code:'VERBAL_CONFLICT',source:'manual',status:'ready',selection:{id:'verbal',content_hash:'hash',modules:['whole']}}];openBatchSkillDiagnosis(AnalysisSummary.aggregate(insightRows()).issues[0]);`);assert.equal(x.run('batchDiagnosisDraft.serviceId'),'verbal');assert.match(x.node('modalBody').innerHTML,/已保存，直接带入/);assert.match(x.node('modalBody').innerHTML,/name="batchDiagnosisFinding"/);
});
test('联合报告在诊断页签汇总并回填各工单原问题覆盖；旧报告折叠保留且不改评级',()=>{
 const x=insightWorkspace();x.run(`
  var selected=[{rating_id:'rating-a',item_id:'a',finding_index:0,original_finding_index:0,record_name:'记录a',description:'问题甲'},{rating_id:'rating-b',item_id:'b',finding_index:1,original_finding_index:0,record_name:'记录b',description:'问题乙'}];
  var joint={id:'joint',kind:'batch',rating_ids:['rating-a','rating-b'],status:'completed',created_at:'2026-10-21T01:00:00Z',request_snapshot:{selected_findings:selected,service_skills:[{code:'VERBAL_CONFLICT',version:'v1'}]},report:{summary:'两个工单存在共同核验缺口',groups:[{id:'group_1',title:'共同证据问题',explanation:'问题影响',location:'核验分支',suggestion:'补充条件',kind:'common',case_count:2,finding_indices:[0,1],validity:'supported',cause_status:'direct_basis',action:'modify_skill'}],findings:selected.map(s=>({finding_index:s.finding_index,location:'核验分支',explanation:'本单说明',suggestion:'本单建议',evidence_quotes:[],skill_quotes:[],requirement_quotes:[],verification_cases:[],missing_materials:[]}))}};
  data.skill_diagnoses=[joint];var issue=AnalysisSummary.aggregate(insightRows()).issues[0];var before=JSON.stringify(data.ratings);
 `);
 assert.equal(x.run('diagnosisCount(issue)'),2);assert.equal(x.run('diagnosisRecordState(data.ratings[1]).covered.has(0)'),true);assert.match(x.run('diagnosisHistoryHtml(data.ratings[1])'),/已纳入多工单联合诊断/);assert.match(x.run('diagnosisHistoryHtml(data.ratings[1])'),/data-diagnosis-open="joint"/);
 let html=x.run('diagnosisIssueHtml(issue)');for(const text of ['共同证据问题','共性问题','问题与影响','Skill 定位','建议怎么处理','查看涉及工单'])assert.ok(html.includes(text),text);
 x.run(`data.skill_diagnoses.push({...joint,id:'new-joint',created_at:'2026-10-21T02:00:00Z'});`);html=x.run('diagnosisIssueHtml(issue)');assert.match(html,/历史联合诊断报告（1）/);assert.equal(x.run('JSON.stringify(data.ratings)===before'),true);
});

test('新版联合报告按诊断问题共用修订与验证，工单明细只核查原问题，导出不重复',()=>{
 const x=insightWorkspace();x.run(`
  var detail={validity:'supported',cause_status:'direct_basis',action:'modify_skill',location:'章节一',explanation:'本单核查说明',suggestion:'共享处理动作',revision:{before:'原条款',proposed_text:'唯一共享修订内容',reason:'修改原因'},verification_cases:[{name:'边界案例',input:'唯一共享验证条件',expected:'预期动作'}],skill_quotes:[],requirement_quotes:[],evidence_quotes:[{id:'E001',label:'本单原文',text:'原文内容'}],missing_materials:[]};
  var compactJoint={id:'compact',kind:'batch',scene:'合成场景',rating_ids:['rating-a','rating-b'],status:'completed',request_snapshot:{selected_findings:[{finding_index:0,original_finding_index:0,rating_id:'rating-a',item_id:'a',record_name:'记录a',description:'问题甲'},{finding_index:1,original_finding_index:0,rating_id:'rating-b',item_id:'b',record_name:'记录b',description:'问题乙'}],service_skills:[{code:'VERBAL_CONFLICT',version:'v1'}]},report:{report_layout:'group_first',summary:'共同问题',findings:[{...detail,finding_index:0},{...detail,finding_index:1}],groups:[{...detail,id:'group_1',title:'共同定义缺口',kind:'common',case_count:2,finding_indices:[0,1]}]}};
 `);
 const html=x.run('batchDiagnosisReportHtml(compactJoint)'),doc=x.run('diagnosisReportDocument(compactJoint)');assert.equal((html.match(/唯一共享修订内容/g)||[]).length,1);assert.equal((html.match(/唯一共享验证条件/g)||[]).length,1);assert.equal((doc.match(/唯一共享修订内容/g)||[]).length,1);assert.equal((doc.match(/唯一共享验证条件/g)||[]).length,1);assert.match(html,/本诊断问题共用的条款与处理方案/);assert.match(html,/问题甲/);assert.match(html,/问题乙/);assert.equal((html.match(/核查结论/g)||[]).length,2);
 x.run(`delete compactJoint.report.report_layout;`);const legacy=x.run('batchDiagnosisReportHtml(compactJoint)');assert.equal((legacy.match(/唯一共享修订内容/g)||[]).length,2);
});

test('新版工单表现评估直接展示五项报告，不再藏在两层判断依据中',()=>{
  const x=workspace();
  x.run(`var helpRow={status:'L2',item:{id:'new-help',record_snapshot:{name:'合成工单'}},rating:{id:'new-rating',report:{grade:'L2',summary:'已整理争议，仍需核查支付记录。',task_summary:'辅助核查重复收费',helpful_contributions:[{result:'已识别支付争议',evidence_reason:'输出保留双方说法',benefit:'减少客服翻找材料的工作',evidence_refs:['E001']}],remaining_work:[{work:'核查支付记录',reason:'双方陈述不一致',kind:'supplement',evidence_refs:['E001']}],dimensions:[],findings:[],missing_materials:['支付记录：确认是否重复收取'],requires_review:true},request_snapshot:{evaluation_stage:'performance',sources:[],reference_index:[{id:'E001',role:'ai_output',text:'双方对支付存在不同说法',label:'AI输出'}]}}};var helpHtml=insightRecordHtml(helpRow);`);
  const html=x.run('helpHtml');for(const text of ['评估结论','关键点是什么','没解决什么','本次任务','已经提供的帮助','仍需客服完成的工作','暂不能判断的事项'])assert.ok(html.includes(text),text);
  assert.doesNotMatch(html,/查看判断依据|完整评级与运行详情/);assert.match(html,/查看详细检查与判级依据/);
});

test('二线详情优先展开诉求、人工处理和AI责任结论，索引信息与其他输出靠后且原文不重复',()=>{
 const x=workspace();
 for(const profile of ['rnd','standard']){
  const row={'工单ID':'SYN-REVIEW','反馈内容':'司机申诉：停车费确实发生。','处理意见':'人工已核实：无收费凭证，维持原处理。',...(profile==='rnd'?{'traceId':'TRACE-REVIEW','租户id':'SYN','责任方':'司机','责任结论':'AI认为停车费合理，无需调整。','关键信息提取':'其他提取内容'}:{'AI分析结论':'AI认为停车费合理，无需调整。','AI处理记录':'其他处理日志'})};
  x.run('var reviewSourceRecord=BusinessImport.adaptRecord('+JSON.stringify(row)+');var reviewSourceHtml=businessRecordHtml(reviewSourceRecord);');
  const html=x.run('reviewSourceHtml');
  const human=html.indexOf('原始诉求与人工处理'),ai=html.indexOf('AI 责任结论'),metadata=html.indexOf('工单信息与材料说明');assert.ok(human>=0&&ai>human&&metadata>ai);
  assert.match(html,/class="review-key-text">司机申诉：停车费确实发生。/);assert.match(html,/class="review-key-text">人工已核实：无收费凭证，维持原处理。/);assert.match(html,/class="review-key-text">AI认为停车费合理，无需调整。/);
  assert.equal((html.match(/AI认为停车费合理，无需调整。/g)||[]).length,1);assert.doesNotMatch(html.slice(0,ai),/<details/);
  assert.match(html,/<details class="record-other-materials"><summary>工单信息与材料说明/);
 }
 x.run(`var missingSource=businessRecordHtml(BusinessImport.adaptRecord({'工单ID':'EMPTY'}));`);assert.match(x.run('missingSource'),/未提供原始诉求|未提供人工处理意见|未提供 AI 责任结论/);
 x.run(`reviewSourceRecord.business_record.fields.handling_opinion='<script>unsafe</script>';`);assert.doesNotMatch(x.run('businessRecordHtml(reviewSourceRecord)'),/<script>/);
});
test('业务 Skill 维护按左侧场景与对象定位，状态操作清晰，编辑保留原文预览',()=>{
 const x=workspace();x.run(`data.scenes=[{id:'pickup',name:'接驾异常',status:'active',scopes:['frontline','tier2']},{id:'cancel',name:'订单取消',status:'active',scopes:['tier2']}];data.services=[{id:'a',code:'PICKUP',version:'v1',scene_id:'pickup',scene:'接驾异常',scope:'frontline',raw:'## 原文\\n- 核实',source:'导出',content_hash:'hash',created_at:'2026-10-22'},{id:'b',code:'CANCEL',version:'v1',scene_id:'cancel',scene:'订单取消',scope:'tier2',raw:'取消核实',source:'导出',content_hash:'other',created_at:'2026-10-22'}];show('services',{restore:true});`);
 let html=x.node('view').innerHTML;assert.match(html,/全部业务 Skills/);assert.match(html,/data-service-scene="pickup"/);assert.match(html,/当前使用/);assert.match(html,/data-service-edit="a"/);assert.match(html,/data-service-delete="b"/);assert.equal(x.node('.scope').hidden,true);x.click({serviceScene:'pickup'});html=x.node('view').innerHTML;assert.match(html,/data-service-edit="a"/);assert.doesNotMatch(html,/data-service-edit="b"/);x.click({serviceEdit:'a'});assert.match(x.node('modalBody').innerHTML,/编辑业务 Skill/);assert.match(x.node('modalBody').innerHTML,/阅读预览/);assert.match(x.node('modalBody').innerHTML,/原文/);assert.match(x.node('modalBody').innerHTML,/id="serviceUseCurrent" checked/);x.dispatch('change',{target:{id:'serviceObjectScope',value:'tier2',dataset:{}}});html=x.node('view').innerHTML;assert.doesNotMatch(html,/data-service-edit="a"/);assert.match(html,/data-service-edit="b"/);
});
test('新增场景或发布配置后只重新匹配当前未确认的待处理批次',async()=>{
 const x=workspace();x.run(`analysisTaskId='current';data.batch_routing_reviews=[{batch_id:'current',confirmed:false,pending_group_count:1},{batch_id:'other',confirmed:false,pending_group_count:1}];var rematched=[];refreshBatchRouting=async id=>rematched.push(id);`);
 assert.equal(await x.run('refreshRoutingAfterConfiguration()'),true);assert.equal(x.run('rematched.join()'),'current');
 x.run(`data.batch_routing_reviews[0].confirmed=true;`);assert.equal(await x.run('refreshRoutingAfterConfiguration()'),false);
 x.run(`data.batch_routing_reviews[0].confirmed=false;data.batch_routing_reviews[0].pending_group_count=0;`);assert.equal(await x.run('refreshRoutingAfterConfiguration()'),false);
 x.run(`routingReturnBatch='other';`);assert.equal(await x.run('refreshRoutingAfterConfiguration()'),true);assert.equal(x.run('rematched.join()'),'current,other');
 x.run(`routingReturnBatch=null;analysisTaskId=null;`);assert.equal(await x.run('refreshRoutingAfterConfiguration()'),false);
});
test('新增场景保存和评估配置生效都会等待本批重新匹配',async()=>{
 const x=capabilityWorkspace();x.run(`var rematchEvents=[];request=async(method,url)=>{rematchEvents.push(url);return {};};refresh=async()=>rematchEvents.push('refresh');refreshRoutingAfterConfiguration=async()=>{rematchEvents.push('rematch');return true;};action=async fn=>fn();actor=()=>'测试';sceneEditor();`);
 await x.run(`document.getElementById('saveScene').onclick()`);assert.match(x.run('rematchEvents.join()'),/\/api\/monitor\/scenes,refresh,rematch/);
 x.run(`rematchEvents=[];activateEvaluator('v5');`);await x.run(`document.getElementById('confirmEvaluatorActivate').onclick()`);assert.match(x.run('rematchEvents.join()'),/\/activate,refresh,rematch/);
});

test('责任结论问题优先，定位不等于引用；列表精简，详情对照材料默认可见',()=>{
 const x=insightWorkspace();x.run(`
  var detailOnly={type:'提取问题',title:'详情字段问题',description:'详情提取遗漏',problem_source_ids:['ai_key_information'],affects_primary_conclusion:false,impact:'影响查阅详情',evidence_refs:['E2'],quotes:[{id:'E2',source:'ai_key_information',role:'ai_output',quote:'详情原句'}]};
  var primaryIssue={type:'责任问题',title:'结论依据不足',description:'责任结论确定表述超出录音',suggestion:'核听录音后修正',evidence_reason:'取消行为没有可见支持',problem_source_ids:['ai_analysis_conclusion'],affects_primary_conclusion:true,impact:'当前判责结论需复核',quotes:[{id:'E1',source:'ai_analysis_conclusion',role:'ai_output',quote:'AI确定判责原句'},{id:'E3',source:'journey_dialogue_text',role:'context',quote:'司机的录音原话'}]};
  data.ratings[0].report.findings=[detailOnly,primaryIssue];
  data.ratings[0].request_snapshot={sources:[{id:'ai_analysis_conclusion',role:'ai_output',label:'责任结论'},{id:'ai_key_information',role:'ai_output',label:'关键信息提取'},{id:'journey_dialogue_text',role:'context',label:'行程对话'}]};
  analysisTaskId='batch';view='batches';render();
 `);
 x.click({batchIssue:'-1'});const list=x.node('view').innerHTML;assert.ok(list.indexOf('责任结论确定表述超出录音')<list.indexOf('详情提取遗漏'));assert.match(list,/当前判责结论需复核/);assert.doesNotMatch(list,/AI确定判责原句|司机的录音原话/);
 x.click({findingOpen:JSON.stringify(['rating-a',1]),findingItem:'a'});const detail=x.node('modalBody').innerHTML;
 assert.ok(detail.indexOf('data-record-finding="1"')<detail.indexOf('data-record-finding="0"'));assert.match(detail,/AI 相关输出/);assert.match(detail,/核对材料/);assert.match(detail,/AI确定判责原句/);assert.match(detail,/司机的录音原话/);assert.match(detail,/建议怎么处理/);
 const beforeFold=detail.slice(0,detail.indexOf('<summary>查看具体帮助'));assert.match(beforeFold,/data-record-finding="1"/);
 const location=x.run('findingLocationHtml(primaryIssue,data.ratings[0].request_snapshot.sources)');assert.match(location,/责任结论/);assert.doesNotMatch(location,/行程对话/);
});

test('从问题入口保留原评估轮次与冻结材料；后续评估不能替换当前问题',()=>{
 const x=insightWorkspace();x.run(`
  var old=data.ratings[0];old.report.findings[0].description='旧轮次的具体问题';old.record_snapshot={...data.batch_items[0].record_snapshot,name:'旧轮次冻结工单',session_text:'旧轮次冻结原文'};
  old.request_snapshot={sources:[],reference_index:[]};
  data.ratings.push({...structuredClone(old),id:'rating-new',record_snapshot:{...old.record_snapshot,name:'新轮次工单',session_text:'新轮次原文'},report:{...structuredClone(old.report),findings:[{description:'新轮次另一个问题',type:'其他',quotes:[]}]}});
 `);
 x.click({findingOpen:JSON.stringify(['rating-a',0]),findingItem:'a'});const html=x.node('modalBody').innerHTML;assert.match(html,/旧轮次的具体问题/);assert.match(html,/旧轮次冻结原文/);assert.doesNotMatch(html,/新轮次另一个问题|新轮次原文/);
});


test('分析总结可直接标记工单，筛选后问题与详情队列都只含重点工单',()=>{
 const x=insightWorkspace();x.run(`view='batches';analysisTaskId='batch';data.batch_items[0].focus_marked=true;render();`);
 assert.match(x.node('view').innerHTML,/id="batchSummaryMarkType"/);assert.match(x.node('view').innerHTML,/data-mark-item="a"[^>]*aria-pressed="true"/);
 x.dispatch('change',{target:{id:'batchSummaryMarkType',value:'marked',dataset:{}}});
 assert.equal(x.run(`batchSummaryRows('batch').map(r=>r.item.id).join()`),'a');assert.equal(x.run(`AnalysisSummary.aggregate(insightRows()).issues[0].count`),1);
 x.click({findingRecord:'a',findingRating:'rating-a'});assert.match(x.node('modalBody').innerHTML,/具体事实矛盾/);assert.equal(x.run('workspaceEvidenceQueue.join()'),'a');
 x.click({summaryReset:''});assert.equal(x.run(`batchSummaryRows('batch').length`),3);assert.equal(x.run('data.batch_items[0].focus_marked'),true);
});

test('主要位置只保留一个普通文本，关联位置在详情说明；影响复用原句且不误报历史缺失',()=>{
 const x=insightWorkspace();assert.equal(x.run('insightOrderedSources({sources:[{item_id:"a",finding_index:1},{item_id:"a",finding_index:0}]}).map(s=>s.finding_index).join()'),'0,1');x.run(`
  var simplifiedFinding={type:'事实判断',title:'录音解读超出可见内容',description:'AI把车辆老旧直接写成“引导乘客取消”，未标注待核实；客服若直接采用，会把未确认行为当作维持判责依据。',evidence_reason:'录音片段不足以支持确定判断。',quotes:[{source:'ai_analysis_conclusion',role:'ai_output',quote:'存在引导乘客取消行为，平台维持原判责。'},{source:'ai_key_information',role:'ai_output',quote:'司机引导乘客取消。'},{source:'ai_core_evidence',role:'ai_output',quote:'车子老了。'}]};
  data.ratings[0].report.findings=[simplifiedFinding];analysisTaskId='batch';view='batches';render();
 `);
 x.click({batchIssue:'-1'});const list=x.node('view').innerHTML;
 assert.match(list,/<th>主要问题位置<\/th>/);assert.match(list,/<span class="finding-main-location">责任结论<\/span>/);
 assert.doesNotMatch(list,/关键信息提取|核心证据|默认展示| · 详情|引用涉及|历史报告未|历史问题位置/);
 assert.equal((list.match(/客服若直接采用，会把未确认行为当作维持判责依据。/g)||[]).length,1);
 x.click({findingOpen:JSON.stringify(['rating-a',0]),findingItem:'a'});const detail=x.node('modalBody').innerHTML;
 assert.match(detail,/同一问题也出现在：关键信息提取。/);assert.doesNotMatch(detail,/同一问题也出现在：[^<]*核心证据|默认展示| · 详情|历史报告未单列处理影响/);
 const missing=x.run('insightIssueExplanation({key:"empty-impact",sources:[{item_id:"a",rating_id:"rating-a",finding_index:0,description:"提取内容不完整。",quotes:[]}]})');
 assert.match(missing,/<td class="issue-impact-cell"><p>—<\/p>/);assert.doesNotMatch(missing,/历史报告|需核对/);
});

test('记录列表三项摘要与详情一致，等级、复核、标记和操作保留',()=>{
 const x=workspace();x.run(`data.batch_items=[{id:'summary-item',case_id:'case-summary',batch_id:'batch',record_snapshot:{name:'摘要样例',scope:'tier2'}}];data.ratings=[{id:'summary-rating',item_id:'summary-item',status:'completed',report:{grade:'L2',summary:'关键点是什么：已提取双方说法，但核心费用条件缺失，仍需补齐。\\n\\n没解决什么：核对费用条件。',output_readability:{status:'needs_improvement',reason:'结论没有关联费用条件。'}}}];var summaryHtml=workspaceRecordsPanel(workspaceRows({batch:'all',target:'all',scene:'all'}));`);
 const html=x.run('summaryHtml');for(const label of ['关键点是什么','没解决什么','可读性怎么样','需要改进','核对费用条件。','结论没有关联费用条件。','grade-L2','data-workspace-evidence','data-mark-item'])assert.ok(html.includes(label),label);
 assert.doesNotMatch(html,/结论摘要|解决了什么：/);assert.equal((html.match(/<th scope="col">/g)||[]).length,5);
});


test('新报告重新显示未查看，已有问题标记保留并提示来自较早评估',()=>{
 const x=insightWorkspace();x.run(`data.record_views=[{item_id:'a',revision_key:'rating:rating-a'}];data.batch_items[0].attention_marks=[{type:'evaluation',reason:'漏读依据',suggestion:'补充判据',rating_id:'rating-a',actor:'甲',at:'2026-10-22T00:00:00Z'}];`);
 assert.equal(x.run(`workspaceViewState(evidenceRow('a'))`),'viewed');x.run(`data.ratings.push({...data.ratings[0],id:'new-rating'});`);
 assert.equal(x.run(`workspaceViewState(evidenceRow('a'))`),'unviewed');assert.match(x.run(`recordMarkBadges(data.batch_items[0],'new-rating')`),/较早评估/);
 x.run(`openWorkspaceEvidence('a');`);assert.match(x.node('modalBody').innerHTML,/漏读依据/);assert.match(x.node('modalBody').innerHTML,/完善评估标准/);
});
test('一键标记直接进入唯一待分析事项，已有事项打开分析表单且保留原等级',async()=>{
 const x=insightWorkspace();x.run(`view='records';request=async(method,url,body)=>({item:{...data.batch_items[0],focus_marked:true,attention_task_id:'attention'},task:{id:'attention',source:'record_attention',attention_item_id:'a',case_id:data.batch_items[0].case_id,rating_id:'rating-a',rating_refs:[{item_id:'a',rating_id:'rating-a'}],status:'待分析',title:'工单 · 问题分析',analysis_marks:[],history:[],version:0}});`);
 await x.run(`openRecordMarkEditor('a','rating-a')`);assert.equal(x.run('data.tasks.length'),1);assert.equal(x.run('data.tasks[0].status'),'待分析');
 x.run(`openRecordMarkEditor('a','rating-a')`);const html=x.node('modalBody').innerHTML;
 for(const text of ['评估不符合','AI 客服有问题','评估不符合的原因','AI 问题与原文位置','AI 客服改进方案','草稿','无需改进'])assert.ok(html.includes(text),text);
 assert.doesNotMatch(html,/workspaceReviewGrade|人工等级/);assert.equal(x.run('data.rating_reviews.length'),0);assert.equal(x.run('data.tasks.length'),1);
 x.run(`openWorkspaceEvidence('a')`);assert.doesNotMatch(x.node('modalBody').innerHTML,/创建改进待办|data-rating-task=/);assert.match(x.node('modalBody').innerHTML,/查看待办/);
});
test('已标记工单直接提供取消和查看待办，点击取消不再走标记入口',()=>{
 const x=insightWorkspace();x.run(`data.batch_items[0].focus_marked=true;data.tasks=[{id:'cancel-task',source:'record_attention',attention_item_id:'a',status:'待分析'}];var cancelCalls=0,markCalls=0;cancelRecordMark=()=>{cancelCalls++};openRecordMarkEditor=()=>{markCalls++};`);
 const html=x.run(`workspaceMarkButton(data.batch_items[0],'rating-a')`);assert.match(html,/data-cancel-mark="a"/);assert.match(html,/取消标记/);assert.match(html,/查看待办/);
 x.click({markItem:'a',cancelMark:'a',markRating:'rating-a'});assert.equal(x.run('cancelCalls'),1);assert.equal(x.run('markCalls'),0);
});
test('撤回后清除标记并退出默认待办，已推进时显示确认且不立即提交',async()=>{
 const x=insightWorkspace();x.run(`data.batch_items[0].focus_marked=true;data.batch_items[0].attention_version=1;data.tasks=[{id:'cancel-task',source:'record_attention',attention_item_id:'a',case_id:data.batch_items[0].case_id,rating_refs:[{item_id:'a',rating_id:'rating-a'}],status:'待分析',title:'待分析事项',history:[],version:0}];var cancelRequests=0;request=async()=>{cancelRequests++;return {item:{...data.batch_items[0],focus_marked:false,attention_marks:[],attention_version:2},task:{...data.tasks[0],status:'已撤回',version:1}}};`);
 await x.run(`cancelRecordMark('a','rating-a')`);assert.equal(x.run('cancelRequests'),1);assert.equal(x.run('data.batch_items[0].focus_marked'),false);assert.equal(x.run('attentionTaskFor(data.batch_items[0])'),undefined);assert.doesNotMatch(x.run('renderTasks()'),/待分析事项/);assert.match(x.run(`workspaceMarkButton(data.batch_items[0])`),/>标记</);
 x.run(`data.batch_items[0].focus_marked=true;data.tasks[0].status='修改中';cancelRecordMark('a','rating-a')`);assert.match(x.node('modalBody').innerHTML,/确认取消并撤回/);assert.equal(x.run('cancelRequests'),1);
});

test('记录租户筛选精确匹配并重置分页和详情队列，重置恢复全部租户',()=>{
 const x=insightWorkspace();x.run(`data.batch_items.forEach((item,i)=>item.record_snapshot.tenant_id=i===0?'800029':i===1?'8000290':'00800029');show('records');workspaceRecordPage=3;workspaceEvidenceQueue=['a','b'];`);
 assert.match(x.node('view').innerHTML,/id="workspaceTenantFilter"/);assert.match(x.node('view').innerHTML,/00800029/);
 x.dispatch('change',{target:{id:'workspaceTenantFilter',value:'800029',dataset:{}}});
 assert.equal(x.run('filteredWorkspaceRows(workspaceRows()).map(r=>r.item.id).join()'),'a');assert.equal(x.run('workspaceRecordPage'),1);assert.equal(x.run('workspaceEvidenceQueue.length'),0);assert.match(x.node('view').innerHTML,/租户 ID：800029/);
 x.click({resetWorkspaceRecords:''});assert.equal(x.run('tenantFilter'),'all');assert.equal(x.run('filteredWorkspaceRows(workspaceRows()).length'),3);
});

test('批次总结的租户范围贯穿问题、诊断与记录下钻，按批保存且重置恢复全批',()=>{
 const x=insightWorkspace();x.run(`data.batch_items.forEach((item,i)=>item.record_snapshot.tenant_id=i===0?'800029':'800030');analysisTaskId='batch';view='batches';render();`);
 assert.match(x.node('view').innerHTML,/id="batchSummaryTenant"/);
 x.dispatch('change',{target:{id:'batchSummaryTenant',value:'800029',dataset:{}}});assert.equal(x.run('insightRows().map(r=>r.item.id).join()'),'a');assert.equal(x.run(`batchWorkspaceState('other').tenant`),'all');
 x.click({batchDetailTab:'diagnosis'});assert.match(x.node('view').innerHTML,/data-diagnose-rating="rating-a"/);assert.doesNotMatch(x.node('view').innerHTML,/data-diagnose-rating="rating-b"/);
 x.click({summaryRecords:''});assert.equal(x.run('tenantFilter'),'800029');assert.equal(x.run('filteredWorkspaceRows(insightRows()).map(r=>r.item.id).join()'),'a');
 x.click({batchTab:'summary'});x.click({summaryReset:''});assert.equal(x.run(`batchWorkspaceState('batch').tenant`),'all');assert.equal(x.run('insightRows().length'),3);
});

test('看板租户条件查询后生效，指标与下钻及返回保持租户范围，重置恢复全量',()=>{
 const x=insightWorkspace();x.run(`data.batch_items.forEach((item,i)=>item.record_snapshot.tenant_id=i===0?'800029':'800030');show('analytics');`);
 assert.match(x.node('view').innerHTML,/id="analyticsTenantFilter"/);
 x.node('analyticsScopeFilter').value='all';x.node('analyticsSceneFilter').value='all';x.node('analyticsBatchFilter').value='all';x.node('analyticsTenantFilter').value='800029';
 x.dispatch('change',{target:{id:'analyticsTenantFilter',value:'800029',dataset:{}}});assert.equal(x.run('analyticsSnapshot().unique.length'),3);
 x.dispatch('submit',{target:{id:'analyticsRangeForm'},preventDefault(){}});assert.equal(x.run('analyticsSnapshot().unique.length'),1);
 x.click({dashboardDrill:'0'});assert.equal(x.run('tenantFilter'),'800029');assert.equal(x.run('filteredWorkspaceRows(workspaceRows()).map(r=>r.item.id).join()'),'a');
 x.click({insightReturn:''});assert.equal(x.run('analyticsTenant'),'800029');assert.equal(x.run('analyticsSnapshot().unique.length'),1);
 x.click({dashboardReset:''});assert.equal(x.run('analyticsTenant'),'all');assert.equal(x.run('analyticsSnapshot().unique.length'),3);
});

test('助手范围提供租户筛选，跳转记录讨论时带入当前租户条件',()=>{
 const x=insightWorkspace();x.run(`data.batch_items[0].record_snapshot.tenant_id='800029';show('home');`);assert.match(x.node('view').innerHTML,/id="workspaceTenant"/);
 x.dispatch('change',{target:{id:'workspaceTenant',value:'800029',dataset:{}}});assert.equal(x.run('workspaceContext.tenant_id'),'800029');
 x.run(`tenantFilter='800029';workspaceRecordsBatch='batch';show('records');`);x.click({discussRecords:''});assert.equal(x.run('workspaceContext.tenant_id'),'800029');assert.equal(x.run('workspaceContext.batch_id'),'batch');
});

function sceneCatalogWorkspace(){
 const x=workspace();x.run(`data.scenes=Array.from({length:68},(_,i)=>({id:'scene-'+i,code:'SCENE_'+String(i+1).padStart(3,'0'),name:i===35?'取消费复核':'接驾场景 '+(i+1),description:i===35?'核验乘客取消后的费用争议':'场景说明 '+i,boundary:'完整边界 '+i,examples:'典型示例 '+i,version:2,status:i%4===0?'archived':'active',scopes:[i%2===0?'frontline':'tier2']}));show('scenes');`);return x;
}
test('场景目录按页渲染，大量场景翻页不遗漏，筛选回到第一页且可以组合对象和状态',()=>{
 const x=sceneCatalogWorkspace();assert.equal(x.run('sceneCatalogRows().length'),68);assert.equal((x.node('view').innerHTML.match(/class="scene-catalog-name"/g)||[]).length,15);assert.doesNotMatch(x.node('view').innerHTML,/适用边界<|完整边界|典型示例 0/);
 x.click({sceneCatalogPage:'5'});assert.match(x.node('sceneCatalogResults').innerHTML,/61–68 \/ 68/);assert.equal((x.node('sceneCatalogResults').innerHTML.match(/class="scene-catalog-name"/g)||[]).length,8);
 x.dispatch('change',{target:{id:'sceneCatalogObject',value:'frontline',dataset:{}}});assert.equal(x.run('sceneCatalog.page'),1);assert.equal(x.run('sceneCatalogRows().length'),34);
 x.dispatch('change',{target:{id:'sceneCatalogStatus',value:'active',dataset:{}}});assert.equal(x.run('sceneCatalogRows().length'),17);
 x.click({sceneCatalogReset:''});assert.equal(x.run('sceneCatalogRows().length'),68);assert.equal(x.run('sceneCatalog.query'),'');
});
test('场景名称、编码及边界可搜索，空结果提供重置，改变每页数量及数据减少后页码有效',()=>{
 const x=sceneCatalogWorkspace();x.dispatch('input',{target:{id:'sceneCatalogQuery',value:'scene_036',dataset:{}}});assert.equal(x.run('sceneCatalogRows().map(s=>s.id).join()'),'scene-35');
 x.dispatch('input',{target:{id:'sceneCatalogQuery',value:'取消费',dataset:{}}});assert.equal(x.run('sceneCatalogRows().length'),1);
 x.dispatch('input',{target:{id:'sceneCatalogQuery',value:'完整边界 67',dataset:{}}});assert.equal(x.run('sceneCatalogRows()[0].id'),'scene-67');
 x.dispatch('input',{target:{id:'sceneCatalogQuery',value:'不存在的场景',dataset:{}}});assert.match(x.node('sceneCatalogResults').innerHTML,/没有符合条件的场景/);assert.match(x.node('sceneCatalogResults').innerHTML,/data-scene-catalog-reset/);
 x.click({sceneCatalogReset:''});x.dispatch('change',{target:{id:'sceneCatalogPageSize',value:'30',dataset:{}}});assert.equal((x.node('sceneCatalogResults').innerHTML.match(/class="scene-catalog-name"/g)||[]).length,30);
 x.run(`sceneCatalog.page=3;data.scenes=data.scenes.slice(0,4);refreshSceneCatalog()`);assert.equal(x.run('sceneCatalog.page'),1);assert.match(x.node('sceneCatalogResults').innerHTML,/1–4 \/ 4/);
});
test('场景详情完整展示边界与示例，保留编辑和配置入口，关闭再返回不丢列表条件',()=>{
 const x=sceneCatalogWorkspace();x.run(`data.scenes[35].boundary='完整边界 <script>danger</script>';sceneCatalog.query='取消费';sceneCatalog.object='tier2';render();`);x.click({sceneDetail:'scene-35'});
 const html=x.node('modalBody').innerHTML;assert.match(html,/取消费复核/);assert.match(html,/完整边界 &lt;script&gt;danger&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(html,/典型示例 35/);assert.match(html,/data-scene-plans="scene-35"/);assert.match(html,/data-edit-scene="scene-35"/);
 x.run('hideModal();render();');assert.equal(x.run('sceneCatalog.query'),'取消费');assert.equal(x.run('sceneCatalog.object'),'tier2');assert.equal(x.run('sceneCatalogRows().length'),1);
 x.run(`var catalogOpenedScene;openEvaluationSettings=id=>{catalogOpenedScene=id};`);x.click({sceneDetail:'scene-35'});x.click({scenePlans:'scene-35'});assert.equal(x.node('overlay').hidden,true);assert.equal(x.run('catalogOpenedScene'),'scene-35');
});
test('历史映射折叠并分页，搜索后保留原始映射索引，空目录可新建',()=>{
 const x=workspace();x.run(`data.unmapped_scenes=Array.from({length:24},(_,i)=>({name:'历史场景 '+i,scope:'frontline',count:i+1}));show('scenes');`);assert.match(x.node('view').innerHTML,/<details class="panel scene-legacy"><summary>/);assert.match(x.node('view').innerHTML,/还没有业务场景/);
 x.dispatch('input',{target:{id:'sceneLegacyQuery',value:'历史场景 23',dataset:{}}});assert.match(x.node('sceneLegacyResults').innerHTML,/data-map-scene="23"/);assert.doesNotMatch(x.node('sceneLegacyResults').innerHTML,/data-map-scene="0"/);
 x.dispatch('input',{target:{id:'sceneLegacyQuery',value:'',dataset:{}}});x.click({sceneLegacyPage:'3'});assert.equal((x.node('sceneLegacyResults').innerHTML.match(/data-map-scene=/g)||[]).length,4);
});
