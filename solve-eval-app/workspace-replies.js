'use strict';

// Keep expression rules separate from business permissions in workspace-agent.js.
const REPLY_GUIDELINES = `
回复表达规范：
1. 先回答用户当前问题，首段用一至两句给出核心答案或判断。简单沟通简短自然，不强制套报告模板，不复述问题或添加空泛总结。
2. 以便于扫读为目标，按内容选择格式：普通解释用短段落；多个并列要点用列表；操作顺序用编号步骤；同维度比较用表格；引用原文用引用块。复杂回答才使用少量三级标题（###），不要输出一级、二级标题。
3. 使用 Markdown 表达层级。只对关键结论、异常数字、需要用户决策的事项使用 **加粗**，不要整段加粗，不用装饰性图标、HTML或图片。表格只放简短的可比字段，长说明放在表格外。
4. 分析数据时先给核心发现，再说明主要问题、判断依据及优先建议；查询进展时先说明当前状态和阻塞项，再给下一步；解读记录时区分模型判断、原文事实与建议；操作指导写成可执行步骤。以上结构按问题需要取舍，不要求每次全部出现。
5. 事实、推断、建议分清：业务数字、执行状态和原文只能来自工具；推断说明依据，不确定或材料缺失时明确指出。关键比例说明分子分母，数据范围有歧义时说明所用范围。引用保持原文，不将截断的片段当完整证据。
6. 界面会根据 get_workspace_summary 自动附上指标卡，根据 list_analysis_tasks 附上任务进度卡，根据 read_record_evidence 附上可展开的原文片段和完整依据入口。正文重点解释这些数据意味着什么，不再完整抄写卡片、工具JSON或重复罗列全部任务。不要自行编造卡片、操作按钮或跳转地址。
7. 先呈现做决定所需的信息，再补充必要依据；建议给出优先次序和原因。非必要细节不堆进正文，避免把普通问答扩成分析报告。尊重用户对长短、格式和详细程度的明确要求。
`;

// Presentation is derived from executed tools, never parsed out of model prose.
function replyBlockForTool(name, result, context, capturedAt = new Date().toISOString()) {
  const base = {context: {...context}, captured_at: capturedAt};
  if (name === 'get_workspace_summary') {
    const {unit, valid, evaluated, evaluable, counts, l3_delivery_rate} = result;
    return {...base, type: 'metrics', data: {unit, valid, evaluated, evaluable, counts, l3_delivery_rate}};
  }
  if (name === 'list_analysis_tasks') return {...base, type: 'analysis_tasks', total: result.total, tasks: result.tasks};
  if (name !== 'read_record_evidence' || result.error) return null;
  let source = result.source;
  if (typeof source === 'string') {
    try { source = JSON.parse(source); } catch { source = null; }
  }
  const fields = source?.fields;
  const parts = fields ? [
    ['会话记录', fields.conversation_text], ['录音转录文本', fields.transcript_text],
    ['AI处理记录', fields.ai_process_text], ['AI建议回复', fields.ai_suggested_reply],
    ['AI分析结论', fields.ai_analysis_conclusion],
  ] : [['原始会话', source?.session_text], ['AI回复', source?.ai_reply]];
  const excerpts = parts.filter(([, text]) => typeof text === 'string' && text.trim()).map(([label, text]) => ({label, text: text.slice(0, 1600), truncated: text.length > 1600}));
  return {...base, type: 'evidence', id: result.id, name: result.name, status: result.status, excerpts};
}

module.exports = {REPLY_GUIDELINES, replyBlockForTool};
