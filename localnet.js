/* localnet.js - Football Mania
 * Thin JavaScript wrapper around the native Capacitor plugin "LocalNet" (Java).
 * Put this file in the GitHub repo next to index.html and load it with:
 *     <script src="localnet.js"></script>
 * Everything is JSON in/out. On a normal desktop browser (no app) LocalNet.ready() resolves false
 * and every call rejects with a readable message, so Solo mode never breaks.
 *
 * Roles (star network):  one HOST phone  <-->  up to 7 CLIENT phones.
 *   Host   : LocalNet.host({...})  -> clients appear as events 'peerJoined' {id}; use sendTo / broadcast.
 *   Client : LocalNet.discover() -> 'roomFound' events -> LocalNet.join(address) -> send(obj).
 *
 * Events (LocalNet.on(name, fn)):
 *   message      fn(from, obj)         'host' on clients, 'p1'..'p7' on the host
 *   peerJoined   fn({id,address,count})        host only
 *   peerLeft     fn({id,reason,count})         host only
 *   disconnected fn({reason})                  client only ("rejected:full", "timeout", "closed", ...)
 *   roomFound    fn(room)  room = {id,name,host,n,max,open,address,port,info}
 *   roomLost     fn({id})
 *   status       fn(text)   short human sentence, show it on screen
 *   log          fn(line)   native debug line
 */
(function (global) {
  'use strict';

  var P = null;                    // native plugin proxy
  var handlers = {};
  var readyPromise = null;
  var logs = [];
  var rooms = {};                  // id -> room (kept up to date by events)

  function native() {
    var C = global.Capacitor;
    return (C && C.Plugins && C.Plugins.LocalNet) || null;
  }

  function on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); return function () { off(name, fn); }; }
  function off(name, fn) { handlers[name] = (handlers[name] || []).filter(function (f) { return f !== fn; }); }
  function emit(name) {
    var args = Array.prototype.slice.call(arguments, 1);
    (handlers[name] || []).slice().forEach(function (f) { try { f.apply(null, args); } catch (e) { console.error(e); } });
  }
  function status(text) { emit('status', text); }

  function need() {
    if (!P) return Promise.reject(new Error('Multiplayer needs the Football Mania app (native network plugin not found).'));
    return Promise.resolve();
  }
  function call(method, opts) {
    return need().then(function () { return P[method](opts || {}); });
  }

  /* Resolves true when the native plugin is there (waits up to 3 s for the app bridge to appear). */
  function ready() {
    if (readyPromise) return readyPromise;
    readyPromise = new Promise(function (resolve) {
      var t0 = Date.now();
      (function poll() {
        var p = native();
        if (p) {
          P = p;
          try {
            P.addListener('messages', function (e) {
              (e.list || []).forEach(function (m) {
                var obj; try { obj = JSON.parse(m.data); } catch (_) { obj = m.data; }
                emit('message', m.from, obj);
              });
            });
            P.addListener('peerJoined', function (e) { emit('peerJoined', e); });
            P.addListener('peerLeft', function (e) { emit('peerLeft', e); });
            P.addListener('disconnected', function (e) { emit('disconnected', e); });
            P.addListener('roomFound', function (r) { rooms[r.id] = r; emit('roomFound', r); });
            P.addListener('roomLost', function (r) { delete rooms[r.id]; emit('roomLost', r); });
            P.addListener('log', function (e) { logs.push(e.line); if (logs.length > 80) logs.shift(); emit('log', e.line); });
          } catch (err) { console.error('LocalNet listeners failed', err); }
          return resolve(true);
        }
        if (Date.now() - t0 > 3000) { return resolve(false); }
        setTimeout(poll, 50);
      })();
    });
    return readyPromise;
  }

  /* ---- own address ---- */
  function addresses() { return call('getLocalAddresses'); }   // {v4:[], v6:[], best:'', ifaces:[]}

  /* ---- host ---- */
  function host(opts) {
    opts = opts || {};
    status('Opening room...');
    return call('startHost', {
      name: opts.name || 'Host', room: opts.room || 'Football Mania',
      maxPlayers: opts.maxPlayers || 8, info: opts.info ? JSON.stringify(opts.info) : '', bindWifi: opts.bindWifi !== false
    }).then(function (r) {
      status(r.announcing ? 'Room open. Waiting for players.' : 'Room open, but not announcing. Players must join by IP: ' + r.best);
      return r;
    }, function (e) { status('Could not open room: ' + (e && e.message || e)); throw e; });
  }
  function updateRoom(o) {
    o = o || {};
    var p = {};
    if (o.name !== undefined) p.name = o.name;
    if (o.open !== undefined) p.open = !!o.open;
    if (o.maxPlayers !== undefined) p.maxPlayers = o.maxPlayers;
    if (o.info !== undefined) p.info = JSON.stringify(o.info);
    return call('updateRoom', p);
  }
  function stopHost() { return call('stopHost'); }

  /* ---- discovery / join ---- */
  function discover() {
    rooms = {};
    status('Looking for rooms...');
    return call('startDiscovery').catch(function (e) { status('Cannot search: ' + (e && e.message || e)); throw e; });
  }
  function stopDiscover() { return call('stopDiscovery'); }
  function scanNow() { return call('scanNow'); }
  function listRooms() { return Object.keys(rooms).map(function (k) { return rooms[k]; }); }
  function join(address, port) {
    status('Joining ' + address + '...');
    return call('join', { address: address, port: port || 50501 }).then(function (r) {
      status('Connected. Waiting for host...'); return r;
    }, function (e) { status('Join failed: ' + (e && e.message || e)); throw e; });
  }
  function leave() { return call('leave'); }

  /* ---- messages ---- */
  function enc(o) { return typeof o === 'string' ? o : JSON.stringify(o); }
  function send(o, opt) { return call('send', { data: enc(o), unreliable: !!(opt && opt.unreliable) }); }               // client -> host
  function sendTo(id, o, opt) { return call('sendTo', { id: id, data: enc(o), unreliable: !!(opt && opt.unreliable) }); } // host -> one
  function broadcast(o, opt) {                                                                                         // host -> all
    return call('broadcast', { data: enc(o), except: (opt && opt.except) || '', unreliable: !!(opt && opt.unreliable) });
  }
  function kick(id) { return call('kick', { id: id }); }
  function stopAll() { return call('stopAll'); }

  /* ---- diagnostics (for on-screen debug panel) ---- */
  function getStatus() { return call('getStatus'); }
  function nativeLog() { return call('getLog').then(function (r) { return r.lines || []; }); }

  global.LocalNet = {
    ready: ready, on: on, off: off,
    addresses: addresses, getStatus: getStatus, nativeLog: nativeLog,
    host: host, updateRoom: updateRoom, stopHost: stopHost,
    discover: discover, stopDiscover: stopDiscover, scanNow: scanNow, listRooms: listRooms,
    join: join, leave: leave,
    send: send, sendTo: sendTo, broadcast: broadcast, kick: kick, stopAll: stopAll,
    get available() { return !!P; }, get logs() { return logs.slice(); }
  };
})(window);
