/* Firebase sign-in + a tiny adapter that mirrors the artifact db API the app uses:
   collection(path).doc(id).set/get/onSnapshot, collection(path).where().orderBy().limit().get/onSnapshot, doc(path).
   Paths "data/users/<uid>/..." map to Firestore "users/<uid>/docs/...". */
import {initializeApp} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {getAuth,GoogleAuthProvider,onAuthStateChanged,signInWithPopup,signInWithRedirect,getRedirectResult,signOut} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {makeTasks} from "./tasks.js";
import {initializeFirestore,persistentLocalCache,persistentMultipleTabManager,doc,collection,setDoc,getDoc,getDocs,getDocFromServer,onSnapshot,query,where,deleteField,increment} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {getMessaging,getToken,deleteToken,isSupported} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";
import {getFunctions,httpsCallable} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import {getStorage,ref as sref,uploadBytes,getDownloadURL,deleteObject} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
/* Web Push key from Firebase → Project settings → Cloud Messaging → Web Push certificates (public, safe to share) */
const VAPID_KEY="BM0n1OI8l5kaNpEHMlaYeY1y-mTfWdO-h-52aYCPzL-Il2hx4nVq7Z6xRi8qWGUdEAmPGWcxop2vnKdNOBkLPlI";

const firebaseConfig={
  apiKey:"AIzaSyD_5cBocXlhsy3495kZoSvLoj6qXo1rhU8",
  authDomain:"steady-days-6a2e7.firebaseapp.com",
  projectId:"steady-days-6a2e7",
  storageBucket:"steady-days-6a2e7.firebasestorage.app",
  messagingSenderId:"67356692919",
  appId:"1:67356692919:web:95d754b3452827a2cc1832"
};
const app=initializeApp(firebaseConfig);
const auth=getAuth(app);
let fs;
try{fs=initializeFirestore(app,{ignoreUndefinedProperties:true,localCache:persistentLocalCache({tabManager:persistentMultipleTabManager()})})}
catch(_){fs=initializeFirestore(app,{ignoreUndefinedProperties:true})}

function makeDb(uid){
  const base="users/"+uid+"/docs";
  const colPath=p=>{const m=/^data\/users\/[^/]+(\/.*)?$/.exec(p);if(!m)throw new Error("Unsupported path "+p);return m[1]?base+m[1]:base};
  const docSnap=s=>({id:s.id,exists:s.exists(),data:()=>s.data(),fromCache:!!(s.metadata&&s.metadata.fromCache)});
  const docRef=ref=>({id:ref.id,
    set:data=>setDoc(ref,JSON.parse(JSON.stringify(data))),
    get:async()=>docSnap(await getDoc(ref)),
    /* straight from the server (never a possibly-empty local cache), for safe first saves */
    getServer:async()=>docSnap(await getDocFromServer(ref)),
    onSnapshot:(next,err)=>onSnapshot(ref,s=>next(docSnap(s)),e=>err&&err(e))});
  /* where() runs on the server; orderBy/limit run here, so no composite indexes are needed */
  const makeQuery=(path,wh=[],ord=null,lim=null)=>{
    const ref=()=>wh.length?query(collection(fs,path),...wh.map(w=>where(...w))):collection(fs,path);
    const shape=s=>{let ds=s.docs.map(d=>({id:d.id,exists:true,data:()=>d.data()}));
      if(ord){const [f,dir]=ord;ds.sort((a,b)=>{const x=a.data()[f],y=b.data()[f];return (x<y?-1:x>y?1:0)*(dir==="desc"?-1:1)})}
      if(lim)ds=ds.slice(0,lim);return {docs:ds,size:ds.length,empty:!ds.length,fromCache:!!(s.metadata&&s.metadata.fromCache)}};
    return {path,
      where:(f,op,v)=>makeQuery(path,[...wh,[f,op,v]],ord,lim),
      orderBy:(f,dir="asc")=>makeQuery(path,wh,[f,dir],lim),
      limit:n=>makeQuery(path,wh,ord,n),
      doc:id=>docRef(doc(fs,path,id)),
      get:async()=>shape(await getDocs(ref())),
      onSnapshot:(next,err)=>onSnapshot(ref(),s=>next(shape(s)),e=>err&&err(e))};
  };
  return {
    collection:p=>makeQuery(colPath(p)),
    /* other shared docs (e.g. "reminder/next") live beside your entries */
    doc:p=>docRef(doc(fs,base,String(p).replace(/\//g,"__")))
  };
}

const gate=document.getElementById("sd-gate");
const showGate=(msg)=>{gate.hidden=false;gate.classList.remove("opening");const m=document.getElementById("sd-gate-msg");if(m)m.textContent=msg||""};
let started=false;
window.__sdAuth={signOut:async()=>{await signOut(auth);location.reload()}};
document.getElementById("sd-signin").addEventListener("click",async()=>{
  const p=new GoogleAuthProvider();p.setCustomParameters({prompt:"select_account"});
  try{await signInWithPopup(auth,p)}
  catch(e){
    if(e&&(e.code==="auth/popup-blocked"||e.code==="auth/operation-not-supported-in-this-environment"||e.code==="auth/cancelled-popup-request"))return signInWithRedirect(auth,p);
    if(e&&e.code==="auth/popup-closed-by-user")return;
    showGate(e&&e.code==="auth/unauthorized-domain"?"This address isn't allowed yet. Add it in Firebase → Authentication → Settings → Authorized domains.":"Sign-in didn't work: "+(e&&e.code||e));
  }
});
getRedirectResult(auth).catch(e=>showGate("Sign-in didn't work: "+(e&&e.code||e)));
onAuthStateChanged(auth,u=>{
  if(!u){showGate("");return}
  gate.hidden=true;window.__sdAuth.email=u.email;
  if(started)return;started=true;
  /* a direct server read tells us whether the database is really reachable (not just this device's copy) */
  window.__sdAuth.check=async()=>{
    try{await Promise.race([getDocFromServer(doc(fs,"users/"+u.uid+"/docs","settings")),new Promise((_,rej)=>setTimeout(()=>rej({code:"timeout",message:"No answer from the database after 12 seconds."}),12000))]);return {ok:true}}
    catch(e){return {ok:false,code:e&&e.code||"error",message:e&&e.message||String(e)}}
  };
  /* Claude, through the server (the key stays there) */
  const fns=getFunctions(app,"europe-west2");
  /* photos: users/<uid>/media/<id>.jpg, private to you (see storage.rules) */
  const st=getStorage(app);
  window.__sdMedia={
    put:async(id,blob)=>{const path=`users/${u.uid}/media/${id}.jpg`;const r=sref(st,path);await uploadBytes(r,blob,{contentType:"image/jpeg",cacheControl:"private, max-age=31536000"});return {path,url:await getDownloadURL(r)}},
    del:async path=>{try{await deleteObject(sref(st,path))}catch(e){if(e&&e.code!=="storage/object-not-found")throw e}}
  };
  /* usage log: counts only (which screens and buttons), one small doc per day, added up safely from every device */
  window.__sdUse={
    bump:async(day,counts)=>{const body={kind:"use",date:day};for(const [cat,m] of Object.entries(counts)){if(typeof m==="number"){body[cat]=increment(m);continue}body[cat]={};for(const [k,v] of Object.entries(m))body[cat][k]=increment(v)}
      await setDoc(doc(fs,"users/"+u.uid+"/docs","use-"+day),body,{merge:true})},
    read:async()=>{const s=await getDocs(query(collection(fs,"users/"+u.uid+"/docs"),where("kind","==","use")));return s.docs.map(d=>d.data())}
  };
  window.__sdStudy=async(force)=>(await httpsCallable(fns,"studyRefresh",{timeout:40000})({force:!!force})).data;
  window.__sdMangaBaka=async()=>(await httpsCallable(fns,"mangabakaSync",{timeout:130000})({})).data;
  window.__sdClaude=async(prompt,tier)=>(await httpsCallable(fns,"claude",{timeout:130000})({prompt,tier:tier||"default"})).data.text;
  /* notifications on this device */
  const devRef=doc(fs,"users/"+u.uid+"/docs","devices");
  window.__sdPush={
    supported:async()=>!VAPID_KEY.startsWith("__")&&"Notification" in window&&"serviceWorker" in navigator&&await isSupported().catch(()=>false),
    permission:()=>("Notification" in window)?Notification.permission:"unsupported",
    isOn:()=>{try{return !!localStorage.getItem("sd-push")&&Notification.permission==="granted"}catch(_){return false}},
    enable:async()=>{
      const perm=await Notification.requestPermission();if(perm!=="granted")throw {code:"denied"};
      const reg=await navigator.serviceWorker.register("sw.js");await navigator.serviceWorker.ready;
      const tok=await getToken(getMessaging(app),{vapidKey:VAPID_KEY,serviceWorkerRegistration:reg});
      await setDoc(devRef,{tokens:{[tok]:{added:new Date().toISOString(),device:navigator.userAgent.slice(0,140)}}},{merge:true});
      try{localStorage.setItem("sd-push",tok)}catch(_){}return tok;
    },
    disable:async()=>{let tok=null;try{tok=localStorage.getItem("sd-push");localStorage.removeItem("sd-push")}catch(_){}
      if(tok)await setDoc(devRef,{tokens:{[tok]:deleteField()}},{merge:true});try{await deleteToken(getMessaging(app))}catch(_){}}
  };
  window.__sdReady({db:makeDb(u.uid),mcp:makeTasks(fs,u.uid),user:{id:async()=>u.uid,isOwner:()=>true,canEdit:()=>true}});
});

if("serviceWorker" in navigator)navigator.serviceWorker.register("sw.js").catch(()=>{});
