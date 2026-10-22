'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const P=require('../public/finding-presentation');
const sources=[{id:'ai_analysis_conclusion',role:'ai_output',label:'责任结论'},{id:'ai_key_information',role:'ai_output',label:'关键信息提取'},{id:'ai_core_evidence',role:'ai_output',label:'核心证据'},{id:'journey_dialogue_text',role:'context',label:'行程对话'}];
function recordingFinding(){return {description:'AI把司机提及车辆老旧、“车不搞了”直接写成“引导乘客取消”，但引用录音没有乘客回应或取消指令，也未标注待核实；客服若直接采用，会把未确认行为当作维持判责依据。',quotes:[{source:'ai_key_information',quote:'存在因车辆原因引导乘客取消的行为。'},{source:'ai_analysis_conclusion',quote:'录音显示司机引导乘客取消，平台维持原判责。'},{source:'ai_core_evidence',quote:'司机：车子老了，车不搞了。'},{source:'journey_dialogue_text',quote:'司机：车子老了，车不搞了。'}]};}
test('旧报告依据明确争议表述定位，一件问题保留一个主要位置；正确摘录不被标错',()=>{
 const f=recordingFinding(),before=JSON.stringify(f),where=P.locations(f,sources);
 assert.equal(where.main.id,'ai_analysis_conclusion');assert.deepEqual(where.others.map(x=>x.id),['ai_key_information']);assert.equal(where.origin,'description');assert.equal(where.confirmed,false);assert.ok(!where.items.some(x=>x.id==='ai_core_evidence'||x.id==='journey_dialogue_text'));assert.equal(JSON.stringify(f),before);
});
test('仅仅引用责任结论或核心证据不能定位为错误；不靠关键词猜测任意字段',()=>{
 const f=recordingFinding();f.description='需要核对材料才能判断问题位置。';assert.equal(P.locations(f,sources).main,null);
 f.description='核心证据准确摘录了原话；引用责任结论用于核对。';assert.equal(P.locations(f,sources).main,null);
});
test('数值被作为维持判责依据时，仅定位包含该断言的责任结论',()=>{
 const f={description:'AI用派单距离1026米、接单后3.5分钟取消来支撑维持原判责，但没有交代来源；客服需自行补查才能判断结论能否使用。',quotes:[{source:'ai_analysis_conclusion',quote:'派单距离1026米，3.5分钟取消，平台维持原判责。'},{source:'ai_core_evidence',quote:'司机称车辆老旧。'}]};
 assert.equal(P.locations(f,sources).main.id,'ai_analysis_conclusion');assert.equal(P.locations(f,sources).others.length,0);
 assert.equal(P.impact(f).text,'客服需自行补查才能判断结论能否使用。');assert.doesNotMatch(P.problem(f),/客服需自行补查/);
});
test('保留已有处理影响原句和假设语气，避免误报历史缺失或重复展示',()=>{
 const f=recordingFinding(),before=JSON.stringify(f);
 assert.equal(P.impact(f).text,'客服若直接采用，会把未确认行为当作维持判责依据。');assert.doesNotMatch(P.problem(f),/客服若直接采用/);assert.match(P.problem(f),/直接写成“引导乘客取消”/);assert.equal(JSON.stringify(f),before);
 assert.equal(P.impact({...f,impact:'当前结论需复核。'}).text,'当前结论需复核。');
});
test('不把AI引文或改进建议误读为已经确认的处理影响',()=>{
 assert.equal(P.impact({description:'AI写道“客服需自行补查”。',suggestion:'客服需核对记录。'}).text,'');
 assert.equal(P.impact({description:'提取内容不完整。'}).text,'');
 assert.equal(P.problem({description:'客服需补查。',title:'结论缺依据'}),'结论缺依据');
});
test('结构化位置优先于文字定位，多位置去重且按主次展示',()=>{
 const f={...recordingFinding(),problem_source_ids:['ai_key_information','ai_key_information','ai_analysis_conclusion']};const where=P.locations(f,sources);
 assert.equal(where.confirmed,true);assert.equal(where.main.label,'责任结论');assert.deepEqual(where.others.map(x=>x.label),['关键信息提取']);
});
