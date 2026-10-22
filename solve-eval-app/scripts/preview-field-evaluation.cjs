'use strict';
// Isolated opt-in trial: reads current data/configuration, writes only artifacts.
const fs=require('node:fs'),path=require('node:path');
const Field=require('../field-evaluation'),{requestRating,validateOutput,VERSION,SYSTEM,contextStats}=require('../llm-rating');
const args=process.argv.slice(2),arg=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
const ticket=arg('--ticket-id'),ratingId=arg('--rating-id'),out=arg('--out-dir'),synthetic=args.includes('--synthetic');
if((!synthetic&&!ticket&&!ratingId)||!out)throw Error('请指定 --synthetic、--ticket-id 或 --rating-id，以及全新的 --out-dir。');
const outDir=path.resolve(out);if(fs.existsSync(outDir))throw Error('输出目录已存在，请选择新目录以保留先前试评。');
const dataFile=path.resolve(arg('--data-file')||path.join(__dirname,'../data/db.json'));
const data=JSON.parse(fs.readFileSync(dataFile,'utf8'));
let rating;
if(synthetic){
 const {buildInput}=require('../llm-rating'),B=require('../public/business-import');
 const record=B.adaptRecord({'工单ID':'SYN-DRAFT-REVIEW','traceId':'SYN-TRACE','租户id':'SYN','反馈内容':'合成司机申诉称车辆故障，希望复核责任。','责任结论':'司机因车辆老旧引导乘客取消。派单距离800米不满足免责条件，因此维持原判责。','关键信息提取':'司机提到车辆老旧，存在引导乘客取消的行为。','核心证据':'司机：车子老了，今天不开了。','行程对话':'司机：车子老了，今天不开了。'});
 rating={id:'synthetic-draft-review',record_snapshot:record,request_snapshot:buildInput(record,{definition:{document:'这是合成案例。任务是整理申诉及录音事实，检查确定性判责是否有支持。未提供距离底单或免责规则时保留核验边界，不将材料缺失直接等同于AI未核验。'}})};
}else rating=ratingId?data.monitor_ratings.find(r=>r.id===ratingId):data.monitor_ratings.filter(r=>String(r.record_snapshot?.business_record?.fields?.ticket_id||'')===ticket).at(-1);
if(!rating?.request_snapshot)throw Error('没有找到所选工单的冻结评估材料。');
const selection=data.settings.model_default,profile=data.model_profiles.find(p=>p.id===selection?.profile_id);
if(!profile?.api_key||!profile.models.includes(selection.model))throw Error('当前默认模型配置不可用。');
const config={base_url:profile.base_url,api_key:profile.api_key,model:selection.model,rating_options:profile.rating_options?.[selection.model]||{}};
const input=Field.prepareInput(structuredClone(rating.request_snapshot));input.contract_version=VERSION;
const stats=contextStats(input,SYSTEM);if(config.rating_options.max_input_chars&&stats.total_chars>config.rating_options.max_input_chars)throw Error('试评超过已配置输入预算，未调用模型。');
fs.mkdirSync(outDir,{recursive:true});fs.writeFileSync(path.join(outDir,'系统评估要求.txt'),Field.systemFor(input,SYSTEM),{flag:'wx'});fs.writeFileSync(path.join(outDir,'冻结试评输入.json'),JSON.stringify(input,null,2),{flag:'wx'});
const status={issue:'发现问题',no_issue_found:'当前范围未发现问题',unknown:'暂无法判断',not_applicable:'不适用',usable:'可使用',needs_verification:'需核实后使用',not_usable:'当前结论不能直接采用',not_assessable:'暂无法判断',required:'任务要求',supporting:'辅助信息',not_required:'任务不要求',unclear:'任务范围待确认',qualified:'已保留边界',overstated:'确定性越界',not_provided:'本次未提供',incomplete:'材料不完整',unverified:'尚未独立核实'};
const clean=s=>String(s??'').replace(/\|/g,'\\|').replace(/\r?\n/g,' ');
function markdown(report,meta){
 const lines=['# 逐字段评估独立试评报告','',`工单：${clean(rating.record_snapshot?.name)}。本报告为${synthetic?'合成案例的真实模型试评，不含真实工单材料':'真实工单独立试评'}，未写回业务数据库或覆盖原报告。`,`模型：${meta.model}；扩展规则：${Field.VERSION}；试评时间：${new Date(meta.finished_at).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false})}（北京时间）。`,'',`整体等级：${report.grade}。结论可用性：**${status[report.conclusion_usability.status]}**。`,report.conclusion_usability.reason,'',report.summary,'','## 各项输出分别判断','','| 输出 | 是否提供 | 任务相关性 | 判断 | 理由 | 关联问题 |','| --- | --- | --- | --- | --- | --- |',...report.output_assessments.map(a=>`| ${clean(a.label)} | ${a.available?'已提供':'本次未提供'} | ${status[a.task_relevance]} | ${status[a.status]} | ${clean(a.reason)} | ${a.finding_ids.join('、')||'—'} |`),'','## 具体问题与每处原句',''];
 for(const f of report.findings){lines.push(`### ${f.finding_id} ${f.title}`,'',f.description,'',`处理影响：${f.impact}`,'',`此问题共 ${f.occurrences.length} 处；每处单独列明原句及理由，不区分主要／次要位置。`,'');for(const o of f.occurrences){lines.push(`**出错字段：${o.source_label}**`,'',...o.output_quotes.map(q=>`> ${q.text.trim().replace(/\n/g,'\n> ')}（${q.id}）`),'',`本处问题：${o.explanation}`,'',`核对依据：${o.comparison_quotes.map(q=>q.label+' · '+q.id+'：'+q.text.trim()).join('；')||'根据可见输出或本次提供材料范围判断，未伪造缺失材料的引用。'}`,'');}lines.push(`建议：${f.suggestion}`,'');}
 lines.push('## 材料限制（单独列出，不自动认定为AI错误）','');for(const m of report.material_limitations)lines.push(`- ${m.material}：${status[m.status]}。限制：${m.limits}。AI处理：${status[m.ai_handling]}；关联问题：${m.finding_ids.join('、')||'无已确认问题'}。`);
 lines.push('','## 人工剩余工作','',...report.remaining_work.map(w=>`- ${w.kind==='redo'?'需重做核心工作':'补充确认'}：${w.work} 原因：${w.reason}`),'','## 验证边界','','结构校验已验证字段、真实引用及问题对应关系；模型对材料含义、归因与等级的判断仍需人工确认。未据本次试评确认实际业务责任。');return lines.join('\n');
}
(async()=>{
 try{
  const result=await requestRating(input,config,{timeoutMs:180000});fs.writeFileSync(path.join(outDir,'模型原始返回.json'),result.raw,{flag:'wx'});
  const report=validateOutput(result.value,input),meta={source_rating_id:rating.id,model:config.model,field_evaluation_version:Field.VERSION,finished_at:new Date().toISOString(),usage:result.usage,elapsed_ms:result.elapsed_ms,status:'validated'};
  fs.writeFileSync(path.join(outDir,'评估报告.json'),JSON.stringify(report,null,2),{flag:'wx'});fs.writeFileSync(path.join(outDir,'试评记录.json'),JSON.stringify(meta,null,2),{flag:'wx'});fs.writeFileSync(path.join(outDir,'试评报告.md'),markdown(report,meta),{flag:'wx'});
  console.log(JSON.stringify({status:'validated',outDir,grade:report.grade,usability:report.conclusion_usability.status,outputs:report.output_assessments.map(a=>({label:a.label,status:a.status})),findings:report.findings.map(f=>({id:f.finding_id,title:f.title,fields:f.occurrences.map(o=>o.source_label)}))},null,2));
 }catch(error){if(error.raw_response&&!fs.existsSync(path.join(outDir,'模型原始返回.json')))fs.writeFileSync(path.join(outDir,'模型原始返回.json'),error.raw_response,{flag:'wx'});fs.writeFileSync(path.join(outDir,'试评失败说明.txt'),String(error.message),{flag:'wx'});console.error(error.message);process.exitCode=1;}
})();
