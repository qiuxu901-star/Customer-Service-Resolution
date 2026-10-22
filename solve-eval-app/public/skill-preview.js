(function(root){
 'use strict';
 const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const labels={id:'定义编码',code:'编码',type:'定义类型',scenePrompt:'场景提示词',variables:'变量与工作指令',task:'任务',role:'角色',sop:'处理步骤',rules:'判断规则',example:'示例',examples:'示例',description:'说明',content:'正文',prompt:'提示词',instructions:'工作指令',name:'名称'};
 function inline(text,depth=0){
  if(depth>12)return escape(text);
  const pattern=/(`+)([^\n]*?)\1|\*\*([^\n]+?)\*\*|__([^\n]+?)__|\*([^*\n]+)\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  let result='',last=0,match;
  while((match=pattern.exec(text))){
   result+=escape(text.slice(last,match.index));
   if(match[1])result+='<code>'+escape(match[2])+'</code>';
   else if(match[3]||match[4])result+='<strong>'+inline(match[3]||match[4],depth+1)+'</strong>';
   else if(match[5])result+='<em>'+escape(match[5])+'</em>';
   else result+=/^https?:\/\//i.test(match[7])?'<a href="'+escape(match[7])+'" target="_blank" rel="noopener noreferrer">'+escape(match[6])+'</a>':escape(match[0]);
   last=pattern.lastIndex;
  }
  return result+escape(text.slice(last));
 }
 const list=line=>line.match(/^(\s*)([-+*]|\d+[.)])\s+(.*)$/);
 const indent=line=>(line.match(/^\s*/)||[''])[0].length;
 function blocks(lines,depth=0){
  if(depth>24)return '<pre><code>'+escape(lines.join('\n'))+'</code></pre>';
  let html='',i=0;
  const special=line=>/^\s*(?:#{1,6}\s|`{3,}|~{3,}|>|(?:[-*_]\s*){3,}$)/.test(line)||!!list(line);
  while(i<lines.length){
   const line=lines[i];if(!line.trim()){i++;continue;}
   const fence=line.match(/^\s*(`{3,}|~{3,})\s*(.*)$/);
   if(fence){
    const code=[];i++;const end=new RegExp('^\\s*'+fence[1][0]+'{'+fence[1].length+',}\\s*$');
    while(i<lines.length&&!end.test(lines[i]))code.push(lines[i++]);if(i<lines.length)i++;
    html+='<pre class="skill-code-block"><code'+(fence[2]?' data-language="'+escape(fence[2])+'"':'')+'>'+escape(code.join('\n'))+'</code></pre>';continue;
   }
   const heading=line.match(/^\s*(#{1,6})\s+(.+)$/);
   if(heading){const level=Math.min(6,heading[1].length+1);html+='<h'+level+'>'+inline(heading[2])+'</h'+level+'>';i++;continue;}
   if(/^\s*(?:[-*_]\s*){3,}$/.test(line)){html+='<hr>';i++;continue;}
   if(/^\s*>/.test(line)){const quoted=[];while(i<lines.length&&/^\s*>/.test(lines[i]))quoted.push(lines[i++].replace(/^\s*> ?/,''));html+='<blockquote>'+blocks(quoted,depth+1)+'</blockquote>';continue;}
   if(line.includes('|')&&i+1<lines.length&&/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i+1])){
    const cells=row=>row.trim().replace(/^\||\|$/g,'').split('|').map(c=>c.trim());
    html+='<div class="skill-table-wrap"><table><thead><tr>'+cells(line).map(c=>'<th>'+inline(c)+'</th>').join('')+'</tr></thead><tbody>';i+=2;
    while(i<lines.length&&lines[i].trim()&&lines[i].includes('|'))html+='<tr>'+cells(lines[i++]).map(c=>'<td>'+inline(c)+'</td>').join('')+'</tr>';
    html+='</tbody></table></div>';continue;
   }
   const first=list(line);
   if(first){
    const base=first[1].length,ordered=/^\d/.test(first[2]),tag=ordered?'ol':'ul';
    html+='<'+tag+(ordered?' start="'+parseInt(first[2],10)+'"':'')+'>';
    while(i<lines.length){
     const item=list(lines[i]);if(!item||item[1].length!==base||/^\d/.test(item[2])!==ordered)break;
     const body=[item[3]],contentIndent=base+item[2].length+1;i++;
     while(i<lines.length){
      if(!lines[i].trim()){body.push('');i++;continue;}
      if(indent(lines[i])<=base)break;
      body.push(lines[i].slice(Math.min(indent(lines[i]),contentIndent)));i++;
     }
     html+='<li'+(ordered?' value="'+parseInt(item[2],10)+'"':'')+'>'+blocks(body,depth+1)+'</li>';
    }
    html+='</'+tag+'>';continue;
   }
   const paragraph=[line];i++;
   while(i<lines.length&&lines[i].trim()&&!special(lines[i])&&!(lines[i].includes('|')&&i+1<lines.length&&/^\s*\|?\s*:?-{3,}/.test(lines[i+1])))paragraph.push(lines[i++]);
   html+='<p>'+inline(paragraph.join('\n')).replace(/\n/g,'<br>')+'</p>';
  }
  return html;
 }
 function markdown(text){
  const lines=String(text??'').replace(/\r\n?/g,'\n').replace(/\t/g,'    ').split('\n');
  const occupied=lines.filter(l=>l.trim()),common=occupied.length?occupied.reduce((n,line)=>Math.min(n,indent(line)),Infinity):0;
  return blocks(common?lines.map(l=>l.slice(common)):lines);
 }
 function structured(value,path='',depth=0){
  if(depth>24)return '<pre><code>'+escape(JSON.stringify(value,null,2))+'</code></pre>';
  if(typeof value==='string')return value.trim()?markdown(value):'<p class="skill-empty-field">未填写</p>';
  if(value===null||value===undefined)return '<p class="skill-empty-field">未填写</p>';
  if(Array.isArray(value))return value.length?value.map((item,i)=>'<section class="skill-object-item"><h3>定义 '+(i+1)+(item?.id?' · '+escape(item.id):'')+'</h3>'+structured(item,path?path+'.'+i:String(i),depth+1)+'</section>').join(''):'<p class="skill-empty-field">空列表</p>';
  if(typeof value==='object'){
   const keys=Object.keys(value);if(!keys.length)return '<p class="skill-empty-field">空对象</p>';
   return keys.map(key=>{
    const location=path?path+'.'+key:key;
    return '<section class="skill-document-field"><h3>'+escape(labels[key]||key)+(labels[key]?'<small>'+escape(location)+'</small>':'')+'</h3>'+structured(value[key],location,depth+1)+'</section>';
   }).join('');
  }
  return '<p>'+escape(value)+'</p>';
 }
 function render(raw){
  if(typeof raw!=='string'||!raw.trim())return '<p class="skill-preview-empty">粘贴 Skill 正文后，自动显示阅读预览。</p>';
  let value,parsed=false;
  try{value=JSON.parse(raw);parsed=true;}catch{
   if(/^\s*\{/.test(raw))try{value=JSON.parse('['+raw.trim().replace(/,\s*$/,'')+']');parsed=true;}catch{}
  }
  return '<article class="skill-readable-document">'+(parsed?structured(value):(/^\s*[\[{]/.test(raw)?'<p class="skill-format-note">JSON 格式尚未完整，以下保留原文预览。</p>':'')+markdown(raw))+'</article>';
 }
 function source(raw){
  const lines=String(raw??'').replace(/\r\n?/g,'\n').split('\n');
  return '<pre class="skill-source-highlight"><code>'+lines.map(line=>{
   if(/^\s*#{1,6}\s/.test(line))return '<span class="skill-syntax-heading">'+escape(line)+'</span>';
   const pattern=/`[^`]*`|\*\*[^*]+\*\*|^(?:\s*)(?:[-+*]|\d+[.)])(?=\s)/g;let html='',last=0,m;
   while((m=pattern.exec(line))){html+=escape(line.slice(last,m.index));const cls=m[0].startsWith('`')?'skill-syntax-code':'skill-syntax-marker';html+='<span class="'+cls+'">'+escape(m[0])+'</span>';last=pattern.lastIndex;}
   return html+escape(line.slice(last));
  }).join('\n')+'</code></pre>';
 }
 const api={render,markdown,source};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.SkillPreview=api;
})(typeof globalThis!=='undefined'?globalThis:this);
