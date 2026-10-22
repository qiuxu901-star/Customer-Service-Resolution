'use strict';
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.AnalysisSummary=factory();
})(globalThis,function(){
  const grades=['L0','L1','L2','L3','U'];
  const text=value=>String(value??'').replace(/\s+/g,' ').trim();
  const short=(value,max=90)=>{const s=text(value);return s.length>max?s.slice(0,max-1)+'…':s;};
  function conclusionParts(report={}){
    const raw=text(report.summary||report.reason),current=raw.match(/^关键点是什么[：:]\s*([\s\S]*?)\s*没解决什么[：:]\s*([\s\S]*)$/),previous=raw.match(/^解决了什么[：:]\s*([\s\S]*?)\s*没解决什么[：:]\s*([\s\S]*)$/);
    const basis=report.grade_basis,remaining=(report.remaining_work||[]).map(w=>text(w.work)).filter(Boolean).join('；');
    const reason=basis?.critical_error?.confirmed?text(basis.critical_error.reason):text(basis?.substantive_value?.reason);
    const key_points=text(current?.[1])||(previous?(reason||'历史成果摘要：'+text(previous[1])):raw||reason)||'原报告未单独说明评价原因。';
    const unresolved=text((current||previous)?.[2])||remaining||(report.grade==='L3'&&report.task_summary?'本次任务未发现需补齐的关键事项。':report.grade==='U'?'现有材料不足，暂不能确认任务内的具体缺口。':(report.missing_materials||[]).length?'仍需补充：'+report.missing_materials.map(text).join('；'):'原报告未单独说明，需结合原结论核对。');
    const assessment=report.output_readability,readability_status={clear:'清楚易理解',needs_improvement:'需要改进',unknown:'暂无法判断'}[assessment?.status]||'未评估';
    return {key_points,unresolved,readability_status,readability_reason:text(assessment?.reason)||(raw?'原报告未记录可读性判断，需重新评估。':'评估完成后展示。'),legacy:!current,raw};
  }
  function record(row){
    const report=row.rating?.report||{},graded=grades.includes(row.status);
    const findings=graded?(report.findings||[]).filter(f=>text(f.description)):[];
    const missing=graded?(report.missing_materials||[]).map(text).filter(Boolean):[];
    let problem=findings[0]?.description,advice=findings[0]?.suggestion;
    if(!problem&&row.status==='U'){problem=missing.length?'缺少'+missing.join('、'):'现有依据不足，暂无法判断';advice=missing.length?'补充'+missing.join('、')+'后重新评估。':'核对原文与方案，补齐判断依据后重新评估。';}
    if(!problem&&graded)problem=['L0','L1'].includes(row.status)?'评级提示存在缺口，具体问题需复核':'未列出明确问题';
    const pending={routing_pending:['场景或监测方案待确认','确认本条场景与监测方案后开始分析。'],pending:['尚未开始评级','完成方案确认后开始本批评级。'],running:['正在分析','分析完成后查看结论。'],failed:['评级执行失败','查看运行详情，修正错误后重试。'],import_failed:['导入失败','修正源文件后重新导入。'],not_applicable:['当前方案不适用','核对场景与评估对象，选择适用的监测方案。']};
    if(!graded){[problem,advice]=pending[row.status]||['尚未形成结论','完成评级后查看建议。'];}
    const conclusion=text((graded||row.status==='not_applicable')&&(report.summary||report.reason)||row.rating?.error||row.item?.error||row.routing?.reason||problem);
    const parts=graded||row.status==='not_applicable'?conclusionParts(report):{key_points:conclusion,unresolved:advice,readability_status:'未评估',readability_reason:'尚未形成可读性评估。'};
    return {conclusion,problem:text(problem),advice:text(advice)||'暂无具体改进建议，可结合依据进一步复核。',findings,missing,...parts};
  }
  function aggregate(rows){
    const groups=new Map(),counts=Object.fromEntries(grades.map(g=>[g,0]));let assessed=0;
    function add(key,title,kind,row,description,suggestion,rank,finding=null){
      if(!groups.has(key))groups.set(key,{key,title,kind,ids:new Set(),examples:[],suggestions:[],scenes:new Set(),rank,sources:[]});
      const g=groups.get(key);g.ids.add(row.item.id);
      const source={item_id:row.item.id,rating_id:row.rating.id,batch_id:row.item.batch_id,record_name:row.item.record_snapshot?.name||'记录',scene:row.item.record_snapshot?.scene||'',total_finding_count:(row.rating.report.findings||[]).length,scene_id:row.item.record_snapshot?.scene_id,scope:row.item.record_snapshot?.scope,grade:row.status,problem_source_ids:finding?.problem_source_ids,affects_primary_conclusion:finding?.affects_primary_conclusion,impact:text(finding?.impact),title:text(finding?.title),description,suggestion,evidence_reason:text(finding?.evidence_reason),suggestion_reason:text(finding?.suggestion_reason),finding_index:finding?(row.rating.report.findings||[]).indexOf(finding):null,quotes:(finding?.quotes||(finding?.quote?[{quote:finding.quote,source:finding.source}]:[])).map(q=>({...q,role:q.role||row.rating.request_snapshot?.sources?.find(s=>s.id===q.source)?.role,label:q.label||row.rating.request_snapshot?.sources?.find(s=>s.id===q.source)?.label||q.source||'原始材料'})),evidence_refs:finding?.evidence_refs||[],rule_refs:finding?.rule_refs||[]};if(!g.sources.some(s=>s.rating_id===source.rating_id&&s.item_id===source.item_id&&s.finding_index===source.finding_index))g.sources.push(source);g.rank=Math.max(g.rank,rank);
      if(description&&!g.examples.includes(description))g.examples.push(description);
      if(suggestion&&!g.suggestions.includes(suggestion))g.suggestions.push(suggestion);
      if(row.item.record_snapshot?.scene)g.scenes.add(row.item.record_snapshot.scene);
      return g;
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
        const classified=Array.isArray(row.classifications),index=(row.rating.report.findings||[]).indexOf(f),assignment=row.classifications?.find(a=>a.finding_index===index);
        const state=assignment?.status||'not_classified',statusNames={unclassified:'未分类',not_classified:'尚未归类',outdated:'需重新归类'};
        const category=state==='classified'?assignment?.category:null;
        const groupKey=classified?JSON.stringify(['category',category?assignment.classification.taxonomy_revision_id:state,category?.id||state]):key;
        const g=add(groupKey,classified?(category?.name||statusNames[state]):text(f.title)||type,'finding',row,text(f.description),text(f.suggestion),row.status==='L0'?3:2,f);
        if(classified){g.classification_status=state;g.category=category||null;g.taxonomy_version=assignment?.taxonomy_version||null;g.sources.find(x=>x.item_id===row.item.id&&x.finding_index===index).classification=assignment||null;}
        g.finding_count=g.sources.length;
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
    if(issue.kind==='missing')return {target:'业务依据或证据'};
    if(issue.kind==='review')return {target:'先复核具体问题'};
    return {target:'表现问题／原因待诊断'};
  }
  return {short,record,conclusionParts,aggregate,improvement};
});
