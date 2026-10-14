'use strict';
/* 种子标准库：示例尺子（意图定义/场景定义/场景检查清单/回复规则），均为「待确认」状态示例 */

const SEED_STANDARDS = [
  {
    type: 'intent_def',
    name: '奖励到账咨询',
    content: '司机咨询奖励、保底、冲单奖等各类激励款项的到账时间、到账状态、未到账原因。包含：到账时效咨询、到账状态查询、未到账催办。排除：奖励金额计算方式咨询（归「奖励规则咨询」）、奖励风控冻结（归「奖励风控咨询」）。',
    version: 1,
    status: '已生效',
    source: '人工',
  },
  {
    type: 'intent_def',
    name: '奖励金额异常',
    content: '司机反馈实际到账或展示的奖励金额与预期不一致，包括金额少了、多了、计算错误。排除：仅咨询计算规则（归「奖励规则咨询」）、未到账（归「奖励到账咨询」）。',
    version: 1,
    status: '已生效',
    source: '人工',
  },
  {
    type: 'intent_def',
    name: '奖励规则咨询',
    content: '司机咨询奖励如何计算、适用条件、限制规则。排除：具体订单的金额异常（归「奖励金额异常」）。',
    version: 1,
    status: '待确认',
    source: '人工',
  },
  {
    type: 'scene_def',
    name: '奖励到账咨询',
    content: '处理司机关于奖励款项到账状态与时效的场景。命中条件：司机明确提出奖励/保底/冲单奖到账相关问题。注意：与「奖励金额异常」场景的边界——只问到账时间与状态归本场景，涉及金额对不上的归金额异常场景。',
    version: 1,
    status: '已生效',
    source: '人工',
  },
  {
    type: 'scene_def',
    name: '奖励金额异常',
    content: '处理司机反馈奖励金额与预期不一致的场景。命中条件：司机明确表达金额差异（少了/多了/算错）。',
    version: 1,
    status: '已生效',
    source: '人工',
  },
  {
    type: 'checklist',
    name: '奖励到账咨询·场景检查清单',
    content: '1. 是否查询该司机对应奖励的实际状态（而非只给通用时效）？\n2. 是否说明当前状态的原因（已发放/审核中/未达标）？\n3. 是否给出明确到账时间或预计时间（有规则依据）？\n4. 未到账时是否给出后续动作（催办路径/客服跟进）？\n5. 是否避免无依据的时效承诺？',
    version: 1,
    status: '已生效',
    source: '人工',
  },
  {
    type: 'reply_rule',
    name: '奖励到账时效规则',
    content: '奖励一般在活动结束后 3 个工作日内发放，特殊情况最长 7 个工作日。到账时间以司机端账单明细为准。不得承诺「保证到账」「一定到账」。',
    version: 1,
    status: '已生效',
    source: '人工',
  },
  {
    type: 'case_positive',
    name: '正例·完整方案（奖励未到账）',
    content: 'AI 建议：「已为您查到，上周保底奖励当前状态为「审核中」，系统显示发放批次为 10 月第 2 批，按规则将在批次日后 3 个工作日内到账，即 10 月 16 日前到账，您可在司机端账单明细查看。若 10 月 16 日后仍未到账，可通过司机端「奖励申诉」入口提交，我们将在 48 小时内核实处理。」——判定要点：查了该司机实际状态、说明原因、给出有规则依据的时间、提供后续动作。',
    version: 1,
    status: '已生效',
    source: '人工',
  },
  {
    type: 'case_negative',
    name: '负例·仅信息相关（奖励未到账）',
    content: 'AI 建议：「奖励一般在三个工作日内到账，请您耐心等待。」——判定要点：未查该司机实际状态、未说明原因、未给后续动作，只给通用时效，属 L1（G8：规则未针对当前诉求应用）。',
    version: 1,
    status: '已生效',
    source: '人工',
  },
];

function seedStandards(storage) {
  if (storage.list('standards').length) return;
  const now = new Date().toISOString();
  for (const s of SEED_STANDARDS) {
    storage.insert('standards', Object.assign({}, s, { created_at: now, effective_at: s.status === '已生效' ? now : null }));
  }
}

module.exports = { seedStandards, SEED_STANDARDS };
