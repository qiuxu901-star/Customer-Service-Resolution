'use strict';
const ISSUE_TYPES={evidence_not_linked:'结论与依据未挂钩',buried_conclusion:'结论埋没或文字成墙',redundant_noise:'重复或无关内容过多',uncertainty_mixed:'已知与待核实混同',audience_mixed:'内部判据与对外话术混同'};
const CONTRACT={status:'clear | needs_improvement | unknown',reason:'一句话说明客服能否理解结论、依据、待核实事项和下一步；有问题时指出实际障碍和增加的工作',evidence_refs:['E编号；可判断时至少引用AI实际输出'],issue_types:Object.keys(ISSUE_TYPES),recommendations:[{suggestion:'针对已确认的理解障碍，说明应补哪项依据关联或结构及其作用；无问题或无法判断时为空列表',rewrite_example:{disposition:'【处置结论】本次任务的结论或处理方向；不强求判责、金额，依据不足时明确暂不能定论',basis:'【核验依据】仅列现有材料支持的事实、计算或适用规则；保持来源及可信边界，不把单方说法改成已核实事实',pending_verification:'【待客服核实】具体缺什么、查来确认什么；确认无需补充才写无',driver_message:'【建议对司话术】仅任务需要对司沟通时填写可复制话术，否则为null；不虚构处理承诺'}}]};
const INSTRUCTIONS=`AI输出可读性为通用必评项，单独返回output_readability，不依赖是否存在场景方案。围绕客服能否快速理解本次任务的结论、依据、待核实事项和下一步，检查：1.结论与本单已有依据是否挂钩；2.核心结论是否容易找到、内容是否分层；3.是否存在大段复述或未指出本单分支的通用规则噪音；4.材料已支持的事实、单方说法、推测与待核实是否分清；5.任务涉及沟通时，内部判据与对外话术是否分清。不是按模板打分，不因结论未在第一行、没有四段、篇幅长或没有任务未要求的对司话术就判差。材料本身缺失且AI已说明，不算依据呈现缺陷；已有材料却未说明怎样支持结论，才列evidence_not_linked。AI自述核实不自动证明已核实。二线责任结论默认展示，其余AI信息点击详情可见。可读性分两层：责任结论是否让客服一眼抓住核心判断和处理方向，详情是否能方便找到支持依据和待核实事项。详情中的有效依据应计入，不因责任结论未重复列出就判evidence_not_linked；正常点击详情本身不算问题。详情混乱、定位困难或与结论缺乏对应时，说明具体障碍及额外工作。详情丰富也不能掩盖默认结论含糊、矛盾或方向不清。不猜内部执行或Skill根因。
output_readability.status：clear=输出足够清楚、客服可理解并接着处理；needs_improvement=已确认具体理解障碍，reason写哪里难理解及客服多做什么；unknown=缺少完整可见输出或基本任务，无法判断，说明限制。局部无法核实责任，不自动导致可读性unknown。可判断时evidence_refs必须含AI实际输出，引用上下文时保持来源边界；issue_types只列已确认类型，不把五个枚举全抄进列表。clear/unknown时issue_types与recommendations为空。needs_improvement时列1至3项recommendations，并把具体问题并入findings供后续复核，已有同一问题不重复拆条。
每项recommendations先写缺哪项依据关联或结构，再给rewrite_example的处置结论、核验依据、待客服核实、建议对司话术。示范仅重组已给材料，不补造时间、距离、金额、规则、核验结果或实际处置；证据不够时保留暂不能定论、材料显示/当事人表示和待核实。task只要求提取或分析时，处置结论写本次成果/分析方向，不擅自增加退款、处罚或安抚任务。driver_message只在任务需要对司沟通时填写，否则null；其他三项不可留空。缺少依据时直接说明，不强造金额或责任结论。可读性问题只按实际增加的客服工作影响整体帮助判断，不自动等于L0/L1/U；clear也不证明业务结论正确。`;
function validateReadability(value,{required,references,bad,string}){
 if(value===undefined&&!required)return undefined;
 if(!value||typeof value!=='object'||Array.isArray(value))bad('缺少AI输出可读性判断');
 const {status,reason,evidence_refs,issue_types,recommendations}=value;
 if(!['clear','needs_improvement','unknown'].includes(status))bad('AI输出可读性状态不正确');
 string(reason,'AI输出可读性判断依据');
 if(!Array.isArray(evidence_refs)||evidence_refs.some(id=>!references.has(id)||!id.startsWith('E')||references.get(id).role==='metadata')||status!=='unknown'&&!evidence_refs.some(id=>references.get(id).role==='ai_output'))bad('AI输出可读性须引用有效的AI实际输出');
 if(!Array.isArray(issue_types)||issue_types.length>5||new Set(issue_types).size!==issue_types.length||issue_types.some(t=>!Object.hasOwn(ISSUE_TYPES,t)))bad('AI输出可读性问题类型无效');
 if(!Array.isArray(recommendations)||recommendations.length>3)bad('AI输出可读性改进建议应为不超过3项的列表');
 if(status==='needs_improvement'&&(!issue_types.length||!recommendations.length))bad('可读性需改进时必须说明问题并提供改写示范');
 if(status!=='needs_improvement'&&(issue_types.length||recommendations.length))bad('可读性清楚或无法判断时不得编造问题与改写建议');
 const clean=recommendations.map(r=>{
  if(!r||typeof r!=='object')bad('可读性改进建议格式无效');string(r.suggestion,'可读性改进建议');
  const sample=r.rewrite_example;if(!sample||typeof sample!=='object'||Array.isArray(sample))bad('可读性建议缺少结构化改写示范');
  const rewrite_example={};for(const [key,label]of [['disposition','处置结论'],['basis','核验依据'],['pending_verification','待客服核实']])rewrite_example[key]=string(sample[key],'改写示范'+label).trim();
  if(sample.driver_message!==null)string(sample.driver_message,'改写示范建议对司话术');rewrite_example.driver_message=sample.driver_message===null?null:sample.driver_message.trim();
  return {suggestion:r.suggestion.trim(),rewrite_example};
 });
 return {status,reason:reason.trim(),evidence_refs:[...new Set(evidence_refs)],issue_types:[...issue_types],recommendations:clean};
}
module.exports={ISSUE_TYPES,CONTRACT,INSTRUCTIONS,validateReadability};
