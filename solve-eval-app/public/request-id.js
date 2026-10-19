(function(root){
  'use strict';
  let sequence=0;
  function newId(){
    const crypto=root.crypto;
    if(typeof crypto?.randomUUID==='function'){
      try{return crypto.randomUUID();}catch{}
    }
    // getRandomValues is also available on ordinary HTTP origins where
    // randomUUID may be absent. Do not modify the browser's Crypto object.
    if(typeof crypto?.getRandomValues==='function'){
      try{
        const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);
        bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
        const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
        return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
      }catch{}
    }
    // These are request/evidence identifiers, never authentication tokens.
    sequence++;
    return 'req-'+Date.now().toString(36)+'-'+sequence.toString(36)+'-'+Math.random().toString(36).slice(2)+'-'+Math.random().toString(36).slice(2);
  }
  const api={newId};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.AppIds=api;
})(typeof globalThis!=='undefined'?globalThis:this);
