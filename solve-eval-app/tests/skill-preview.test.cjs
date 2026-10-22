'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const Preview=require('../public/skill-preview');
const sample='## step8: 判断司机到达上车点后是否等待5分钟以上\n- 获取订单取消时间，**无需关心具体取消的操作人**，记录为 `T_cancel`\n  - 计算时间差 `Δt = T_cancel - T_arrive`（单位：分钟）\n  - **IF** `Δt >= 5`\n    - **IF** `driverViolationsEvidenceList.size == 0`\n      - 添加乘客违规证据至 `passengerViolationsEvidenceList`\n      - **终止分析**（禁止执行step9及以后）';
test('阅读预览把步骤、条件嵌套、粗体和变量排版，保留阈值、分支及终止要求',()=>{
 const html=Preview.render(sample);
 assert.match(html,/<h3>step8:/);assert.match(html,/<strong>无需关心具体取消的操作人<\/strong>/);assert.match(html,/<code>Δt &gt;= 5<\/code>/);assert.match(html,/<strong>终止分析<\/strong>/);assert.match(html,/禁止执行step9及以后/);
 assert.ok((html.match(/<ul>/g)||[]).length>=4);assert.equal((html.match(/<ul>/g)||[]).length,(html.match(/<\/ul>/g)||[]).length);assert.match(html,/<li><p><strong>IF<\/strong> <code>driverViolationsEvidenceList/);
});
test('JSON封装的variables.sop和rules解码换行并分别预览，不修改原始定义；多定义片段同样可读',()=>{
 const raw=JSON.stringify({id:'PICKUP',scenePrompt:null,variables:{role:'核对证据',sop:sample,rules:'- 不能补造事实\n- 保留未知'},type:'workflow'}),before=raw;
 const html=Preview.render(raw);assert.match(html,/处理步骤/);assert.match(html,/variables.sop/);assert.match(html,/<h3>step8:/);assert.match(html,/判断规则/);assert.doesNotMatch(html,/\\n/);assert.equal(raw,before);
 const fragments=raw+',\n'+JSON.stringify({id:'OTHER',content:'## 第二份\n独立正文'})+',';
 const all=Preview.render(fragments);assert.match(all,/定义 1/);assert.match(all,/定义 2/);assert.match(all,/独立正文/);
 const string=Preview.render(JSON.stringify(sample));assert.match(string,/<h3>step8:/);
});
test('代码块和行内代码不被当成Markdown语法；有序列表保留起始编号，表格可阅读',()=>{
 const html=Preview.markdown('```js\nif (x < 5) { **raw** }\n```\n\n8. 核查\n9. 结束\n\n| 项目 | 条件 |\n| --- | --- |\n| 等待 | `Δt >= 5` |');
 assert.match(html,/if \(x &lt; 5\) \{ \*\*raw\*\* \}/);assert.match(html,/<ol start="8">/);assert.match(html,/<li value="9">/);assert.match(html,/<table>/);assert.match(html,/<code>Δt &gt;= 5<\/code>/);
 assert.match(Preview.markdown('`**IF**`'),/<code>\*\*IF\*\*<\/code>/);
});
test('仅渲染文字，HTML和脚本链接不执行，也不加载远程图片；错误JSON不被偷偷修正',()=>{
 const html=Preview.render('<script>window.pwned=true</script>\n\n<img src=x onerror=alert(1)>\n\n[危险](javascript:alert)\n\n![图片](https://example.invalid/private.png)');
 assert.doesNotMatch(html,/<script>|<img|href="javascript:/i);assert.match(html,/&lt;script&gt;/);
 assert.match(Preview.render('{"variables":{"sop":"broken"}'),/JSON 格式尚未完整/);assert.match(Preview.render(''),/粘贴 Skill 正文后/);
});
test('高亮预览保留原始缩进和Markdown符号，只添加显示样式',()=>{
 const html=Preview.source(sample);assert.match(html,/skill-syntax-heading/);assert.match(html,/skill-syntax-code/);assert.match(html,/skill-syntax-marker/);assert.match(html,/      -/);
 const visible=html.replace(/<[^>]+>/g,'').replace(/&gt;/g,'>').replace(/&lt;/g,'<').replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&quot;/g,'"');assert.equal(visible,sample);
});
