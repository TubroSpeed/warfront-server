/**
 * WARFRONT.IO — Multiplayer Relay Server
 * ---------------------------------------
 * This is a small, real, authoritative-ish relay server. It does NOT simulate fake players —
 * every "player" that appears in a lobby is a real browser tab connected to this exact
 * server process. Its job is:
 *
 *   1. Let one player "host" a match -> generates a short lobby code (e.g. AB72-KD91).
 *   2. Let other players "join" using that code -> they get placed in the same lobby room.
 *   3. Relay real-time position/health/hit updates between everyone in that lobby.
 *   4. Track a simple public match list so people can browse open games.
 *
 * HOW TO RUN THIS:
 *   1. Install Node.js (https://nodejs.org) if you don't have it.
 *   2. In this folder, run:  npm install
 *   3. Then run:             node server.js
 *   4. It will print something like "Relay listening on port 3000".
 *   5. Open game.html, go to Play Online, and enter your server's address:
 *        - Same computer:      http://localhost:3000
 *        - Friend on your LAN: http://<your-local-ip>:3000
 *        - Over the internet:  deploy this folder to a free host (Render, Railway, Fly.io)
 *          and use the URL it gives you (e.g. https://your-app.onrender.com)
 *
 * This file intentionally stays simple and readable so it's easy to extend.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }, // allow the game.html file (opened from file:// or any host) to connect
});

const PORT = process.env.PORT || 3000;

// In-memory lobby store. No database needed for this scope.
// lobbies[code] = { code, mode, map, privacy, hostId, players: Map(id -> playerInfo), started }
const lobbies = new Map();

function generateLobbyCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no O/I to avoid confusion
  const digits = '23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += letters[Math.floor(Math.random() * letters.length)];
  code += '-';
  for (let i = 0; i < 4; i++) code += digits[Math.floor(Math.random() * digits.length)];
  return code;
}

function uniqueLobbyCode() {
  let code;
  do { code = generateLobbyCode(); } while (lobbies.has(code));
  return code;
}

function lobbyPublicView(lobby) {
  return {
    code: lobby.code,
    mode: lobby.mode,
    map: lobby.map,
    playerCount: lobby.players.size,
  };
}

function lobbyPlayerList(lobby) {
  return Array.from(lobby.players.values()).map(p => ({
    id: p.id, name: p.name, isHost: p.id === lobby.hostId, team: p.team,
  }));
}

function broadcastLobbyUpdate(lobby) {
  io.to(lobby.code).emit('lobby_update', {
    code: lobby.code, mode: lobby.mode, map: lobby.map,
    players: lobbyPlayerList(lobby),
  });
}

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  socket.on('ping_check', (ack) => { if (typeof ack === 'function') ack(); });

  socket.on('create_lobby', ({ mode, map, privacy, name }) => {
    const code = uniqueLobbyCode();
    const lobby = {
      code, mode: mode || 'tdm', map: map || 'base', privacy: privacy || 'private',
      hostId: socket.id, players: new Map(), started: false,
    };
    lobby.players.set(socket.id, { id: socket.id, name: name || 'Host', team: 'a' });
    lobbies.set(code, lobby);

    socket.join(code);
    socket.data.lobbyCode = code;

    socket.emit('lobby_created', {
      code, playerId: socket.id,
      players: lobbyPlayerList(lobby), mode: lobby.mode, map: lobby.map,
    });
    console.log(`[lobby] ${socket.id} created ${code} (${lobby.mode} / ${lobby.map}, ${lobby.privacy})`);
  });

  socket.on('join_lobby', ({ code, name }) => {
    const normalized = (code || '').trim().toUpperCase();
    const lobby = lobbies.get(normalized);
    if (!lobby) {
      socket.emit('lobby_join_error', { message: `No lobby found with code ${normalized}` });
      return;
    }
    if (lobby.started) {
      socket.emit('lobby_join_error', { message: 'That match has already started' });
      return;
    }
    if (lobby.players.size >= 16) {
      socket.emit('lobby_join_error', { message: 'Lobby is full' });
      return;
    }
    const team = lobby.players.size % 2 === 0 ? 'a' : 'b';
    lobby.players.set(socket.id, { id: socket.id, name: name || 'Player', team });
    socket.join(lobby.code);
    socket.data.lobbyCode = lobby.code;

    socket.emit('lobby_joined', {
      code: lobby.code, playerId: socket.id,
      players: lobbyPlayerList(lobby), mode: lobby.mode, map: lobby.map,
    });
    broadcastLobbyUpdate(lobby);
    console.log(`[lobby] ${socket.id} joined ${lobby.code}`);
  });

  socket.on('list_public_lobbies', (ack) => {
    const list = Array.from(lobbies.values())
      .filter(l => l.privacy === 'public' && !l.started)
      .map(lobbyPublicView);
    if (typeof ack === 'function') ack(list);
  });

  socket.on('leave_lobby', () => {
    leaveCurrentLobby(socket);
  });

  socket.on('start_match', () => {
    const code = socket.data.lobbyCode;
    const lobby = lobbies.get(code);
    if (!lobby) return;
    if (lobby.hostId !== socket.id) return; // only host can start
    lobby.started = true;
    io.to(code).emit('match_starting', { mode: lobby.mode, map: lobby.map });
    console.log(`[match] ${code} started (${lobby.mode} / ${lobby.map})`);
  });

  // ---- live gameplay relay ----
  socket.on('player_state', (data) => {
    const code = socket.data.lobbyCode;
    if (!code) return;
    const lobby = lobbies.get(code);
    if (!lobby) return;
    const p = lobby.players.get(socket.id);
    if (!p) return;
    p.team = data.team || p.team;
    p.name = data.name || p.name;
    // relay to everyone else in the lobby (not back to sender)
    socket.to(code).emit('player_state', { id: socket.id, ...data });
  });

  socket.on('player_hit', (data) => {
    // data: { targetId, damage, weaponName, attackerName }
    const code = socket.data.lobbyCode;
    if (!code) return;
    io.to(code).emit('player_hit', data);
  });

  socket.on('disconnect', () => {
    console.log(`[disconnect] ${socket.id}`);
    leaveCurrentLobby(socket);
  });
});

function leaveCurrentLobby(socket) {
  const code = socket.data.lobbyCode;
  if (!code) return;
  const lobby = lobbies.get(code);
  if (!lobby) return;

  lobby.players.delete(socket.id);
  socket.leave(code);
  socket.data.lobbyCode = null;
  io.to(code).emit('player_left', socket.id);

  if (lobby.players.size === 0) {
    lobbies.delete(code);
    console.log(`[lobby] ${code} closed (empty)`);
    return;
  }
  // reassign host if the host left
  if (lobby.hostId === socket.id) {
    const next = lobby.players.keys().next();
    if (!next.done) lobby.hostId = next.value;
  }
  broadcastLobbyUpdate(lobby);
}

app.get('/', (req, res) => {
  res.send(`
    <html><body style="font-family:sans-serif; background:#0a0b0d; color:#eee; padding:40px;">
      <h2>WARFRONT.IO relay server</h2>
      <p>This server is running correctly. Active lobbies: ${lobbies.size}</p>
      <p>Point your game.html "Relay Server Address" field at this URL.</p>
    </body></html>
  `);
});

server.listen(PORT, () => {
  console.log(`Relay listening on port ${PORT}`);
  console.log(`Local:   http://localhost:${PORT}`);
  console.log(`Give friends your public IP or a deployed URL + this port to connect.`);
});
