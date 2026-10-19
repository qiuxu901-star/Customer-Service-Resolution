'use strict';
const count=x=>Number.isSafeInteger(x)&&x>=0?x:null;
function cacheCapability(base_url){
  let hostname='';try{hostname=new URL(base_url).hostname;}catch{}
  if(hostname==='api.deepseek.com')return {mode:'automatic_prefix',label:'DeepSeek 自动前缀缓存',reference:'https://api-docs.deepseek.com/zh-cn/guides/kv_cache/',body_required:true,note:'仍逐条发送正文；是否命中以实际 usage 为准，不能保证每次命中'};
  if(hostname==='api.openai.com')return {mode:'automatic_prefix',label:'OpenAI 前缀缓存（依模型条件）',reference:'https://developers.openai.com/api/docs/guides/prompt-caching',body_required:true,note:'仍逐条发送正文；缓存条件和费率依模型而定'};
  return {mode:'unknown',label:'供应商缓存能力未确认',body_required:true,note:'完整发送选中规则；仅依据供应商实际返回量展示缓存，不承诺折扣'};
}
function normalizeUsage(raw){
  if(!raw||typeof raw!=='object')return null;
  const prompt=count(raw.prompt_tokens??raw.input_tokens),completion=count(raw.completion_tokens??raw.output_tokens),total=count(raw.total_tokens);
  const details=raw.prompt_tokens_details||raw.input_tokens_details||{};
  const hit=count(raw.prompt_cache_hit_tokens??details.cached_tokens),miss=count(raw.prompt_cache_miss_tokens);
  const write=count(details.cache_write_tokens);
  const inconsistent=prompt!==null&&((hit!==null&&hit>prompt)||(miss!==null&&miss>prompt)||(hit!==null&&miss!==null&&hit+miss!==prompt)||(write!==null&&hit!==null&&write+hit>prompt));
  return {prompt_tokens:prompt,completion_tokens:completion,total_tokens:total,cached_tokens:inconsistent?null:hit,cache_miss_tokens:inconsistent?null:miss,cache_write_tokens:inconsistent?null:write,reasoning_tokens:count((raw.completion_tokens_details||raw.output_tokens_details||{}).reasoning_tokens),cache_metrics_valid:!inconsistent};
}
function estimateCost(usage,pricing){
  if(!usage||!pricing)return null;
  const {prompt_tokens:p,completion_tokens:c,cached_tokens:h,cache_write_tokens:w}=usage;
  if(p===null||c===null||!usage.cache_metrics_valid)return null;
  if(h===null||w>0)return null; // Unknown categories cannot be priced as free or ordinary input.
  const input=(p-h)*pricing.input_per_million/1e6,cached=h*pricing.cached_input_per_million/1e6,output=c*pricing.output_per_million/1e6;
  return {amount:input+cached+output,currency:pricing.currency,estimated:true,pricing_snapshot:structuredClone(pricing)};
}
module.exports={cacheCapability,normalizeUsage,estimateCost};
