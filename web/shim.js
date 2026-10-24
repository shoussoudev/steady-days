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
    if(name==="sample"){await ready;if(!window.__sdClaude)return null;
      const err=e=>{const c=String(e&&e.code||"");return {code:/permission-denied/.test(c)?"not_granted":/resource-exhausted/.test(c)?"rate_limited":/not-found|internal|unavailable|failed-precondition/.test(c)?"server_missing":"upstream_error",message:e&&e.message||String(e)}};
      const sample=async(input,opts)=>{const p=typeof input==="string"?input:(input||[]).map(t=>t.content).join("\n\n");try{return {text:await window.__sdClaude(p,opts&&opts.modelTier),truncated:false}}catch(e){throw err(e)}};
      sample.json=async(input,opts)=>{const {text}=await sample(input,opts);const m=String(text).match(/[\[{][\s\S]*[\]}]/);if(!m)throw {code:"invalid_json",text};try{return JSON.parse(m[0])}catch(_){throw {code:"invalid_json",text}}};
      return sample}
    return null; /* sample (Claude) etc. are not available outside Claude yet */
  }};
})();
