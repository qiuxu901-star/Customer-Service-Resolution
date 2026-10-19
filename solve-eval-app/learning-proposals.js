'use strict';
const {hash}=require('./monitoring');
const definitions={
 context:{title:'是否结合关键陈述进行分析',check:'检查 AI 是否识别并分析用户、客服或通话中的关键陈述，是否说明相互矛盾的说法及其对结论的影响。将当事人说法与已核实事实区分，不直接把陈述认定为客观事实或免责结论。',benefit:'帮助评估员发现只看数值、漏看取消意愿或申诉理由等分析遗漏。'},
 evidence:{title:'数值和事实结论是否有依据',check:'检查 AI 使用的数值、事实断言是否有材料支持，是否交代来源及待核实事项。未提供底单只限制相应事实核验，不能据此直接认定 AI 捏造、从未执行或整单无法评价。',benefit:'帮助评估员区分已有分析成果、待核实的数据和没有依据的确定性表述。'},
 reasoning:{title:'责任或处理结论是否经过充分分析',check:'检查 AI 的责任或处理结论是否由本单材料与已提供的有效业务规则支持，是否回应可能改变结论的情况并解释推理。不能把缺少政策、当事人陈述或与人工意见不一致直接等同于已经确认的责任错误。',benefit:'帮助评估员发现推理跳步，同时避免凭录音陈述或缺失材料直接判定业务对错。'},
 delivery:{title:'是否给出可执行的后续处理路径',check:'检查 AI 是否针对本单说明已有成果、需人工补查的事项及下一步处理建议；有必要时列出举证或沟通路径。不把人工完成的工作计为 AI 成果，未提供话术或日志的部分单独保留未知。',benefit:'帮助评估员判断客服能用这些分析做什么，以及还需要补做哪些工作。'},
 review:{title:'是否准确评价已有帮助和分析缺口',check:'对照本单材料评价 AI 已完成的实质帮助、尚存缺口与人工剩余工作；将最终业务责任待核实与分析质量可评价分开。发现相似情况时独立判断，不套用历史人工等级或预期答案。',benefit:'将人工复核提示的评估盲点转为检查方向，供后续案例独立验证。'}
};
function category(signal){
 if(signal.kind==='review')return 'review';
 const t=String(signal.title||'');
 if(/交付|路径|处置建议|处理建议|举证引导|安抚|话术|前置引导/.test(t))return 'delivery';
 if(/语境|陈述|诉求|信息遗漏|关键.*遗漏|录音|沟通|ASR|AUDIO|MULTI.MODAL/i.test(t))return 'context';
 if(/证据|数值|底单|来源|测算|测距|工具|断言|事实.*核实|捏造/.test(t))return 'evidence';
 if(/推理|归因|归责|判责|定责|规则|政策|责任|逻辑|阈值|围栏/.test(t))return 'reasoning';
 const details=String(signal.description||'');
 if(/语境|陈述|录音|通话|取消意愿/.test(details))return 'context';
 if(/底单|数值|证据|数据来源/.test(details))return 'evidence';
 return 'other-'+hash(t).slice(0,12);
}
function proposalsFor(group){
 const map=new Map();for(const s of group.signals){const key=category(s);if(!map.has(key))map.set(key,[]);map.get(key).push(s);}
 return [...map].map(([key,sources])=>{const definition=definitions[key]||{title:'是否核对“'+String(sources[0].title||'相关问题').slice(0,32)+'”所涉信息',check:'根据本单提供的材料，核查相关分析是否充分、结论是否有依据、是否形成实质帮助；不能将历史问题直接认定为本单事实或业务政策。',benefit:'把本次出现的问题作为后续核查线索，具体业务判据仍需确认。'};
 return {id:hash({batch:group.batch_id,scene:group.scene_id,scope:group.scope,key,sources:sources.map(s=>s.id).sort()}),category:key,...definition,reason:'本批评估提出：'+String(sources[0].description),record_count:new Set(sources.map(s=>s.case_id)).size,source_ids:sources.map(s=>s.id),examples:sources.map(s=>({item_id:s.item_id,rating_id:s.rating_id,record_name:s.record_name,description:s.description,quotes:s.quotes||[],review:s.review||null})),needs_confirmation:true};
 }).sort((a,b)=>Number(b.category==='review')-Number(a.category==='review')||b.record_count-a.record_count||a.category.localeCompare(b.category));
}
module.exports={proposalsFor};
