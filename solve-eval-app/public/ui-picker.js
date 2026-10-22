'use strict';
// Keep the original select as the source of truth, including all existing change handlers.
(()=>{
  if(typeof MutationObserver==='undefined'||!document.createElement)return;
  const enhanced=new Map();let opened=null,scheduled=false;
  function close(restore=false){if(!opened)return;const old=opened;opened=null;old.popup.remove();old.button.setAttribute('aria-expanded','false');if(restore&&old.button.isConnected)old.button.focus();}
  function enhance(select){
    if(enhanced.has(select)||select.hidden||select.multiple||select.size>1||select.dataset.nativeSelect!==undefined)return;
    const button=document.createElement('button');button.type='button';button.className='ui-picker-button';button.setAttribute('aria-haspopup','listbox');button.setAttribute('aria-expanded','false');
    const hadFocus=document.activeElement===select;select.hidden=true;select.classList.add('ui-picker-source');select.tabIndex=-1;select.setAttribute('aria-hidden','true');select.after(button);enhanced.set(select,button);
    button.addEventListener('click',()=>{if(opened?.select===select){close();return;}open(select,button);});
    button.addEventListener('keydown',e=>{if(['ArrowDown','ArrowUp','Enter',' '].includes(e.key)){e.preventDefault();open(select,button);}});
    select.addEventListener('change',()=>sync(select,button));
    sync(select,button);if(hadFocus)button.focus();
  }
  function sync(select,button){const label=select.options[select.selectedIndex]?.textContent||'请选择',context=select.getAttribute('aria-label')||select.closest('label')?.firstChild?.textContent?.trim()||select.id||'选择';if(button.textContent!==label)button.textContent=label;if(button.disabled!==select.disabled)button.disabled=select.disabled;button.setAttribute('aria-label',context+'：'+label);button.title=label;}
  function open(select,button){close();const popup=document.createElement('div');popup.className='ui-picker-popup';const search=document.createElement('input');search.type='search';search.placeholder='输入关键词搜索';search.setAttribute('aria-label','搜索选项');search.setAttribute('role','combobox');search.setAttribute('aria-autocomplete','list');search.setAttribute('aria-expanded','true');const list=document.createElement('div');list.className='ui-picker-options';list.setAttribute('role','listbox');list.id='ui-picker-list';list.setAttribute('aria-label',button.getAttribute('aria-label'));search.setAttribute('aria-controls',list.id);popup.append(search,list);
    const host=select.closest('#modalBody')||document.body;host.append(popup);opened={select,button,popup};button.setAttribute('aria-expanded','true');let visible=[],active=-1;
    const choose=option=>{select.value=option.value;close();sync(select,button);select.dispatchEvent(new Event('change',{bubbles:true}));if(button.isConnected)button.focus();};
    const highlight=index=>{active=visible.length?(index+visible.length)%visible.length:-1;list.querySelectorAll('[role="option"]').forEach((n,i)=>{n.classList.toggle('is-focused',i===active);if(i===active){search.setAttribute('aria-activedescendant',n.id);n.scrollIntoView({block:'nearest'});}});if(active<0)search.removeAttribute('aria-activedescendant');};
    const update=()=>{const query=search.value.trim().toLowerCase();visible=[...select.options].filter(o=>!o.disabled&&!o.hidden&&o.textContent.toLowerCase().includes(query));list.replaceChildren();visible.forEach((o,i)=>{const row=document.createElement('button');row.type='button';row.id='ui-picker-option-'+i;row.setAttribute('role','option');row.setAttribute('aria-selected',String(o.selected));row.tabIndex=-1;row.textContent=o.textContent;row.title=o.textContent;row.addEventListener('mousedown',e=>e.preventDefault());row.addEventListener('click',()=>choose(o));list.append(row);});if(!visible.length){const empty=document.createElement('p');empty.className='sub';empty.textContent='没有匹配的选项';list.append(empty);}highlight(Math.max(0,visible.findIndex(o=>o.selected)));};
    search.addEventListener('input',update);search.addEventListener('keydown',e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();highlight(active+(e.key==='ArrowDown'?1:-1));}if(e.key==='Enter'&&visible[active]){e.preventDefault();choose(visible[active]);}if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close(true);}if(e.key==='Tab')close(true);});
    const rect=button.getBoundingClientRect(),width=Math.min(Math.max(rect.width,280),window.innerWidth-24),roomBelow=window.innerHeight-rect.bottom-12,roomAbove=rect.top-12,below=roomBelow>=Math.min(300,roomAbove),height=Math.min(340,Math.max(roomBelow,roomAbove));popup.style.width=width+'px';popup.style.maxHeight=height+'px';popup.style.left=Math.max(12,Math.min(rect.left,window.innerWidth-width-12))+'px';if(below)popup.style.top=(rect.bottom+6)+'px';else popup.style.bottom=(window.innerHeight-rect.top+6)+'px';update();search.focus();
  }
  function refresh(){scheduled=false;for(const [select,button]of enhanced){if(!select.isConnected){if(opened?.select===select)close();button.remove();enhanced.delete(select);}else sync(select,button);}document.querySelectorAll('select').forEach(enhance);}
  const observer=new MutationObserver(()=>{if(!scheduled){scheduled=true;queueMicrotask(refresh);}});observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled','selected','hidden']});
  document.addEventListener('pointerdown',e=>{if(opened&&!opened.popup.contains(e.target)&&e.target!==opened.button)close();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&opened){e.preventDefault();e.stopImmediatePropagation();close(true);}},true);
  document.addEventListener('scroll',e=>{if(opened&&!opened.popup.contains(e.target))close();},true);window.addEventListener('resize',()=>close());
  refresh();
})();
