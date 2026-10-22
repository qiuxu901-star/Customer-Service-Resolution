'use strict';
let servicePreviewCounter=0,servicePreviewTimer=null;
const servicePreviewBaseModal=modal;
modal=function(html){document.querySelector('.modal').classList.remove('service-editor-dialog');return servicePreviewBaseModal(html);};
function serviceSkillPreviewHtml(raw){
 const id='service-preview-'+(++servicePreviewCounter);
 return '<section class="skill-preview-widget"><div class="skill-preview-tabs" role="tablist" aria-label="Skill 查看方式"><button type="button" id="'+id+'-read-tab" role="tab" aria-selected="true" aria-controls="'+id+'-read" data-skill-view="read">阅读预览</button><button type="button" id="'+id+'-source-tab" role="tab" aria-selected="false" aria-controls="'+id+'-source" tabindex="-1" data-skill-view="source">原文高亮</button></div><div id="'+id+'-read" role="tabpanel" aria-labelledby="'+id+'-read-tab" class="skill-preview-reading">'+SkillPreview.render(raw)+'</div><div id="'+id+'-source" role="tabpanel" aria-labelledby="'+id+'-source-tab" class="skill-preview-source" hidden>'+SkillPreview.source(raw)+'</div></section>';
}
function updateServicePreview(){
 const panel=$('serviceLivePreview'),editor=$('serviceRaw');if(!panel||!editor)return;
 panel.querySelector('.skill-preview-reading').innerHTML=SkillPreview.render(editor.value);
 panel.querySelector('.skill-preview-source').innerHTML=SkillPreview.source(editor.value);
 const count=$('serviceRawCount');if(count)count.textContent=editor.value.length.toLocaleString()+' 字符';
}
document.addEventListener('input',event=>{
 if(event.target.id!=='serviceRaw')return;
 clearTimeout(servicePreviewTimer);servicePreviewTimer=setTimeout(updateServicePreview,120);
});
function selectSkillPreviewTab(button){
 const widget=button.closest('.skill-preview-widget');if(!widget)return;
 for(const tab of widget.querySelectorAll('[data-skill-view]')){const selected=tab===button;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;}
 widget.querySelector('.skill-preview-reading').hidden=button.dataset.skillView!=='read';
 widget.querySelector('.skill-preview-source').hidden=button.dataset.skillView!=='source';
}
document.addEventListener('click',event=>{
 const button=event.target.closest?.('button');if(!button?.dataset?.skillView)return;
 selectSkillPreviewTab(button);
});
document.addEventListener('keydown',event=>{
 const button=event.target.closest?.('[data-skill-view]');if(!button?.dataset?.skillView||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
 const tabs=[...button.closest('.skill-preview-widget').querySelectorAll('[data-skill-view]')];
 const next=event.key==='Home'?tabs[0]:event.key==='End'?tabs.at(-1):tabs[(tabs.indexOf(button)+1)%tabs.length];
 event.preventDefault();selectSkillPreviewTab(next);next.focus();
});
