'use strict';
const {createHash}=require('node:crypto');
const BASIC_ID='__basic__',BASIC_VERSION='basic-quality/v1';
const DOCUMENT=`# 基础分析检查（无场景专属方案）
本次为基础评估，不代表已配置场景监测。按全局评估员判断分析质量和实质帮助，不因缺少场景方案自动降低等级或判 U。不得自行创造业务政策、免责条件或责任真值。

## 检查维度
1. 诉求回应：是否理解并回应当前用户的核心诉求。
2. 信息利用与分析：是否提取并利用已有材料的关键内容，是否遗漏语境、存在矛盾或仅套用条款。
3. 实际帮助与交付：是否提供可由现有材料支持的实质分析或处理路径，人工还需补做什么。
4. 结论与证据边界：结论是否有据、是否说明待核实项；未知的业务责任与可评价的分析质量分别记录。

## 边界
只有材料能确认关键错误才判 L0；有明确分析缺口但无实质帮助可判 L1，有可确认实质帮助但不完整可判 L2。其他等级及 U 按全局评估员规则。未知底单、业务政策或运行版本单独列出，不直接认定未执行或业务 Skill 根因。关联业务 Skill 如有提供，仅作为对照版本。
`;
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function basicBinding(scene,scope){const definition={name:'基础分析检查',scene:scene.name,scene_id:scene.id,scope,participants:[scope],document:DOCUMENT,service_refs:[],service_bindings:[]};return {kind:'basic_evaluation',evaluation_mode:'basic',selection_id:BASIC_ID,plan_id:null,revision_id:BASIC_VERSION,document_hash:digest(definition),definition};}
module.exports={BASIC_ID,BASIC_VERSION,DOCUMENT,basicBinding};
