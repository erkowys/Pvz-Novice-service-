// ═══════════════════════════════════════════════════════
//  PvZ Novice - Serveur Replit v1.0
//  Fonctionnalités : Auth, Chat temps réel, Amis, Admin
// ═══════════════════════════════════════════════════════

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
app.use(express.static('.'));

// CORS pour le jeu HTML
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  next();
});

// ── Base de données JSON ──
const DB_FILE = 'db.json';
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch(e) { return { users: {}, messages: [], friendRequests: [] }; }
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// Init DB avec admin
function initDB() {
  var db = loadDB();
  if (!db.users['erkowys']) {
    db.users['erkowys'] = {
      displayName: 'erkowys',
      passHash: hash('Dandana26'),
      isAdmin: true,
      level: 1, wins: 0,
      avatar: { type: 'plant', id: 'sunflower' },
      friends: [],
      createdAt: Date.now()
    };
    saveDB(db);
    console.log('✅ Compte admin erkowys créé');
  }
}

function hash(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

// ── Clients WebSocket connectés ──
// Map: username → { ws, status, gameInfo }
const onlineUsers = new Map();

function broadcast(data, excludeUser) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN && ws.username !== excludeUser) {
      ws.send(msg);
    }
  });
}

function sendTo(username, data) {
  const client = onlineUsers.get(username);
  if (client && client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(data));
  }
}

function getOnlineList() {
  const list = [];
  onlineUsers.forEach((info, username) => {
    list.push({
      username,
      displayName: info.displayName,
      status: info.status,
      gameInfo: info.gameInfo,
      isAdmin: info.isAdmin,
      avatar: info.avatar
    });
  });
  return list;
}

// ── WebSocket Handler ──
wss.on('connection', (ws) => {
  ws.username = null;

  ws.on('message', (rawData) => {
    let data;
    try { data = JSON.parse(rawData); } catch(e) { return; }

    const { type, payload } = data;

    // ── Authentification WS ──
    if (type === 'AUTH') {
      const db = loadDB();
      const user = db.users[payload.username?.toLowerCase()];
      if (!user || user.passHash !== hash(payload.password)) {
        ws.send(JSON.stringify({ type: 'AUTH_FAIL', payload: { message: 'Identifiants incorrects' } }));
        return;
      }
      ws.username = payload.username.toLowerCase();
      ws.displayName = user.displayName || ws.username;
      onlineUsers.set(ws.username, {
        ws, displayName: ws.displayName,
        status: 'menu', gameInfo: null,
        isAdmin: user.isAdmin || false,
        avatar: user.avatar
      });
      ws.send(JSON.stringify({ type: 'AUTH_OK', payload: {
        username: ws.username,
        displayName: user.displayName,
        isAdmin: user.isAdmin || false,
        level: user.level || 1,
        wins: user.wins || 0,
        friends: user.friends || [],
        avatar: user.avatar
      }}));
      // Notifier les amis
      broadcast({ type: 'FRIEND_ONLINE', payload: { username: ws.username, displayName: ws.displayName }}, ws.username);
      // Envoyer la liste en ligne
      ws.send(JSON.stringify({ type: 'ONLINE_LIST', payload: getOnlineList() }));
      // Envoyer les 50 derniers messages
      const db2 = loadDB();
      ws.send(JSON.stringify({ type: 'CHAT_HISTORY', payload: db2.messages.slice(-50) }));
      console.log(`🟢 ${ws.username} connecté`);
    }

    // ── Chat global ──
    if (type === 'CHAT_MSG' && ws.username) {
      const db = loadDB();
      const msg = {
        id: Date.now(),
        from: ws.username,
        displayName: ws.displayName,
        text: String(payload.text || '').slice(0, 200),
        time: Date.now(),
        isAdmin: (db.users[ws.username] || {}).isAdmin || false
      };
      if (!msg.text.trim()) return;
      db.messages.push(msg);
      if (db.messages.length > 500) db.messages = db.messages.slice(-500);
      saveDB(db);
      broadcast({ type: 'CHAT_MSG', payload: msg });
    }

    // ── Demande d'ami ──
    if (type === 'FRIEND_REQUEST' && ws.username) {
      const targetUser = payload.to?.toLowerCase();
      const db = loadDB();
      if (!db.users[targetUser]) {
        ws.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Joueur introuvable' } })); return;
      }
      if (targetUser === ws.username) return;
      // Vérifier pas déjà ami
      const myUser = db.users[ws.username];
      if ((myUser.friends || []).includes(targetUser)) {
        ws.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Déjà ami avec ce joueur' } })); return;
      }
      // Envoyer la demande
      const req = { from: ws.username, fromDisplay: ws.displayName, to: targetUser, time: Date.now() };
      db.friendRequests = db.friendRequests || [];
      // Pas de doublon
      const exists = db.friendRequests.find(r => r.from === ws.username && r.to === targetUser);
      if (!exists) {
        db.friendRequests.push(req);
        saveDB(db);
        sendTo(targetUser, { type: 'FRIEND_REQUEST', payload: req });
        ws.send(JSON.stringify({ type: 'INFO', payload: { message: `Demande envoyée à ${targetUser}` } }));
      }
    }

    // ── Réponse demande d'ami ──
    if (type === 'FRIEND_RESPONSE' && ws.username) {
      const db = loadDB();
      const reqIdx = (db.friendRequests || []).findIndex(r => r.from === payload.from && r.to === ws.username);
      if (reqIdx === -1) return;
      db.friendRequests.splice(reqIdx, 1);
      if (payload.accept) {
        db.users[ws.username].friends = db.users[ws.username].friends || [];
        db.users[payload.from].friends = db.users[payload.from].friends || [];
        if (!db.users[ws.username].friends.includes(payload.from))
          db.users[ws.username].friends.push(payload.from);
        if (!db.users[payload.from].friends.includes(ws.username))
          db.users[payload.from].friends.push(ws.username);
        saveDB(db);
        ws.send(JSON.stringify({ type: 'FRIEND_ADDED', payload: { username: payload.from } }));
        sendTo(payload.from, { type: 'FRIEND_ADDED', payload: { username: ws.username } });
      } else {
        saveDB(db);
        sendTo(payload.from, { type: 'FRIEND_DECLINED', payload: { username: ws.username } });
      }
    }

    // ── Mise à jour statut ──
    if (type === 'STATUS_UPDATE' && ws.username) {
      const info = onlineUsers.get(ws.username);
      if (info) {
        info.status = payload.status || 'menu';
        info.gameInfo = payload.gameInfo || null;
        // Notifier les admins
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN && onlineUsers.get(client.username)?.isAdmin) {
            client.send(JSON.stringify({ type: 'ONLINE_LIST', payload: getOnlineList() }));
          }
        });
      }
    }

    // ── Admin : demande liste en ligne ──
    if (type === 'ADMIN_GET_ONLINE' && ws.username) {
      const db = loadDB();
      if (!(db.users[ws.username] || {}).isAdmin) return;
      ws.send(JSON.stringify({ type: 'ONLINE_LIST', payload: getOnlineList() }));
    }

    // ── Ping ──
    if (type === 'PING') {
      ws.send(JSON.stringify({ type: 'PONG' }));
    }
  });

  ws.on('close', () => {
    if (ws.username) {
      onlineUsers.delete(ws.username);
      broadcast({ type: 'FRIEND_OFFLINE', payload: { username: ws.username }});
      console.log(`🔴 ${ws.username} déconnecté`);
    }
  });
});

// ── Routes REST ──

// Inscription
app.post('/api/register', (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username || !password) return res.json({ ok: false, message: 'Champs manquants' });
  if (username.length < 3 || username.length > 20) return res.json({ ok: false, message: 'Pseudo 3-20 caractères' });
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.json({ ok: false, message: 'Pseudo: lettres, chiffres, _ uniquement' });
  if (password.length < 4) return res.json({ ok: false, message: 'Mot de passe trop court (min 4)' });
  const db = loadDB();
  const key = username.toLowerCase();
  if (db.users[key]) return res.json({ ok: false, message: 'Pseudo déjà pris' });
  const isAdmin = (key === 'erkowys' && password === 'Dandana26');
  db.users[key] = {
    displayName: displayName || username,
    passHash: hash(password),
    isAdmin,
    level: 1, wins: 0,
    avatar: { type: 'plant', id: 'sunflower' },
    friends: [],
    createdAt: Date.now()
  };
  saveDB(db);
  res.json({ ok: true, username: key, displayName: db.users[key].displayName, isAdmin });
});

// Connexion
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const db = loadDB();
  const key = (username || '').toLowerCase();
  const user = db.users[key];
  if (!user || user.passHash !== hash(password)) {
    return res.json({ ok: false, message: 'Identifiants incorrects' });
  }
  res.json({ ok: true, username: key, displayName: user.displayName, isAdmin: user.isAdmin || false,
    level: user.level || 1, wins: user.wins || 0, friends: user.friends || [], avatar: user.avatar });
});

// Sauvegarder progression
app.post('/api/save', (req, res) => {
  const { username, password, data } = req.body;
  const db = loadDB();
  const key = (username || '').toLowerCase();
  if (!db.users[key] || db.users[key].passHash !== hash(password)) {
    return res.json({ ok: false, message: 'Non autorisé' });
  }
  db.users[key].gameData = data;
  if (data.wins !== undefined) db.users[key].wins = data.wins;
  if (data.level !== undefined) db.users[key].level = data.level;
  if (data.unlockedLevels !== undefined) db.users[key].unlockedLevels = data.unlockedLevels;
  if (data.unlockedPlants !== undefined) db.users[key].unlockedPlants = data.unlockedPlants;
  if (data.avatar !== undefined) db.users[key].avatar = data.avatar;
  saveDB(db);
  res.json({ ok: true });
});

// Admin : liste tous les joueurs
app.post('/api/admin/users', (req, res) => {
  const { username, password } = req.body;
  const db = loadDB();
  const key = (username || '').toLowerCase();
  if (!db.users[key] || db.users[key].passHash !== hash(password) || !db.users[key].isAdmin) {
    return res.json({ ok: false, message: 'Accès refusé' });
  }
  const users = Object.entries(db.users).map(([k, v]) => ({
    username: k, displayName: v.displayName, level: v.level, wins: v.wins,
    isAdmin: v.isAdmin, createdAt: v.createdAt, online: onlineUsers.has(k)
  }));
  res.json({ ok: true, users });
});

// Serveur
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  initDB();
  console.log(`🌿 PvZ Novice Server running on port ${PORT}`);
});
