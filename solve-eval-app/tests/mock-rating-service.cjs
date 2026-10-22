'use strict';
const http=require('node:http');
async function createMockRatingService({delayMs=15}={}){
 const calls=[];
 const server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;let body;try{body=JSON.parse(raw);}catch{res.writeHead(400);res.end('{}');return;}calls.push(body);let input;try{input=JSON.parse(body.messages.at(-1).content);}catch{input={sources:[]};}const aiSource=input.sources?.find(s=>s.role==='ai_output'),source=aiSource?.segments?{...aiSource,...aiSource.segments[0]}:aiSource;const output={applicability:'applicable',grade:'U',summary:'已读取 AI 处理记录；缺少独立底单，暂不能确认判责正确性。',dimensions:[{name:'判责合规度',status:'unknown',reason:'当前材料未提供独立政策和物理底单。',evidence_refs:[]}],findings:[],missing_materials:['适用运营规则及独立底单'],requires_review:true};
 if(input.record?.name?.includes('合成展示')&&source){output.grade='L2';output.summary='AI 提供了有效分析，但道路异常主张仍需补充核查。';output.dimensions=[{name:'取证完整度',status:'gap',reason:'处理记录承认需要补查道路通行情况。',score:10,max_score:25,evidence_refs:[source.id]},{name:'判责合规度',status:'unknown',reason:'缺少道路管制及适用政策底单。',evidence_refs:[]}];output.findings=[{type:'DEFECT_EVIDENCE_OMISSION',title:'道路通行情况还需要核实',evidence_reason:'AI输出提到道路情况待查，尚无可核对的查询结果。',suggestion_reason:'核实通行情况后才能判断它是否影响接驾。',description:'道路通行事实尚未核查',evidence_refs:[source.id],rule_refs:[],suggestion:'补充查询接驾时段道路管制情况，并记录依据。'}];}
 output.grade_basis={critical_error:{confirmed:false,reason:'合成材料未确认关键错误',evidence_refs:[]},substantive_value:{confirmed:output.grade==='L2',reason:output.grade==='L2'?'合成输出有可引用的核查建议':'合成材料不足以确认实质辅助价值',evidence_refs:output.grade==='L2'?[source.id]:[]},standard_conflict:{present:false,reason:'合成规则没有阻断性冲突',rule_refs:[]}};
 if(input.record?.name?.includes('不适用'))Object.assign(output,{applicability:'not_applicable',grade:null,summary:'本条未触发接驾异常场景。',dimensions:[],missing_materials:[]});
 Object.assign(output,require('./helpers-rating.cjs').helpReport(input,output.grade));
 if(input.record?.name?.includes('格式失败'))output.grade='INVALID';
 await new Promise(r=>setTimeout(r,delayMs));res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(output)}}],usage:{prompt_tokens:120,completion_tokens:80,total_tokens:200,prompt_cache_hit_tokens:80,prompt_cache_miss_tokens:40,completion_tokens_details:{reasoning_tokens:20}}}));});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});return {server,calls,base_url:'http://127.0.0.1:'+server.address().port+'/v1',close:()=>new Promise(r=>server.close(r))};
}
module.exports={createMockRatingService};
