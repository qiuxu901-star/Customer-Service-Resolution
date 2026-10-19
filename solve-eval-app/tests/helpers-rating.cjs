'use strict';
// Provider fixture for the v4 structured business decision contract.
function gradeBasis(input,grade='L2'){
  const refs=(input.reference_index||[]).filter(r=>r.role==='ai_output').slice(0,1).map(r=>r.id);
  return {critical_error:{confirmed:grade==='L0',reason:grade==='L0'?'合成材料确认关键方向错误':'未确认关键错误',evidence_refs:grade==='L0'?refs:[]},substantive_value:{confirmed:['L2','L3'].includes(grade),reason:['L2','L3'].includes(grade)?'合成 AI 已完成事实归纳，人工仍需核查政策':'未确认实质辅助成果',evidence_refs:['L2','L3'].includes(grade)?refs:[]},standard_conflict:{present:false,reason:'无已确认的阻断性规则冲突',rule_refs:[]}};
}
module.exports={gradeBasis};
