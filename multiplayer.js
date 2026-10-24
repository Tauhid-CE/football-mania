/* Football Mania - multiplayer (host / join, waiting lobby, match networking).
 * Loaded after the game script and the shell script in index.html. Uses the game's globals
 * (P, all, bl, pl, own, st, sc, clock, setSquad, kickoff, beginMP ...) and localnet.js (LocalNet).
 *
 * Star network: ONE host phone <-> up to 7 client phones.
 *   host   = referee: ball, goals, tackles, clock, score, bots, goalkeepers. Also plays its own player.
 *   client = moves its own player instantly, sends state ~30x/s, renders everything else from host snapshots (~20x/s).
 *
 * Tunables are at the top. */
(function () {
'use strict';
var $ = function (id) { return document.getElementById(id); };
var LN = window.LocalNet;
var now = function () { return performance.now(); };
var r1 = function (v) { return Math.round(v * 10) / 10; };
var r2 = function (v) { return Math.round(v * 100) / 100; };

var MAXTEAM = 4;       // max HUMANS per team (8 total).  Change here if you want another limit.
var ROWS = 5;          // rows per team table
var MAXOUT = 11;       // humans + bots per team (the bot goalkeeper is extra)
var PROTO = 1;         // bump when the message format changes so old apps are refused
var SNAP_MS = 50;      // host -> clients state rate (20/s)
var IN_MS = 33;        // client -> host state rate (30/s)
var DELAY = 110;       // ms clients render other players behind real time (smooths network jitter)

var MP = window.MP = {};
var role = null;                       // 'host' | 'client' | null
var phase = 'menu';                    // menu | hj | join | wait | match | over
var myPid = -1, nextPid = 1;
var players = new Map();               // pid -> {pid, peer, name, pin, banner}
var rows = [fill(-1), fill(-1)];       // rows[team][row] = pid or -1
var bots = { on: true, n: 3 };
var cfg = null;
var peerPid = {};                      // host: peer id ('p1'..) -> pid
var handlersSet = false, joinTimer = 0;
var hostName = '';

function fill(v) { var a = []; for (var i = 0; i < ROWS; i++) a.push(v); return a; }
function clean(s) { return String(s == null ? '' : s).replace(/[<>]/g, '').slice(0, 14) || 'Player'; }
function img(s) { return typeof s === 'string' && s.indexOf('data:image/') === 0 && s.length < 90000 ? s : ''; }
function toast(s) { var e = $('toast'); e.textContent = s; e.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(function () { e.classList.remove('on'); }, 2600); }
function setStatus(t) { $('mpSt').textContent = t || ''; }

/* ------------------------------------------------------------------ sending */
function ok() { }
function sendH(o, unrel) { if (role === 'client') LN.send(o, { unreliable: !!unrel }).then(ok, ok); }
function toPeer(peer, o, unrel) { if (role === 'host' && peer) LN.sendTo(peer, o, { unreliable: !!unrel }).then(ok, ok); }
function bcast(o, exceptPeer, unrel) { if (role === 'host') LN.broadcast(o, { except: exceptPeer || '', unreliable: !!unrel }).then(ok, ok); }
MP.bcast = function (o) { bcast(o); };
MP.toPlayer = function (e, o) { var p = players.get(e.pid); if (p && p.peer) toPeer(p.peer, o); };

/* ------------------------------------------------------------------ screens */
function show(id) {
  ['mpHJ', 'mpJL', 'mpWL'].forEach(function (x) { $(x).classList.toggle('on', x === id); });
  $('mp').classList.add('on'); $('land').classList.add('h');
}
function hideAll() { $('mp').classList.remove('on'); }
function toMainLobby() { hideAll(); $('land').classList.remove('h'); phase = 'menu'; }

MP.open = function () {
  if (!LN) { toast('Multiplayer needs the Football Mania app'); return; }
  LN.ready().then(function (yes) {
    if (!yes) { toast('Multiplayer needs the Football Mania app'); return; }
    setHandlers(); phase = 'hj'; setStatus(''); show('mpHJ');
  });
};

/* ------------------------------------------------------------------ LocalNet events */
function setHandlers() {
  if (handlersSet) return; handlersSet = true;
  LN.on('status', setStatus);
  LN.on('message', onMessage);
  LN.on('peerJoined', function (e) { if (role === 'host' && phase !== 'wait') LN.kick(e.id).then(ok, ok); });
  LN.on('peerLeft', onPeerLeft);
  LN.on('disconnected', function (e) {
    if (role !== 'client') return;
    var why = e && e.reason || '';
    role = null;
    var msg = why.indexOf('rejected:full') === 0 ? 'Room is full' : why.indexOf('rejected:closed') === 0 ? 'Match already started' : 'Connection lost';
    toast(msg);
    if (phase === 'match' || phase === 'over') { var b = $('menuB'); if (b && b.onclick) b.onclick(); }
    else { MP.leaveAll(); toMainLobby(); }
  });
  LN.on('roomFound', renderRooms);
  LN.on('roomLost', renderRooms);
  LN.on('log', function () { if ($('mpLog').classList.contains('on')) refreshLog(); });
}

/* ------------------------------------------------------------------ host / join buttons */
$('mpBack0').onclick = function () { toMainLobby(); };
$('mpHost').onclick = function () {
  var pr = UI.profile(); resetLobby(); role = 'host'; myPid = 0; hostName = pr.name;
  players.set(0, { pid: 0, peer: '', name: pr.name, pin: pr.pin, banner: pr.banner });
  rows[0][0] = 0;
  setStatus('Opening room...');
  LN.host({ name: pr.name, room: pr.name + "'s room", maxPlayers: 8, info: { v: PROTO, n: 1 } }).then(function (r) {
    phase = 'wait'; show('mpWL'); renderLobby();
    $('wlI').textContent = 'Room open \u00b7 your address ' + (r && r.best || '?');
  }, function (e) { role = null; setStatus('Could not open room: ' + (e && e.message || e)); toast('Could not open room'); });
};
$('mpJoin').onclick = function () {
  phase = 'join'; show('mpJL'); renderRooms(true);
  LN.discover().then(ok, function (e) { setStatus('Cannot search: ' + (e && e.message || e)); });
};
$('mpScan').onclick = function () { LN.scanNow().then(ok, ok); LN.discover().then(ok, ok); renderRooms(true); };
$('mpBack1').onclick = function () { LN.stopDiscover().then(ok, ok); phase = 'hj'; show('mpHJ'); };
$('mpIPgo').onclick = function () { var v = $('mpIP').value.trim(); if (v) joinAddr(v, 50501); };

var roomSig = '';
function renderRooms(force) {
  var box = $('mpRooms'); if (!box || phase !== 'join') return;
  var list = LN.listRooms(), sig = list.map(function (r) { return r.id + ':' + r.n + ':' + r.open + ':' + r.name; }).join('|');
  if (force !== true && sig === roomSig) return;       // same list: leave the DOM alone so taps are not lost
  roomSig = sig; box.innerHTML = '';
  if (!list.length) { var d = document.createElement('div'); d.className = 'rm em'; d.textContent = 'Searching... ask your friend to press Host'; box.appendChild(d); return; }
  list.forEach(function (r) {
    var d = document.createElement('div'), full = !r.open || (r.n >= r.max);
    d.className = 'rm' + (full ? ' no' : '');
    var b = document.createElement('b'); b.textContent = r.name || r.host || 'Room';
    var sm = document.createElement('small'); sm.textContent = full ? (r.open ? 'full' : 'in match') : (r.n + '/' + r.max);
    d.appendChild(b); d.appendChild(sm); d.onclick = function () { joinAddr(r.address, r.port); };
    box.appendChild(d);
  });
}

function joinAddr(addr, port) {
  setStatus('Joining ' + addr + '...');
  LN.stopDiscover().then(ok, ok);
  LN.join(addr, port).then(function () {
    role = 'client'; var pr = UI.profile(); myPid = -1;
    sendH({ t: 'hello', v: PROTO, name: pr.name, pin: pr.pin, banner: pr.banner });
    clearTimeout(joinTimer);
    joinTimer = setTimeout(function () { if (phase !== 'wait') { toast('Host did not answer'); LN.leave().then(ok, ok); role = null; phase = 'join'; show('mpJL'); LN.discover().then(ok, ok); } }, 6000);
  }, function (e) { toast('Could not join'); setStatus('Join failed: ' + (e && e.message || e)); });
}

/* ------------------------------------------------------------------ waiting lobby */
function resetLobby() { players.clear(); rows = [fill(-1), fill(-1)]; peerPid = {}; nextPid = 1; myPid = -1; cfg = null; }
function findRow(pid) { for (var t = 0; t < 2; t++) for (var r = 0; r < ROWS; r++) if (rows[t][r] === pid) return [t, r]; return null; }
function teamCount(t, except) { return rows[t].filter(function (x) { return x >= 0 && x !== except; }).length; }
function tryMove(pid, t, r) {
  if (t !== 0 && t !== 1) return false; if (r < 0 || r >= ROWS || rows[t][r] !== -1) return false;
  if (teamCount(t, pid) >= MAXTEAM) return false;
  var f = findRow(pid); if (f) rows[f[0]][f[1]] = -1; rows[t][r] = pid; return true;
}
function autoPlace(pid) {
  var t = teamCount(0) <= teamCount(1) ? 0 : 1;
  for (var k = 0; k < 2; k++) { var tt = (t + k) % 2; for (var r = 0; r < ROWS; r++) if (tryMove(pid, tt, r)) return true; }
  return false;
}
function plist() { var a = []; players.forEach(function (p) { a.push({ pid: p.pid, name: p.name, pin: p.pin, banner: p.banner }); }); return a; }
function lobbyMsg() { return { t: 'L', rows: rows, bots: bots }; }
function pushLobby() { bcast(lobbyMsg()); renderLobby(); if (role === 'host') LN.updateRoom({ info: { v: PROTO, n: players.size } }).then(ok, ok); }

function sizes() {
  var s = [];
  for (var t = 0; t < 2; t++) { var h = teamCount(t), b = bots.on ? Math.max(0, Math.min(bots.n, MAXOUT - h)) : 0; s.push([h, b]); }
  return s;
}
function renderLobby() {
  if (phase !== 'wait') return;
  var isHost = role === 'host', sz = sizes();
  for (var t = 0; t < 2; t++) {
    var box = $('rows' + t); box.innerHTML = '';
    $('tc' + t).textContent = teamCount(t) + '/' + MAXTEAM;
    for (var r = 0; r < ROWS; r++) (function (t, r) {
      var pid = rows[t][r], d = document.createElement('div');
      if (pid >= 0 && players.get(pid)) {
        var p = players.get(pid); d.className = 'rw' + (pid === myPid ? ' me' : '') + (pid === 0 ? ' host' : '');
        if (p.banner) d.style.backgroundImage = 'url(' + p.banner + ')';
        var av = document.createElement('i'); av.className = 'av'; if (p.pin) av.style.backgroundImage = 'url(' + p.pin + ')';
        var b = document.createElement('b'); b.textContent = p.name; d.appendChild(av); d.appendChild(b);
      } else {
        d.className = 'rw em'; d.textContent = 'tap to move here';
        d.onclick = function () { if (isHost) { if (tryMove(0, t, r)) pushLobby(); else toast('Team full'); } else sendH({ t: 'mv', team: t, row: r }); };
      }
      box.appendChild(d);
    })(t, r);
  }
  $('wlHost').style.display = isHost ? 'flex' : 'none';
  $('wlGuest').style.display = isHost ? 'none' : 'block';
  $('botOn').checked = bots.on; $('botN').textContent = bots.n;
  $('botStp').classList.toggle('off', !bots.on);
  $('wlSz').textContent = 'Blue ' + sz[0][0] + '+' + sz[0][1] + ' bots \u00b7 Red ' + sz[1][0] + '+' + sz[1][1] + ' bots (max ' + MAXOUT + ')';
  $('wlT').textContent = isHost ? 'Your room' : 'Waiting lobby';
  if (!isHost) $('wlI').textContent = 'Connected to ' + (hostName || 'host');
}
$('botOn').onchange = function () { bots.on = $('botOn').checked; pushLobby(); };
$('botMin').onclick = function () { bots.n = Math.max(0, bots.n - 1); pushLobby(); };
$('botPlus').onclick = function () { bots.n = Math.min(MAXOUT, bots.n + 1); pushLobby(); };
$('wlLeave').onclick = function () { MP.leaveAll(); toMainLobby(); };
$('mpDbg').onclick = function () { var l = $('mpLog'); l.classList.toggle('on'); if (l.classList.contains('on')) refreshLog(); };
function refreshLog() {
  var l = $('mpLog'), txt = '';
  LN.addresses().then(function (a) { txt += 'my addresses: ' + JSON.stringify(a.v4 || []) + ' ' + JSON.stringify(a.v6 || []) + ' best=' + a.best + '\n'; }, function () { })
    .then(function () { return LN.nativeLog(); }).then(function (lines) { l.textContent = txt + lines.slice(-14).join('\n'); }, function () { l.textContent = txt; });
}

/* ------------------------------------------------------------------ message router */
function onMessage(from, o) {
  if (!o || typeof o !== 'object') return;
  if (role === 'host') hostMsg(from, o); else if (role === 'client') clientMsg(o);
}

function hostMsg(peer, o) {
  var pid = peerPid[peer];
  switch (o.t) {
    case 'hello': {
      if (phase !== 'wait') { LN.kick(peer).then(ok, ok); return; }
      if (o.v !== PROTO) { toPeer(peer, { t: 'X', why: 'Different game version - update the app' }); setTimeout(function () { LN.kick(peer).then(ok, ok); }, 400); return; }
      var np = nextPid++; peerPid[peer] = np;
      var p = { pid: np, peer: peer, name: clean(o.name), pin: img(o.pin), banner: img(o.banner) };
      players.set(np, p);
      if (!autoPlace(np)) { players.delete(np); delete peerPid[peer]; toPeer(peer, { t: 'X', why: 'Room is full' }); setTimeout(function () { LN.kick(peer).then(ok, ok); }, 400); return; }
      toPeer(peer, { t: 'W', pid: np, rows: rows, bots: bots, plist: plist(), host: hostName });
      bcast({ t: 'P', pid: np, name: p.name, pin: p.pin, banner: p.banner }, peer);
      pushLobby(); break;
    }
    case 'mv': if (pid != null && phase === 'wait') { if (tryMove(pid, o.team | 0, o.row | 0)) pushLobby(); else toPeer(peer, { t: 'N', s: 'Team full' }); } break;
    case 'rdy': if (pid != null) ready.add(pid); break;
    case 'i': { var e = entOfPid(pid); if (e) { var n = e.net || (e.net = {}); n.x = +o.x; n.z = +o.z; n.vx = +o.vx; n.vz = +o.vz; n.dx = +o.dx; n.dz = +o.dz; n.f = o.f | 0; n.at = now(); n.ok = 1; } break; }
    case 'k': onClientKick(peer, pid, o); break;
    case 'bye': LN.kick(peer).then(ok, ok); break;
  }
}

function clientMsg(o) {
  switch (o.t) {
    case 'W':
      clearTimeout(joinTimer); resetLobby(); myPid = o.pid; hostName = o.host || 'host'; rows = o.rows; bots = o.bots;
      o.plist.forEach(function (p) { players.set(p.pid, p); });
      phase = 'wait'; show('mpWL'); setStatus(''); renderLobby(); break;
    case 'P': players.set(o.pid, { pid: o.pid, name: o.name, pin: o.pin, banner: o.banner }); renderLobby(); break;
    case 'L': rows = o.rows; bots = o.bots; for (var pid of Array.from(players.keys())) if (!findRow(pid) && pid !== 0) players.delete(pid); renderLobby(); break;
    case 'X': toast(o.why); LN.leave().then(ok, ok); role = null; MP.leaveAll(); toMainLobby(); break;
    case 'N': toast(o.s); break;
    case 'go': enterMatch(o.cfg); sendH({ t: 'rdy' }); break;
    case 'ko': if (phase === 'match') { koAt = now(); kickoff(); } break;
    case 's': if (phase === 'match') snaps.push(Object.assign(o, { at: now() })); if (snaps.length > 60) snaps.shift(); break;
    case 'k': if (phase === 'match') {
      var e = ENT[o.i]; if (e && e !== pl) { applyLaunch(e, o.b, o.ty, o.p, o.q); ballGrace = 0; predOwn = 0; } break; }
    case 'rv': pl.recv = 1.5; break;
    case 'm': msg(o.s, o.d); break;
    case 'g': if (phase === 'match') scoreGoal(o.g, { sc: o.sc, txt: o.txt }); break;
    case 'end': if (phase === 'match' && st !== 'over') { sc = o.sc; endGame(); } break;
    case 'bot': { var b = ENT[o.i]; if (b) { b.hum = 0; b.net = null; b.pid = -1; var k = HUMS.indexOf(b); if (k >= 0) HUMS.splice(k, 1); } break; }
    case 'drop': { var d = ENT[o.i]; if (d) dropEnt(d); break; }
    case 'back': backToLobby(); break;
  }
}

function onPeerLeft(e) {
  if (role !== 'host') return;
  var pid = peerPid[e.id]; delete peerPid[e.id]; if (pid == null) return;
  var p = players.get(pid); players.delete(pid);
  var f = findRow(pid); if (f) rows[f[0]][f[1]] = -1;
  if (phase === 'wait') { pushLobby(); return; }
  var ent = entOfPid(pid);
  if (ent) {
    ready.delete(pid);
    if (cfg && cfg.bots) { ent.hum = 0; ent.net = null; ent.pid = -1; var k = HUMS.indexOf(ent); if (k >= 0) HUMS.splice(k, 1); bcast({ t: 'bot', i: ent.id }); }
    else { dropEnt(ent); bcast({ t: 'drop', i: ent.id }); }
    msg((p ? p.name : 'A player') + ' left', 1.4);
  }
}
function entOfPid(pid) { for (var i = 0; i < HUMS.length; i++) if (HUMS[i].pid === pid) return HUMS[i]; return null; }

/* ------------------------------------------------------------------ start match */
$('wlStart').onclick = function () {
  if (role !== 'host' || phase !== 'wait') return;
  var cf = buildCfg(); if (!cf) { toast('Each team needs at least one player'); return; }
  LN.updateRoom({ open: false }).then(ok, ok);
  bcast({ t: 'go', cfg: cf });
  enterMatch(cf);
};
function buildCfg() {
  var tm = [[], []], sz = sizes();
  for (var t = 0; t < 2; t++) {
    var hum = rows[t].filter(function (x) { return x >= 0; }), n = sz[t][0] + sz[t][1];
    if (n < 1) return null;
    var slots = PRI.slice(0, n);
    slots.forEach(function (idx, k) { tm[t].push({ i: idx, p: k < hum.length ? hum[k] : -1 }); });
  }
  return { tm: tm, dur: 120, bots: bots.on };
}

var ready = new Set([0]), goAt = 0, labels = [], snaps = [], vt = 0, koAt = 0, ballGrace = 0, predOwn = 0;
var seq = 0, lastSnap = 0, lastIn = 0;

function enterMatch(cf) {
  cfg = cf; phase = 'match'; ready = new Set([0]); snaps = []; vt = 0; ballGrace = 0; predOwn = 0; seq = 0;
  MPS.on = 1; MPS.host = role === 'host' ? 1 : 0; MPS.cl = role === 'client' ? 1 : 0; MPS.dur = cf.dur; MPS.started = 0;
  setSquad([cf.tm[0].map(function (x) { return x.i; }), cf.tm[1].map(function (x) { return x.i; })]);
  MPS.me = null;
  for (var T = 0; T < 2; T++) cf.tm[T].forEach(function (en) {
    if (en.p < 0) return;
    var e = POOL[T][en.i]; e.hum = 1; e.pid = en.p; HUMS.push(e);
    if (en.p === myPid) { MPS.me = e; MPS.team = T; } else if (role === 'host') e.net = { ok: 0, at: 0 };
  });
  if (!MPS.me) { toast('Could not start (no player)'); MP.leaveAll(); toMainLobby(); return; }
  makeLabels();
  $('mpTeam').textContent = 'You: ' + MPS.names[MPS.team];
  $('mpTeam').style.color = MPS.team ? '#ff6b9d' : '#35c8ff';
  hideAll(); beginMP();
  $('again').style.display = role === 'host' ? '' : 'none'; $('again').textContent = 'Lobby';
  goAt = now();
}

/* ------------------------------------------------------------------ labels above teammates */
function makeLabels() {
  hideLabels(true);
  HUMS.forEach(function (e) {
    var p = players.get(e.pid); var c = document.createElement('canvas'); c.width = 256; c.height = 64;
    var x = c.getContext('2d'); x.font = '400 34px Anton,Impact,sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.lineWidth = 7; x.strokeStyle = 'rgba(0,0,0,.85)'; x.strokeText(p ? p.name : 'Player', 128, 34); x.fillStyle = '#fff'; x.fillText(p ? p.name : 'Player', 128, 34);
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthTest: false, depthWrite: false }));
    sp.scale.set(3.6, .9, 1); sp.renderOrder = 10; sp.visible = false; S.add(sp); labels.push({ e: e, sp: sp });
  });
}
function hideLabels(remove) { labels.forEach(function (l) { l.sp.visible = false; if (remove) { S.remove(l.sp); l.sp.material.map.dispose(); l.sp.material.dispose(); } }); if (remove) labels = []; }
MP.hideLabels = function () { hideLabels(true); $('mpTeam').textContent = ''; };
function updLabels() {
  labels.forEach(function (l) { var e = l.e, v = e.hum && e.team === MPS.team && e !== pl && e.g.visible; l.sp.visible = !!v; if (v) l.sp.position.set(e.x, 2.75, e.z); });
}

/* ------------------------------------------------------------------ in-match hooks called by the game ------ */
MP.onKick = function (e, ty, p, q) {
  var b = [r2(bl.x), r2(bl.y), r2(bl.z), r2(bl.vx), r2(bl.vy), r2(bl.vz), r2(bl.bend)];
  var ev = { t: 'k', i: e.id, b: b, ty: ty, p: r2(p || 0), q: q ? q.id : -1 };
  if (role === 'host') { bcast(ev); if (q && q.net) MP.toPlayer(q, { t: 'rv' }); }
  else if (role === 'client' && e === pl) { sendH(ev); ballGrace = now() + 400; predOwn = 0; }
};
MP.onGoal = function (g, txt) { bcast({ t: 'g', g: g, sc: sc.slice(), txt: txt }); };
MP.onKickoff = function () { bcast({ t: 'ko' }); };
MP.onEnd = function () {
  phase = 'over';
  if (role === 'host') bcast({ t: 'end', sc: sc.slice() });
  $('again').style.display = role === 'host' ? '' : 'none';
  $('es').textContent += role === 'host' ? '' : '  \u00b7  waiting for host';
};

function onClientKick(peer, pid, ev) {
  var e = ENT[ev.i]; if (!e || e.pid !== pid || !e.hum || phase !== 'match' || st !== 'play') return;
  var d = Math.hypot(bl.x - e.x, bl.z - e.z);
  if (!(own === e || (!own && d < 3.2 && bl.y < 2.4) || (own && own.team !== e.team && d < 3.2))) return;   // stale prediction: ignore
  if (!Array.isArray(ev.b) || ev.b.length !== 7) return;
  applyLaunch(e, ev.b, ev.ty, ev.p, ev.q);
  bcast(ev, peer);
  var q = ENT[ev.q]; if (q && q.net) MP.toPlayer(q, { t: 'rv' });
}

/* ------------------------------------------------------------------ per-frame: before update() */
MP.pre = function (dt) {
  if (role === 'host') hostPre(dt); else if (role === 'client') clientPre(dt);
};
function hostPre(dt) {
  var t0 = now();
  if (!MPS.started) {
    var all_ = true; HUMS.forEach(function (h) { if (!ready.has(h.pid)) all_ = false; });
    if (all_ || t0 - goAt > 6000) { MPS.started = 1; kickoff(); }
  }
  HUMS.forEach(function (e) {
    var n = e.net; if (e === pl || !n || !n.ok) return;
    var age = Math.min(.25, (t0 - n.at) / 1000);
    e.x = cl(n.x + n.vx * age, -W - 1, W + 1); e.z = cl(n.z + n.vz * age, -L - 1, L + 1); e.vx = n.vx; e.vz = n.vz;
    var l = Math.hypot(n.dx, n.dz) || 1; e.dx = n.dx / l; e.dz = n.dz / l;
    var f = n.f; e.sl = (f & 2) ? .3 : 0; e.rspr = (f & 64) ? 1 : 0; e.inv = (f & 128) ? Math.max(e.inv, .3) : Math.min(e.inv, 0);
  });
}
function clientPre(dt) {
  if (!snaps.length) return;
  var n = now(), last = snaps[snaps.length - 1];
  if (!vt) vt = last.at - DELAY;
  var rate = ts < .95 ? ts : (n - vt > DELAY + 40 ? 1.25 : 1);
  vt += dt * 1000 * rate; if (vt > n - DELAY) vt = n - DELAY; if (n - vt > 2500) vt = n - DELAY;
  while (snaps.length > 2 && snaps[1].at <= vt) snaps.shift();
  var A = snaps[0], B = snaps.length > 1 ? snaps[1] : null, u = 0, age = 0;
  if (B && vt >= A.at && B.at > A.at) u = Math.min(1, (vt - A.at) / (B.at - A.at)); else { B = null; age = Math.min(.25, Math.max(0, (vt - A.at) / 1000)); }
  /* other entities */
  for (var k = 0; k < all.length; k++) {
    var e = all[k], a = A.e[k], b = B ? B.e[k] : null; if (!a) continue;
    if (e === pl) { if ((a[6] & 1) && pl.st <= 0) pl.st = .3; continue; }
    var x, z, vx, vz, dx, dz;
    if (b) { x = a[0] + (b[0] - a[0]) * u; z = a[1] + (b[1] - a[1]) * u; vx = a[2] + (b[2] - a[2]) * u; vz = a[3] + (b[3] - a[3]) * u; dx = a[4] + (b[4] - a[4]) * u; dz = a[5] + (b[5] - a[5]) * u; }
    else { x = a[0] + a[2] * age; z = a[1] + a[3] * age; vx = a[2]; vz = a[3]; dx = a[4]; dz = a[5]; }
    e.x = x; e.z = z; e.vx = vx; e.vz = vz; var l = Math.hypot(dx, dz) || 1; e.dx = dx / l; e.dz = dz / l;
    var f = (b && u > .5 ? b : a)[6]; e.st = (f & 1) ? .5 : 0; e.sl = (f & 2) ? .3 : 0; e.str = (f & 4) ? .3 : 0;
    if (e.kp) { var dv = (b && u > .5 ? b : a)[7]; e.dv = Math.abs(dv) / 100; if (dv) e.dd = dv < 0 ? -1 : 1; }
  }
  /* match meta from the newest snapshot */
  sc = last.s.slice();
  if (Math.abs(clock - last.c) > .6) clock = last.c;
  var ss = ['cd', 'play', 'goal', 'over'][last.q];
  if (ss === 'play' && (st === 'goal' || st === 'cd') && now() - koAt > 700) { koAt = now(); kickoff(); }
  else if (ss === 'goal' && st === 'play') { st = 'goal'; goalT = 3.6; gAge = 0; }
  else if (ss === 'over' && st !== 'over') endGame();
  /* possession */
  var oid = A.o;
  if (ballGrace && n < ballGrace && oid === pl.id) oid = -1;      // stale snapshot from before my own kick
  if (predOwn > n) { if (oid === pl.id) predOwn = 0; else if (oid >= 0) { predOwn = 0; own = ENT[oid]; } else own = pl; }
  else { predOwn = 0; own = oid >= 0 ? ENT[oid] : null; }
  /* ball */
  if (!own) {
    if (ballGrace && n < ballGrace) stepBall(bl, dt);
    else {
      var tb = { x: A.b[0], y: A.b[1], z: A.b[2], vx: A.b[3], vy: A.b[4], vz: A.b[5], bend: A.b[6] }, rem = Math.max(0, (vt - A.at) / 1000);
      rem = Math.min(rem, .4); while (rem > 0) { var h = Math.min(1 / 60, rem); stepBall(tb, h); rem -= h; }
      var err = Math.hypot(bl.x - tb.x, bl.z - tb.z) + Math.abs(bl.y - tb.y);
      if (err > 3) Object.assign(bl, tb);
      else { var kk = Math.min(1, 10 * dt); bl.x += (tb.x - bl.x) * kk; bl.y += (tb.y - bl.y) * kk; bl.z += (tb.z - bl.z) * kk; bl.vx = tb.vx; bl.vy = tb.vy; bl.vz = tb.vz; bl.bend = tb.bend; }
    }
    /* predicted pick-up so dribbling feels instant */
    if (st === 'play' && lockE !== pl && pl.st <= 0 && bl.y < 1 && Math.hypot(bl.x - pl.x, bl.z - pl.z) < 1.0 && !(oid >= 0)) { own = pl; predOwn = n + 400; }
  }
}

/* ------------------------------------------------------------------ per-frame: after update() */
MP.post = function (dt) {
  var n = now();
  if (role === 'host') {
    if (n - lastSnap >= SNAP_MS) { lastSnap = n; bcast(makeSnap(), '', true); }
  } else if (role === 'client') {
    if (n - lastIn >= IN_MS) {
      lastIn = n; var f = 0; if (spr) f |= 64; if (pl.sl > 0) f |= 2; if (pl.dg > 0) f |= 8; if (pl.bt > 0) f |= 16; if (pl.inv > 0) f |= 128;
      sendH({ t: 'i', x: r2(pl.x), z: r2(pl.z), vx: r1(pl.vx), vz: r1(pl.vz), dx: r2(pl.dx), dz: r2(pl.dz), f: f }, true);
    }
  }
  updLabels();
};
function makeSnap() {
  var e = [];
  for (var i = 0; i < all.length; i++) {
    var a = all[i], f = 0;
    if (a.st > 0) f |= 1; if (a.sl > 0) f |= 2; if (a.str > 0) f |= 4; if (a.dg > 0) f |= 8; if (a.bt > 0) f |= 16; if (a.recv > 0) f |= 32;
    if (a.rspr || (a === pl && spr)) f |= 64; if (a.inv > 0) f |= 128;
    e.push([r2(a.x), r2(a.z), r1(a.vx), r1(a.vz), r2(a.dx), r2(a.dz), f, a.kp ? Math.round(a.dv * 100) * (a.dd < 0 ? -1 : 1) : 0]);
  }
  return { t: 's', k: ++seq, c: r1(clock), q: { cd: 0, play: 1, goal: 2, over: 3 }[st] || 0, s: sc, o: own ? own.id : -1,
    b: [r2(bl.x), r2(bl.y), r2(bl.z), r1(bl.vx), r1(bl.vy), r1(bl.vz), r2(bl.bend)], e: e };
}

/* ------------------------------------------------------------------ after the match / leaving */
MP.again = function () { if (role === 'host') { bcast({ t: 'back' }); backToLobby(); } };
function backToLobby() {
  if (document.pointerLockElement) document.exitPointerLock();
  fire = 0; shotEnd(); ['hud', 'ui', 'gear', 'mute', 'hint', 'set'].forEach(function (i) { $(i).style.display = 'none'; });
  document.body.classList.remove('cin', 'fire'); $('end').classList.add('h'); $('again').style.display = ''; $('again').textContent = 'Play again';
  MPS.on = MPS.host = MPS.cl = 0; MPS.started = 0; setSquad(SOLO); hideLabels(true); $('mpTeam').textContent = ''; $('bW').style.display = '';
  st = 'land'; own = null; phase = 'wait'; ready = new Set([0]); snaps = [];
  if (role === 'host') LN.updateRoom({ open: true }).then(ok, ok);
  show('mpWL'); renderLobby();
}
MP.leaveAll = function () {
  clearTimeout(joinTimer);
  if (role === 'client') sendH({ t: 'bye' });
  if (role) { var r = role; role = null; setTimeout(function () { LN.stopAll().then(ok, ok); }, r === 'client' ? 80 : 0); }
  else if (LN && LN.available) LN.stopDiscover().then(ok, ok);
  MPS.on = MPS.host = MPS.cl = 0; MPS.started = 0; setSquad(SOLO); hideLabels(true); $('mpTeam').textContent = '';
  $('bW').style.display = ''; $('again').style.display = ''; $('again').textContent = 'Play again';
  phase = 'menu'; resetLobby(); hideAll(); $('mpLog').classList.remove('on');
};
})();
