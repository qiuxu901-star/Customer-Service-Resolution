(function(root){
  'use strict';
  const legacyFields=[['goal','要检查什么'],['trigger','什么场景触发'],['prompt','提示词 / 工作指令'],['materials','需要哪些材料'],['judgement','怎么判断'],['exceptions','例外和证据不足'],['output','希望输出什么'],['reference','依据与适用范围']];
  const hasDocument=data=>Object.prototype.hasOwnProperty.call(data||{},'document');
  function documentOf(data={}){
    if(hasDocument(data))return typeof data.document==='string'?data.document:'';
    return legacyFields.filter(([key])=>typeof data[key]==='string'&&data[key].trim()).map(([key,label])=>'## '+label+'\n\n'+data[key]).join('\n\n');
  }
  function canonical(data={}){const result={...data,document:documentOf(data)};for(const [key]of legacyFields)delete result[key];return result;}
  function ready(document){
    const lines=String(document||'').split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&!/^#{1,6}\s/.test(line));
    return lines.length>0&&!lines.some(line=>/^(?:[-*]\s*)?(?:待补齐|待填写|请填写|未知|待确认|不知道|无|暂无|TODO|TBD)[。.!！:：;；]*$/i.test(line));
  }
  const template=legacyFields.map(([,label])=>'## '+label+'\n\n待补齐').join('\n\n');
  const api={documentOf,canonical,hasDocument,ready,template};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.PlanDocument=api;
})(typeof globalThis!=='undefined'?globalThis:this);
