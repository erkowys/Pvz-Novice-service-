const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST');
  next();
});

// Servir le jeu
app.get('/', (req, res) => {
  for (const f of ['pvz-novice.html','pvz-novice (1).html','index.html']) {
    if (fs.existsSync(path.join(__dirname, f))) return res.sendFile(path.join(__dirname, f));
  }
  res.send('<h1>PvZ Novice Server</h1>');
});
app.get('/pvz-novice.html', (req, res) => {
  for (const f of ['pvz-novice.html','pvz-novice (1).html']) {
    if (fs.existsSync(path.join(__dirname, f))) return res.sendFile(path.join(__dirname, f));
  }
  res.status(404).send('Not found');
});

const DB_FILE = path.join(__dirname, 'db.json');
function loadDB() { try { return JSON.parse(fs.readFileSync(DB_FILE,'utf8')); } catch(e) { return {users:{},messages:[],friendRequests:[]}; } }
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db,null,2)); }
function hash(str) { return crypto.createHash('sha256').update(str).digest('hex'); }

function initDB() {
  var db = loadDB();
  if (!db.users['erkowys']) {
    db.users['erkowys'] = { displayName:'erkowys', passHash:hash('Dandana26'), isAdmin:true,
      level:1, wins:0, avatar:{type:'plant',id:'sunflower'}, friends:[], createdAt:Date.now() };
    saveDB(db); console.log('✅ Admin erkowys créé');
  }
}

const onlineUsers = new Map();
// spectateRelations: {spectator: target}
const spectateRelations = new Map();

function broadcast(data, excludeUser) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => { if (ws.readyState===WebSocket.OPEN && ws.pvzUser!==excludeUser) ws.send(msg); });
}
function sendTo(username, data) {
  const info = onlineUsers.get(username);
  if (info && info.ws.readyState===WebSocket.OPEN) info.ws.send(JSON.stringify(data));
}
function getOnlineList() {
  const list = [];
  onlineUsers.forEach((info,username) => list.push({username, displayName:info.displayName, status:info.status, isAdmin:info.isAdmin, gameInfo:info.gameInfo||null}));
  return list;
}
function notifyAdmins(data) {
  const db = loadDB();
  onlineUsers.forEach((info,username) => {
    if ((db.users[username]||{}).isAdmin && info.ws.readyState===WebSocket.OPEN)
      info.ws.send(JSON.stringify(data));
  });
}

wss.on('connection', (ws) => {
  ws.pvzUser = null;

  ws.on('message', (raw) => {
    let data; try { data = JSON.parse(raw); } catch(e) { return; }
    const { type, payload } = data;

    // ── AUTH ──
    if (type === 'AUTH') {
      const db = loadDB();
      const key = (payload.username||'').toLowerCase();
      const user = db.users[key];
      if (!user || user.passHash !== hash(payload.password)) {
        ws.send(JSON.stringify({type:'AUTH_FAIL',payload:{message:'Identifiants incorrects'}})); return;
      }
      ws.pvzUser = key;
      onlineUsers.set(key, {ws, displayName:user.displayName, status:'menu', isAdmin:user.isAdmin||false, gameInfo:null});
      ws.send(JSON.stringify({type:'AUTH_OK',payload:{username:key,displayName:user.displayName,
        isAdmin:user.isAdmin||false,level:user.level||1,wins:user.wins||0,friends:user.friends||[],avatar:user.avatar}}));
      broadcast({type:'FRIEND_ONLINE',payload:{username:key,displayName:user.displayName}},key);
      ws.send(JSON.stringify({type:'ONLINE_LIST',payload:getOnlineList()}));
      const db2 = loadDB();
      ws.send(JSON.stringify({type:'CHAT_HISTORY',payload:db2.messages.slice(-50)}));
      (db2.friendRequests||[]).filter(r=>r.to===key).forEach(req=>ws.send(JSON.stringify({type:'FRIEND_REQUEST',payload:req})));
      console.log('🟢', key);
    }

    // ── CHAT GLOBAL ──
    if (type==='CHAT_MSG' && ws.pvzUser) {
      const db = loadDB();
      const info = onlineUsers.get(ws.pvzUser)||{};
      const msg = {id:Date.now(),from:ws.pvzUser,displayName:info.displayName||ws.pvzUser,
        text:String(payload.text||'').trim().slice(0,200),time:Date.now(),isAdmin:(db.users[ws.pvzUser]||{}).isAdmin||false};
      if (!msg.text) return;
      db.messages.push(msg);
      if (db.messages.length>500) db.messages=db.messages.slice(-500);
      saveDB(db);
      broadcast({type:'CHAT_MSG',payload:msg});
    }

    // ── DM (message privé) ──
    if (type==='DM_MSG' && ws.pvzUser) {
      const target = (payload.to||'').toLowerCase();
      const info = onlineUsers.get(ws.pvzUser)||{};
      const msg = {from:ws.pvzUser,fromDisplay:info.displayName||ws.pvzUser,text:String(payload.text||'').trim().slice(0,200),time:Date.now()};
      if (!msg.text) return;
      sendTo(target, {type:'DM_MSG',payload:msg});
    }

    // ── FRIEND REQUEST ──
    if (type==='FRIEND_REQUEST' && ws.pvzUser) {
      const target=(payload.to||'').toLowerCase();
      const db=loadDB();
      if(!db.users[target]){ws.send(JSON.stringify({type:'ERROR',payload:{message:'Joueur introuvable'}}));return;}
      if(target===ws.pvzUser) return;
      if((db.users[ws.pvzUser].friends||[]).includes(target)){ws.send(JSON.stringify({type:'ERROR',payload:{message:'Déjà ami'}}));return;}
      db.friendRequests=db.friendRequests||[];
      if(!db.friendRequests.find(r=>r.from===ws.pvzUser&&r.to===target)){
        const info=onlineUsers.get(ws.pvzUser)||{};
        const req={from:ws.pvzUser,fromDisplay:info.displayName||ws.pvzUser,to:target,time:Date.now()};
        db.friendRequests.push(req); saveDB(db);
        sendTo(target,{type:'FRIEND_REQUEST',payload:req});
        ws.send(JSON.stringify({type:'INFO',payload:{message:'Demande envoyée !'}}));
      }
    }

    // ── FRIEND RESPONSE ──
    if (type==='FRIEND_RESPONSE' && ws.pvzUser) {
      const db=loadDB();
      const idx=(db.friendRequests||[]).findIndex(r=>r.from===payload.from&&r.to===ws.pvzUser);
      if(idx===-1) return;
      db.friendRequests.splice(idx,1);
      if(payload.accept){
        db.users[ws.pvzUser].friends=db.users[ws.pvzUser].friends||[];
        db.users[payload.from].friends=db.users[payload.from].friends||[];
        if(!db.users[ws.pvzUser].friends.includes(payload.from)) db.users[ws.pvzUser].friends.push(payload.from);
        if(!db.users[payload.from].friends.includes(ws.pvzUser)) db.users[payload.from].friends.push(ws.pvzUser);
        saveDB(db);
        ws.send(JSON.stringify({type:'FRIEND_ADDED',payload:{username:payload.from}}));
        sendTo(payload.from,{type:'FRIEND_ADDED',payload:{username:ws.pvzUser}});
      } else { saveDB(db); }
    }

    // ── STATUS UPDATE ──
    if (type==='STATUS_UPDATE' && ws.pvzUser) {
      const info=onlineUsers.get(ws.pvzUser);
      if(info){ info.status=payload.status||'menu'; info.gameInfo=payload.gameInfo||null; }
      notifyAdmins({type:'ONLINE_LIST',payload:getOnlineList()});
      // Envoyer données aux spectateurs
      if (payload.gameState) {
        spectateRelations.forEach((target, spectator) => {
          if (target===ws.pvzUser) sendTo(spectator, {type:'SPECTATE_DATA',payload:payload.gameState});
        });
      }
    }

    // ── SPECTATE ──
    if (type==='SPECTATE_LIST' && ws.pvzUser) {
      ws.send(JSON.stringify({type:'SPECTATE_LIST',payload:getOnlineList()}));
    }
    if (type==='SPECTATE_JOIN' && ws.pvzUser) {
      sendTo(payload.target, {type:'SPECTATE_REQUEST',payload:{from:ws.pvzUser,fromDisplay:(onlineUsers.get(ws.pvzUser)||{}).displayName||ws.pvzUser}});
    }
    if (type==='SPECTATE_ACCEPT' && ws.pvzUser) {
      spectateRelations.set(payload.to, ws.pvzUser);
      sendTo(payload.to, {type:'INFO',payload:{message:'Spectate accepté ! Vous observez '+ws.pvzUser}});
    }
    if (type==='SPECTATE_STOP' && ws.pvzUser) {
      spectateRelations.forEach((target,spectator)=>{
        if(spectator===ws.pvzUser){
          sendTo(target,{type:'SPECTATE_STOPPED',payload:{username:ws.pvzUser}});
          spectateRelations.delete(spectator);
        } else if(target===ws.pvzUser){
          sendTo(spectator,{type:'SPECTATE_STOPPED',payload:{username:ws.pvzUser}});
          spectateRelations.delete(spectator);
        }
      });
    }

    // ── GIVE ADMIN ──
    if (type==='GIVE_ADMIN' && ws.pvzUser) {
      const db=loadDB();
      if(!(db.users[ws.pvzUser]||{}).isAdmin){ws.send(JSON.stringify({type:'ERROR',payload:{message:'Accès refusé'}}));return;}
      const target=(payload.to||'').toLowerCase();
      if(!db.users[target]) return;
      db.users[target].isAdmin=true; saveDB(db);
      sendTo(target,{type:'ADMIN_GRANTED',payload:{from:ws.pvzUser}});
      ws.send(JSON.stringify({type:'INFO',payload:{message:'Admin donné à '+target}}));
      console.log('👑 Admin donné à', target, 'par', ws.pvzUser);
    }

    // ── ADMIN GET ONLINE ──
    if (type==='ADMIN_GET_ONLINE' && ws.pvzUser) {
      const db=loadDB();
      if(!(db.users[ws.pvzUser]||{}).isAdmin) return;
      ws.send(JSON.stringify({type:'ONLINE_LIST',payload:getOnlineList()}));
    }

    if (type==='PING') ws.send(JSON.stringify({type:'PONG'}));
  });

  ws.on('close', () => {
    if (ws.pvzUser) {
      onlineUsers.delete(ws.pvzUser);
      spectateRelations.forEach((target,spectator)=>{ if(spectator===ws.pvzUser||target===ws.pvzUser) spectateRelations.delete(spectator); });
      broadcast({type:'FRIEND_OFFLINE',payload:{username:ws.pvzUser}});
      console.log('🔴', ws.pvzUser);
    }
  });
});

// ── API REST ──
app.post('/api/register', (req,res) => {
  const {username,password,displayName}=req.body;
  if(!username||!password||username.length<3||password.length<4) return res.json({ok:false,message:'Données invalides'});
  if(!/^[a-zA-Z0-9_]+$/.test(username)) return res.json({ok:false,message:'Pseudo invalide'});
  const db=loadDB(); const key=username.toLowerCase();
  if(db.users[key]) return res.json({ok:false,message:'Pseudo déjà pris'});
  const isAdmin=(key==='erkowys'&&password==='Dandana26');
  db.users[key]={displayName:displayName||username,passHash:hash(password),isAdmin,level:1,wins:0,avatar:{type:'plant',id:'sunflower'},friends:[],createdAt:Date.now()};
  saveDB(db); res.json({ok:true,username:key,displayName:db.users[key].displayName,isAdmin});
});

app.post('/api/login', (req,res) => {
  const db=loadDB(); const key=(req.body.username||'').toLowerCase(); const user=db.users[key];
  if(!user||user.passHash!==hash(req.body.password)) return res.json({ok:false,message:'Identifiants incorrects'});
  res.json({ok:true,username:key,displayName:user.displayName,isAdmin:user.isAdmin||false,
    level:user.level||1,wins:user.wins||0,friends:user.friends||[],avatar:user.avatar});
});

app.post('/api/save', (req,res) => {
  const db=loadDB(); const key=(req.body.username||'').toLowerCase();
  if(!db.users[key]||db.users[key].passHash!==hash(req.body.password)) return res.json({ok:false,message:'Non autorisé'});
  const d=req.body.data||{};
  ['wins','level','unlockedLevels','unlockedPlants','avatar'].forEach(k=>{ if(d[k]!==undefined) db.users[key][k]=d[k]; });
  saveDB(db); res.json({ok:true});
});

app.post('/api/admin/users', (req,res) => {
  const db=loadDB(); const key=(req.body.username||'').toLowerCase();
  if(!db.users[key]||db.users[key].passHash!==hash(req.body.password)||!db.users[key].isAdmin) return res.json({ok:false,message:'Accès refusé'});
  const users=Object.entries(db.users).map(([k,v])=>({username:k,displayName:v.displayName,level:v.level,isAdmin:v.isAdmin,online:onlineUsers.has(k)}));
  res.json({ok:true,users});
});

const PORT = process.env.PORT||3000;
server.listen(PORT, ()=>{ initDB(); console.log('🌿 PvZ Server on port',PORT); });
