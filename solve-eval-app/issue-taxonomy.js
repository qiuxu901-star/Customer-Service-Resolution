'use strict';
const {hash}=require('./monitoring');
const seed=require('./issue-taxonomy-seed.json');
const clone=x=>structuredClone(x),fail=(s,c=400)=>{throw Object.assign(Error(s),{statusCode:c});};
const required=(v,label,max=4000)=>{if(typeof v!=='string'||!v.trim()||v.length>max)fail(label+'不能为空或过长');return v.trim();};
function normalizeCategory(c){
 if(!c||!/^C\d{2,4}$/.test(c.id))fail('类别编号必须为稳定的 C 数字编号');
 const list=(v,label)=>{if(!Array.isArray(v)||!v.length||v.length>20)fail('请填写'+label);return v.map(x=>required(x,label,1000));};
 const example=(v,label)=>({kind:v?.kind==='real_reference'?'real_reference':'synthetic',text:required(v?.text,label,2000)});
 if(typeof c.enabled!=='boolean')fail('请明确类别是否启用');
 return {id:c.id,name:required(c.name,'类别名称',80),definition:required(c.definition,'类别定义'),inclusion_rules:list(c.inclusion_rules,'包含条件'),exclusion_rules:list(c.exclusion_rules,'排除条件'),positive_example:example(c.positive_example,'正例'),negative_example:example(c.negative_example,'反例'),enabled:c.enabled};
}
function normalizeCategories(value,previous=[]){
 if(!Array.isArray(value)||!value.length||value.length>60)fail('分类目录需有1至60个类别');
 const categories=value.map(normalizeCategory),ids=new Set(categories.map(c=>c.id)),names=new Set(categories.map(c=>c.name));
 if(ids.size!==categories.length||names.size!==categories.length)fail('类别编号或名称重复');
 if(!categories.some(c=>c.enabled))fail('至少保留一个启用类别');
 for(const c of previous)if(!ids.has(c.id))fail('已有类别请停用，不可删除或重复使用编号');
 return categories;
}
const REASONS=['no_matching_definition','ambiguous_boundary','insufficient_context','compound_finding','invalid_model_category'];
function normalizeClassification(f,catalog){
 const category=catalog.categories.find(c=>c.id===f.category_id&&c.enabled);
 if(category&&typeof f.classification_reason==='string'&&f.classification_reason.trim())return {category_id:category.id,classification_reason:f.classification_reason.trim().slice(0,4000),unclassified_reason:null};
 const reason=REASONS.includes(f.unclassified_reason)?f.unclassified_reason:f.category_id!=null?'invalid_model_category':f.category_id===null?'no_matching_definition':'invalid_model_category';
 return {category_id:null,classification_reason:typeof f.classification_reason==='string'&&f.classification_reason.trim()?f.classification_reason.trim().slice(0,4000):'模型未提供可核对的有效分类，保留未分类。',unclassified_reason:reason};
}
function createIssueTaxonomy({storage}){
 const state=()=>storage.getSetting('issue_taxonomy_state',null),get=id=>storage.byId('issue_taxonomy_revisions',id)||fail('分类目录版本不存在',404);
 if(!state())storage.transaction(()=>{const categories=normalizeCategories(seed.categories),r=storage.insert('issue_taxonomy_revisions',{number:1,categories,content_hash:hash(categories),note:'按已确认 V1 方案初始化七类问题定义，后续可维护',actor:'系统初始化',confirmed_by:'系统初始化（已确认V1方案）',confirmed_at:new Date().toISOString()});storage.setSetting('issue_taxonomy_state',{active_revision_id:r.id,head_revision_id:r.id});});
 function snapshot(id=state().active_revision_id){const r=get(id);if(r.content_hash!==hash(r.categories))fail('分类定义摘要不一致',409);return clone({id:r.id,number:r.number,version:'v'+r.number,content_hash:r.content_hash,categories:r.categories});}
 function save(body){const actor=required(body.actor,'维护人',100),s=state();if(body.base_revision_id!==s.head_revision_id)fail('分类定义已有更新，请刷新后核对',409);const all=storage.list('issue_taxonomy_revisions'),reserved=[...new Map(all.flatMap(r=>r.categories).map(c=>[c.id,c])).values()],categories=normalizeCategories(body.categories,reserved),note=required(body.note,'修改说明',500);return storage.transaction(()=>{const r=storage.insert('issue_taxonomy_revisions',{number:Math.max(...all.map(r=>r.number))+1,parent_id:s.head_revision_id,categories,content_hash:hash(categories),note,actor});storage.setSetting('issue_taxonomy_state',{...s,head_revision_id:r.id});return clone(r);});}
 function activate(id,body){const s=state(),r=get(id),actor=required(body.actor,'发布人',100);if(body.expected_active_revision_id!==s.active_revision_id||s.head_revision_id!==id||r.confirmed_at)fail('分类版本已变化或不是最新草稿，请刷新',409);return storage.transaction(()=>{const saved=storage.update('issue_taxonomy_revisions',id,{confirmed_by:actor,confirmed_at:new Date().toISOString()});storage.setSetting('issue_taxonomy_state',{active_revision_id:id,head_revision_id:id});return clone(saved);});}
 function bootstrap(){const s=state();return {...s,revisions:clone(storage.list('issue_taxonomy_revisions')).map(r=>({...r,status:r.id===s.active_revision_id?'active':r.confirmed_at?'historical':'draft'})),active:snapshot()};}
 function nextId(){const ids=storage.list('issue_taxonomy_revisions').flatMap(r=>r.categories.map(c=>Number(c.id.slice(1))));return 'C'+String(Math.max(0,...ids)+1).padStart(2,'0');}
 return {snapshot,save,activate,bootstrap,nextId};
}
module.exports={createIssueTaxonomy,normalizeCategories,normalizeCategory,normalizeClassification,REASONS,required};
