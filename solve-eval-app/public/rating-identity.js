'use strict';
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.RatingIdentity=factory();})(globalThis,function(){
 const ordered=x=>x&&typeof x==='object'?(Array.isArray(x)?x.map(ordered):Object.fromEntries(Object.keys(x).sort().filter(k=>x[k]!==undefined).map(k=>[k,ordered(x[k])]))):x;
 const canonical=x=>JSON.stringify(ordered(x));
 function matches(rating,route){return !!rating&&!!route&&(rating.route_id===route.id||route.status==='ready'&&!!rating.record_hash&&rating.record_hash===route.record_hash&&rating.scene_id===route.scene_id&&!!rating.monitor_binding&&!!route.monitor_binding&&canonical(rating.monitor_binding)===canonical(route.monitor_binding));}
 return {matches};
});
