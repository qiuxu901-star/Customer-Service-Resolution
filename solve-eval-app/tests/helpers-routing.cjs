'use strict';
function confirmBatch(batches,id){const review=batches.routingReview(id);return batches.confirmRouting(id,{actor:'合成确认人',review_hash:review.review_hash,confirmed:true,group_keys:review.groups.map(g=>g.key)});}
module.exports={confirmBatch};
