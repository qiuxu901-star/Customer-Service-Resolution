'use strict';
let diagnosisBackgroundTimer=null,diagnosisBackgroundPolling=false,diagnosisConnectionError=false;
const diagnosisObservedStatuses=new Map(),diagnosisNotifications=new Set();
function diagnosisTrackRows(){for(const d of data.skill_diagnoses||[]){const old=diagnosisObservedStatuses.get(d.id);if(['pending','running'].includes(old)&&['completed','failed'].includes(d.status)){diagnosisNotifications.add(d.id);toast(d.status==='completed'?'业务 Skill 诊断已完成，可直接查看报告':'业务 Skill 诊断失败，可查看原因');}diagnosisObservedStatuses.set(d.id,d.status);}}
function diagnosisActivityHtml(){
 const active=(data.skill_diagnoses||[]).filter(diagnosisIsActive),notices=(data.skill_diagnoses||[]).filter(d=>diagnosisNotifications.has(d.id)),first=active[0]||notices.at(-1);if(!first)return '';
 return '<aside id="diagnosisActivity" class="diagnosis-activity '+(active.length?'is-running':'is-finished')+'" aria-label="业务 Skill 诊断状态"><div role="status" aria-live="polite"><strong>'+(active.length?'业务 Skill 诊断中 · '+active.length+' 项':first.status==='failed'?'诊断未完成':'诊断已完成')+'</strong><p>'+esc(diagnosisRecordName(first))+' · '+esc(diagnosisPhase(first))+'</p>'+(active.length?'<p class="meta" data-diagnosis-elapsed="'+esc(first.id)+'">'+esc(diagnosisElapsed(first))+'</p>':'')+(diagnosisConnectionError?'<p class="error">暂时无法确认最新状态，正在重连；请勿重复发起。</p>':'')+'</div><div class="actions">'+wsButton(active.length?'查看诊断进度':'查看诊断报告',active.length||notices.length>1?'data-diagnosis-activity':'data-diagnosis-open="'+esc(first.id)+'"',true)+(!active.length?wsButton('收起提示','data-diagnosis-dismiss'):'')+'</div></aside>';
}
function diagnosisRenderActivity(){
 const html=diagnosisActivityHtml(),existing=document.getElementById('diagnosisActivity');
 if(existing){if(html)existing.outerHTML=html;else existing.remove?.();}else if(html)$('view')?.insertAdjacentHTML('beforeend',html);
}
function diagnosisTickClock(){for(const element of document.querySelectorAll('[data-diagnosis-elapsed]')){const d=(data.skill_diagnoses||[]).find(d=>d.id===element.dataset.diagnosisElapsed);if(d)element.textContent=diagnosisElapsed(d);}}
function diagnosisEnsurePolling(){
 diagnosisTrackRows();if(diagnosisBackgroundTimer||diagnosisBackgroundPolling)return;
 if((data.skill_diagnoses||[]).some(diagnosisIsActive))diagnosisBackgroundTimer=setTimeout(diagnosisPollBackground,1500);
}
async function diagnosisPollBackground(){
 diagnosisBackgroundTimer=null;if(diagnosisBackgroundPolling)return;
 const ids=(data.skill_diagnoses||[]).filter(diagnosisIsActive).slice(0,100).map(d=>d.id);if(!ids.length)return;
 if(busy){diagnosisEnsurePolling();return;}
 diagnosisBackgroundPolling=true;
 try{
  const result=await request('POST','/api/monitor/skill-diagnoses/status',{ids});let changed=false;
  for(const patch of result.diagnoses){const row=data.skill_diagnoses.find(d=>d.id===patch.id);if(!row)continue;if(row.status!==patch.status||row.phase!==patch.phase)changed=true;Object.assign(row,patch);}
  diagnosisConnectionError=false;diagnosisTrackRows();
  if(changed){
   const open=diagnosisOpenId;render();
   if(!$('overlay').hidden&&open==='activity')openDiagnosisActivity();
   else if(!$('overlay').hidden&&open){const row=data.skill_diagnoses.find(d=>d.id===open);if(row)openDiagnosisReport(row);}
   else if(!$('overlay').hidden)for(const root of document.querySelectorAll('[data-record-diagnosis-root]')){const r=data.ratings.find(r=>r.id===root.dataset.recordDiagnosisRoot);let indices=null;try{indices=JSON.parse(root.dataset.diagnosisIndices||'null');}catch{}if(r)root.innerHTML=diagnosisRecordContent(r,indices,{footerActions:root.dataset.diagnosisFooterActions==='true'});}
  }
  diagnosisRefreshRecordControls();diagnosisRenderActivity();diagnosisTickClock();
 }catch{diagnosisConnectionError=true;diagnosisRenderActivity();}
 finally{diagnosisBackgroundPolling=false;diagnosisEnsurePolling();}
}
function openDiagnosisActivity(){
 const active=(data.skill_diagnoses||[]).filter(diagnosisIsActive),recent=[...(data.skill_diagnoses||[])].filter(d=>!diagnosisIsActive(d)).reverse().slice(0,8);
 modal('<h2 id="modalTitle">业务 Skill 诊断进度</h2><p class="sub">'+active.length+' 项执行中。关闭后仍会继续，页面右下角持续显示状态。</p>'+(active.length?active.map(d=>diagnosisProgressHtml(d)+'<p>'+wsButton('查看本次任务','data-diagnosis-open="'+esc(d.id)+'"')+'</p>').join(''):'<p class="notice">当前没有执行中的诊断。</p>')+'<h3>最近的诊断结果</h3>'+recent.map(d=>'<article class="diagnosis-activity-row"><div><strong>'+esc(diagnosisRecordName(d))+'</strong><p>'+esc(diagnosisPhase(d))+' · 第 '+diagnosisAttempt(d)+' 次 · '+esc(formatTime(d.created_at))+'</p></div>'+wsButton(d.status==='completed'?'查看报告':'查看失败原因','data-diagnosis-open="'+esc(d.id)+'"')+'</article>').join(''));
 diagnosisOpenId='activity';diagnosisEnsurePolling();
}
const renderBeforeDiagnosisActivity=render;
render=function(){renderBeforeDiagnosisActivity();diagnosisTrackRows();diagnosisRenderActivity();diagnosisEnsurePolling();};
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b||b.disabled||busy)return;if(b.hasAttribute('data-diagnosis-activity'))openDiagnosisActivity();if(b.hasAttribute('data-diagnosis-dismiss')){diagnosisNotifications.clear();diagnosisRenderActivity();}});
window.addEventListener('focus',()=>{if((data.skill_diagnoses||[]).some(diagnosisIsActive)&&!diagnosisBackgroundPolling){clearTimeout(diagnosisBackgroundTimer);diagnosisBackgroundTimer=null;diagnosisPollBackground();}});
