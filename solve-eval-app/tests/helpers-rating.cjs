'use strict';
// Provider fixture for the v4 structured business decision contract.
function gradeBasis(input,grade='L2'){
  const refs=(input.reference_index||[]).filter(r=>r.role==='ai_output').slice(0,1).map(r=>r.id);
  return {critical_error:{confirmed:grade==='L0',reason:grade==='L0'?'合成材料确认关键方向错误':'未确认关键错误',evidence_refs:grade==='L0'?refs:[]},substantive_value:{confirmed:['L2','L3'].includes(grade),reason:['L2','L3'].includes(grade)?'合成 AI 已完成事实归纳，人工仍需核查政策':'未确认实质辅助成果',evidence_refs:['L2','L3'].includes(grade)?refs:[]},standard_conflict:{present:false,reason:'无已确认的阻断性规则冲突',rule_refs:[]}};
}
function helpReport(input,grade='L2'){
 const refs=input.reference_index||(input.sources||[]).flatMap(s=>(s.segments||[]).map(r=>({...r,role:s.role})));
 const ids=refs.filter(r=>r.role==='ai_output').slice(0,1).map(r=>r.id);
 return {output_readability:{status:ids.length?'clear':'unknown',reason:ids.length?'合成输出已区分本次成果与待核实事项，客服可以理解并继续处理':'未提供AI输出，无法判断可读性',evidence_refs:ids,issue_types:[],recommendations:[]},task_summary:'合成任务：帮助客服整理关键事实并分析处理条件',helpful_contributions:['L2','L3'].includes(grade)&&ids.length?[{result:'已整理本单关键事实',evidence_reason:'合成输出包含针对本单的事实整理',benefit:'客服可在已有整理基础上继续核实，无需重找这些内容',evidence_refs:ids}]:[],remaining_work:['L1','L2','L0'].includes(grade)?[{work:'核对关键条件后完成本次判断',reason:'合成材料中仍有未完成的关键分析',kind:grade==='L2'?'supplement':'redo',evidence_refs:ids}]:[]};
}
module.exports={gradeBasis,helpReport};
