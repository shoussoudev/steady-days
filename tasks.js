/* Steady Days' own task store, speaking the same small "TickTick" tool language the app already uses.
   Lists, tasks, kanban columns and progress notes live in one private Firestore doc: users/<uid>/docs/tt.
   This lets every existing screen (Top 3, rollover, tomorrow, lists, project board) work without TickTick. */
import {doc,setDoc,onSnapshot} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const pad=n=>String(n).padStart(2,"0");
const localKey=d=>d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
const isoLocal=d=>{const o=-d.getTimezoneOffset(),s=o>=0?"+":"-",a=Math.abs(o);
  return localKey(d)+"T"+pad(d.getHours())+":"+pad(d.getMinutes())+":"+pad(d.getSeconds())+s+pad(Math.floor(a/60))+pad(a%60)};
const nowIso=()=>isoLocal(new Date());
const newId=()=>Array.from(crypto.getRandomValues(new Uint8Array(12)),b=>b.toString(16).padStart(2,"0")).join("");
const dueKey=t=>t&&t.dueDate?localKey(new Date(t.dueDate)):null;
const isInbox=pid=>!pid||pid==="inbox"||/^inbox/.test(pid);
const fail=(message,code="tool_error")=>{const e=new Error(message);e.code=code;e.message=message;throw e};

/* repeating tasks: advance the due date by the RRULE instead of closing */
function nextDue(t){
  const m=/FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/.exec(t.repeatFlag||"");if(!m)return null;
  const n=+((/INTERVAL=(\d+)/.exec(t.repeatFlag)||[])[1]||1);
  const base=t.repeatFrom==="1"?new Date():new Date(t.dueDate||Date.now());const d=new Date(base);
  if(t.repeatFrom==="1")d.setHours(0,0,0,0);
  ({DAILY:()=>d.setDate(d.getDate()+n),WEEKLY:()=>d.setDate(d.getDate()+7*n),MONTHLY:()=>d.setMonth(d.getMonth()+n),YEARLY:()=>d.setFullYear(d.getFullYear()+n)})[m[1]]();
  return isoLocal(d);
}

export function makeTasks(fs,uid){
  const ref=doc(fs,"users/"+uid+"/docs","tt");
  let data={projects:[],tasks:[],columns:{},comments:[]};
  let resolveLoaded;const loaded=new Promise(r=>{resolveLoaded=r});
  /* lets the photo review tell open, finished and deleted tasks apart */
  window.__sdTaskState=id=>{const t=data.tasks.find(x=>x.id===id);return !t?"gone":(t.status===0||t.status==null)?"open":"done"};
  onSnapshot(ref,s=>{if(s.exists()){const d=s.data();data={projects:d.projects||[],tasks:d.tasks||[],columns:d.columns||{},comments:d.comments||[]}}resolveLoaded()},()=>resolveLoaded());
  const save=()=>setDoc(ref,JSON.parse(JSON.stringify({...data,kind:"tt",updated:nowIso()})));
  const task=id=>data.tasks.find(t=>t.id===id)||fail("That task wasn't found.");
  const open=t=>t.status===0||t.status==null;
  const merge=(t,patch)=>{const {id,...rest}=patch||{};
    /* undoing a repeating task's "done" puts its date back */
    if(rest.status===0&&t.status===0&&t.prevDue&&rest.dueDate==null){t.dueDate=t.prevDue;t.startDate=t.prevDue;delete t.prevDue}
    Object.assign(t,rest);if(rest.status===0)t.completedTime=null;if(rest.dueDate)delete t.prevDue;t.modifiedTime=nowIso();return t};
  const projects=()=>[{id:"inbox",name:"Inbox",kind:"TASK",viewMode:"list"},...data.projects.filter(p=>p.id!=="inbox"&&!p.closed)];

  const tools={
    list_projects:()=>({result:projects()}),
    get_project_with_undone_tasks:({project_id})=>{
      const p=project_id==="inbox"?projects()[0]:data.projects.find(x=>x.id===project_id);if(!p)fail("That list wasn't found.");
      return {project:p,tasks:data.tasks.filter(t=>open(t)&&(project_id==="inbox"?isInbox(t.projectId):t.projectId===project_id)),columns:data.columns[project_id]||[]};
    },
    list_undone_tasks_by_date:({search})=>{
      const a=localKey(new Date(search.startDate)),b=localKey(new Date(search.endDate||search.startDate));
      return {result:data.tasks.filter(t=>{const k=dueKey(t);return open(t)&&k&&k>=a&&k<=b})}},
    list_undone_tasks_by_time_query:({query_command})=>{
      const d=new Date();if(query_command==="tomorrow")d.setDate(d.getDate()+1);const k=localKey(d);
      return {result:data.tasks.filter(t=>open(t)&&dueKey(t)===k)}},
    create_task:async({task:t})=>{
      if(!t||!String(t.title||"").trim())fail("A task needs a title.");
      const pid=t.projectId&&!isInbox(t.projectId)?t.projectId:"inbox";
      const cols=data.columns[pid]||[];
      const nt={content:"",priority:0,kind:"TEXT",timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,isAllDay:!!t.dueDate,...t,
        id:newId(),projectId:pid,status:0,createdTime:nowIso(),modifiedTime:nowIso(),columnId:t.columnId||(cols[0]&&cols[0].id)||""};
      data.tasks.push(nt);await save();return nt;
    },
    complete_task:async({task_id})=>{
      const t=task(task_id);const nd=nextDue(t);
      if(nd){t.prevDue=t.dueDate;t.dueDate=nd;t.startDate=nd}else{t.status=2;t.completedTime=nowIso()}
      t.modifiedTime=nowIso();await save();return t;
    },
    update_task:async({task_id,task:patch})=>{const t=merge(task(task_id||patch.id),patch);await save();return t},
    batch_update_tasks:async({tasks})=>{(tasks||[]).forEach(p=>{const t=data.tasks.find(x=>x.id===p.id);if(t)merge(t,p)});await save();return {ok:true}},
    add_comment:async({task_id,title})=>{data.comments.push({id:newId(),taskId:task_id,title,created:nowIso()});await save();return {ok:true}},
    create_project:async({name,viewMode})=>{
      if(!String(name||"").trim())fail("A list needs a name.");
      const p={id:newId(),name:String(name).trim(),kind:"TASK",viewMode:viewMode||"list",closed:false,sortOrder:Date.now()};
      data.projects.push(p);await save();return p;
    },
    update_project:async({project_id,name,closed})=>{const p=data.projects.find(x=>x.id===project_id)||fail("That list wasn't found.");
      if(name!=null)p.name=String(name).trim()||p.name;if(closed!=null)p.closed=!!closed;await save();return p},
    list_habits:()=>({result:[]}),
    get_habit_checkins:()=>({result:[]}),
    upsert_habit_checkins:()=>({ok:true})
  };
  return {
    callTool:async(server,name,input)=>{
      await loaded;const f=tools[name];if(!f)fail("Not available in Steady Days yet: "+name,"tool_not_found");
      return {payload:await f(input||{})};
    }
  };
}
