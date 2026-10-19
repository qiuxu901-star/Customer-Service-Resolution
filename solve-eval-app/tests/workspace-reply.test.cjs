'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {markdown, body, presentation} = require('../public/workspace-reply');
const {replyBlockForTool} = require('../workspace-replies');
const helpers = {action: a => '<button data-action="' + a.type + '">' + a.label + '</button>', scopeLabel: () => '一线 · 当前任务', time: () => '查询时间'};

test('结论、标题、嵌套步骤、表格、引用和代码形成层级；简单回复保持短段落', () => {
  assert.equal(markdown('可以，先核对原文。'), '<p>可以，先核对原文。</p>');
  const html = markdown('优先复核 **2 条异常记录**。\n\n### 处理顺序\n1. 核对原文\n   - 比较依据\n   - 保留 `record_id`\n2. 补齐材料\n\n| 问题 | 数量 |\n| --- | ---: |\n| 缺少依据 | **2** |\n\n> 原文仅提及联系失败。\n\n```text\n<script>原样显示</script>\n```');
  assert.match(html, /<strong>2 条异常记录<\/strong>/);
  assert.match(html, /<h3>处理顺序<\/h3>/);
  assert.match(html, /<ol start="1"><li><p>核对原文<\/p><ul>/);
  assert.match(html, /<li><p>补齐材料<\/p><\/li><\/ol>/);
  assert.match(html, /<th scope="col" class="reply-align-right">数量<\/th>/);
  assert.match(html, /<blockquote><p>原文仅提及联系失败。<\/p><\/blockquote>/);
  assert.match(html, /<pre><code>&lt;script&gt;原样显示&lt;\/script&gt;<\/code><\/pre>/);
  assert.match(markdown('###标题没有空格\n未闭合 **重点'), /###标题没有空格<br>未闭合 \*\*重点/);
});

test('不执行HTML、脚本链接和外部图片；合法链接安全打开，代码保持原样', () => {
  const html = markdown('<img src=x onerror="alert(1)">\n<script>alert(1)</script>\n\n[危险](javascript:evil) [编码危险](javascript&#58;evil) [数据](data:text/html,boom) ![图](https://example.test/a.png)\n\n[文档](https://example.test/?q=a&b=c) `**保持原样**`');
  assert.doesNotMatch(html, /<(?:img|script|iframe)\b/);
  assert.doesNotMatch(html, /href="(?:javascript|data):/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /href="https:\/\/example.test\/\?q=a&amp;b=c" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /<code>\*\*保持原样\*\*<\/code>/);
});

test('表格中的转义管道和代码管道不拆列，不完整表格保持可读', () => {
  const html = markdown('| 字段 | 值 |\n| --- | --- |\n| a\\|b | `c|d` |\n\n后续说明');
  assert.match(html, /<td class="reply-align-left">a\|b<\/td><td class="reply-align-left"><code>c\|d<\/code><\/td>/);
  assert.match(html, /<\/div><p>后续说明<\/p>$/);
  assert.equal(markdown('| 只有文字 |\n| 没有分隔行 |'), '<p>| 只有文字 |<br>| 没有分隔行 |</p>');
});

test('先看到答案再看到业务事实和建议；纯文字与以标题开头的历史回复正常显示', () => {
  const html=body('**先补齐依据。**\n\n### 下一步\n1. 核对原文。','<section>业务数据</section>');
  assert.ok(html.indexOf('先补齐依据') < html.indexOf('业务数据'));
  assert.ok(html.indexOf('业务数据') < html.indexOf('下一步'));
  assert.match(html, /reply-prose reply-detail/);
  assert.equal(body('简单回答。'), '<div class="message-text reply-prose"><p>简单回答。</p></div>');
  assert.match(body('### 历史标题\n\n内容','<section>依据</section>'), /<h3>历史标题<\/h3><p>内容<\/p><\/div><section>依据<\/section>/);
});

test('统计卡保留口径和异常分类，零分母不显示零绩效；旧消息无需卡片', () => {
  const block = replyBlockForTool('get_workspace_summary', {valid:1, evaluated:1, evaluable:0, counts:{L3:0, U:1, failed:2}, l3_delivery_rate:null}, {scope:'frontline'});
  const out = presentation({version:1, blocks:[block]}, helpers);
  assert.match(out.html, /<dd>—<\/dd>/); assert.doesNotMatch(out.html, /0\.0%/);
  assert.match(out.html, /L3 0 条 \/ 可评价 0 条 · 尚无可评价记录/);
  assert.match(out.html, /U · 无法判断 <b>1<\/b>/); assert.match(out.html, /评级失败 <b>2<\/b>/);
  assert.equal(out.covered.has('analytics:'), true);
  assert.equal(presentation(undefined, helpers).html, '');
  assert.equal(presentation({version:99, blocks:[block]}, helpers).html, '');
  assert.equal(presentation({version:1, blocks:[null, {type:'unknown'}]}, helpers).html, '');
});

test('任务进度不猜测，未知确认状态单独说明；多数任务按需展开', () => {
  const tasks = [
    {id:'1', name:'<img src=x>', imported_count:5, confirmed:null, latest_run:[]},
    {id:'2', name:'运行任务', imported_count:10, latest_run:[{status:'running', total:10, processed_count:3, failed_count:1}]},
    {id:'3', name:'历史任务', imported_count:4, latest_run:[{status:'completed', total:4}]},
    {id:'4', name:'待确认任务', imported_count:2, confirmed:false, latest_run:[]},
  ];
  const out = presentation({version:1, blocks:[{type:'analysis_tasks', total:6, tasks}]}, helpers);
  assert.match(out.html, /方案确认状态待核对/); assert.match(out.html, /<progress max="10" value="3"/);
  assert.equal((out.html.match(/<progress /g) || []).length, 1);
  assert.match(out.html, /展开其余 1 个任务/); assert.match(out.html, /仅展示最近 4 个任务/);
  assert.match(out.html, /&lt;img src=x&gt;/); assert.equal(out.covered.has('batch:4'), true);
});

test('证据折叠并原样转义，截取有标记；越权或不完整原文不生成假证据', () => {
  const block = replyBlockForTool('read_record_evidence', {id:'r1', name:'记录1', source:JSON.stringify({fields:{conversation_text:'<script>不要执行</script>' + '原文'.repeat(900), ai_suggested_reply:'**不排版原文**'}})}, {});
  assert.equal(block.excerpts[0].text.length, 1600); assert.equal(block.excerpts[0].truncated, true);
  const out = presentation({version:1, blocks:[block]}, helpers);
  assert.match(out.html, /<details class="reply-more"><summary>展开已读取的原文片段/);
  assert.doesNotMatch(out.html, /<details[^>]* open|<script>|<strong>不排版原文/);
  assert.match(out.html, /片段已截取/); assert.match(out.html, /\*\*不排版原文\*\*/);
  assert.equal(out.covered.has('record:r1'), true);
  assert.equal(replyBlockForTool('read_record_evidence', {error:'不在范围内'}, {}), null);
  assert.deepEqual(replyBlockForTool('read_record_evidence', {id:'r2', source:'{"被截断'}, {}).excerpts, []);
  assert.equal(replyBlockForTool('open_batch_import', {}, {}), null);
});
