(function(root){
  'use strict';
  // Parse framing only. Never repair JSON values or infer a module by similarity.
  function parse(raw){
    raw=typeof raw==='string'?raw:'';
    if(!raw.trim())return {modules:[],error:'Skill 正文为空'};
    let value;
    try{value=JSON.parse(raw);}catch{
      if(!/^[\s]*[\[{]/.test(raw))return {modules:[{key:'whole',id:null,type:'文本文档',text:raw}],error:null};
      try{value=JSON.parse('['+raw.trim().replace(/,\s*$/,'')+']');}
      catch{return {modules:[],error:'Skill JSON 无法解析，请修正原始正文'};}
    }
    const values=Array.isArray(value)?value:[value];
    if(!values.length||values.some(v=>!v||typeof v!=='object'||Array.isArray(v)))return {modules:[],error:'Skill 定义应为对象或对象列表'};
    const modules=values.map((v,i)=>({key:'module_'+(i+1),id:typeof v.id==='string'?v.id:typeof v.code==='string'?v.code:null,type:String(v.type||''),text:JSON.stringify(v,null,2)}));
    return {modules,error:null};
  }
  function selection(skill,binding){
    const parsed=parse(skill?.raw);
    if(parsed.error)return {...parsed,selected:[],needs_confirmation:true,reason:parsed.error};
    const picks=binding?.modules;
    if(Array.isArray(picks)&&picks.some(p=>typeof p!=='string'&&(!p||typeof p!=='object'||typeof p.key!=='string')))return {...parsed,selected:[],needs_confirmation:true,reason:'Skill 定义选择无效，请重新选择'};
    const explicit=Array.isArray(picks)&&picks.length>0;
    const implicit=parsed.modules.length===1&&(!parsed.modules[0].id||parsed.modules[0].id===skill.code);
    const selected=explicit?parsed.modules.filter(m=>picks.some(p=>(typeof p==='string'?p:p.key)===m.key)):(implicit?parsed.modules:[]);
    const invalid=explicit&&(selected.length!==picks.length||new Set(picks.map(p=>typeof p==='string'?p:p.key)).size!==picks.length);
    const needs_confirmation=invalid||!selected.length;
    return {...parsed,selected:needs_confirmation?[]:selected,needs_confirmation,reason:needs_confirmation?'Skill 含多个定义或目录代码不匹配，请在监测方案中确认具体定义':''};
  }
  const api={parse,selection};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.SkillDefinitions=api;
})(typeof globalThis!=='undefined'?globalThis:this);
