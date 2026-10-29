/* Offline shell: serve the last good copy when there's no network. Your data syncs through Firebase. */
const CACHE="sd-shell-v20261029211503";
const SHELL=["./","index.html","shim.js","boot.js","tasks.js","manifest.webmanifest","icons/icon-192.png","icons/icon-512.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{
  const u=new URL(e.request.url);if(e.request.method!=="GET")return;
  const same=u.origin===location.origin,cdn=/gstatic\.com$|fonts\.(googleapis|gstatic)\.com$/.test(u.hostname)&&!u.pathname.includes("/channel");
  if(!same&&!cdn)return;
  e.respondWith(fetch(e.request).then(r=>{if(r.ok&&(same||cdn)){const c=r.clone();caches.open(CACHE).then(x=>x.put(e.request,c))}return r}).catch(()=>caches.match(e.request).then(r=>r||caches.match("index.html"))));
});

/* notifications sent by the Steady Days server (morning nudge, task reminders) */
self.addEventListener("push",e=>{let d={};try{const j=e.data.json();d=j.data||j.notification||j}catch(_){d={title:"Steady Days",body:e.data?e.data.text():""}}
  e.waitUntil(self.registration.showNotification(d.title||"Steady Days",{body:d.body||"",icon:"icons/icon-192.png",badge:"icons/icon-192.png",tag:d.tag||"steady-days",data:{url:d.url||"./"}}))});
self.addEventListener("notificationclick",e=>{e.notification.close();const url=(e.notification.data&&e.notification.data.url)||"./";
  e.waitUntil(clients.matchAll({type:"window",includeUncontrolled:true}).then(cs=>{for(const c of cs){if("focus" in c)return c.focus()}return clients.openWindow(url)}))});
