'use strict';
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./rating-identity'),require('./business-import'));else root.AnalyticsData=factory(root.RatingIdentity,root.BusinessImport);})(globalThis,function(RatingIdentity,BusinessImport){
  const grades=['L0','L1','L2','L3','U'];
  const stamp=x=>Number.isFinite(Date.parse(x))?Date.parse(x):0;
  function businessDay(record){
    const fields=record?.business_record?.fields||{};
    const value=fields.session_time||fields.created_time||record?.session_time||record?.created_time||record?.business_time;
    if(!value)return null;
    const s=String(value).trim(),match=s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:$|[ T])/);
    if(match&&!/[zZ]$|[+-]\d\d:\d\d$/.test(s)){
      const day=match[1]+'-'+match[2].padStart(2,'0')+'-'+match[3].padStart(2,'0'),date=new Date(day+'T00:00:00Z');
      return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===day?day:null;
    }
    if(!stamp(s))return null;
    return new Date(stamp(s)+8*3600000).toISOString().slice(0,10);
  }
  function identity(item,batch){
    const record=item.record_snapshot||{},fields=record.business_record?.fields||{};
    const sourceId=fields.session_id||fields.ticket_id;
    if(record.business_record?.import_profile==='tier2_rnd_v1')return JSON.stringify([batch?.source_system||'business',record.scope,fields.tenant_id,fields.ticket_id,fields.trace_id]);
    if(sourceId)return JSON.stringify([batch?.source_system||'business',record.scope,BusinessImport.tenantId(item),String(sourceId)]);
    if(item.identity_quality!=='batch_row_only'&&item.source_record_id&&item.logical_key)return item.logical_key;
    // Row numbers from old exports are not reliable cross-batch business IDs.
    return JSON.stringify([item.batch_id,item.case_id||item.id]);
  }
  function metrics(rows){
    const counts=Object.fromEntries([...grades,'pending','running','failed','routing_pending','import_failed','not_applicable'].map(s=>[s,0]));
    for(const row of rows)counts[row.status]=(counts[row.status]||0)+1;
    const valid=rows.filter(r=>r.item.case_id).length,done=grades.reduce((n,g)=>n+counts[g],0),evaluable=done-counts.U;
    const ratio=(n,d)=>d?n/d:null;
    return {counts,valid,done,evaluable,coverage:ratio(done,valid),delivery:ratio(counts.L3,evaluable),assisted:ratio(counts.L2+counts.L3,evaluable),error:ratio(counts.L0,evaluable),unknown:ratio(counts.U,done)};
  }
  function collect(data,{batch='all',target='all',scene='all',tenant='all',from='',to=''}={},resolve=x=>x){
    const batches=new Map((data.batches||[]).map(b=>[b.id,b])),routes=new Map((data.item_routes||[]).map(r=>[r.id,r]));
    const ratings=new Map();for(const r of data.ratings||[]){if(!ratings.has(r.item_id))ratings.set(r.item_id,[]);ratings.get(r.item_id).push(r);}
    const items=(data.batch_items||[]).filter(i=>batch==='all'||i.batch_id===batch).map(resolve).filter(i=>BusinessImport.matchesTenant(i,tenant));
    const groups=new Map(),invalid=[];
    for(const [index,item]of items.entries()){
      if(!item.case_id){invalid.push({item,status:'import_failed',index});continue;}
      const routing=routes.get(item.current_route_id),list=(ratings.get(item.id)||[]).filter(r=>!routing||RatingIdentity.matches(r,routing)).sort((a,b)=>stamp(a.finished_at||a.created_at)-stamp(b.finished_at||b.created_at));
      const effective=list.filter(r=>r.status==='completed'&&grades.includes(r.report?.grade)||r.status==='not_applicable').at(-1),rating=effective||list.at(-1);
      const status=routing&&routing.status!=='ready'?'routing_pending':rating?.status==='not_applicable'?'not_applicable':rating?.status==='completed'&&grades.includes(rating.report?.grade)?rating.report.grade:['failed','running','pending'].includes(rating?.status)?rating.status:'pending';
      const last=list.at(-1),executionStatus=routing&&routing.status!=='ready'?'routing_pending':last?.status==='completed'&&grades.includes(last.report?.grade)?last.report.grade:last?.status==='not_applicable'?'not_applicable':['failed','running','pending'].includes(last?.status)?last.status:'pending';
      const row={item,routing,rating,...(data.issue_taxonomy?{classifications:(data.issue_classifications||[]).filter(x=>x.rating_id===rating?.id)}:{}),status,index,day:businessDay(item.record_snapshot),execution:{item,routing,rating:last,status:executionStatus,day:businessDay(item.record_snapshot)}};
      const key=identity(item,batches.get(item.batch_id));if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);
    }
    const selected=[];
    for(const list of groups.values()){
      const latest=list.at(-1),effective=list.filter(r=>grades.includes(r.status)||r.status==='not_applicable');
      effective.sort((a,b)=>stamp(a.rating.finished_at||a.rating.created_at)-stamp(b.rating.finished_at||b.rating.created_at)||a.index-b.index);
      const chosen=effective.at(-1)||latest;
      selected.push({...chosen,imports:list.length,newerPending:(chosen.item.id!==latest.item.id||chosen.rating?.id!==latest.execution.rating?.id)&&!grades.includes(latest.execution.status)&&latest.execution.status!=='not_applicable',latestExecution:latest.execution});
    }
    const matches=row=>{
      const record=row.item.record_snapshot||{};
      return (['all','linked'].includes(target)||record.scope===target)&&(scene==='all'||(scene==='unmapped'?!record.analytics_scene_id:record.analytics_scene_id===scene));
    };
    const inTime=row=>!from&&!to||!!row.day&&(!from||row.day>=from)&&(!to||row.day<=to);
    const scoped=selected.filter(matches),unique=scoped.filter(inTime),failed=target==='all'&&scene==='all'&&!from&&!to?invalid:[];
    const raw=items.filter(item=>matches({item})&&inTime({day:businessDay(item.record_snapshot)}));
    const rndRows=unique.filter(r=>r.item.record_snapshot.business_record?.import_profile==='tier2_rnd_v1');
    const rndTickets=new Set(rndRows.map(r=>{const item=r.item,f=item.record_snapshot.business_record.fields;return JSON.stringify([batches.get(item.batch_id)?.source_system,item.record_snapshot.scope,f.tenant_id,f.ticket_id]);}));
    return {rows:[...unique,...failed],unique,rndCallCount:rndRows.length,rndTicketCount:rndTickets.size,operations:unique.map(r=>r.latestExecution),rawCount:raw.length,rawValid:raw.filter(i=>i.case_id).length,duplicates:raw.filter(i=>i.case_id).length-unique.length,batchCount:new Set(raw.map(i=>i.batch_id)).size,allBatches:items.length?new Set(items.map(i=>i.batch_id)).size:0,undated:scoped.filter(r=>!r.day).length,olderEffective:unique.filter(r=>r.newerPending).length};
  }
  function trend(rows){
    const groups=new Map();for(const r of rows){if(!r.day||!r.item.case_id)continue;if(!groups.has(r.day))groups.set(r.day,[]);groups.get(r.day).push(r);}
    return [...groups].sort(([a],[b])=>a.localeCompare(b)).map(([day,list])=>({day,rows:list,...metrics(list)}));
  }
  function comparisons(data,rows,{from='',to=''}={}){
    const batches=new Map((data.batches||[]).map(b=>[b.id,b])),keys=new Set(rows.filter(r=>r.item.case_id).map(r=>identity(r.item,batches.get(r.item.batch_id))));
    const caseIds=new Set((data.batch_items||[]).filter(i=>i.case_id&&keys.has(identity(i,batches.get(i.batch_id)))).map(i=>i.case_id)),seen=new Map();
    for(const run of data.runs||[]){
      if(!['uploaded_output_comparison','isolated_model_replay'].includes(run.kind)||run.executed!==true||!caseIds.has(run.case_id)||!run.before||!run.after)continue;
      const day=businessDay(run.case_snapshots?.find(c=>c.id===run.case_id)?.record);
      if((from||to)&&(!day||from&&day<from||to&&day>to))continue;
      const key=run.base_run_id+':'+run.case_id,old=seen.get(key);
      if(!old||stamp(run.created_at)>=stamp(old.created_at))seen.set(key,run);
    }
    return [...seen.values()];
  }
  return {businessDay,identity,metrics,collect,trend,comparisons};
});
