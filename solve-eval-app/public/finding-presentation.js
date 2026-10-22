'use strict';
(function(root,factory){
 if(typeof module==='object'&&module.exports)module.exports=factory();
 else root.FindingPresentation=factory();
})(globalThis,function(){
 const labels={ai_analysis_conclusion:'责任结论',ai_key_information:'关键信息提取',ai_responsible_party:'责任方',ai_cited_policy:'判责依据条款',ai_core_evidence:'核心证据',ai_reply:'AI 回复'};
 const primary=id=>id==='ai_analysis_conclusion'||id==='ai_reply';
 const text=value=>typeof value==='string'?value.trim():'';
 function quotesOf(f){return f.quotes||(f.quote?[{source:f.source,quote:f.quote}]:[]);}
 function locations(f,sources=[]){
  const confirmed=Array.isArray(f.problem_source_ids)&&f.problem_source_ids.length>0;
  const quotes=quotesOf(f),description=text(f.description);
  const ai=quotes.filter(q=>(q.role||sources.find(s=>s.id===q.source)?.role)==='ai_output');
  let ids=confirmed?f.problem_source_ids:[],origin=confirmed?'report':'unknown';
  if(!confirmed){
   // Attribute only an explicitly disputed assertion, not every cited output.
   // A correctly quoted source phrase (e.g. “车不搞了”) is not a target.
   const disputed=[...description.matchAll(/(?:写成|表述为|认定为|断言为|误判为|错误地称为)[“「]([^”」]{2,80})[”」]/g)].map(m=>m[1]);
   if(disputed.length)ids=ai.filter(q=>disputed.some(term=>text(q.quote).includes(term))).map(q=>q.source);
   // Older reports sometimes name the faulty field directly.
   if(!ids.length)for(const [id,label]of Object.entries(labels)){
    if(new RegExp(label+'(?:中|里|的)?(?:存在|出现|遗漏|漏掉|错误|误将|误把|未|缺少|缺乏|没有)').test(description)&&ai.some(q=>q.source===id))ids.push(id);
   }
   // Data asserted as a reason for a decision: locate that assertion only in
   // a cited conclusion containing the same numeric facts, not in evidence.
   if(!ids.length&&/(?:支撑|给出|作出|维持).*(?:判责|结论)|(?:判责|责任结论).*(?:缺少|缺乏|没有)/.test(description)){
    const numbers=description.match(/\d+(?:\.\d+)?/g)||[];
    ids=ai.filter(q=>primary(q.source)&&numbers.length&&numbers.some(n=>text(q.quote).includes(n))).map(q=>q.source);
   }
   if(ids.length)origin='description';
  }
  const items=[...new Set(ids)].filter(id=>!sources.find(s=>s.id===id)||sources.find(s=>s.id===id).role==='ai_output').map(id=>({id,label:labels[id]||sources.find(s=>s.id===id)?.label||quotes.find(q=>q.source===id)?.label||id,primary:primary(id)})).sort((a,b)=>Number(b.primary)-Number(a.primary));
  return {confirmed,origin,items,main:items[0]||null,others:items.slice(1)};
 }
 function impact(f){
  if(text(f.impact))return {text:text(f.impact),origin:'field'};
  // Reuse verbatim impact clauses already written by the evaluator. Do not
  // invent consequences from missing evidence or from a proposed suggestion.
  for(const key of ['description','evidence_reason']){
   const value=text(f[key]);
   for(const sentence of value.match(/[^。！？；;\n]+[。！？；;]?/g)||[]){
    const outsideQuotes=sentence.replace(/[“「][^”」]*[”」]/g,m=>' '.repeat(m.length));
    const start=outsideQuotes.search(/客服(?:若|如果|需|需要|仍需|还需|无法|难以|不能|会|须)|(?:若|如)直接采用|(?:可能|容易)导致/);
    const prefix=start<0?'':sentence.slice(0,start).trim();
    if(start>=0&&(!prefix||/[，,:：]$/.test(prefix)||/^(?:因此|所以|从而|导致|使得|因而)$/.test(prefix)))return {text:sentence.slice(start).trim().replace(/[；;]$/,'。'),origin:key};
   }
  }
  return {text:'',origin:'none'};
 }
 function problem(f){
  const description=text(f.description),effect=impact(f);
  if(effect.origin!=='description')return description;
  const tail=effect.text.replace(/[。！？]$/,'');
  const at=description.lastIndexOf(tail);
  if(at<0||description.slice(at+tail.length).replace(/[。！？\s]/g,''))return description;
  const result=description.slice(0,at).replace(/[；;，,\s]+$/,'');
  return result||text(f.title)||description;
 }
 function priority(f){return f.problem_source_ids?.some(primary)?0:f.affects_primary_conclusion===true?1:f.problem_source_ids?.length?2:3;}
 function ordered(findings){return findings.map((finding,index)=>({finding,index})).sort((a,b)=>priority(a.finding)-priority(b.finding)||a.index-b.index);}
 return {locations,impact,problem,priority,ordered};
});
