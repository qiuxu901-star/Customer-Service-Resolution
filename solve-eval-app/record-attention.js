'use strict';
function createRecordAttention({storage}){
  const fail=(message,statusCode=400)=>{throw Object.assign(Error(message),{statusCode});};
  const getItem=id=>storage.byId('monitor_batch_items',id)||fail('工单不存在',404);
  function version(item,ratingId){
    if(ratingId!==null&&ratingId!==undefined&&ratingId!==''){
      const rating=storage.byId('monitor_ratings',ratingId);
      if(!rating||rating.item_id!==item.id)fail('评估结果不属于此工单');
      if(['pending','running'].includes(rating.status))fail('评估尚未完成，请完成后再操作',409);
      return {rating_id:rating.id,revision_key:'rating:'+rating.id};
    }
    return {rating_id:null,revision_key:'record:'+(item.current_route_id||item.record_hash||'original')};
  }
  function viewed(id,body,user){
    const item=getItem(id);if(!item.case_id)fail('导入失败的记录没有可查看的工单');
    const revision=version(item,body.rating_id),existing=storage.find('monitor_record_views',v=>v.item_id===id&&v.user_id===user.id&&v.revision_key===revision.revision_key);
    if(existing)return structuredClone(existing);
    return storage.insert('monitor_record_views',{item_id:id,user_id:user.id,...revision,viewed_at:new Date().toISOString()});
  }
  function saveMarks(id,body,user){
    const item=getItem(id);if(!item.case_id)fail('导入失败的记录不能标记');
    if(item.attention_task_id)fail('请在关联改进待办中补充分析',409);
    if(!Number.isInteger(body.base_version)||body.base_version!==(item.attention_version||0))fail('标记已被其他人更新，请重新打开后编辑',409);
    if(!Array.isArray(body.marks)||body.marks.length>2)fail('请选择有效的问题类型');
    const revision=version(item,body.rating_id),types=new Set(),previous=item.attention_marks||[];
    const text=(value,label,required=false)=>{
      if(value===undefined||value===null)value='';
      if(typeof value!=='string'||value.length>6000||required&&!value.trim())fail('请填写'+label+'（最多6000字）');
      return value.trim();
    };
    const marks=body.marks.map(mark=>{
      if(!mark||!['evaluation','ai'].includes(mark.type)||types.has(mark.type))fail('问题类型无效或重复');types.add(mark.type);
      return {type:mark.type,reason:text(mark.reason,mark.type==='evaluation'?'评估不符合的原因':'AI问题和原文位置',true),suggestion:text(mark.suggestion,mark.type==='evaluation'?'评估标准完善建议':'AI客服改进方案',mark.type==='ai'),...revision,actor:user.name,user_id:user.id,at:new Date().toISOString()};
    });
    return storage.update('monitor_batch_items',id,{
      attention_marks:marks,attention_version:(item.attention_version||0)+1,
      attention_history:[...(item.attention_history||[]),{actor:user.name,user_id:user.id,at:new Date().toISOString(),previous:structuredClone(previous),marks:structuredClone(marks),legacy_marked:item.focus_marked===true&&!previous.length}],
      focus_marked:marks.length>0,focus_marked_by:marks.length?user.name:null,focus_marked_at:marks.length?new Date().toISOString():null,
    });
  }
  function mark(id,body,user){
    const item=getItem(id);if(!item.case_id)fail('导入失败的记录不能标记');
    const revision=version(item,body.rating_id);
    const existing=storage.find('monitor_tasks',t=>t.source==='record_attention'&&t.attention_item_id===id);
    if(existing&&existing.status!=='已撤回')return {item:structuredClone(item),task:structuredClone(existing)};
    const note=readText(body.note,'初步备注'),at=new Date().toISOString();
    return storage.transaction(()=>{
      const taskData={source:'record_attention',attention_item_id:id,case_id:item.case_id,batch_id:item.batch_id,
        record_snapshot:structuredClone((revision.rating_id&&storage.byId('monitor_ratings',revision.rating_id)?.record_snapshot)||item.record_snapshot),rating_id:revision.rating_id,rating_refs:[{item_id:id,case_id:item.case_id,...revision}],title:(item.record_snapshot?.name||'工单')+' · 问题分析',
        description:note,initial_note:note,analysis_marks:[],owner:'',category:'待明确',goal:'',status:'待分析',version:existing?(existing.version||0)+1:0,analysis_note:'',withdrawn_at:null,
        history:[...(existing?.history||[]),{at,actor:user.name,user_id:user.id,action:existing?'重新标记并进入待分析':'标记并进入待分析',note}]};
      const task=existing?storage.update('monitor_tasks',existing.id,taskData):storage.insert('monitor_tasks',taskData);
      const updated=storage.update('monitor_batch_items',id,{focus_marked:true,focus_marked_by:user.name,focus_marked_at:at,attention_task_id:task.id,attention_marks:[],attention_version:(item.attention_version||0)+1});
      return {item:structuredClone(updated),task:structuredClone(task)};
    });
  }
  function readText(value,label,required=false){
    if(value===undefined||value===null)value='';
    if(typeof value!=='string'||value.length>6000||required&&!value.trim())fail('请填写'+label+'（最多6000字）');
    return value.trim();
  }
  function updateTask(id,body,user){
    const task=storage.byId('monitor_tasks',id);if(!task||task.source!=='record_attention')fail('待分析事项不存在',404);
    if(task.status==='已撤回')fail('该标记已取消，待办已撤回，请刷新页面',409);
    if(!Number.isInteger(body.base_version)||body.base_version!==(task.version||0))fail('待办已被其他人更新，请重新打开后编辑',409);
    if(!['待分析','待修改','修改中','待复验','无需改进'].includes(body.status))fail('待办状态无效');
    const confirmed=['待修改','修改中','待复验'].includes(body.status);
    if(!Array.isArray(body.marks)||body.marks.length>2||confirmed&&!body.marks.length)fail('请明确至少一种问题类型');
    const types=new Set(),at=new Date().toISOString(),revision=task.rating_refs[0];
    const marks=body.marks.map(m=>{
      if(!m||!['evaluation','ai'].includes(m.type)||types.has(m.type))fail('问题类型无效或重复');types.add(m.type);
      return {type:m.type,reason:readText(m.reason,m.type==='evaluation'?'评估不符合的原因':'AI问题和原文位置',confirmed),suggestion:readText(m.suggestion,m.type==='evaluation'?'评估标准完善建议':'AI客服改进方案',confirmed),rating_id:revision.rating_id,revision_key:revision.revision_key,actor:user.name,user_id:user.id,at};
    });
    const note=readText(body.note,'分析备注',body.status==='无需改进'),owner=readText(body.owner,'负责人',confirmed),goal=readText(body.goal,'验收目标',confirmed);
    return storage.transaction(()=>{
      const updated=storage.update('monitor_tasks',id,{analysis_marks:marks,description:marks.map(m=>m.reason).filter(Boolean).join('；')||task.initial_note||'',owner,goal,status:body.status,
        category:marks.map(m=>m.type==='evaluation'?'完善评估标准':'完善 AI 客服').join(' / ')||'待明确',analysis_note:note,version:(task.version||0)+1,
        history:[...task.history,{at,actor:user.name,user_id:user.id,action:body.status,note,marks:structuredClone(marks),owner,goal}]});
      const item=getItem(task.attention_item_id);
      const updatedItem=storage.update('monitor_batch_items',item.id,{attention_marks:marks,attention_version:(item.attention_version||0)+1});
      return {task:structuredClone(updated),item:structuredClone(updatedItem)};
    });
  }
  function cancel(id,body,user){
    const item=getItem(id),task=storage.find('monitor_tasks',t=>t.source==='record_attention'&&t.attention_item_id===id);
    if(!Number.isInteger(body.base_version)||body.base_version!==(item.attention_version||0))fail('标记已更新，请刷新后重试',409);
    if(task&&(!Number.isInteger(body.task_version)||body.task_version!==(task.version||0)))fail('待办已更新，请重新查看后撤回',409);
    if(task&&task.status!=='待分析'&&task.status!=='已撤回'&&body.confirm_withdraw!==true)fail('待办已进入'+task.status+'，请确认取消标记并撤回待办',409);
    const note=readText(body.note,'撤回说明'),at=new Date().toISOString();
    return storage.transaction(()=>{
      const updatedTask=task?storage.update('monitor_tasks',task.id,{status:'已撤回',withdrawn_at:at,version:(task.version||0)+1,
        history:[...task.history,{at,actor:user.name,user_id:user.id,action:'取消标记并撤回待办',note,previous_status:task.status,marks:structuredClone(task.analysis_marks||[]),owner:task.owner,goal:task.goal,rating_refs:structuredClone(task.rating_refs),record_snapshot:structuredClone(task.record_snapshot)}]}):null;
      const updatedItem=storage.update('monitor_batch_items',id,{focus_marked:false,focus_marked_by:null,focus_marked_at:null,attention_marks:[],attention_version:(item.attention_version||0)+1,
        attention_history:[...(item.attention_history||[]),{at,actor:user.name,user_id:user.id,action:'取消标记',marks:[],previous:structuredClone(item.attention_marks||[]),note}]});
      return {item:structuredClone(updatedItem),task:updatedTask?structuredClone(updatedTask):null};
    });
  }
  return {viewed,saveMarks,mark,updateTask,cancel,views:userId=>storage.list('monitor_record_views').filter(v=>v.user_id===userId)};
}
module.exports={createRecordAttention};
