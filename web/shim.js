/* Steady Days app shim.
   The app code was written for Claude's artifact runtime (window.claude.use).
   Here we provide the same small surface on top of Firebase, so one codebase serves both. */
(function(){
  window.__sdStandalone=true;
  let resolveReady;const ready=new Promise(r=>{resolveReady=r});
  window.__sdReady=v=>resolveReady(v);
  const downloads={save:async({filename,data})=>{
    const blob=data instanceof Blob?data:new Blob([data]);const url=URL.createObjectURL(blob);
    const a=document.createElement("a");a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),10000);return {status:"saved"};
  }};
  window.claude={use:async name=>{
    if(name==="downloads")return downloads;
    if(name==="db"||name==="user"||name==="mcp"){const r=await ready;return r[name]}
    return null; /* sample (Claude) etc. are not available outside Claude yet */
  }};
})();
