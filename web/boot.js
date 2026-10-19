/* Firebase sign-in + a tiny adapter that mirrors the artifact db API the app uses:
   collection(path).doc(id).set/get/onSnapshot, collection(path).where().orderBy().limit().get/onSnapshot, doc(path).
   Paths "data/users/<uid>/..." map to Firestore "users/<uid>/docs/...". */
import {initializeApp} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {getAuth,GoogleAuthProvider,onAuthStateChanged,signInWithPopup,signInWithRedirect,getRedirectResult,signOut} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {initializeFirestore,persistentLocalCache,persistentMultipleTabManager,doc,collection,setDoc,getDoc,getDocs,onSnapshot,query,where} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

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
  const docSnap=s=>({id:s.id,exists:s.exists(),data:()=>s.data()});
  const docRef=ref=>({id:ref.id,
    set:data=>setDoc(ref,JSON.parse(JSON.stringify(data))),
    get:async()=>docSnap(await getDoc(ref)),
    onSnapshot:(next,err)=>onSnapshot(ref,s=>next(docSnap(s)),e=>err&&err(e))});
  /* where() runs on the server; orderBy/limit run here, so no composite indexes are needed */
  const makeQuery=(path,wh=[],ord=null,lim=null)=>{
    const ref=()=>wh.length?query(collection(fs,path),...wh.map(w=>where(...w))):collection(fs,path);
    const shape=s=>{let ds=s.docs.map(d=>({id:d.id,exists:true,data:()=>d.data()}));
      if(ord){const [f,dir]=ord;ds.sort((a,b)=>{const x=a.data()[f],y=b.data()[f];return (x<y?-1:x>y?1:0)*(dir==="desc"?-1:1)})}
      if(lim)ds=ds.slice(0,lim);return {docs:ds,size:ds.length,empty:!ds.length}};
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
const showGate=(msg)=>{gate.hidden=false;const m=document.getElementById("sd-gate-msg");if(m)m.textContent=msg||""};
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
  window.__sdReady({db:makeDb(u.uid),user:{id:async()=>u.uid,isOwner:()=>true,canEdit:()=>true}});
});

if("serviceWorker" in navigator)navigator.serviceWorker.register("sw.js").catch(()=>{});
