/* Football Mania service worker: saves the game on first launch so it runs with no internet.
   Bump VERSION when you want every phone to re-download the lib/fonts files. */
const VERSION='fm-v2',CORE=['./','index.html','localnet.js','multiplayer.js','lib/three.min.js','fonts/anton-latin-400-normal.woff2','fonts/inter-latin-400-normal.woff2','fonts/inter-latin-600-normal.woff2'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(VERSION).then(c=>Promise.all(CORE.map(u=>c.add(new Request(u,{cache:'reload'})).catch(()=>{})))).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==VERSION).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
const put=(r,q)=>{if(r&&r.ok)caches.open(VERSION).then(c=>c.put(q,r.clone()))};
/* lib + fonts never change: cache first. Everything else: network first (so GitHub updates arrive), 2.5 s timeout, then the saved copy. */
function netFirst(req){return new Promise(res=>{let d=0;const fb=()=>caches.match(req,{ignoreSearch:true}).then(r=>r||(req.mode==='navigate'?caches.match('index.html'):0));
 const t=setTimeout(()=>fb().then(r=>{if(r&&!d){d=1;res(r)}}),2500);
 fetch(req).then(r=>{clearTimeout(t);put(r,req);if(!d){d=1;res(r)}}).catch(()=>{clearTimeout(t);fb().then(r=>{if(!d){d=1;res(r||Response.error())}})})})}
self.addEventListener('fetch',e=>{const q=e.request;if(q.method!=='GET'||new URL(q.url).origin!==location.origin)return;
 if(/\/(lib|fonts)\//.test(q.url))e.respondWith(caches.match(q).then(r=>r||fetch(q).then(x=>{put(x,q);return x})));else e.respondWith(netFirst(q))});
