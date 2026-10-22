'use strict';
// One provider-call budget for production ratings, trials and manual diagnoses.
function createCallLimiter(concurrency=2){
 let active=0;const queue=[];
 return async function limited(fn){if(active>=concurrency)await new Promise(resolve=>queue.push(resolve));else active++;try{return await fn();}finally{const next=queue.shift();if(next)next();else active--;}};
}
module.exports={createCallLimiter};
