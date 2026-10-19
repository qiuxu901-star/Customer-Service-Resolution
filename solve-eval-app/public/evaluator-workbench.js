'use strict';
names.evaluator='评估员 Skill';
let evaluatorTab='editor',evaluatorBuffer=null,evaluatorPollTimer=null;
function evaluatorState(){return data.evaluator_skill||{revisions:[],trials:[]};}
function evaluatorRevision(id){return evaluatorState().revisions.find(r=>r.id===id);}
function evaluatorDraft(){
  const s=evaluatorState(),head=evaluatorRevision(s.head_revision_id);
  if(!evaluatorBuffer&&head)evaluatorBuffer={base_revision_id:head.id,document:head.document,note:'',dirty:false};
  return evaluatorBuffer;
}
function evaluatorBaselineId(s){return s.active_revision_id!==s.head_revision_id?s.active_revision_id:(s.revisions.at(-2)?.id||s.active_revision_id);}
function evaluatorVersion(r){return r?'v'+r.number:'历史未记录';}
function renderEvaluatorSkill(){
  clearTimeout(evaluatorPollTimer);const state=evaluatorState(),active=evaluatorRevision(state.active_revision_id),head=evaluatorRevision(state.head_revision_id),buffer=evaluatorDraft();
  if(!active)return heading('','评估员 Skill','维护所有场景共用的评估方法和等级边界。')+'<section class="panel empty"><h3>尚未加载评估员规则</h3><p>请确认服务已更新后刷新。</p></section>';
  if(state.trials.some(t=>t.status==='running'))evaluatorPollTimer=setTimeout(async()=>{if(view!=='evaluator')return;try{data.evaluator_skill=await request('GET','/api/monitor/evaluator-skill');render();}catch{if(view==='evaluator')render();}},2000);
  const tabs=[['editor','正文维护'],['history','版本与差异'],['trials','工单试评']];
  return heading('','评估员 Skill','统一证据纪律与判级方法，让每次评估有据可追。',state.built_in?'<button class="btn" data-evaluator-builtin>查看系统内置 Skill</button>':'')+
    '<section class="panel evaluator-live"><div><span class="evaluator-dot"></span><strong>当前生效 '+evaluatorVersion(active)+'</strong><span class="meta">全场景通用 · '+esc(active.confirmed_by)+' · '+esc(formatTime(active.confirmed_at))+'</span></div><span class="badge good">后续评级使用此版本</span></section>'+
    '<div class="evaluator-tabs" role="tablist" aria-label="评估员 Skill 维护">'+tabs.map(([id,label])=>'<button role="tab" aria-selected="'+(evaluatorTab===id)+'" class="'+(evaluatorTab===id?'active':'')+'" data-evaluator-tab="'+id+'">'+label+(id==='history'?'<span>'+state.revisions.length+'</span>':'')+'</button>').join('')+'</div>'+
    (evaluatorTab==='editor'?evaluatorEditorHtml(state,active,head,buffer):evaluatorTab==='history'?evaluatorHistoryHtml(state,active):evaluatorTrialsHtml(state));
}
function evaluatorEditorHtml(state,active,head,buffer){
  const draft=head.id!==active.id,stale=buffer.base_revision_id!==head.id;
  return '<div class="evaluator-layout"><section class="panel evaluator-editor"><div class="panel-head"><div><h2>评估员规则正文</h2><p class="sub">'+(draft?'最新草稿 '+evaluatorVersion(head)+' · 保存后可试评或确认生效':'基于生效版本 '+evaluatorVersion(active)+' 编辑，保存将创建新草稿')+'</p></div><span class="badge '+(draft?'warn':'')+'">'+(draft?'草稿待确认':'已生效')+'</span></div>'+
    (stale?'<div class="notice warn">服务器已有新版本，你的输入已保留。请复制正文并查看版本差异，再载入最新正文。<button class="link" data-evaluator-reload>载入最新正文</button></div>':'')+
    '<label class="field" for="evaluatorDocument">完整 Skill 正文 <small>支持 Markdown，最多 100000 字符</small></label><textarea id="evaluatorDocument" class="evaluator-document" spellcheck="false" maxlength="100000">'+esc(buffer.document)+'</textarea><div class="evaluator-editor-meta"><span id="evaluatorDirty" role="status">'+(buffer.dirty?'有未保存修改':'正文已保存')+'</span><span id="evaluatorChars">'+buffer.document.length.toLocaleString()+' 字符</span></div>'+
    '<label class="field">修改说明<input id="evaluatorNote" maxlength="500" value="'+esc(buffer.note)+'" placeholder="说明这次修改的判据、原因与预期影响"></label><p class="error" id="evaluatorError" role="alert"></p>'+
    '<div class="evaluator-savebar"><span>保存草稿后，当前生效版本继续用于评级。</span><div class="actions"><button class="btn" data-evaluator-save '+(stale?'disabled':'')+'>保存草稿</button><button class="btn primary" data-evaluator-activate="'+esc(head.id)+'" '+(!draft||buffer.dirty?'disabled':'')+'>确认生效 '+(draft?evaluatorVersion(head):'')+'</button></div></div></section>'+
    '<aside class="evaluator-guide"><section class="panel"><span class="eyebrow">规则分工</span><h3>从全局到场景</h3><ol><li><strong>评估员 Skill</strong><p>评估方法、等级定义、证据纪律与判断顺序。</p></li><li><strong>监测方案</strong><p>当前场景检查哪些维度，适用哪些业务判据。</p><button class="link" data-view="plans">查看监测方案 ↗</button></li><li><strong>客服业务 Skill</strong><p>被评客服应遵循的取证、判责与处理流程。</p><button class="link" data-view="services">查看客服业务 Skills ↗</button></li></ol></section>'+
    '<section class="panel"><h3>生效范围</h3><p>适用于所有场景的后续 LLM 自动评级。任务启动时固定版本，执行中编辑规则不会改变该轮输入。</p><p>历史报告保留原快照；重新评级产生新轮次。旧版检测台继续使用原有规则。</p><button class="btn" data-evaluator-tab="trials">先用工单试评</button></section><details class="panel"><summary>系统固定的输出校验</summary><p>JSON 格式、证据编号和引用范围由系统维护。已确认关键错误与 L0、L2/L3 的实质价值、阻断判断的规则冲突之间须保持一致；矛盾结果标为评级失败，供重试或复核。</p></details></aside></div>';
}
function evaluatorBuiltIn(){
  const s=evaluatorState(),builtIn=s.built_in,protocol=s.system_protocol;
  if(!builtIn)throw Error('请刷新页面加载系统内置 Skill');
  modal('<h2 id="modalTitle">系统内置评估员 Skill</h2><p class="meta">内置版本 '+esc(builtIn.version)+' · '+builtIn.document.length.toLocaleString()+' 字符</p><p>包含评估流程、材料来源、等级判据、缺证边界、关联 Skill 核验、规则冲突与引用要求。采用后创建可维护草稿。</p><pre>'+esc(builtIn.document)+'</pre>'+(protocol?'<details><summary>系统运行协议（只读） · '+esc(protocol.version)+'</summary><p class="sub">实际调用使用的系统提示词与 JSON 输出契约，技术协议由系统维护。</p><h3>系统提示词原文</h3><pre>'+esc(protocol.system_prompt)+'</pre><h3>输出契约</h3><pre>'+esc(JSON.stringify(protocol.output_contract,null,2))+'</pre><p class="meta">协议摘要 '+esc(protocol.prompt_hash)+'</p></details>':'')+'<div id="formError" class="error"></div><div class="form-actions"><button class="btn primary" id="useEvaluatorBuiltIn">采用内置正文为新草稿</button></div>');
  $('useEvaluatorBuiltIn').onclick=()=>action(async()=>{
    if(evaluatorBuffer?.dirty)throw Error('当前有未保存正文，请先保存草稿再采用内置版本');
    await request('POST','/api/monitor/evaluator-skill/revisions',{actor:actor(),base_revision_id:s.head_revision_id,document:builtIn.document,note:'采用系统内置完整版 '+builtIn.version});
    evaluatorBuffer=null;evaluatorTab='editor';hideModal();await refresh();toast('系统内置 Skill 已保存为新草稿，可继续维护或确认生效');
  });
}
function evaluatorHistoryHtml(state,active){
  return '<section class="panel"><div class="panel-head"><div><h2>版本历史</h2><p class="sub">每次保存创建独立版本；恢复历史内容会新建草稿。</p></div><button class="btn" data-evaluator-diff>比较版本差异</button></div><div class="table-scroll"><table class="batch-table"><thead><tr><th>版本 / 状态</th><th>修改说明</th><th>维护与生效</th><th>操作</th></tr></thead><tbody>'+[...state.revisions].reverse().map(r=>'<tr><td><strong>'+evaluatorVersion(r)+'</strong><span class="badge '+(r.id===active.id?'good':r.status==='draft'?'warn':'')+'">'+(r.id===active.id?'当前生效':r.status==='draft'?'草稿':'历史生效')+'</span></td><td>'+esc(r.note)+'</td><td>'+esc(r.actor)+' · '+esc(formatTime(r.created_at))+(r.confirmed_at?'<small>确认：'+esc(r.confirmed_by)+' · '+esc(formatTime(r.confirmed_at))+'</small>':'')+'</td><td><button class="link" data-evaluator-detail="'+r.id+'">查看正文</button> <button class="link" data-evaluator-restore="'+r.id+'">恢复为草稿</button></td></tr>').join('')+'</tbody></table></div></section>';
}
function evaluatorTrialStatus(t){return {running:'试评中',completed:'已完成',completed_with_errors:'部分失败',interrupted:'已中断'}[t.status]||t.status;}
function evaluatorTrialsHtml(state){
  const trials=[...state.trials].reverse();
  return '<section class="panel"><div class="panel-head"><div><h2>同一工单，比较两个评估员版本</h2><p class="sub">固定原工单、场景方案、客服 Skill 和同一模型，各调用一次。试评结果独立保存。</p></div><button class="btn primary" data-evaluator-new-trial '+(state.revisions.length<2||state.trials.some(t=>t.status==='running')?'disabled':'')+'>选择工单试评</button></div>'+(state.revisions.length<2?'<div class="notice">先保存一份草稿，即可与生效版本比较。</div>':'')+'<p class="meta">会向所选模型发送该工单和规则，产生两次模型调用；结果不进入正式评级分布，也不修改人工复核。</p>'+(trials.length?'<div class="evaluator-trial-list">'+trials.map(t=>'<article class="evaluator-trial-row"><div><strong>'+esc(t.record_name)+'</strong><p class="meta">'+esc(t.model_snapshot?.model)+' · '+esc(formatTime(t.created_at))+'</p></div><div class="evaluator-trial-grades">'+['baseline','candidate'].map(side=>{const s=t.sides[side];return '<span>'+esc(s.evaluator_skill_snapshot.version)+' <b>'+esc(s.report?.grade||(s.status==='failed'?'失败':s.report?.applicability==='not_applicable'?'不适用':'…'))+'</b></span>';}).join('<span class="meta">→</span>')+'</div><span class="badge">'+evaluatorTrialStatus(t)+'</span><button class="link" data-evaluator-trial-detail="'+t.id+'">查看对比</button></article>').join('')+'</div>':'<div class="empty"><h3>尚无试评记录</h3><p>选一条有完整评级快照的工单，观察规则变化对判断的影响。</p></div>')+'</section>';
}
function evaluatorModalError(e){if($('formError'))$('formError').textContent=e.message;else if($('evaluatorError'))$('evaluatorError').textContent=e.message;else toast(e.message);}
async function saveEvaluatorDraft(){
  const b=evaluatorDraft();const result=await request('POST','/api/monitor/evaluator-skill/revisions',{base_revision_id:b.base_revision_id,document:b.document,note:b.note,actor:actor()});
  evaluatorBuffer=null;await refresh();toast('草稿 '+evaluatorVersion(result.revision)+' 已保存，确认生效后用于后续评级');
}
function activateEvaluator(id){
  const s=evaluatorState(),r=evaluatorRevision(id);if(evaluatorBuffer?.dirty)throw Error('请先保存正文修改，再确认生效');
  modal('<h2 id="modalTitle">确认生效 '+evaluatorVersion(r)+'</h2><p>'+esc(r.note)+'</p><p>将全场景的后续 LLM 评级切换到此版本。已启动任务和历史结果保留原版本。</p><details open><summary>本次生效正文</summary><pre>'+esc(r.document)+'</pre></details><div id="formError" class="error"></div><div class="form-actions"><button class="btn primary" id="confirmEvaluatorActivate">确认生效</button></div>');
  $('confirmEvaluatorActivate').onclick=()=>action(async()=>{await request('POST','/api/monitor/evaluator-skill/revisions/'+id+'/activate',{expected_active_revision_id:s.active_revision_id,actor:actor()});evaluatorBuffer=null;hideModal();await refresh();toast(evaluatorVersion(r)+' 已生效，后续评级使用此版本');});
}
function evaluatorDiffLines(before,after){
  const a=before.split('\n'),b=after.split('\n');if(a.length*b.length>500000)return '<p class="sub">正文较长，显示完整前后版本。</p><div class="evaluator-compare"><pre>'+esc(before)+'</pre><pre>'+esc(after)+'</pre></div>';
  const dp=Array.from({length:a.length+1},()=>new Uint32Array(b.length+1));for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)dp[i][j]=a[i]===b[j]?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]);
  let i=0,j=0,html='';while(i<a.length||j<b.length){if(i<a.length&&j<b.length&&a[i]===b[j]){html+='<div class="diff-same">  '+esc(a[i++])+'</div>';j++;}else if(j<b.length&&(i===a.length||dp[i][j+1]>=dp[i+1][j]))html+='<div class="diff-add">+ '+esc(b[j++])+'</div>';else html+='<div class="diff-remove">− '+esc(a[i++])+'</div>';}
  return '<div class="evaluator-diff" aria-label="版本差异：加号为新增，减号为删除">'+html+'</div>';
}
function evaluatorDiff(){
  const s=evaluatorState(),options=id=>s.revisions.map(r=>'<option value="'+r.id+'" '+(r.id===id?'selected':'')+'>'+evaluatorVersion(r)+' · '+esc(r.note)+'</option>').join('');
  modal('<h2 id="modalTitle">比较版本差异</h2><div class="form-grid"><label class="field">原版本<select id="evaluatorDiffBefore">'+options(evaluatorBaselineId(s))+'</select></label><label class="field">比较版本<select id="evaluatorDiffAfter">'+options(s.head_revision_id)+'</select></label></div><p class="meta">绿色 + 为新增，红色 − 为删除。</p><div id="evaluatorDiffResult"></div>');
  const update=()=>{$('evaluatorDiffResult').innerHTML=evaluatorDiffLines(evaluatorRevision($('evaluatorDiffBefore').value).document,evaluatorRevision($('evaluatorDiffAfter').value).document);};$('evaluatorDiffBefore').onchange=update;$('evaluatorDiffAfter').onchange=update;update();
}
function restoreEvaluator(id){
  if(evaluatorBuffer?.dirty)throw Error('当前有未保存正文，请先保存草稿');const s=evaluatorState(),r=evaluatorRevision(id);
  modal('<h2 id="modalTitle">恢复 '+evaluatorVersion(r)+' 为新草稿</h2><p>保留版本历史和当前生效规则，恢复后仍需确认生效。</p><label class="field">恢复说明<input id="evaluatorRestoreNote" maxlength="500" value="恢复 '+evaluatorVersion(r)+' 的规则内容"></label><div id="formError" class="error"></div><div class="form-actions"><button class="btn primary" id="confirmEvaluatorRestore">创建恢复草稿</button></div>');
  $('confirmEvaluatorRestore').onclick=()=>action(async()=>{await request('POST','/api/monitor/evaluator-skill/revisions',{base_revision_id:s.head_revision_id,document:r.document,note:$('evaluatorRestoreNote').value,restored_from:id,actor:actor()});evaluatorBuffer=null;evaluatorTab='editor';hideModal();await refresh();toast('历史内容已恢复为新草稿');});
}
function evaluatorTrialEditor(){
  if(evaluatorBuffer?.dirty)throw Error('请先保存正文草稿，再进行版本试评');const s=evaluatorState(),rows=[...(data.ratings||[])].reverse().filter(r=>r.request_snapshot?.monitoring_plan&&r.request_snapshot?.sources);
  modal('<h2 id="modalTitle">工单试评</h2><p class="sub">固定原输入快照，以同一模型重新评估两个版本。不会修改正式等级。</p><label class="field">选择评级记录（可输入工单号筛选）<input id="evaluatorTrialSearch" type="search" placeholder="例如：206014020684"></label><label class="field">工单及原轮次<select id="evaluatorTrialRating"></select></label><div class="form-grid"><label class="field">基准版本<select id="evaluatorTrialBaseline">'+s.revisions.map(r=>'<option value="'+r.id+'" '+(r.id===evaluatorBaselineId(s)?'selected':'')+'>'+evaluatorVersion(r)+'</option>').join('')+'</select></label><label class="field">比较版本<select id="evaluatorTrialCandidate">'+s.revisions.map(r=>'<option value="'+r.id+'" '+(r.id===s.head_revision_id?'selected':'')+'>'+evaluatorVersion(r)+'</option>').join('')+'</select></label></div><label class="field">两次试评使用模型<select id="evaluatorTrialModel"><option value="">'+esc(data.model_config?.default_model?'默认 · '+data.model_config.default_model.model:'请选择模型')+'</option>'+modelOptions()+'</select></label><p>开始后会向所选模型发送该工单、方案及两个版本规则，产生两次调用。</p><div id="formError" class="error"></div><div class="form-actions"><button class="btn primary" id="startEvaluatorTrial">开始两版本试评</button></div>');
  const filter=()=>{const q=$('evaluatorTrialSearch').value.trim().toLowerCase();$('evaluatorTrialRating').innerHTML=rows.filter(r=>(r.record_snapshot?.name||r.request_snapshot.record?.name||'').toLowerCase().includes(q)).map(r=>'<option value="'+r.id+'">'+esc(r.record_snapshot?.name||r.request_snapshot.record?.name)+' · '+esc(formatTime(r.created_at))+' · 原评级 '+esc(r.report?.grade||r.status)+'</option>').join('');};filter();$('evaluatorTrialSearch').oninput=filter;
  $('startEvaluatorTrial').onclick=()=>action(async()=>{const selection=$('evaluatorTrialModel').value;await request('POST','/api/monitor/evaluator-skill/trials',{actor:actor(),request_id:AppIds.newId(),rating_id:$('evaluatorTrialRating').value,baseline_revision_id:$('evaluatorTrialBaseline').value,candidate_revision_id:$('evaluatorTrialCandidate').value,model_selection:selection?JSON.parse(selection):undefined});hideModal();evaluatorTab='trials';await refresh();toast('试评已开始，两版本结果将独立保存');});
}
function evaluatorTrialDetail(id){
  const t=evaluatorState().trials.find(t=>t.id===id);modal('<h2 id="modalTitle">'+esc(t.record_name)+' · 版本试评</h2><p class="meta">'+esc(t.model_snapshot.model)+' · '+evaluatorTrialStatus(t)+' · 不计入正式统计</p>'+(t.error?'<p class="error">'+esc(t.error)+'</p>':'')+'<div class="evaluator-compare">'+['baseline','candidate'].map(side=>{const s=t.sides[side],r=s.report;return '<section class="panel"><span class="eyebrow">'+(side==='baseline'?'基准版本':'比较版本')+'</span><h3>评估员 '+esc(s.evaluator_skill_snapshot.version)+' <span class="badge">'+esc(r?.grade||({pending:'待评',running:'试评中',failed:'失败'}[s.status]||'不适用'))+'</span></h3><p>'+esc(r?.summary||s.error||'等待模型返回')+'</p>'+(r?.grade_basis?evaluatorBasisHtml(r.grade_basis):'')+(r?'<h4>检查维度</h4>'+r.dimensions.map(d=>'<p><strong>'+esc(d.name)+'</strong> · '+esc({pass:'通过',gap:'缺口',error:'错误',unknown:'未知'}[d.status])+'<br>'+esc(d.reason)+'</p>').join('')+'<h4>待补材料</h4><p>'+esc(r.missing_materials.join('；')||'无')+'</p>':'')+ratingUsageHtml([s])+'<details><summary>实际规则、材料与模型原文</summary><pre>'+esc(JSON.stringify(s.request_snapshot,null,2))+'</pre><pre>'+esc(s.raw_response||'尚未返回')+'</pre></details></section>';}).join('')+'</div>');
}
function evaluatorBasisHtml(b){return '<div class="evaluator-basis">'+[['critical_error','关键错误'],['substantive_value','实质辅助成果'],['standard_conflict','规则冲突']].map(([key,label])=>'<p><strong>'+label+'：'+(b[key].confirmed===true||b[key].present===true?'是':'否')+'</strong><br>'+esc(b[key].reason)+'<small>引用：'+esc((b[key].evidence_refs||b[key].rule_refs||[]).join('、')||'无')+'</small></p>').join('')+'</div>';}
document.addEventListener('input',e=>{if(['evaluatorDocument','evaluatorNote'].includes(e.target.id)){const b=evaluatorDraft();b.document=$('evaluatorDocument').value;b.note=$('evaluatorNote').value;b.dirty=true;$('evaluatorDirty').textContent='有未保存修改';$('evaluatorChars').textContent=b.document.length.toLocaleString()+' 字符';document.querySelector('[data-evaluator-activate]')?.setAttribute('disabled','');}});
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b||b.disabled||busy)return;const d=b.dataset;
  if(b.hasAttribute('data-evaluator-builtin'))try{evaluatorBuiltIn();}catch(e){toast(e.message);}
  if(d.evaluatorTab){evaluatorTab=d.evaluatorTab;render();}
  if(b.hasAttribute('data-evaluator-save'))action(async()=>{try{await saveEvaluatorDraft();}catch(e){evaluatorModalError(e);}});
  if(d.evaluatorActivate)try{activateEvaluator(d.evaluatorActivate);}catch(e){toast(e.message);}
  if(b.hasAttribute('data-evaluator-reload')){evaluatorBuffer=null;render();}
  if(d.evaluatorDetail){const r=evaluatorRevision(d.evaluatorDetail);modal('<h2 id="modalTitle">评估员 Skill '+evaluatorVersion(r)+'</h2><p>'+esc(r.note)+'</p><pre>'+esc(r.document)+'</pre>');}
  if(b.hasAttribute('data-evaluator-diff'))evaluatorDiff();
  if(d.evaluatorRestore)try{restoreEvaluator(d.evaluatorRestore);}catch(e){toast(e.message);}
  if(b.hasAttribute('data-evaluator-new-trial'))try{evaluatorTrialEditor();}catch(e){toast(e.message);}
  if(d.evaluatorTrialDetail)evaluatorTrialDetail(d.evaluatorTrialDetail);
});
window.addEventListener('beforeunload',event=>{if(evaluatorBuffer?.dirty){event.preventDefault();event.returnValue='';}});

if(typeof location!=='undefined'&&new URLSearchParams(location.search).get('view')==='evaluator')view='evaluator';
