'use strict';
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.AnalysisSummary=factory();
})(globalThis,function(){
  const grades=['L0','L1','L2','L3','U'];
  const text=value=>String(value??'').replace(/\s+/g,' ').trim();
  const short=(value,max=90)=>{const s=text(value);return s.length>max?s.slice(0,max-1)+'…':s;};
  function record(row){
    const report=row.rating?.report||{},graded=grades.includes(row.status);
    const findings=graded?(report.findings||[]).filter(f=>text(f.description)):[];
    const missing=graded?(report.missing_materials||[]).map(text).filter(Boolean):[];
    let problem=findings[0]?.description,advice=findings[0]?.suggestion;
    if(!problem&&row.status==='U'){problem=missing.length?'缺少'+missing.join('、'):'现有依据不足，暂无法判断';advice=missing.length?'补充'+missing.join('、')+'后重新评估。':'核对原文与方案，补齐判断依据后重新评估。';}
    if(!problem&&graded)problem=['L0','L1'].includes(row.status)?'评级提示存在缺口，具体问题需复核':'未列出明确问题';
    const pending={routing_pending:['场景或监测方案待确认','确认本条场景与监测方案后开始分析。'],pending:['尚未开始评级','完成方案确认后开始本批评级。'],running:['正在分析','分析完成后查看结论。'],failed:['评级执行失败','查看运行详情，修正错误后重试。'],import_failed:['导入失败','修正源文件后重新导入。'],not_applicable:['当前方案不适用','核对场景与评估对象，选择适用的监测方案。']};
    if(!graded){[problem,advice]=pending[row.status]||['尚未形成结论','完成评级后查看建议。'];}
    return {conclusion:text((graded||row.status==='not_applicable')&&(report.summary||report.reason)||row.rating?.error||row.item?.error||row.routing?.reason||problem),problem:text(problem),advice:text(advice)||'暂无具体改进建议，可结合依据进一步复核。',findings,missing};
  }
  function aggregate(rows){
    const groups=new Map(),counts=Object.fromEntries(grades.map(g=>[g,0]));let assessed=0;
    function add(key,title,kind,row,description,suggestion,rank,finding=null){
      if(!groups.has(key))groups.set(key,{key,title,kind,ids:new Set(),examples:[],suggestions:[],scenes:new Set(),rank,sources:[]});
      const g=groups.get(key);g.ids.add(row.item.id);
      const source={item_id:row.item.id,rating_id:row.rating.id,batch_id:row.item.batch_id,record_name:row.item.record_snapshot?.name||'记录',scene_id:row.item.record_snapshot?.scene_id,scope:row.item.record_snapshot?.scope,grade:row.status,description,suggestion,finding_index:finding?(row.rating.report.findings||[]).indexOf(finding):null,quotes:finding?.quotes||[],evidence_refs:finding?.evidence_refs||[],rule_refs:finding?.rule_refs||[]};if(!g.sources.some(s=>s.rating_id===source.rating_id&&s.item_id===source.item_id&&s.finding_index===source.finding_index))g.sources.push(source);g.rank=Math.max(g.rank,rank);
      if(description&&!g.examples.includes(description))g.examples.push(description);
      if(suggestion&&!g.suggestions.includes(suggestion))g.suggestions.push(suggestion);
      if(row.item.record_snapshot?.scene)g.scenes.add(row.item.record_snapshot.scene);
    }
    for(const row of rows){
      if(!grades.includes(row.status))continue;
      counts[row.status]++;assessed++;
      const r=record(row);
      for(const f of r.findings){
        const type=text(f.type)||'待复核问题',rules=[...new Set(f.rule_refs||[])].sort();
        // Rule IDs are local to a frozen plan. Never merge unrelated plans by P1/S1.
        const binding=row.rating.monitor_binding,plan=binding?.revision_id||binding?.candidate_id||binding?.definition?.id||row.item.record_snapshot?.scene_id||row.item.record_snapshot?.scene||'unscoped';
        const generic=/^(问题|其他|缺口|待复核问题)$/.test(type);
        const key=JSON.stringify(['finding',type,plan,row.item.record_snapshot?.scope||'',rules,generic?text(f.description):'']);
        add(key,type,'finding',row,text(f.description),text(f.suggestion),row.status==='L0'?3:2,f);
      }
      if(row.status==='U')add('missing','判断依据不足','missing',row,r.missing.length?'缺少'+r.missing.join('、'):r.problem,r.missing.length?'补充'+r.missing.join('、')+'后重新评估。':r.advice,1);
      else if(!r.findings.length&&['L0','L1'].includes(row.status))add('review-'+row.status,'评级缺口待复核','review',row,r.conclusion,'核对原文与判断依据，确认具体问题及改进动作。',row.status==='L0'?3:2);
    }
    const issues=[...groups.values()].map(g=>({...g,ids:[...g.ids],scenes:[...g.scenes],count:g.ids.size})).sort((a,b)=>b.rank-a.rank||b.count-a.count||a.title.localeCompare(b.title,'zh-CN'));
    const affected=new Set(issues.flatMap(g=>g.ids)).size;
    const remaining=rows.filter(r=>!grades.includes(r.status)&&r.status!=='not_applicable').length;
    const excluded=rows.filter(r=>r.status==='not_applicable').length;
    let conclusion='尚未形成评级，完成分析后会自动生成总结。';
    if(assessed){
      const problem=issues.find(g=>g.kind!=='missing');
      conclusion=problem?'已分析 '+assessed+' 条，优先关注「'+problem.title+'」'+problem.count+' 条。':counts.U?'已分析 '+assessed+' 条，其中 '+counts.U+' 条依据不足，优先补齐材料。':'已分析 '+assessed+' 条，未列出明确问题，可抽查关键记录。';
    }
    return {total:rows.length,assessed,remaining,excluded,counts,affected,issues,conclusion};
  }
  function improvement(issue){
    if(issue.kind==='missing')return {target:'业务依据或证据',why:'现有材料不足以完成相应判断，补齐材料有助于区分真实能力缺口与尚未核实的事项。材料缺失本身不能证明客服 AI 出错。',goal:'补齐已列明的材料，标明来源和适用范围，再核对原判断。'};
    if(issue.kind==='review')return {target:'先复核具体问题',why:'目前只有等级或总结提示，尚未列出明确缺陷，直接改写 Skill 缺少依据。',goal:'先结合原文明确具体遗漏或错误，再决定是否需要修改客服 Skill。'};
    const t=issue.title+' '+issue.examples.join(' ');
    if(/陈述|语境|诉求|遗漏|通话|录音/.test(t))return {target:'AI 客服 Skill',why:'关键陈述没有进入分析时，可能遗漏会改变处理方向的情况，客服还需重新梳理。建议让 Skill 明确要求提取、核对并回应这些信息。',goal:'修改后的 AI 输出应回应材料中的关键陈述，说明矛盾和待核实项；不把当事人说法直接当成已证实事实。'};
    if(/路径|话术|建议|交付|举证|沟通/.test(t))return {target:'AI 客服 Skill',why:'缺少具体处理路径时，客服难以直接使用分析结果，还需自行补充后续动作。',goal:'修改后的 AI 输出应针对本单交代可执行的下一步、需要补查的材料和人工剩余工作。'};
    if(/证据|数值|底单|事实|来源|断言|测算|工具/.test(t))return {target:'AI 客服 Skill',why:'事实和数值的来源交代不清时，客服难以核实结论。应让 Skill 区分已有依据、待核实数据和确定性判断。',goal:'修改后的 AI 输出应标明事实和数值依据，对未核实项保留不确定性，不凭缺少底单推定事实错误。'};
    if(/责任|归因|规则|政策|推理|阈值|定责|判责/.test(t))return {target:'AI 客服 Skill',why:'结论与材料、规则之间缺少解释时，客服难以判断适用条件是否成立，可能需要重新推理。',goal:'修改后的 AI 输出应交代结论的材料依据、适用规则及推理过程；未提供的业务政策不能自行补造。'};
    return {target:'AI 客服 Skill',why:'本批评估提出了具体分析缺口，可将核对后的建议转为 Skill 修改要求，减少同类问题重复出现。',goal:'修改后的 AI 输出应落实本项具体建议，并用原问题案例及原本正确的案例核验，避免引入新问题。'};
  }
  return {short,record,aggregate,improvement};
});
